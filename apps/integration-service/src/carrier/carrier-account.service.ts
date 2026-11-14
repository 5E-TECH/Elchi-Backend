import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import {
  ActivityAction,
  ActivityLogService,
  IP_ALLOWLIST_MAX_ENTRIES,
  Roles,
  Status,
  normalizeIpAllowlistRules,
  rmqSend,
} from '@app/common';
import { CarrierAccount } from '../entities/carrier-account.entity';
import { errorRes, successRes } from '../../../../libs/common/helpers/response';

type Requester = { id?: string; roles?: string[] } | null | undefined;

/** Guard'ga qaytadigan ma'lumot — `CarrierApiKeyGuard` qaror qiladi. */
export type CarrierKeyValidation = {
  id: string;
  name: string;
  is_active: boolean;
  ip_allowlist: string[] | null;
  courier_user_id: string;
  /**
   * Bog'langan kurier HOZIR faolmi (role = courier, status = active,
   * o'chirilmagan). `false` — guard 403 qaytaradi. Faqat `is_active` akkaunt
   * uchun tekshiriladi (o'chiq akkaunt baribir 403).
   */
  courier_active: boolean;
  /**
   * `status: rollback` shu kompaniyaga ruxsatmi (sukut `false`). Akkaunt
   * qatori har so'rovda bazadan o'qiladi (kesh YO'Q) — admin toggle'i
   * keyingi so'rovdan kuchga kiradi.
   */
  rollback_enabled: boolean;
};

