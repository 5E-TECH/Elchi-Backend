import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { Brackets, EntityManager, In, Repository } from 'typeorm';
import {
  ActivityLogService,
  CONTACT_AUDIT_ACTIONS,
  CONTACT_ERROR_CODES,
  CONTACT_SETTING_KEYS,
  MARKET_RESPONSIBLE_ROLES,
  MY_CONTACTS_LOGISTS_MAX,
  RESPONSIBLE_BULK_MAX,
  Roles,
  Status,
  dedupeProblemContacts,
  isMarketResponsibleRole,
  normalizeSupportPhones,
  parseUzPhoneSearch,
  readSupportPhones,
  rmqSend,
  uzPhoneDigitsLikeSql,
} from '@app/common';
import type {
  MyContacts,
  ProblemContact,
  ResponsibleSource,
  ResponsibleSummary,
} from '@app/common';
import { errorRes, successRes } from '../../../../libs/common/helpers/response';
import { User } from '../entities/user.entity';
import { AppSetting } from '../entities/app-setting.entity';
import { CourierRegion } from '../entities/courier-region.entity';
import type { RequesterContext } from '../contracts/user.payloads';

/**
 * T7 (QPq2C1co) «Aloqa raqamlari» — identity tomoni.
 *
 *  - Market mas'uli (`admins.market_responsible_id`) va sukut mas'ul /
 *    zaxira raqamlar (`app_settings`): o'qish, o'zgartirish, bulk
 *    biriktirish — faqat SUPERADMIN / ADMIN (gateway @Roles + shu yerda).
 *  - Market mas'uli rezolveri: faol biriktirilgan → faol sukut → yo'q
 *    (`none`). Nofaol mas'ul biriktiruvi saqlanadi, lekin hisobda
 *    o'tkazib yuboriladi.
 *  - `GET /users/me/contacts` — so'rovchining o'z aloqa kartasi.
 *  - `problem_contacts` — buyurtma viloyati logisti (logistics
 *    `regions.logist_id`), u yo'q/nofaol — zaxira raqamlar. Partiya: bitta
 *    RPC + bitta SQL (N+1 yo'q); keshni gateway yuritadi (60 s).
 *  - B4: mas'ul o'chirilsa / roli mas'ul bo'lmaydiganga o'zgarsa —
 *    `releaseResponsible` (chaqiruvchining tranzaksiyasida).
 */

const ID_PATTERN = /^\d{1,19}$/;
const LOOKUP_TIMEOUT_MS = 5000;
const RESPONSIBLES_LIMIT = 200;

type Requester = RequesterContext | undefined;

interface ContactSettingsState {
  supportPhones: string[];
  defaultResponsibleId: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export interface MarketResponsibleView {
  responsible: ResponsibleSummary | null;
  responsible_source: ResponsibleSource;
}

export interface UpdateContactSettingsInput {
  support_phones?: unknown;
  default_market_responsible_id?: unknown;
}

export interface ProblemContactsInput {
  region_ids?: unknown;
  district_ids?: unknown;
}

export interface ProblemContactsResult {
  regions: Record<string, ProblemContact[]>;
  districts: Record<string, ProblemContact[]>;
  /** Viloyati aniqlanmagan buyurtma uchun — zaxira raqamlar. */
  fallback: ProblemContact[];
}

const asId = (value: unknown): string | null => {
  const text =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  return ID_PATTERN.test(text) ? String(BigInt(text)) : null;
};

const cleanIds = (value: unknown, max = 500): string[] =>
  [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map(asId)
        .filter((id): id is string => id !== null),
    ),
  ].slice(0, max);

const rpcError = (
  message: string,
  statusCode: number,
  code?: string,
): RpcException =>
  new RpcException(
    code
      ? { ...errorRes(message, statusCode), code }
      : errorRes(message, statusCode),
  );

/**
 * TypeORM (postgres) `UPDATE … RETURNING` natijasi `[rows, affected]`
 * ko'rinishida keladi; `SELECT` — oddiy massiv. Ikkalasidan ham qatorlar.
 */
const returnedRows = <T>(result: unknown): T[] => {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
};

const summaryOf = (user: User): ResponsibleSummary => ({
  id: String(user.id),
  name: user.name,
  phone_number: user.phone_number,
  role: user.role,
});