/** Ro'yxat va javoblardagi xavfsiz ko'rinish (hash hech qachon chiqmaydi). */
type CarrierAccountView = {
  id: string;
  name: string;
  courier_user_id: string;
  ip_allowlist: string[] | null;
  is_active: boolean;
  /** Yashirin rollback ruxsati — faqat admin ko'radi (`/admin/carriers`). */
  rollback_enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** `update` da o'zgartirish mumkin bo'lgan ustunlar (kurier va kalit — yo'q). */
type CarrierAccountEditable = Pick<
  CarrierAccount,
  'name' | 'ip_allowlist' | 'rollback_enabled'
>;

type IdentityUser = {
  id: string;
  name?: string | null;
  role?: string;
  status?: string;
};

/**
 * Admin yaratish yo'li: identity'ga ≈6.5 s dan oshmaymiz — gateway
 * `POST /admin/carriers` 20 s kutadi. Ilgari 5 s × 2 urinish ≈ 10.2 s edi va
 * gateway 10 s da voz kechgach ham akkaunt YARATILIB, bir martalik kalit
 * hech kimga yetmay yo'qolardi.
 */
const IDENTITY_ADMIN_OPTS = { timeoutMs: 3000, retries: 1, deadlineMs: 6500 };
/**
 * Har so'rovdagi kurier tekshiruvi: guard `validate_key` ni 5 s kutadi —
 * identity'ga bitta qisqa urinish, natija keshlanadi.
 */
const IDENTITY_KEY_CHECK_OPTS = { timeoutMs: 2500, retries: 0 };
/** Kurier holati keshi. Bloklangan kurier kaliti ko'pi bilan shuncha ishlaydi. */
const COURIER_STATE_TTL_MS = 30_000;
const COURIER_STATE_CACHE_MAX = 1000;

/** Postgres BIGINT chegarasi — undan kattasi DB'da 22003 (500 + requeue) berardi. */
const BIGINT_MAX = 9223372036854775807n;
const isBigintId = (value: string): boolean =>
  /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= BIGINT_MAX;

/**
 * Carrier API akkauntlari (tashqi yetkazuvchi = bitta kurier).
 *
 * Kalit naqshi Partner API bilan bir xil (`IntegrationServiceService.
 * hashApiKey` / `generatePartnerApiKey`): SHA-256 hash saqlanadi, kalit
 * faqat yaratish va rotatsiya javobida BIR MARTA ko'rsatiladi. Prefiks
 * boshqacha (`elc_`) — operator va log'da partner kalitidan ajralib tursin.
 */
@Injectable()
export class CarrierAccountService {
  private readonly logger = new Logger(CarrierAccountService.name);
  /** courier_user_id → { active, at } — `validateKey` dagi kurier tekshiruvi keshi. */
  private readonly courierState = new Map<
    string,
    { active: boolean; at: number }
  >();

  constructor(
    @InjectRepository(CarrierAccount)
    private readonly carrierRepo: Repository<CarrierAccount>,
    private readonly activityLog: ActivityLogService,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  private badRequest(message: string): never {
    throw new RpcException(errorRes(message, 400));
  }

  private notFound(message: string): never {
    throw new RpcException(errorRes(message, 404));
  }

  private conflict(message: string): never {
    throw new RpcException(errorRes(message, 409));
  }

  private unavailable(message: string): never {
    throw new RpcException(errorRes(message, 503));
  }

  private hashApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
  }

  private generateApiKey(): string {
    return `elc_${randomBytes(32).toString('hex')}`;
  }

  private auditActor(requester: Requester): {
    user_id: string | null;
    user_role: string | null;
  } {
    const roles = requester?.roles ?? [];
    return {
      user_id: requester?.id ? String(requester.id) : null,
      user_role: roles.length ? roles.join(',') : null,
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    const e = error as { code?: string; driverError?: { code?: string } };
    return e?.code === '23505' || e?.driverError?.code === '23505';
  }

  /**
   * IP ro'yxatini tekshiradi va kanonik shaklga keltiradi
   * (`normalizeIpAllowlistRules`). `null`/bo'sh — cheklov yo'q. Tushunilmagan
   * yozuv — 400 (ilgari jimgina saqlanib, hech qachon mos kelmasdi).
   */
  private normalizeIpAllowlist(value: unknown): string[] | null {
    if (value === null) {
      return null;
    }
    if (!Array.isArray(value)) {
      this.badRequest("ip_allowlist massiv bo'lishi kerak");
    }
    if (value.length > IP_ALLOWLIST_MAX_ENTRIES) {
      this.badRequest(
        `ip_allowlist ${IP_ALLOWLIST_MAX_ENTRIES} tadan ko'p bo'lmasin`,
      );
    }
    const { rules, invalid } = normalizeIpAllowlistRules(value);
    if (invalid.length) {
      this.badRequest(
        `ip_allowlist da tushunilmagan yozuv: ${invalid.join(', ')}. ` +
          "Qabul qilinadi: IPv4 (203.0.113.10), IPv4 diapazon (203.0.113.0/24), IPv6 manzil (IPv6 diapazon yo'q)",
      );
    }
    return rules.length ? rules : null;
  }

  private toView(row: CarrierAccount): CarrierAccountView {
    return {
      id: String(row.id),
      name: row.name,
      courier_user_id: String(row.courier_user_id),
      ip_allowlist: row.ip_allowlist ?? null,
      is_active: row.is_active,
      rollback_enabled: row.rollback_enabled === true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private parseId(raw: unknown, field = 'id'): string {
    const clean = (
      typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''
    ).trim();
    if (!isBigintId(clean)) {
      this.badRequest(`${field} noto'g'ri`);
    }
    return clean;
  }

  private async findOrFail(id: string): Promise<CarrierAccount> {
    const clean = this.parseId(id);
    const row = await this.carrierRepo.findOne({
      where: { id: clean, isDeleted: false },
    });
    if (!row) {
      this.notFound('Carrier akkaunt topilmadi');
    }
    return row;
  }

  /**
   * Faqat o'zgargan ustunlarni yozadi (ilgari to'liq `save(row)` edi: parallel
   * `status` / `rotate-key` / `update` bir-birining yozuvini eski qiymat bilan
   * bosib ketardi — masalan o'chirilgan akkaunt qayta yoqilib qolardi).
   */
  private async patch(
    id: string,
    changes: Partial<
      Pick<
        CarrierAccount,
        | 'name'
        | 'ip_allowlist'
        | 'is_active'
        | 'api_key_hash'
        | 'rollback_enabled'
      >
    >,
  ): Promise<CarrierAccount> {
    const result = await this.carrierRepo.update(
      { id, isDeleted: false },
      changes,
    );
    if (!result.affected) {
      this.notFound('Carrier akkaunt topilmadi');
    }
    return this.findOrFail(id);
  }

  private async findIdentityUser(
    courierId: string,
    opts: { timeoutMs: number; retries: number; deadlineMs?: number },
  ): Promise<IdentityUser | null> {
    let res: { data?: unknown } | null;
    try {
      res = await rmqSend<{ data?: unknown }>(
        this.identityClient,
        { cmd: 'identity.user.find_by_ids' },
        { ids: [courierId] },
        opts,
      );
    } catch (error) {
      this.logger.warn(
        `carrier: identity.user.find_by_ids failed for ${courierId}: ${
          (error as Error)?.message ?? String(error)
        }`,
      );
      this.unavailable(
        "Kurierni tekshirib bo'lmadi — identity xizmati javob bermadi",
      );
    }
    const rows = Array.isArray(res?.data) ? (res.data as unknown[]) : [];
    // identity `find_by_ids` o'chirilgan (is_deleted) foydalanuvchini qaytarmaydi.
    return (
      (rows.find(
        (r) =>
          r &&
          typeof r === 'object' &&
          String((r as { id?: unknown }).id) === courierId,
      ) as IdentityUser | undefined) ?? null
    );
  }

  private isActiveCourier(user: IdentityUser | null): boolean {
    return (
      !!user &&
      String(user.role ?? '').toLowerCase() === Roles.COURIER &&
      String(user.status ?? '').toLowerCase() === Status.ACTIVE
    );
  }

  /**
   * Kurier user'ni identity'dan tekshiradi: mavjud, role = courier, aktiv.
   *
   * ⚠️ Identity javob bermasa 503 — "kurier emas" deb 400 qaytarish noto'g'ri
   * bo'lardi: operator to'g'ri kurierni tanlagan bo'lsa ham xato qilgandek
   * ko'rardi.
   */
  private async assertActiveCourier(courierId: string): Promise<{
    id: string;
    name: string | null;
  }> {
    const user = await this.findIdentityUser(courierId, IDENTITY_ADMIN_OPTS);
    if (!user) {
      this.notFound('Kurier topilmadi');
    }
    if (String(user.role ?? '').toLowerCase() !== Roles.COURIER) {
      this.badRequest('Bu foydalanuvchi kurier emas');
    }
    if (String(user.status ?? '').toLowerCase() !== Status.ACTIVE) {
      this.badRequest('Kurier faol emas');
    }
    this.rememberCourierState(courierId, true);
    return { id: String(user.id), name: user.name ?? null };
  }

  private rememberCourierState(courierId: string, active: boolean): void {
    if (this.courierState.size >= COURIER_STATE_CACHE_MAX) {
      this.courierState.clear();
    }
    this.courierState.set(courierId, { active, at: Date.now() });
  }

  /**
   * BOG'LANGAN KURIER HOZIR FAOLMI — har `/carrier/*` so'rovida
   * (ultracode review, HIGH).
   *
   * MUAMMO. Kurier faqat akkaunt YARATILGANDA tekshirilardi. Operator odatdagi
   * kurier panelidan kurierni bloklasa yoki o'chirsa, JWT kurier darhol
   * chiqarib yuborilardi (sessiyalar bekor), kompaniyaning `elc_` kaliti esa
   * ishlashda davom etib, mijozlar ma'lumotini o'qir va bloklangan user
   * nomidan kassa yozuvlari qoldirardi.
   *
   * Natija 30 s keshlanadi (har so'rovda identity'ga bormaslik uchun).
   * Identity javob bermasa — 503 (yopiq: tekshirib bo'lmagan kalit o'tmaydi).
   */
  private async isCourierActiveNow(courierId: string): Promise<boolean> {
    const cached = this.courierState.get(courierId);
    if (cached && Date.now() - cached.at < COURIER_STATE_TTL_MS) {
      return cached.active;
    }
    const user = await this.findIdentityUser(
      courierId,
      IDENTITY_KEY_CHECK_OPTS,
    );
    const active = this.isActiveCourier(user);
    this.rememberCourierState(courierId, active);
    return active;
  }

  /**
   * `X-Api-Key` ni tekshiradi (gateway guard'idan). `is_active` FILTRLANMAYDI
   * — guard 401 (topilmadi) va 403 (faol emas) ni ajratsin.
   */
  async validateKey(apiKey: string): Promise<CarrierKeyValidation | null> {
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      return null;
    }
    const row = await this.carrierRepo.findOne({
      where: { api_key_hash: this.hashApiKey(apiKey.trim()), isDeleted: false },
      select: {
        id: true,
        name: true,
        is_active: true,
        ip_allowlist: true as never,
        courier_user_id: true,
        rollback_enabled: true,
      },
    });
    if (!row) {
      return null;
    }
    const courierId = String(row.courier_user_id);
    return {
      id: String(row.id),
      name: row.name,
      is_active: row.is_active,
      ip_allowlist: row.ip_allowlist ?? null,
      courier_user_id: courierId,
      courier_active: row.is_active
        ? await this.isCourierActiveNow(courierId)
        : false,
      // Faqat aniq `true` — eski/yo'q ustun yopiq (rollback o'chiq).
      rollback_enabled: row.rollback_enabled === true,
    };
  }

  async create(dto: {
    name?: string;
    courier_id?: string | number;
    ip_allowlist?: string[] | null;
    requester?: Requester;
  }) {
    const name = String(dto?.name ?? '').trim();
    if (!name) {
      this.badRequest('name majburiy');
    }
    if (name.length > 200) {
      this.badRequest('name 200 belgidan oshmasin');
    }
    const courierId = String(dto?.courier_id ?? '').trim();
    if (!isBigintId(courierId)) {
      this.badRequest('courier_id majburiy (kurier user id, musbat butun son)');
    }
    const ipAllowlist =
      dto.ip_allowlist === undefined
        ? null
        : this.normalizeIpAllowlist(dto.ip_allowlist);

    const courier = await this.assertActiveCourier(courierId);

    const existing = await this.carrierRepo.findOne({
      where: { courier_user_id: courierId, isDeleted: false },
      select: { id: true, name: true },
    });
    if (existing) {
      this.conflict(
        `Bu kurier allaqachon "${existing.name}" carrier akkauntiga bog'langan ` +
          `(id ${String(existing.id)}). Kalit yo'qolgan bo'lsa — ` +
          `POST /admin/carriers/${String(existing.id)}/rotate-key`,
      );
    }

    const apiKey = this.generateApiKey();
    let saved: CarrierAccount;
    try {
      saved = await this.carrierRepo.save(
        this.carrierRepo.create({
          name,
          courier_user_id: courierId,
          api_key_hash: this.hashApiKey(apiKey),
          ip_allowlist: ipAllowlist,
          is_active: true,
          // Yangi kompaniya — rollback DOIM o'chiq (yaratishda berilmaydi:
          // gateway DTO'sida maydon yo'q → 400; RMQ'da kelsa ham e'tiborsiz).
          rollback_enabled: false,
        }),
      );
    } catch (error) {
      // Parallel yaratish: ikkinchisi qisman unique indeksga uriladi.
      if (this.isUniqueViolation(error)) {
        this.conflict(
          "Bu kurier allaqachon boshqa carrier akkauntiga bog'langan — " +
            "ro'yxatdan topib rotate-key qiling",
        );
      }
      throw error;
    }

    // Kalit HECH QACHON log qilinmaydi.
    await this.activityLog.log({
      entity_type: 'CarrierAccount',
      entity_id: String(saved.id),
      action: ActivityAction.CREATED,
      new_value: {
        name: saved.name,
        courier_user_id: String(saved.courier_user_id),
        is_active: saved.is_active,
        rollback_enabled: saved.rollback_enabled === true,
      },
      ...this.auditActor(dto.requester),
    });

    return successRes(
      {
        ...this.toView(saved),
        courier_name: courier.name,
        // Faqat SHU javobda — keyin qayta ko'rsatilmaydi.
        api_key: apiKey,
      },
      201,
      'carrier account created',
    );
  }

  async list() {
    const rows = await this.carrierRepo.find({
      where: { isDeleted: false },
      order: { id: 'DESC' },
    });
    return successRes(
      rows.map((r) => this.toView(r)),
      200,
      'carrier accounts',
    );
  }

  /**
   * Nom, IP ro'yxati va rollback ruxsatini yangilaydi (har biri ixtiyoriy,
   * birga yoki alohida). Kurier bog'lanishi va kalit bu yerda O'ZGARMAYDI:
   * kurier almashsa — yangi akkaunt (eski buyurtmalar va kassa eski kurierda
   * qoladi); kalit uchun `rotateKey`.
   *
   * `rollback_enabled` — `status: rollback` ruxsati (yashirin, sukut false).
   * Kuchga kirishi: keyingi `/carrier/*` so'rovidan (akkaunt qatori
   * keshlanmaydi). Audit: o'zgargan maydonlarning eski → yangi qiymati.
   */
  async update(
    id: string,
    dto: {
      name?: string;
      ip_allowlist?: string[] | null;
      rollback_enabled?: boolean;
    },
    requester?: Requester,
  ) {
    const cleanId = this.parseId(id);
    const changed: Partial<CarrierAccountEditable> = {};

    if (dto?.name !== undefined) {
      const name = String(dto.name ?? '').trim();
      if (!name) {
        this.badRequest("name bo'sh bo'lishi mumkin emas");
      }
      if (name.length > 200) {
        this.badRequest('name 200 belgidan oshmasin');
      }
      changed.name = name;
    }
    if (dto?.ip_allowlist !== undefined) {
      changed.ip_allowlist = this.normalizeIpAllowlist(dto.ip_allowlist);
    }
    if (dto?.rollback_enabled !== undefined) {
      if (typeof dto.rollback_enabled !== 'boolean') {
        this.badRequest("rollback_enabled boolean bo'lishi kerak");
      }
      changed.rollback_enabled = dto.rollback_enabled;
    }
    if (!Object.keys(changed).length) {
      this.badRequest("O'zgartirish uchun hech qanday maydon berilmadi");
    }

    // Audit uchun eski qiymatlar (faqat o'zgartirilayotgan maydonlar).
    const before = await this.findOrFail(cleanId);
    const oldValue: Partial<CarrierAccountEditable> = {};
    if (changed.name !== undefined) {
      oldValue.name = before.name;
    }
    if (changed.ip_allowlist !== undefined) {
      oldValue.ip_allowlist = before.ip_allowlist ?? null;
    }
    if (changed.rollback_enabled !== undefined) {
      oldValue.rollback_enabled = before.rollback_enabled === true;
    }

    const saved = await this.patch(cleanId, changed);
    await this.activityLog.log({
      entity_type: 'CarrierAccount',
      entity_id: cleanId,
      action: ActivityAction.UPDATED,
      old_value: oldValue,
      new_value: changed,
      ...this.auditActor(requester),
    });
    if (
      changed.rollback_enabled !== undefined &&
      changed.rollback_enabled !== (before.rollback_enabled === true)
    ) {
      this.logger.log(
        `carrier ${cleanId}: rollback ${
          changed.rollback_enabled ? 'YOQILDI' : "O'CHIRILDI"
        } (requester ${requester?.id ?? '-'})`,
      );
    }
    return successRes(this.toView(saved), 200, 'carrier account updated');
  }

  /**
   * Yangi kalit — eski kalit DARHOL ishlamay qoladi (hash almashadi).
   * Bloklangan/o'chirilgan kurierga yangi kalit chiqarilmaydi.
   */
  async rotateKey(id: string, requester?: Requester) {
    const row = await this.findOrFail(id);
    await this.assertActiveCourier(String(row.courier_user_id));
    const apiKey = this.generateApiKey();
    await this.patch(String(row.id), { api_key_hash: this.hashApiKey(apiKey) });

    await this.activityLog.log({
      entity_type: 'CarrierAccount',
      entity_id: String(row.id),
      action: ActivityAction.UPDATED,
      new_value: { key_rotated: true },
      ...this.auditActor(requester),
    });
    return successRes(
      {
        id: String(row.id),
        api_key: apiKey,
        rollback_enabled: row.rollback_enabled === true,
      },
      200,
      'carrier key rotated',
    );
  }

  /**
   * Faol emas akkaunt bilan `/carrier/*` → 403. Yoqishda bog'langan kurier
   * faol bo'lishi shart (bloklangan kurier kaliti qayta tirilmasin).
   */
  async setActive(id: string, isActive: boolean, requester?: Requester) {
    if (typeof isActive !== 'boolean') {
      this.badRequest("is_active boolean bo'lishi kerak");
    }
    const row = await this.findOrFail(id);
    if (isActive) {
      await this.assertActiveCourier(String(row.courier_user_id));
    }
    const saved = await this.patch(String(row.id), { is_active: isActive });

    await this.activityLog.log({
      entity_type: 'CarrierAccount',
      entity_id: String(row.id),
      action: ActivityAction.UPDATED,
      new_value: { is_active: saved.is_active },
      ...this.auditActor(requester),
    });
    return successRes(
      {
        id: String(row.id),
        is_active: saved.is_active,
        rollback_enabled: saved.rollback_enabled === true,
      },
      200,
      'carrier status updated',
    );
  }
}