const isActiveResponsible = (user: User | null | undefined): user is User =>
  Boolean(
    user &&
    !user.isDeleted &&
    user.status === Status.ACTIVE &&
    isMarketResponsibleRole(user.role),
  );

const isActiveLogist = (user: User | null | undefined): user is User =>
  Boolean(
    user &&
    !user.isDeleted &&
    user.status === Status.ACTIVE &&
    user.role === Roles.LOGIST &&
    String(user.phone_number ?? '').trim(),
  );

@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(AppSetting)
    private readonly settings: Repository<AppSetting>,
    @InjectRepository(CourierRegion)
    private readonly courierRegions: Repository<CourierRegion>,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    private readonly activityLog: ActivityLogService,
  ) {}

  // ==================== Ruxsat va yordamchilar ====================

  private assertAdmin(requester: Requester): void {
    const roles = (requester?.roles ?? []).map((role) =>
      String(role).toLowerCase(),
    );
    if (!roles.includes(Roles.SUPERADMIN) && !roles.includes(Roles.ADMIN)) {
      throw rpcError(
        "Aloqa sozlamalari va market mas'ullarini faqat superadmin yoki admin boshqaradi",
        403,
      );
    }
  }

  private actor(requester: Requester) {
    const roles = requester?.roles ?? [];
    return {
      user_id: requester?.id ? String(requester.id) : null,
      user_role: roles.length ? roles.join(',') : null,
    };
  }

  private async readSettings(
    manager: EntityManager = this.settings.manager,
  ): Promise<ContactSettingsState> {
    const rows = await manager.getRepository(AppSetting).find({
      where: {
        key: In([
          CONTACT_SETTING_KEYS.SUPPORT_PHONES,
          CONTACT_SETTING_KEYS.DEFAULT_MARKET_RESPONSIBLE,
        ]),
      },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    // updated_at / updated_by — kalitlardan eng oxirgi o'zgargani.
    const latest = rows
      .filter((row) => row.updated_by !== null || row.updated_at)
      .sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      )[0];
    return {
      supportPhones: readSupportPhones(
        byKey.get(CONTACT_SETTING_KEYS.SUPPORT_PHONES)?.value,
      ),
      defaultResponsibleId: asId(
        byKey.get(CONTACT_SETTING_KEYS.DEFAULT_MARKET_RESPONSIBLE)?.value,
      ),
      updatedAt: latest?.updated_at ?? null,
      updatedBy: latest?.updated_by ? String(latest.updated_by) : null,
    };
  }

  private async writeSetting(
    manager: EntityManager,
    key: string,
    value: unknown,
    updatedBy: string | null,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO "identity_schema"."app_settings" ("key", "value", "updated_by", "updated_at")
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT ("key") DO UPDATE
         SET "value" = EXCLUDED."value",
             "updated_by" = EXCLUDED."updated_by",
             "updated_at" = now()`,
      [key, JSON.stringify(value ?? null), updatedBy],
    );
  }

  /**
   * Xodimni mas'ul sifatida tekshiradi: 404 / RESPONSIBLE_ROLE_INVALID /
   * RESPONSIBLE_INACTIVE. `lock` — yozuv tranzaksiyasi ICHIDA `FOR SHARE`
   * bilan qayta tekshirish: parallel o'chirish / rol almashtirish
   * (`deleteUser`, `changeUserRole` — shu qatorni UPDATE qiladi) commit
   * bo'lguncha kutadi va o'chirilgan / roli o'zgargan xodim biriktirilmaydi.
   */
  private async loadAssignableResponsible(
    rawId: unknown,
    manager: EntityManager = this.users.manager,
    lock = false,
  ): Promise<User> {
    const id = asId(rawId);
    const user = id
      ? await manager.getRepository(User).findOne({
          where: { id, isDeleted: false },
          ...(lock ? { lock: { mode: 'pessimistic_read' as const } } : {}),
        })
      : null;
    if (!user) {
      throw rpcError('Xodim topilmadi', 404);
    }
    if (!isMarketResponsibleRole(user.role)) {
      throw rpcError(
        "Mas'ul faqat superadmin, admin, registrator yoki logist bo'lishi mumkin",
        400,
        CONTACT_ERROR_CODES.RESPONSIBLE_ROLE_INVALID,
      );
    }
    if (user.status !== Status.ACTIVE) {
      throw rpcError(
        "Xodim nofaol — mas'ul qilib bo'lmaydi",
        400,
        CONTACT_ERROR_CODES.RESPONSIBLE_INACTIVE,
      );
    }
    return user;
  }

  private async usersByIds(
    ids: Array<string | null | undefined>,
  ): Promise<Map<string, User>> {
    const clean = cleanIds(ids);
    if (!clean.length) {
      return new Map();
    }
    const rows = await this.users.find({
      where: { id: In(clean), isDeleted: false },
    });
    return new Map(rows.map((row) => [String(row.id), row]));
  }

  // ==================== Sozlamalar (GET/PATCH /settings/contacts) ====================

  private async settingsView(state: ContactSettingsState) {
    const defaultUser = state.defaultResponsibleId
      ? (await this.usersByIds([state.defaultResponsibleId])).get(
          state.defaultResponsibleId,
        )
      : undefined;
    return {
      support_phones: state.supportPhones,
      default_market_responsible: defaultUser
        ? { ...summaryOf(defaultUser), status: defaultUser.status }
        : null,
      updated_at: state.updatedAt
        ? new Date(state.updatedAt).toISOString()
        : null,
      updated_by: state.updatedBy,
    };
  }

  async getSettings(requester: Requester) {
    this.assertAdmin(requester);
    return successRes(await this.settingsView(await this.readSettings()));
  }

  async updateSettings(
    input: UpdateContactSettingsInput,
    requester: Requester,
  ) {
    this.assertAdmin(requester);
    const hasPhones = input?.support_phones !== undefined;
    const hasDefault = input?.default_market_responsible_id !== undefined;
    if (!hasPhones && !hasDefault) {
      throw rpcError(
        'support_phones yoki default_market_responsible_id dan kamida bittasi kerak',
        400,
      );
    }

    let phones: string[] | null = null;
    if (hasPhones) {
      phones = normalizeSupportPhones(input.support_phones);
      if (!phones) {
        throw rpcError(
          "Zaxira raqamlar noto'g'ri: +998XXXXXXXXX ko'rinishida, takrorsiz, ko'pi bilan 2 ta",
          400,
          CONTACT_ERROR_CODES.SUPPORT_PHONES_INVALID,
        );
      }
    }

    let defaultId: string | null = null;
    if (hasDefault && input.default_market_responsible_id !== null) {
      defaultId = String(
        (
          await this.loadAssignableResponsible(
            input.default_market_responsible_id,
          )
        ).id,
      );
    }

    const updatedBy = asId(requester?.id);
    const { before, after } = await this.settings.manager.transaction(
      async (manager) => {
        if (defaultId) {
          await this.loadAssignableResponsible(defaultId, manager, true);
        }
        const previous = await this.readSettings(manager);
        if (phones) {
          await this.writeSetting(
            manager,
            CONTACT_SETTING_KEYS.SUPPORT_PHONES,
            phones,
            updatedBy,
          );
        }
        if (hasDefault) {
          await this.writeSetting(
            manager,
            CONTACT_SETTING_KEYS.DEFAULT_MARKET_RESPONSIBLE,
            defaultId,
            updatedBy,
          );
        }
        return { before: previous, after: await this.readSettings(manager) };
      },
    );

    await this.activityLog.log({
      entity_type: 'Settings',
      entity_id: 'contacts',
      action: CONTACT_AUDIT_ACTIONS.SETTINGS_UPDATED,
      old_value: {
        support_phones: before.supportPhones,
        default_market_responsible_id: before.defaultResponsibleId,
      },
      new_value: {
        support_phones: after.supportPhones,
        default_market_responsible_id: after.defaultResponsibleId,
      },
      ...this.actor(requester),
    });

    return successRes(
      await this.settingsView(after),
      200,
      'Aloqa sozlamalari saqlandi',
    );
  }

  // ==================== Mas'ullar ====================

  /** `GET /markets/responsibles?search=` — nomzodlar va ulardagi marketlar soni. */
  async listResponsibles(search: unknown, requester: Requester) {
    this.assertAdmin(requester);
    const term = typeof search === 'string' ? search.trim().slice(0, 100) : '';
    const qb = this.users
      .createQueryBuilder('u')
      .where('u.isDeleted = false')
      .andWhere('u.role IN (:...roles)', { roles: MARKET_RESPONSIBLE_ROLES });
    if (term) {
      qb.andWhere(
        new Brackets((nested) => {
          nested
            .where('u.name ILIKE :term', { term: `%${term}%` })
            .orWhere('u.phone_number ILIKE :term', { term: `%${term}%` });
          const phone = parseUzPhoneSearch(term);
          if (phone) {
            nested.orWhere(uzPhoneDigitsLikeSql('u.phone_number'), {
              phoneDigits: `%${phone.digits}%`,
            });
          }
        }),
      );
    }
    const candidates = await qb
      .orderBy('u.name', 'ASC')
      .addOrderBy('u.id', 'ASC')
      .take(RESPONSIBLES_LIMIT)
      .getMany();

    const counts = await this.marketCounts(
      candidates.map((candidate) => String(candidate.id)),
    );
    const state = await this.readSettings();
    return successRes({
      candidates: candidates.map((candidate) => ({
        ...summaryOf(candidate),
        status: candidate.status,
        market_count: counts.get(String(candidate.id)) ?? 0,
      })),
      default_responsible_id: state.defaultResponsibleId,
      default_market_count: counts.get('') ?? 0,
    });
  }

  /** Mas'ul → marketlar soni (`''` kaliti — sukutdagi, ya'ni NULL). Bitta SQL. */
  private async marketCounts(ids: string[]): Promise<Map<string, number>> {
    const rows: Array<{ responsible_id: string | null; count: string }> =
      await this.users
        .createQueryBuilder('m')
        .select('m.market_responsible_id', 'responsible_id')
        .addSelect('COUNT(*)', 'count')
        .where('m.isDeleted = false')
        .andWhere('m.role = :role', { role: Roles.MARKET })
        .andWhere(
          new Brackets((nested) => {
            nested.where('m.market_responsible_id IS NULL');
            if (ids.length) {
              nested.orWhere('m.market_responsible_id IN (:...ids)', { ids });
            }
          }),
        )
        .groupBy('m.market_responsible_id')
        .getRawMany();
    return new Map(
      rows.map((row) => [
        row.responsible_id === null ? '' : String(row.responsible_id),
        Number(row.count) || 0,
      ]),
    );
  }

  /**
   * `POST /markets/responsible/bulk` — `market_ids` (1–500) ni `responsible_id`
   * ga (null — sukutga) o'tkazadi. Boshqa marketlarga tegilmaydi. Market
   * bo'lmagan / topilmagan id — 400 `NOT_A_MARKET` (hech narsa o'zgarmaydi).
   */
  async bulkAssign(
    input: { responsible_id?: unknown; market_ids?: unknown },
    requester: Requester,
  ) {
    this.assertAdmin(requester);
    const rawIds = Array.isArray(input?.market_ids) ? input.market_ids : null;
    if (!rawIds || rawIds.length < 1 || rawIds.length > RESPONSIBLE_BULK_MAX) {
      throw rpcError(
        `market_ids — 1 dan ${RESPONSIBLE_BULK_MAX} tagacha market id`,
        400,
      );
    }
    const marketIds = cleanIds(rawIds, RESPONSIBLE_BULK_MAX);
    if (marketIds.length !== new Set(rawIds.map(String)).size) {
      throw rpcError("market_ids da noto'g'ri id bor", 400);
    }
    const responsible =
      input?.responsible_id === null
        ? null
        : await this.loadAssignableResponsible(input?.responsible_id);
    const targetId = responsible ? String(responsible.id) : null;

    const changed = await this.users.manager.transaction(async (manager) => {
      if (targetId) {
        await this.loadAssignableResponsible(targetId, manager, true);
      }
      const rows = returnedRows<{
        id: string;
        role: string;
        market_responsible_id: string | null;
      }>(
        await manager.query(
          `SELECT "id", "role", "market_responsible_id"
           FROM "identity_schema"."admins"
          WHERE "id" = ANY($1::bigint[]) AND "is_deleted" = false
          FOR UPDATE`,
          [marketIds],
        ),
      );
      const found = new Map(rows.map((row) => [String(row.id), row]));
      const notMarkets = marketIds.filter(
        (id) => found.get(id)?.role !== Roles.MARKET,
      );
      if (notMarkets.length) {
        throw rpcError(
          `Market emas yoki topilmadi: ${notMarkets.slice(0, 20).join(', ')}`,
          400,
          CONTACT_ERROR_CODES.NOT_A_MARKET,
        );
      }
      const toChange = rows.filter(
        (row) => asId(row.market_responsible_id) !== targetId,
      );
      if (toChange.length) {
        await manager.query(
          `UPDATE "identity_schema"."admins"
              SET "market_responsible_id" = $1
            WHERE "id" = ANY($2::bigint[])`,
          [targetId, toChange.map((row) => String(row.id))],
        );
      }
      return toChange.map((row) => ({
        id: String(row.id),
        from: asId(row.market_responsible_id),
      }));
    });

    const movedFrom = new Map<string, number>();
    for (const row of changed) {
      if (row.from !== null) {
        movedFrom.set(row.from, (movedFrom.get(row.from) ?? 0) + 1);
      }
    }
    for (const row of changed) {
      await this.activityLog.log({
        entity_type: 'User',
        entity_id: row.id,
        action: CONTACT_AUDIT_ACTIONS.RESPONSIBLE_ASSIGNED,
        old_value: { market_responsible_id: row.from },
        new_value: { market_responsible_id: targetId },
        metadata: { bulk: true, market_count: changed.length },
        ...this.actor(requester),
      });
    }

    return successRes(
      {
        updated: changed.length,
        moved_from: [...movedFrom.entries()].map(([responsibleId, count]) => ({
          responsible_id: responsibleId,
          count,
        })),
      },
      200,
      "Market mas'ullari yangilandi",
    );
  }

  /** `PATCH /markets/:id/responsible` — bitta market. */
  async assignOne(
    marketIdInput: unknown,
    responsibleInput: unknown,
    requester: Requester,
  ) {
    this.assertAdmin(requester);
    const marketId = asId(marketIdInput);
    const market = marketId
      ? await this.users.findOne({
          where: { id: marketId, role: Roles.MARKET, isDeleted: false },
        })
      : null;
    if (!market) {
      throw rpcError('Market topilmadi', 404);
    }
    const responsible =
      responsibleInput === null
        ? null
        : await this.loadAssignableResponsible(responsibleInput);
    const targetId = responsible ? String(responsible.id) : null;
    const previous = asId(market.market_responsible_id);

    if (previous !== targetId) {
      await this.users.manager.transaction(async (manager) => {
        if (targetId) {
          await this.loadAssignableResponsible(targetId, manager, true);
        }
        await manager
          .getRepository(User)
          .update(
            { id: String(market.id) },
            { market_responsible_id: targetId },
          );
      });
      await this.activityLog.log({
        entity_type: 'User',
        entity_id: String(market.id),
        action: CONTACT_AUDIT_ACTIONS.RESPONSIBLE_ASSIGNED,
        old_value: { market_responsible_id: previous },
        new_value: { market_responsible_id: targetId },
        ...this.actor(requester),
      });
    }

    const view = await this.resolveMarketResponsibles([
      { id: market.id, market_responsible_id: targetId },
    ]);
    return successRes(
      {
        id: String(market.id),
        ...(view.get(String(market.id)) ?? {
          responsible: null,
          responsible_source: 'none' as const,
        }),
      },
      200,
      "Market mas'uli yangilandi",
    );
  }

  /**
   * Marketlar → `{ responsible, responsible_source }`. Faol biriktirilgan →
   * faol sukut → `none`. Bitta sozlama o'qish + bitta `IN` so'rovi.
   */
  async resolveMarketResponsibles(
    markets: Array<Pick<User, 'id' | 'market_responsible_id'>>,
  ): Promise<Map<string, MarketResponsibleView>> {
    const result = new Map<string, MarketResponsibleView>();
    if (!markets.length) {
      return result;
    }
    const state = await this.readSettings();
    const users = await this.usersByIds([
      state.defaultResponsibleId,
      ...markets.map((market) => market.market_responsible_id),
    ]);
    const fallback = state.defaultResponsibleId
      ? users.get(state.defaultResponsibleId)
      : undefined;
    for (const market of markets) {
      const assigned = users.get(asId(market.market_responsible_id) ?? '');
      if (isActiveResponsible(assigned)) {
        result.set(String(market.id), {
          responsible: summaryOf(assigned),
          responsible_source: 'assigned',
        });
      } else if (isActiveResponsible(fallback)) {
        result.set(String(market.id), {
          responsible: summaryOf(fallback),
          responsible_source: 'default',
        });
      } else {
        result.set(String(market.id), {
          responsible: null,
          responsible_source: 'none',
        });
      }
    }
    return result;
  }

  /**
   * B4 — mas'ul o'chirilganda yoki roli mas'ul bo'lmaydiganga o'zgarganda
   * (chaqiruvchining tranzaksiyasida): uning marketlari sukutga (NULL), sukut
   * shu xodim bo'lsa — `null`. Nofaol bo'lish bunga kirmaydi.
   */
  async releaseResponsible(
    manager: EntityManager,
    userIdInput: unknown,
    updatedBy: string | null,
  ): Promise<{ market_ids: string[]; default_cleared: boolean }> {
    const userId = asId(userIdInput);
    if (!userId) {
      return { market_ids: [], default_cleared: false };
    }
    const released = returnedRows<{ id: string }>(
      await manager.query(
        `UPDATE "identity_schema"."admins"
          SET "market_responsible_id" = NULL
        WHERE "market_responsible_id" = $1
        RETURNING "id"`,
        [userId],
      ),
    );
    const cleared = returnedRows<{ id: string }>(
      await manager.query(
        `UPDATE "identity_schema"."app_settings"
          SET "value" = 'null'::jsonb, "updated_by" = $2, "updated_at" = now()
        WHERE "key" = $3 AND "value" #>> '{}' = $1
        RETURNING "id"`,
        [userId, updatedBy, CONTACT_SETTING_KEYS.DEFAULT_MARKET_RESPONSIBLE],
      ),
    );
    return {
      market_ids: released.map((row) => String(row.id)),
      default_cleared: cleared.length > 0,
    };
  }

  /** `releaseResponsible` natijasini jurnalga yozadi (tranzaksiyadan keyin). */
  async logRelease(
    userId: string,
    release: { market_ids: string[]; default_cleared: boolean },
    reason: 'responsible_deleted' | 'responsible_role_changed',
    requester: Requester,
  ): Promise<void> {
    if (release.market_ids.length) {
      await this.activityLog.log({
        entity_type: 'User',
        entity_id: userId,
        action: CONTACT_AUDIT_ACTIONS.RESPONSIBLE_ASSIGNED,
        old_value: { market_responsible_id: userId },
        new_value: { market_responsible_id: null },
        metadata: {
          reason,
          market_ids: release.market_ids.slice(0, 500),
          market_count: release.market_ids.length,
        },
        ...this.actor(requester),
      });
    }
    if (release.default_cleared) {
      await this.activityLog.log({
        entity_type: 'Settings',
        entity_id: 'contacts',
        action: CONTACT_AUDIT_ACTIONS.SETTINGS_UPDATED,
        old_value: { default_market_responsible_id: userId },
        new_value: { default_market_responsible_id: null },
        metadata: { reason },
        ...this.actor(requester),
      });
    }
  }

  // ==================== Aloqa rezolverlari ====================

  private supportContacts(state: ContactSettingsState): ProblemContact[] {
    return state.supportPhones.map((phone) => ({
      name: null,
      phone,
      source: 'support' as const,
    }));
  }

  /** logistics: viloyatlar (`id`, `name`, `logist_id`). Xato — bo'sh. */
  private async regionsByIds(
    ids: string[],
  ): Promise<
    Map<string, { id: string; name: string; logist_id: string | null }>
  > {
    if (!ids.length) {
      return new Map();
    }
    const response = await rmqSend<{ data?: unknown }>(
      this.logisticsClient,
      { cmd: 'logistics.region.find_by_ids' },
      { ids },
      { timeoutMs: LOOKUP_TIMEOUT_MS, retries: 1 },
    );
    const rows = Array.isArray(response?.data) ? response.data : [];
    return new Map(
      rows
        .map((row: { id?: unknown; name?: unknown; logist_id?: unknown }) => ({
          id: asId(row?.id),
          name: typeof row?.name === 'string' ? row.name : '',
          logist_id: asId(row?.logist_id),
        }))
        .filter(
          (
            row,
          ): row is { id: string; name: string; logist_id: string | null } =>
            row.id !== null,
        )
        .map((row) => [row.id, row] as const),
    );
  }

  /** logistics: tuman → viloyat (`assigned_region` ustun, aks holda `region_id`). */
  private async districtRegions(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) {
      return new Map();
    }
    const response = await rmqSend<{ data?: unknown }>(
      this.logisticsClient,
      { cmd: 'logistics.district.find_by_ids' },
      { ids },
      { timeoutMs: LOOKUP_TIMEOUT_MS, retries: 1 },
    );
    const rows = Array.isArray(response?.data) ? response.data : [];
    const result = new Map<string, string>();
    for (const row of rows as Array<{
      id?: unknown;
      region_id?: unknown;
      assigned_region?: unknown;
    }>) {
      const id = asId(row?.id);
      const regionId = asId(row?.assigned_region) ?? asId(row?.region_id);
      if (id && regionId) {
        result.set(id, regionId);
      }
    }
    return result;
  }

  /**
   * `problem_contacts` partiyasi: viloyat (yoki tuman → viloyat) → faol logist
   * (`source: 'logist'`), aks holda zaxira raqamlar (`source: 'support'`);
   * takrorsiz, ≤ 2. Bitta sozlama o'qish, ≤ 2 logistics RPC, bitta `IN` so'rovi.
   */
  async problemContacts(input: ProblemContactsInput) {
    const regionIds = cleanIds(input?.region_ids);
    const districtIds = cleanIds(input?.district_ids);
    const state = await this.readSettings();
    const fallback = dedupeProblemContacts(this.supportContacts(state));

    const districtRegion = await this.districtRegions(districtIds);
    const allRegionIds = [
      ...new Set([...regionIds, ...districtRegion.values()]),
    ];
    const regions = await this.regionsByIds(allRegionIds);
    const logists = await this.usersByIds(
      [...regions.values()].map((region) => region.logist_id),
    );

    const contactsForRegion = (regionId: string | undefined) => {
      const logistId = regionId ? regions.get(regionId)?.logist_id : null;
      const logist = logistId ? logists.get(logistId) : undefined;
      return isActiveLogist(logist)
        ? dedupeProblemContacts([
            { name: logist.name, phone: logist.phone_number, source: 'logist' },
          ])
        : fallback;
    };

    const result: ProblemContactsResult = {
      regions: {},
      districts: {},
      fallback,
    };
    for (const regionId of regionIds) {
      result.regions[regionId] = contactsForRegion(regionId);
    }
    for (const districtId of districtIds) {
      result.districts[districtId] = contactsForRegion(
        districtRegion.get(districtId),
      );
    }
    return successRes(result);
  }

  /** Filial xodimining filiali viloyati (branch-service). Xato/yo'q — null. */
  private async branchRegionOf(userId: string): Promise<string | null> {
    try {
      const response = await rmqSend<{
        data?: { branch?: { region_id?: unknown } | null } | null;
      }>(
        this.branchClient,
        { cmd: 'branch.user.find_by_user' },
        {
          user_id: userId,
          requester: { id: userId, roles: [Roles.SUPERADMIN] },
        },
        { timeoutMs: LOOKUP_TIMEOUT_MS, retries: 1, attachRequestId: false },
      );
      return asId(response?.data?.branch?.region_id);
    } catch (error) {
      this.logger.warn(
        `myContacts: branch.user.find_by_user failed for ${userId}: ${(error as Error)?.message ?? error}`,
      );
      return null;
    }
  }

  private supportOnly(
    kind: MyContacts['kind'],
    state: ContactSettingsState,
    regions: MyContacts['regions'],
  ): MyContacts {
    const contacts = state.supportPhones.map((phone) => ({
      user_id: null,
      name: null,
      phone,
      role: null,
    }));
    return {
      kind,
      source: contacts.length ? 'support' : null,
      regions,
      contacts,
    };
  }

  /**
   * `GET /users/me/contacts` (har rol). Market / market operatori — o'z
   * mas'uli; kuryer — viloyati logisti (super kuryer — `courier_regions`
   * logistlari, ≤ 5; `serves_all_regions` — zaxira); menejer / branch —
   * filial viloyati logisti. Logist yo'q/nofaol — zaxira raqamlar, ular ham
   * bo'sh — `contacts: []`. Boshqa rollar — `kind: 'none'`.
   */
  async myContacts(userIdInput: unknown) {
    const userId = asId(userIdInput);
    const user = userId
      ? await this.users.findOne({ where: { id: userId, isDeleted: false } })
      : null;
    if (!user) {
      throw rpcError('User topilmadi', 404);
    }
    const none: MyContacts = {
      kind: 'none',
      source: null,
      regions: [],
      contacts: [],
    };

    if (user.role === Roles.MARKET || user.role === Roles.MARKET_OPERATOR) {
      const marketId =
        user.role === Roles.MARKET ? String(user.id) : asId(user.market_id);
      const market = marketId
        ? user.role === Roles.MARKET
          ? user
          : await this.users.findOne({
              where: { id: marketId, role: Roles.MARKET, isDeleted: false },
            })
        : null;
      const view = market
        ? (await this.resolveMarketResponsibles([market])).get(
            String(market.id),
          )
        : undefined;
      if (view?.responsible) {
        return successRes({
          kind: 'market_responsible',
          source:
            view.responsible_source === 'assigned' ? 'assigned' : 'default',
          regions: [],
          contacts: [
            {
              user_id: view.responsible.id,
              name: view.responsible.name,
              phone: view.responsible.phone_number,
              role: view.responsible.role,
            },
          ],
        } satisfies MyContacts);
      }
      return successRes(
        this.supportOnly('market_responsible', await this.readSettings(), []),
      );
    }

    let regionIds: string[] | null = null;
    if (user.role === Roles.COURIER) {
      if (user.is_super_courier && user.serves_all_regions) {
        regionIds = [];
      } else if (user.is_super_courier) {
        const rows = await this.courierRegions.find({
          where: { courier_id: String(user.id) },
          order: { id: 'ASC' },
        });
        regionIds = cleanIds([
          ...rows.map((row) => row.region_id),
          ...(rows.length ? [] : [user.region_id]),
        ]);
      } else {
        regionIds = cleanIds([user.region_id]);
      }
    } else if (user.role === Roles.MANAGER || user.role === Roles.BRANCH) {
      const regionId = await this.branchRegionOf(String(user.id));
      regionIds = regionId ? [regionId] : [];
    }
    if (regionIds === null) {
      return successRes(none);
    }

    const state = await this.readSettings();
    let regions = new Map<
      string,
      { id: string; name: string; logist_id: string | null }
    >();
    try {
      regions = await this.regionsByIds(regionIds);
    } catch (error) {
      this.logger.warn(
        `myContacts: logistics.region.find_by_ids failed: ${(error as Error)?.message ?? error}`,
      );
    }
    const regionList = regionIds
      .map((id) => regions.get(id))
      .filter((region) => Boolean(region))
      .map((region) => ({ id: region!.id, name: region!.name }));
    const logists = await this.usersByIds(
      regionIds.map((id) => regions.get(id)?.logist_id),
    );
    const seen = new Set<string>();
    const contacts: MyContacts['contacts'] = [];
    for (const id of regionIds) {
      const logist = logists.get(regions.get(id)?.logist_id ?? '');
      if (!isActiveLogist(logist) || seen.has(String(logist.id))) {
        continue;
      }
      seen.add(String(logist.id));
      contacts.push({
        user_id: String(logist.id),
        name: logist.name,
        phone: logist.phone_number,
        role: logist.role,
      });
    }
    if (!contacts.length) {
      return successRes(this.supportOnly('region_logist', state, regionList));
    }
    return successRes({
      kind: 'region_logist',
      source: 'assigned',
      regions: regionList,
      contacts: contacts.slice(0, MY_CONTACTS_LOGISTS_MAX),
    } satisfies MyContacts);
  }
}
