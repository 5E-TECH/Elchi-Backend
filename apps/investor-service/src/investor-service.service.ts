import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, ILike, In, Repository } from 'typeorm';
import {
  ActivityAction,
  ActivityLogQuery,
  ActivityLogService,
  Cashbox_type,
  DEFAULT_PROFIT_BASIS,
  FinancialSource_type,
  INVESTOR_PROFIT_DEDUP_PREFIX,
  Roles,
  Status,
  TASHKENT_OFFSET_MINUTES,
  isDayKey,
  isProfitBasis,
  normalizePersonName,
  rmqSend,
  type ProfitBasis,
} from '@app/common';
import { Investor } from './entities/investor.entity';
import { Investment } from './entities/investment.entity';
import { ProfitShare } from './entities/profit-share.entity';
import { InvestorShareTerm } from './entities/investor-share-term.entity';
import {
  allocatePaid,
  computeAccrual,
  planShareTermChange,
  planStartChange,
  type Accrual,
  type DailyPnlLike,
  type TermPlan,
  type TermRow,
} from './investor-accrual';
import { errorRes, successRes } from '../../../libs/common/helpers/response';
import { CreateInvestorDto } from './dto/create-investor.dto';
import { UpdateInvestorDto } from './dto/update-investor.dto';
import { CreateInvestmentDto } from './dto/create-investment.dto';
import { UpdateInvestmentDto } from './dto/update-investment.dto';
import { CreateProfitShareDto } from './dto/create-profit-share.dto';
import { CalculateProfitDto } from './dto/calculate-profit.dto';

type InvestorQuery = {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
};

type InvestmentQuery = {
  investor_id?: string;
  from_date?: string;
  to_date?: string;
  page?: number;
  limit?: number;
};

type ProfitQuery = {
  investor_id?: string;
  is_paid?: boolean;
  page?: number;
  limit?: number;
};

/** Gateway'dan keladigan so'rovchi (JWT: id = sub). */
type Requester = { id?: string; roles?: string[] } | null | undefined;

/**
 * vpKijXce: investorning o'zi ko'radigan maydonlar — OQ RO'YXAT.
 * `user_id`, `description` (admin ichki izohi), `isDeleted`, `updatedAt`
 * ATAYLAB yo'q: entity'ga yangi ustun qo'shilsa ham u investorga avtomatik
 * chiqib ketmaydi.
 */
export type SelfInvestorProfile = {
  id: string;
  name: string;
  phone_number: string;
  status: Status;
  /** «Ulush (%)» — kiritilmagan bo'lsa `null`. */
  share_percent: number | null;
  /** Joriy foyda asosi: 'net' — sof foydadan, 'gross' — daromaddan. */
  profit_basis: ProfitBasis;
  created_at: Date;
};

/** Ulush sharti versiyasi (investor o'zi ham ko'radi — o'z kelishuvi). */
export type SelfShareTerm = {
  share_percent: number;
  profit_basis: ProfitBasis;
  /** `YYYY-MM-DD`, inklyuziv. */
  effective_from: string;
  /** `YYYY-MM-DD`, eksklyuziv; `null` — hozir amal qilmoqda. */
  effective_to: string | null;
};

export type SelfInvestment = {
  id: string;
  amount: number;
  invested_at: Date;
  branch_id: string | null;
  created_at: Date;
};

export type SelfProfitShare = {
  id: string;
  amount: number;
  percentage: number;
  period_start: Date;
  period_end: Date;
  is_paid: boolean;
  paid_at: Date | null;
  created_at: Date;
};

export type InvestorSummary = {
  total_invested: number;
  investments_count: number;
  first_invested_at: Date | null;
  last_invested_at: Date | null;
  /** Investorga haqiqatan to'langan (to'langan `profit_shares`). */
  total_paid_profit: number;
  /**
   * «Kutilayotgan foyda» = hisoblangan ulush − to'langan (2026-11-28 dan;
   * ilgari to'lanmagan `profit_shares` yig'indisi edi). Manfiy — ortiqcha
   * to'langan.
   */
  total_unpaid_profit: number;
  /** = `accrued_profit` (eski maydon nomi). */
  total_profit: number;
  /** Shart boshlanganidan bugungacha hisoblangan ulush (kunlik, P&L daftaridan). */
  accrued_profit: number;
  /** Shu davrdagi asos yig'indisi (sof foyda yoki daromad, investor ulushi olinadigan qism emas — butuni). */
  accrued_basis: number;
  /** Hisob qaysi ish kunigacha (`YYYY-MM-DD`); shart yo'q bo'lsa `null`. */
  accrued_through: string | null;
  /** Investorlik sanasi — birinchi ulush sharti boshi; shart yo'q — `null`. */
  share_started_at: string | null;
  profit_basis: ProfitBasis;
  /** Yozilgan, lekin hali to'lanmagan to'lov qatorlari (`profit_shares`). */
  pending_payout_amount: number;
  profit_shares_count: number;
  current_percentage: number | null;
  last_paid_at: Date | null;
};

export type MonthlyProfitPoint = {
  month: string;
  /** Shu oyda hisoblangan ulush. */
  accrued_amount: number;
  /** Investor shart amal qilgan kunlardagi asos (sof foyda / daromad). */
  basis_amount: number;
  /** Shu oyning ulushidan to'langan qismi (to'lovlar eski oydan boshlab taqsimlanadi). */
  paid_amount: number;
  /** Shu oyning ulushidan hali to'lanmagan qismi. */
  unpaid_amount: number;
  /** = `accrued_amount` (eski maydon nomi). */
  total_amount: number;
  /** Oyda amal qilgan oxirgi ulush foizi; hisob bo'lmagan oy — `null`. */
  share_percent: number | null;
  profit_basis: ProfitBasis | null;
};

/** vpKijXce: oylik foyda grafigi oynasi (oy). */
const MONTHLY_DEFAULT = 12;
const MONTHLY_MAX = 36;
const TASHKENT_OFFSET_MS = TASHKENT_OFFSET_MINUTES * 60 * 1000;
/** To'liq ISO vaqt (`2026-11-01T00:00:00Z`, `…+05:00`). */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** users.id — bigint; '0' = "login bilan bog'lanmagan" investor. */
const LINKED_USER_ID_RE = /^[1-9]\d{0,18}$/;

/** Pul yig'indisi: tiyinlarda butun son bilan — float driftisiz. */
function toCents(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function fromCents(cents: number): number {
  return cents / 100;
}

function toDateOrNull(value: unknown): Date | null {
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'string' && value !== '') {
    date = new Date(value);
  } else {
    return null;
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

@Injectable()
export class InvestorServiceService {
  constructor(
    @InjectRepository(Investor)
    private readonly investorRepo: Repository<Investor>,
    @InjectRepository(Investment)
    private readonly investmentRepo: Repository<Investment>,
    @InjectRepository(ProfitShare)
    private readonly profitShareRepo: Repository<ProfitShare>,
    private readonly activityLog: ActivityLogService,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @InjectRepository(InvestorShareTerm)
    private readonly termRepo: Repository<InvestorShareTerm>,
  ) {}

  private auditActor(requester?: { id?: string; roles?: string[] } | null): {
    user_id: string | null;
    user_role: string | null;
  } {
    const roles = requester?.roles ?? [];
    return {
      user_id: requester?.id ? String(requester.id) : null,
      user_role: roles.length ? roles.join(',') : null,
    };
  }

  async auditLogQuery(q: ActivityLogQuery) {
    return this.activityLog.query(q ?? {});
  }

  async auditLogByEntity(
    entity_type: string,
    entity_id: string,
    limit?: number,
  ) {
    return this.activityLog.findByEntity(entity_type, entity_id, limit ?? 50);
  }

  private badRequest(message: string): never {
    throw new RpcException(errorRes(message, 400));
  }

  private notFound(message: string): never {
    throw new RpcException(errorRes(message, 404));
  }

  private forbidden(message: string): never {
    throw new RpcException(errorRes(message, 403));
  }

  private conflict(message: string): never {
    throw new RpcException(errorRes(message, 409));
  }

  /**
   * «Ulush (%)»: `undefined` — tegilmaydi; `null` / '' — tozalanadi; aks holda
   * 0..100, ko'pi bilan 2 kasr (numeric(5,2)). RMQ'da ValidationPipe yo'q.
   */
  private normalizeSharePercent(raw: unknown): number | null | undefined {
    if (raw === undefined) return undefined;
    if (raw === null || raw === '') return null;
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      this.badRequest("Ulush 0 dan 100 gacha bo'lishi kerak");
    }
    if (Math.round(value * 100) / 100 !== value) {
      this.badRequest("Ulush ko'pi bilan 2 kasr xonali bo'lishi kerak");
    }
    return value;
  }

  /** Foyda asosi: bo'sh — `undefined` (tegilmaydi); aks holda 'net' | 'gross'. */
  private normalizeProfitBasis(raw: unknown): ProfitBasis | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
    if (!isProfitBasis(value)) {
      this.badRequest(
        "profit_basis 'net' (sof foyda) yoki 'gross' (daromad) bo'lishi kerak",
      );
    }
    return value;
  }

  /** Bugungi Toshkent sanasi (`YYYY-MM-DD`). */
  private todayDay(now: Date = new Date()): string {
    return new Date(now.getTime() + TASHKENT_OFFSET_MS)
      .toISOString()
      .slice(0, 10);
  }

  /**
   * Ulush sanasi: `YYYY-MM-DD` yoki to'liq ISO (→ Toshkent kuni). Bo'sh —
   * `undefined`. Kelajak sanasi — 400 (ulush hali boshlanmagan kunni
   * «joriy shart» qilib qo'ymaslik uchun).
   */
  private normalizeShareDay(raw: unknown, field: string): string | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    let day: string | null = null;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (isDayKey(text)) {
      day = text;
    } else if (raw instanceof Date || ISO_DATETIME_RE.test(text)) {
      // Faqat aniq ISO vaqt — `new Date('01.11.2026')` kabi taxminiy
      // o'qishlar (oy/kun almashadi) qabul qilinmaydi.
      const date = toDateOrNull(raw);
      if (date) day = this.todayDay(date);
    }
    if (!day) {
      this.badRequest(`${field} noto'g'ri sana`);
    }
    if (day > this.todayDay()) {
      this.badRequest(`${field} kelajakdagi sana bo'lmasligi kerak`);
    }
    return day;
  }

  /** O'chirilmagan ulush shartlari, `effective_from` bo'yicha o'sib boruvchi. */
  private activeTerms(
    investorId: string,
    repo: Repository<InvestorShareTerm> = this.termRepo,
  ): Promise<InvestorShareTerm[]> {
    return repo.find({
      where: { investor_id: String(investorId), isDeleted: false },
      order: { effective_from: 'ASC' },
    });
  }

  private toTermRow(term: InvestorShareTerm): TermRow {
    return {
      id: String(term.id),
      share_percent: Number(term.share_percent),
      profit_basis: isProfitBasis(term.profit_basis)
        ? term.profit_basis
        : DEFAULT_PROFIT_BASIS,
      effective_from: String(term.effective_from),
      effective_to: term.effective_to ? String(term.effective_to) : null,
    };
  }

  private toSelfTerm(term: InvestorShareTerm): SelfShareTerm {
    const row = this.toTermRow(term);
    return {
      share_percent: row.share_percent,
      profit_basis: row.profit_basis,
      effective_from: row.effective_from,
      effective_to: row.effective_to,
    };
  }

  /**
   * Ulush sharti rejasini bitta tranzaksiyada qo'llaydi va investordagi
   * joriy nusxani (`share_percent`, `profit_basis`) ochiq shartdan yangilaydi.
   * Xato rejasi — 400, hech narsa yozilmaydi.
   */
  private async applyTermPlan(
    investor: Investor,
    plan: (terms: TermRow[]) => TermPlan,
    requester?: Requester,
    note?: string | null,
  ): Promise<{ changed: boolean; terms: InvestorShareTerm[] }> {
    const actorId = this.normalizeLinkedUserId(requester?.id);
    const result = await this.termRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(InvestorShareTerm);
      const before = await this.activeTerms(investor.id, repo);
      const decision = plan(before.map((term) => this.toTermRow(term)));
      if (decision.kind === 'error') {
        this.badRequest(decision.message);
      }
      if (decision.kind === 'noop') {
        return { changed: false, before, terms: before };
      }
      // Yopish/surish — yangi ochiq shartdan OLDIN (ochiq shart unikal).
      for (const update of decision.updates) {
        await repo.update({ id: update.id }, update.patch);
      }
      if (decision.insert) {
        await repo.save(
          repo.create({
            investor_id: String(investor.id),
            ...decision.insert,
            effective_to: null,
            note: note ?? null,
            created_by: actorId,
          }),
        );
      }
      const terms = await this.activeTerms(investor.id, repo);
      const open = terms.find((term) => !term.effective_to);
      if (open) {
        investor.share_percent = Number(open.share_percent);
        investor.profit_basis = this.toTermRow(open).profit_basis;
        await manager.getRepository(Investor).save(investor);
      }
      return { changed: true, before, terms };
    });

    if (result.changed) {
      await this.activityLog.log({
        entity_type: 'Investor',
        entity_id: String(investor.id),
        action: ActivityAction.UPDATED,
        old_value: {
          share_terms: result.before.map((term) => this.toSelfTerm(term)),
        },
        new_value: {
          share_terms: result.terms.map((term) => this.toSelfTerm(term)),
        },
        metadata: { kind: 'share_terms' },
        ...this.auditActor(requester),
      });
    }
    return { changed: result.changed, terms: result.terms };
  }

  /**
   * «Ulush (%)» tozalandi (`null`): ochiq shart bugun yopiladi (bugun
   * boshlangan bo'lsa — o'chiriladi). O'tgan kunlar hisobi qoladi.
   */
  private async closeOpenTerm(investor: Investor, requester?: Requester) {
    const today = this.todayDay();
    const terms = await this.activeTerms(investor.id);
    const open = terms.find((term) => !term.effective_to);
    if (!open) return;
    if (String(open.effective_from) < today) {
      await this.termRepo.update({ id: open.id }, { effective_to: today });
    } else {
      await this.termRepo.update({ id: open.id }, { isDeleted: true });
    }
    await this.activityLog.log({
      entity_type: 'Investor',
      entity_id: String(investor.id),
      action: ActivityAction.UPDATED,
      old_value: { share_terms: terms.map((term) => this.toSelfTerm(term)) },
      new_value: { share_terms_closed_at: today },
      metadata: { kind: 'share_terms' },
      ...this.auditActor(requester),
    });
  }

  /**
   * PATCH / attach'dagi `share_percent` / `profit_basis` → shart versiyasi.
   * `share_percent`: `undefined` — tegilmaydi; `null` — joriy shart yopiladi;
   * son — `effective_from` dan (sukut bugun) yangi shart. Faqat asos berilsa —
   * joriy foiz bilan yangi versiya. O'zgarish bo'ldimi — qaytadi.
   */
  private async applyShareFields(
    investor: Investor,
    fields: {
      share_percent?: number | null;
      profit_basis?: ProfitBasis;
      effective_from?: string;
    },
    requester?: Requester,
  ): Promise<boolean> {
    if (
      fields.share_percent === undefined &&
      fields.profit_basis === undefined
    ) {
      return false;
    }
    if (fields.share_percent === null) {
      const had = investor.share_percent !== null;
      await this.closeOpenTerm(investor, requester);
      investor.share_percent = null;
      if (fields.profit_basis) investor.profit_basis = fields.profit_basis;
      await this.investorRepo.save(investor);
      return had;
    }
    const currentBasis = isProfitBasis(investor.profit_basis)
      ? investor.profit_basis
      : DEFAULT_PROFIT_BASIS;
    const { changed } = await this.applyTermPlan(
      investor,
      (rows) => {
        const open = rows.find((row) => row.effective_to === null);
        const share =
          fields.share_percent ?? open?.share_percent ?? investor.share_percent;
        if (share === null || share === undefined) return { kind: 'noop' };
        return planShareTermChange(rows, {
          share_percent: Number(share),
          profit_basis:
            fields.profit_basis ?? open?.profit_basis ?? currentBasis,
          effective_from: fields.effective_from ?? this.todayDay(),
        });
      },
      requester,
    );
    // Ulushsiz investor: faqat asos nusxasi (shart yo'q — hisob ham yo'q).
    if (
      !changed &&
      fields.profit_basis &&
      investor.share_percent === null &&
      investor.profit_basis !== fields.profit_basis
    ) {
      investor.profit_basis = fields.profit_basis;
      await this.investorRepo.save(investor);
      return true;
    }
    return changed;
  }

  /**
   * PUT /investors/:id/share-terms — «shu sanadan boshlab ulush X%, asos Y».
   * Sana joriy shart boshidan keyin bo'lsa — yangi versiya (o'tgan kunlar
   * eski shart bilan qoladi); teng yoki oldin bo'lsa — joriy shart tuzatiladi.
   * Qoidalar: `planShareTermChange`.
   */
  async setShareTerms(
    investorId: string,
    dto: {
      share_percent?: unknown;
      profit_basis?: unknown;
      effective_from?: unknown;
      note?: unknown;
    },
    requester?: Requester,
  ) {
    const investor = await this.getInvestorOrThrow(investorId);
    const share = this.normalizeSharePercent(dto?.share_percent);
    if (share === undefined || share === null) {
      this.badRequest('share_percent majburiy (0..100)');
    }
    const basis =
      this.normalizeProfitBasis(dto?.profit_basis) ??
      (isProfitBasis(investor.profit_basis)
        ? investor.profit_basis
        : DEFAULT_PROFIT_BASIS);
    const from =
      this.normalizeShareDay(dto?.effective_from, 'effective_from') ??
      this.todayDay();
    const note =
      typeof dto?.note === 'string' && dto.note.trim() ? dto.note.trim() : null;

    const { changed, terms } = await this.applyTermPlan(
      investor,
      (rows) =>
        planShareTermChange(rows, {
          share_percent: share,
          profit_basis: basis,
          effective_from: from,
        }),
      requester,
      note,
    );
    return successRes(
      {
        investor,
        share_terms: terms.map((term) => this.toSelfTerm(term)),
      },
      200,
      changed ? 'share terms updated' : 'share terms unchanged',
    );
  }

  /**
   * vpKijXce: investor yozuvini login (users.id) bilan bog'lash qiymati.
   * Faqat musbat butun son; '0' / bo'sh / boshqa narsa → null.
   */
  private normalizeLinkedUserId(raw: unknown): string | null {
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      return null;
    }
    const value = String(raw).trim();
    return LINKED_USER_ID_RE.test(value) ? value : null;
  }

  /**
   * vpKijXce: bitta login — bitta investor. Aks holda `/investors/me` qaysi
   * yozuvni ko'rsatishni bilmaydi (u yerda fail-closed 409 qaytadi).
   */
  private async assertUserIdFree(
    userId: string,
    exceptInvestorId?: string,
  ): Promise<void> {
    const rows = await this.investorRepo.find({
      where: { user_id: userId, isDeleted: false },
      take: 2,
    });
    const taken = rows.some(
      (row) => String(row.id) !== String(exceptInvestorId ?? ''),
    );
    if (taken) {
      this.badRequest("user_id allaqachon boshqa investorga bog'langan");
    }
  }

  private normalizePagination(page?: number, limit?: number) {
    const safePage = Number(page) > 0 ? Number(page) : 1;
    const safeLimit = Number(limit) > 0 ? Math.min(Number(limit), 100) : 10;
    return {
      page: safePage,
      limit: safeLimit,
      skip: (safePage - 1) * safeLimit,
    };
  }

  private parseDate(
    value: string | undefined,
    fieldName: string,
  ): Date | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      this.badRequest(`${fieldName} noto'g'ri`);
    }
    return parsed;
  }

  private validateUzPhoneNumber(phone: string): void {
    const normalized = String(phone).trim();
    if (!/^\+998\d{9}$/.test(normalized)) {
      this.badRequest("phone_number '+998XXXXXXXXX' formatida bo'lishi kerak");
    }
  }

  private async getInvestorOrThrow(id: string): Promise<Investor> {
    const investor = await this.investorRepo.findOne({
      where: { id: String(id), isDeleted: false },
    });
    if (!investor) {
      this.notFound('Investor topilmadi');
    }
    return investor;
  }

  private async getInvestmentOrThrow(id: string): Promise<Investment> {
    const investment = await this.investmentRepo.findOne({
      where: { id: String(id), isDeleted: false },
    });
    if (!investment) {
      this.notFound('Investitsiya topilmadi');
    }
    return investment;
  }

  async createInvestor(
    dto: CreateInvestorDto,
    requester?: { id?: string; roles?: string[] } | null,
  ) {
    // 2026-11-04: investor — shaxs (forma «Investor ismi», «Ism va
    // familiya»): har so'z bosh harfi katta.
    const name = normalizePersonName(String(dto.name ?? ''));
    const phoneNumber = String(dto.phone_number ?? '').trim();
    if (!name) {
      this.badRequest('Nomi majburiy');
    }
    if (!phoneNumber) {
      this.badRequest('phone_number majburiy');
    }
    this.validateUzPhoneNumber(phoneNumber);

    const exists = await this.investorRepo.findOne({
      where: { phone_number: phoneNumber, isDeleted: false },
    });
    if (exists) {
      this.badRequest('Bu telefon raqami allaqachon mavjud');
    }

    // vpKijXce: login bilan bog'lash — `/investors/me` investorni shu orqali
    // topadi. Ilgari istalgan satr tekshiruvsiz yozilardi.
    let linkedUserId = '0';
    if (
      dto.user_id !== undefined &&
      dto.user_id !== null &&
      String(dto.user_id).trim() !== ''
    ) {
      const normalized = this.normalizeLinkedUserId(dto.user_id);
      if (!normalized) {
        this.badRequest("user_id musbat butun son bo'lishi kerak");
      }
      await this.assertUserIdFree(normalized);
      linkedUserId = normalized;
    }

    const sharePercent = this.normalizeSharePercent(dto.share_percent) ?? null;
    const profitBasis =
      this.normalizeProfitBasis(dto.profit_basis) ?? DEFAULT_PROFIT_BASIS;
    // «Investorlik sanasi» — ulush shu kundan hisoblanadi (bo'sh — bugun).
    const shareStartedAt = this.normalizeShareDay(
      dto.share_started_at,
      'share_started_at',
    );

    const investor = this.investorRepo.create({
      user_id: linkedUserId,
      name,
      phone_number: phoneNumber,
      status: (dto.status as Status) ?? Status.ACTIVE,
      description: dto.description ? String(dto.description).trim() : null,
      share_percent: sharePercent,
      profit_basis: profitBasis,
    });

    const saved = await this.investorRepo.save(investor);

    if (sharePercent !== null) {
      await this.termRepo.save(
        this.termRepo.create({
          investor_id: String(saved.id),
          share_percent: sharePercent,
          profit_basis: profitBasis,
          effective_from: shareStartedAt ?? this.todayDay(),
          effective_to: null,
          note: null,
          created_by: this.normalizeLinkedUserId(requester?.id),
        }),
      );
    }

    await this.activityLog.log({
      entity_type: 'Investor',
      entity_id: String(saved.id),
      action: ActivityAction.CREATED,
      new_value: saved,
      metadata: { user_id: saved.user_id },
      ...this.auditActor(requester),
    });

    return successRes(saved, 201, 'investor created');
  }

  /**
   * «Foydalanuvchi qo'shish» → Investor (BeePost `POST /users/investor`
   * naqshi): gateway investor LOGINI yaratgach, shu telefondagi investor
   * yozuvini topib loginga bog'laydi, yozuv yo'q bo'lsa — yaratadi. Shunda
   * investor «Investorlar» ro'yxatida chiqadi va `/investors/me` ishlaydi.
   *
   * `dry_run` — login yaratilishidan OLDINGI tekshiruv (keyin SMS ketgan
   * loginni o'chirishga to'g'ri kelmasin): telefon boshqa loginga bog'langan
   * yozuvda bo'lsa — 409, aks holda bog'lanadigan yozuv id'si (yoki null).
   */
  async attachLogin(
    dto: {
      user_id?: unknown;
      name?: unknown;
      phone_number?: unknown;
      share_percent?: unknown;
      profit_basis?: unknown;
      share_started_at?: unknown;
      dry_run?: boolean;
    },
    requester?: Requester,
  ) {
    const phoneNumber =
      typeof dto?.phone_number === 'string' ? dto.phone_number.trim() : '';
    this.validateUzPhoneNumber(phoneNumber);
    // dry_run da ham — noto'g'ri ulush/asos/sana login yaratilishidan OLDIN 400.
    const sharePercent = this.normalizeSharePercent(dto?.share_percent);
    const profitBasis = this.normalizeProfitBasis(dto?.profit_basis);
    const shareStartedAt = this.normalizeShareDay(
      dto?.share_started_at,
      'share_started_at',
    );

    const existing = await this.investorRepo.findOne({
      where: { phone_number: phoneNumber, isDeleted: false },
    });
    const userId = this.normalizeLinkedUserId(dto?.user_id);
    const linkedTo = existing ? String(existing.user_id) : '0';
    if (existing && linkedTo !== '0' && linkedTo !== userId) {
      this.conflict(
        "Bu telefon raqamli investor allaqachon boshqa loginga bog'langan",
      );
    }

    if (dto?.dry_run) {
      return successRes({ investor_id: existing ? String(existing.id) : null });
    }

    if (!userId) {
      this.badRequest("user_id musbat butun son bo'lishi kerak");
    }
    await this.assertUserIdFree(userId, existing?.id);

    if (existing) {
      let saved = existing;
      if (linkedTo !== userId) {
        const before = { ...existing };
        existing.user_id = userId;
        saved = await this.investorRepo.save(existing);
        await this.activityLog.logChange({
          entity_type: 'Investor',
          entity_id: String(saved.id),
          old_value: before,
          new_value: saved as unknown as Record<string, unknown>,
          action: ActivityAction.UPDATED,
          ...this.auditActor(requester),
        });
      }
      // Ulush / asos — versiyalangan shart orqali (o'tgan kunlar qayta
      // yozilmaydi); `null` ulush — joriy shart yopiladi.
      const termsChanged = await this.applyShareFields(
        saved,
        {
          share_percent: sharePercent,
          profit_basis: profitBasis,
          effective_from: shareStartedAt,
        },
        requester,
      );
      if (linkedTo === userId && !termsChanged) {
        return successRes(saved, 200, 'investor already linked');
      }
      return successRes(saved, 200, 'investor linked');
    }

    return this.createInvestor(
      {
        name: typeof dto?.name === 'string' ? dto.name : '',
        phone_number: phoneNumber,
        user_id: userId,
        share_percent: sharePercent ?? undefined,
        profit_basis: profitBasis,
        share_started_at: shareStartedAt,
      },
      requester,
    );
  }

  async findAllInvestors(query: InvestorQuery) {
    const { search, status } = query ?? {};
    const { page, limit, skip } = this.normalizePagination(
      query?.page,
      query?.limit,
    );

    const where: any = { isDeleted: false };
    if (status) {
      const safeStatus = String(status).toLowerCase();
      if (![Status.ACTIVE, Status.INACTIVE].includes(safeStatus as Status)) {
        this.badRequest("status active yoki inactive bo'lishi kerak");
      }
      where.status = safeStatus;
    }

    if (search?.trim()) {
      const keyword = `%${search.trim()}%`;
      where.name = ILike(keyword);
    }

    const [items, total] = await this.investorRepo.findAndCount({
      where: search?.trim()
        ? [
            { ...where, name: ILike(`%${search.trim()}%`) },
            { ...where, phone_number: ILike(`%${search.trim()}%`) },
          ]
        : where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    const investorIds = items.map((item) => item.id);
    const investments = investorIds.length
      ? await this.investmentRepo.find({
          where: { investor_id: In(investorIds), isDeleted: false },
          order: { invested_at: 'DESC' },
        })
      : [];

    const investmentsMap = investments.reduce<Record<string, Investment[]>>(
      (acc, row) => {
        const key = String(row.investor_id);
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(row);
        return acc;
      },
      {},
    );

    const data = items.map((item) => ({
      ...item,
      investments: investmentsMap[item.id] ?? [],
    }));

    return successRes({
      items: data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  }

  async findInvestorById(id: string) {
    const investor = await this.getInvestorOrThrow(id);
    const [investments, profits, terms] = await Promise.all([
      this.investmentRepo.find({
        where: { investor_id: investor.id, isDeleted: false },
        order: { invested_at: 'DESC' },
      }),
      this.profitShareRepo.find({
        where: { investor_id: investor.id, isDeleted: false },
        order: { period_start: 'DESC' },
      }),
      this.activeTerms(investor.id),
    ]);

    return successRes({
      ...investor,
      investments,
      profit_shares: profits,
      share_terms: terms.map((term) => this.toSelfTerm(term)),
    });
  }

  async updateInvestor(
    id: string,
    dto: UpdateInvestorDto,
    requester?: { id?: string; roles?: string[] } | null,
  ) {
    const investor = await this.getInvestorOrThrow(id);
    const before = { ...investor };

    if (dto.name !== undefined) {
      const typed = String(dto.name).trim();
      if (!typed) {
        this.badRequest("Nomi bo'sh bo'lmasligi kerak");
      }
      // 2026-11-04: odam ismi — har so'z bosh harfi katta. O'zgarmagan ism
      // (forma hamma maydonni qayta yuboradi) tegilmaydi — eski yozuv
      // ko'chirilmaydi.
      investor.name =
        typed === investor.name ? typed : normalizePersonName(typed);
    }
    if (dto.phone_number !== undefined) {
      const phoneNumber = String(dto.phone_number ?? '').trim();
      if (!phoneNumber) {
        this.badRequest("phone_number bo'sh bo'lmasligi kerak");
      }
      this.validateUzPhoneNumber(phoneNumber);

      if (phoneNumber !== investor.phone_number) {
        const exists = await this.investorRepo.findOne({
          where: { phone_number: phoneNumber, isDeleted: false },
        });
        if (exists) {
          this.badRequest('Bu telefon raqami allaqachon mavjud');
        }
      }
      investor.phone_number = phoneNumber;
    }
    if (dto.description !== undefined) {
      investor.description = dto.description
        ? String(dto.description).trim()
        : null;
    }
    if (dto.status !== undefined) {
      if (![Status.ACTIVE, Status.INACTIVE].includes(dto.status)) {
        this.badRequest("status active yoki inactive bo'lishi kerak");
      }
      investor.status = dto.status;
    }
    // Ulush / asos / investorlik sanasi — saqlashdan OLDIN tekshiriladi
    // (noto'g'ri qiymat bo'lsa boshqa maydonlar ham yozilmaydi), qo'llash —
    // keyin, versiyalangan shart orqali.
    const sharePercent = this.normalizeSharePercent(dto.share_percent);
    const profitBasis = this.normalizeProfitBasis(dto.profit_basis);
    const shareEffectiveFrom = this.normalizeShareDay(
      dto.share_effective_from,
      'share_effective_from',
    );
    const shareStartedAt = this.normalizeShareDay(
      dto.share_started_at,
      'share_started_at',
    );
    // vpKijXce: login bilan bog'lash / uzish (null yoki '' → '0').
    if (dto.user_id !== undefined) {
      if (dto.user_id === null || String(dto.user_id).trim() === '') {
        investor.user_id = '0';
      } else {
        const normalized = this.normalizeLinkedUserId(dto.user_id);
        if (!normalized) {
          this.badRequest("user_id musbat butun son bo'lishi kerak");
        }
        if (normalized !== String(investor.user_id)) {
          await this.assertUserIdFree(normalized, investor.id);
        }
        investor.user_id = normalized;
      }
    }

    const saved = await this.investorRepo.save(investor);

    await this.activityLog.logChange({
      entity_type: 'Investor',
      entity_id: String(saved.id),
      old_value: before as unknown as Record<string, unknown>,
      new_value: saved as unknown as Record<string, unknown>,
      action: ActivityAction.UPDATED,
      ...this.auditActor(requester),
    });

    await this.applyShareFields(
      saved,
      {
        share_percent: sharePercent,
        profit_basis: profitBasis,
        effective_from: shareEffectiveFrom,
      },
      requester,
    );
    if (shareStartedAt !== undefined) {
      await this.applyTermPlan(
        saved,
        (rows) => planStartChange(rows, shareStartedAt),
        requester,
      );
    }

    return successRes(saved, 200, 'investor updated');
  }

  async deleteInvestor(
    id: string,
    requester?: { id?: string; roles?: string[] } | null,
  ) {
    const investor = await this.getInvestorOrThrow(id);
    investor.isDeleted = true;
    investor.status = Status.INACTIVE;
    await this.investorRepo.save(investor);

    await this.activityLog.log({
      entity_type: 'Investor',
      entity_id: String(investor.id),
      action: ActivityAction.DELETED,
      ...this.auditActor(requester),
    });

    return successRes({ id }, 200, 'investor deleted');
  }

  async createInvestment(
    dto: CreateInvestmentDto,
    requester?: { id?: string; roles?: string[] } | null,
  ) {
    const investor_id = String(dto.investor_id ?? '').trim();
    if (!investor_id) {
      this.badRequest('investor_id majburiy');
    }
    await this.getInvestorOrThrow(investor_id);

    const amount = Number(dto.amount ?? 0);
    if (!(amount > 0)) {
      this.badRequest("amount 0 dan katta bo'lishi kerak");
    }

    const investedAt = this.parseDate(dto.invested_at, 'invested_at');
    if (!investedAt) {
      this.badRequest('invested_at majburiy');
    }

    const investment = this.investmentRepo.create({
      investor_id,
      branch_id: dto.branch_id ? String(dto.branch_id) : null,
      amount,
      invested_at: investedAt,
      description: dto.description ? String(dto.description).trim() : null,
    });

    const saved = await this.investmentRepo.save(investment);

    await this.activityLog.log({
      entity_type: 'Investment',
      entity_id: String(saved.id),
      action: ActivityAction.CREATED,
      new_value: saved,
      metadata: {
        investor_id: saved.investor_id,
        branch_id: saved.branch_id,
        amount: saved.amount,
      },
      ...this.auditActor(requester),
    });

    return successRes(saved, 201, 'investment created');
  }

  async findAllInvestments(query: InvestmentQuery) {
    const { page, limit, skip } = this.normalizePagination(
      query?.page,
      query?.limit,
    );
    const where: any = { isDeleted: false };

    if (query?.investor_id) {
      where.investor_id = String(query.investor_id);
    }

    const fromDate = this.parseDate(query?.from_date, 'from_date');
    const toDate = this.parseDate(query?.to_date, 'to_date');
    if (fromDate && toDate && fromDate > toDate) {
      this.badRequest("from_date to_date dan katta bo'lmasligi kerak");
    }
    let range: [Date, Date] | null = null;
    if (fromDate && toDate) {
      range = [fromDate, toDate];
    } else if (fromDate) {
      range = [fromDate, new Date()];
    } else if (toDate) {
      range = [new Date(0), toDate];
    }
    if (range) {
      where.invested_at = Between(range[0], range[1]);
    }

    const [items, total] = await this.investmentRepo.findAndCount({
      where,
      order: { invested_at: 'DESC' },
      skip,
      take: limit,
    });

    // (su4IYGCN) `range_amount` — ro'yxat filtri bilan AYNAN bir xil
    // `invested_at` oralig'idagi yig'indi (sahifadan qat'i nazar); oraliq
    // berilmasa — `total_amount` ga teng. `total_amount` avvalgidek butun
    // davr uchun. Ikkalasi bitta so'rovda (shartli SUM).
    const totalAmountRaw = await this.investmentRepo
      .createQueryBuilder('investment')
      .select('COALESCE(SUM(investment.amount), 0)', 'total')
      .addSelect(
        range
          ? 'COALESCE(SUM(CASE WHEN investment.invested_at BETWEEN :range_from AND :range_to THEN investment.amount ELSE 0 END), 0)'
          : 'COALESCE(SUM(investment.amount), 0)',
        'range_total',
      )
      .where('investment.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere(
        query?.investor_id ? 'investment.investor_id = :investor_id' : '1=1',
        {
          investor_id: query?.investor_id
            ? String(query.investor_id)
            : undefined,
        },
      )
      .setParameters(range ? { range_from: range[0], range_to: range[1] } : {})
      .getRawOne<{ total: string; range_total: string }>();

    return successRes({
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      summary: {
        total_amount: Number(totalAmountRaw?.total ?? 0),
        range_amount: Number(totalAmountRaw?.range_total ?? 0),
      },
    });
  }

  async findInvestmentsByInvestor(
    investor_id: string,
    query?: Pick<InvestmentQuery, 'page' | 'limit'>,
  ) {
    await this.getInvestorOrThrow(investor_id);
    return this.findAllInvestments({
      investor_id,
      page: query?.page,
      limit: query?.limit,
    });
  }

  async findInvestmentById(id: string) {
    const investment = await this.getInvestmentOrThrow(id);
    return successRes(investment);
  }

  /**
   * vpKijXce: ichki yo'l (`/investors/:investor_id/investments/:id`) —
   * investitsiya SHU investorniki bo'lmasa 404 (begona yozuv o'zgarmaydi).
   */
  private assertInvestmentScope(
    investment: Investment,
    scopeInvestorId?: string | null,
  ): void {
    if (scopeInvestorId === undefined || scopeInvestorId === null) {
      return;
    }
    if (String(investment.investor_id) !== String(scopeInvestorId).trim()) {
      this.notFound('Bu investor uchun investitsiya topilmadi');
    }
  }

  async updateInvestment(
    id: string,
    dto: UpdateInvestmentDto,
    requester?: { id?: string; roles?: string[] } | null,
    scopeInvestorId?: string | null,
  ) {
    const investment = await this.getInvestmentOrThrow(id);
    this.assertInvestmentScope(investment, scopeInvestorId);
    const before = { ...investment };

    if (dto.investor_id !== undefined) {
      const investorId = String(dto.investor_id ?? '').trim();
      if (!investorId) {
        this.badRequest("investor_id bo'sh bo'lmasligi kerak");
      }
      await this.getInvestorOrThrow(investorId);
      investment.investor_id = investorId;
    }

    if (dto.branch_id !== undefined) {
      investment.branch_id = dto.branch_id
        ? String(dto.branch_id).trim()
        : null;
    }

    if (dto.amount !== undefined) {
      const amount = Number(dto.amount);
      if (!(amount > 0)) {
        this.badRequest("amount 0 dan katta bo'lishi kerak");
      }
      investment.amount = amount;
    }

    if (dto.invested_at !== undefined) {
      const investedAt = this.parseDate(dto.invested_at, 'invested_at');
      if (!investedAt) {
        this.badRequest('invested_at majburiy');
      }
      investment.invested_at = investedAt;
    }

    if (dto.description !== undefined) {
      investment.description = dto.description
        ? String(dto.description).trim()
        : null;
    }

    const saved = await this.investmentRepo.save(investment);

    await this.activityLog.logChange({
      entity_type: 'Investment',
      entity_id: String(saved.id),
      old_value: before as unknown as Record<string, unknown>,
      new_value: saved as unknown as Record<string, unknown>,
      action: ActivityAction.UPDATED,
      ...this.auditActor(requester),
    });

    return successRes(saved, 200, 'investment updated');
  }

  async deleteInvestment(
    id: string,
    requester?: { id?: string; roles?: string[] } | null,
    scopeInvestorId?: string | null,
  ) {
    const investment = await this.getInvestmentOrThrow(id);
    this.assertInvestmentScope(investment, scopeInvestorId);
    investment.isDeleted = true;
    await this.investmentRepo.save(investment);

    await this.activityLog.log({
      entity_type: 'Investment',
      entity_id: String(investment.id),
      action: ActivityAction.DELETED,
      metadata: { investor_id: investment.investor_id },
      ...this.auditActor(requester),
    });

    return successRes({ id: investment.id }, 200, 'investment deleted');
  }

  async createProfitShare(
    dto: CreateProfitShareDto,
    requester?: { id?: string; roles?: string[] } | null,
  ) {
    const investor_id = String(dto.investor_id ?? '').trim();
    if (!investor_id) {
      this.badRequest('investor_id majburiy');
    }
    await this.getInvestorOrThrow(investor_id);

    const amount = Number(dto.amount ?? 0);
    if (!(amount >= 0)) {
      this.badRequest("amount 0 dan kichik bo'lmasligi kerak");
    }

    const percentage = Number(dto.percentage ?? 0);
    if (percentage < 0 || percentage > 100) {
      this.badRequest("percentage 0 dan 100 gacha bo'lishi kerak");
    }

    const period_start = this.parseDate(dto.period_start, 'period_start');
    const period_end = this.parseDate(dto.period_end, 'period_end');
    if (!period_start || !period_end) {
      this.badRequest('period_start va period_end majburiy');
    }
    if (period_start > period_end) {
      this.badRequest("period_start period_end dan katta bo'lmasligi kerak");
    }

    const row = this.profitShareRepo.create({
      investor_id,
      amount,
      percentage,
      period_start,
      period_end,
      is_paid: false,
      paid_at: null,
      description: dto.description ? String(dto.description).trim() : null,
    });

    const saved = await this.profitShareRepo.save(row);

    await this.activityLog.log({
      entity_type: 'ProfitShare',
      entity_id: String(saved.id),
      action: ActivityAction.CREATED,
      new_value: saved,
      metadata: { investor_id: saved.investor_id },
      ...this.auditActor(requester),
    });

    return successRes(saved, 201, 'profit share created');
  }

  async calculateProfit(
    input: CalculateProfitDto,
    requester?: { id?: string; roles?: string[] } | null,
  ) {
    const period_start = this.parseDate(input?.period_start, 'period_start');
    const period_end = this.parseDate(input?.period_end, 'period_end');
    if (!period_start || !period_end) {
      this.badRequest('period_start va period_end majburiy');
    }
    if (period_start > period_end) {
      this.badRequest("period_start period_end dan katta bo'lmasligi kerak");
    }

    const percentage = Number(input?.percentage ?? 0);
    if (percentage < 0 || percentage > 100) {
      this.badRequest("percentage 0 dan 100 gacha bo'lishi kerak");
    }

    const investors = input?.investor_id
      ? [await this.getInvestorOrThrow(String(input.investor_id))]
      : await this.investorRepo.find({
          where: { isDeleted: false, status: Status.ACTIVE },
        });

    const investorIds = investors.map((investor) => investor.id);
    const totalsRaw = investorIds.length
      ? await this.investmentRepo
          .createQueryBuilder('investment')
          .select('investment.investor_id', 'investor_id')
          .addSelect('COALESCE(SUM(investment.amount), 0)', 'total_amount')
          .where('investment.isDeleted = :isDeleted', { isDeleted: false })
          .andWhere('investment.invested_at BETWEEN :from AND :to', {
            from: new Date(0),
            to: period_end,
          })
          .andWhere('investment.investor_id IN (:...investorIds)', {
            investorIds,
          })
          .groupBy('investment.investor_id')
          .getRawMany<{ investor_id: string; total_amount: string }>()
      : [];

    const totalsMap = new Map(
      totalsRaw.map((row) => [
        String(row.investor_id),
        Number(row.total_amount),
      ]),
    );

    const result: ProfitShare[] = [];
    let skipped_count = 0;
    for (const investor of investors) {
      // Idempotency: a profit-share for this investor + exact period already
      // exists → skip, so a double-click or re-run does not create a duplicate
      // obligation the operator could pay twice. (Audit P1-10.)
      const existing = await this.profitShareRepo.findOne({
        where: {
          investor_id: investor.id,
          period_start,
          period_end,
          isDeleted: false,
        },
      });
      if (existing) {
        skipped_count += 1;
        continue;
      }

      const totalInvestment = totalsMap.get(String(investor.id)) ?? 0;
      const amount = Number(((totalInvestment * percentage) / 100).toFixed(2));

      const row = this.profitShareRepo.create({
        investor_id: investor.id,
        amount,
        percentage,
        period_start,
        period_end,
        is_paid: false,
        paid_at: null,
        description: input?.description
          ? String(input.description).trim()
          : null,
      });
      const savedRow = await this.profitShareRepo.save(row);
      result.push(savedRow);

      await this.activityLog.log({
        entity_type: 'ProfitShare',
        entity_id: String(savedRow.id),
        action: 'investor.profit_calculated',
        new_value: savedRow,
        metadata: {
          investor_id: savedRow.investor_id,
          amount: savedRow.amount,
        },
        ...this.auditActor(requester),
      });
    }

    return successRes(
      {
        calculated_count: result.length,
        skipped_count,
        items: result,
      },
      201,
      skipped_count > 0
        ? `profit calculated (${skipped_count} ta investor uchun bu davr allaqachon hisoblangan — o'tkazib yuborildi)`
        : 'profit calculated',
    );
  }

  async findProfitByInvestor(
    investor_id: string,
    query?: Pick<ProfitQuery, 'is_paid' | 'page' | 'limit'>,
  ) {
    await this.getInvestorOrThrow(investor_id);
    return this.findAllProfits({
      investor_id,
      is_paid: query?.is_paid,
      page: query?.page,
      limit: query?.limit,
    });
  }

  async findAllProfits(query?: ProfitQuery) {
    const { page, limit, skip } = this.normalizePagination(
      query?.page,
      query?.limit,
    );
    const where: any = { isDeleted: false };
    if (query?.investor_id) {
      where.investor_id = String(query.investor_id);
    }
    if (typeof query?.is_paid !== 'undefined') {
      where.is_paid = Boolean(query.is_paid);
    }

    const [items, total] = await this.profitShareRepo.findAndCount({
      where,
      order: { period_start: 'DESC' },
      skip,
      take: limit,
    });

    const [paidRaw, unpaidRaw] = await Promise.all([
      this.profitShareRepo
        .createQueryBuilder('profit')
        .select('COALESCE(SUM(profit.amount), 0)', 'total')
        .where('profit.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere(
          query?.investor_id ? 'profit.investor_id = :investor_id' : '1=1',
          {
            investor_id: query?.investor_id
              ? String(query.investor_id)
              : undefined,
          },
        )
        .andWhere('profit.is_paid = :is_paid', { is_paid: true })
        .getRawOne<{ total: string }>(),
      this.profitShareRepo
        .createQueryBuilder('profit')
        .select('COALESCE(SUM(profit.amount), 0)', 'total')
        .where('profit.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere(
          query?.investor_id ? 'profit.investor_id = :investor_id' : '1=1',
          {
            investor_id: query?.investor_id
              ? String(query.investor_id)
              : undefined,
          },
        )
        .andWhere('profit.is_paid = :is_paid', { is_paid: false })
        .getRawOne<{ total: string }>(),
    ]);

    const totalPaid = Number(paidRaw?.total ?? 0);
    const totalUnpaid = Number(unpaidRaw?.total ?? 0);

    return successRes({
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      summary: {
        total_paid_amount: Number.isFinite(totalPaid) ? totalPaid : 0,
        total_unpaid_amount: Number.isFinite(totalUnpaid) ? totalUnpaid : 0,
      },
    });
  }

  async markProfitPaid(
    id: string,
    requester?: { id?: string; roles?: string[] } | null,
  ) {
    const row = await this.profitShareRepo.findOne({
      where: { id: String(id), isDeleted: false },
    });
    if (!row) {
      this.notFound('Foyda ulushi topilmadi');
    }

    // GADgsW5G: pul aktorsiz chiqmasin. Ilgari requester yo'q bo'lsa kassa
    // chiqimi `user_id: '0'` (mavjud bo'lmagan foydalanuvchi) nomidan
    // qilinardi va audit izida user_id = null qolardi. Endi aktor (musbat
    // butun users.id) bo'lmasa — 403, kassaga ham, qatorga ham tegilmaydi.
    const actorId = this.normalizeLinkedUserId(requester?.id);
    if (!actorId) {
      this.forbidden(
        "Foyda to'lovi uchun foydalanuvchi (requester) aniqlanmadi — pul aktorsiz chiqmaydi",
      );
    }

    /**
     * ⚠️ PUL KASSADAN YECHILADI (audit M6).
     *
     * Ilgari bu metod faqat `is_paid = true` qo'yardi: investorga haqiqatan
     * chiqqan pul MAIN kassada ham, P&L daftarida ham ko'rinmasdi. Natijada
     * kompaniya qoldig'i doimiy ravishda haqiqiy naqddan ko'p bo'lib turardi
     * va o'sha "bor" pul asosida yangi to'lovlar qilinardi.
     *
     * Tartib ATAYLAB shunday: avval pul yechiladi, keyin qator "to'landi"
     * deb belgilanadi. Kassada pul yetmasa (`Insufficient cash balance`)
     * belgilash umuman bo'lmaydi — ya'ni "to'landi, lekin pul chiqmagan"
     * holati yuzaga kelmaydi. Takroriy bosish `dedup_epoch` bilan bir marta
     * o'tadi.
     */
    if (!row.is_paid) {
      const dedupToken = `${INVESTOR_PROFIT_DEDUP_PREFIX}${String(row.id)}`;
      await rmqSend(
        this.financeClient,
        { cmd: 'finance.cashbox.spend' },
        {
          user_id: actorId,
          cashbox_type: Cashbox_type.MAIN,
          amount: Number(row.amount),
          comment: `Investor #${String(row.investor_id)} foyda to'lovi`,
          created_by: actorId,
          dedup_epoch: dedupToken,
        },
      );
      await rmqSend(
        this.financeClient,
        { cmd: 'finance.financial_balance.record' },
        {
          amount: -Number(row.amount),
          source_type: FinancialSource_type.MANUAL_EXPENSE,
          related_user_id: String(row.investor_id),
          comment: `Investor #${String(row.investor_id)} foyda to'lovi`,
          created_by: actorId,
          dedup_key: dedupToken,
        },
      ).catch(() => undefined);
    }

    row.is_paid = true;
    row.paid_at = new Date();
    const saved = await this.profitShareRepo.save(row);

    await this.activityLog.log({
      entity_type: 'ProfitShare',
      entity_id: String(saved.id),
      action: ActivityAction.PAYMENT,
      new_value: saved,
      metadata: { amount: saved.amount, investor_id: saved.investor_id },
      ...this.auditActor(requester),
    });

    return successRes(saved, 200, 'profit marked as paid');
  }

  // ---------------------------------------------------------------------
  // vpKijXce: investorning O'ZI uchun ("mening investitsiyam") o'qish.
  //
  // Doira FAQAT so'rovchidan (JWT sub → investors.user_id) aniqlanadi —
  // payload'dagi `investor_id` umuman o'qilmaydi, shuning uchun boshqa
  // investorni ko'rib bo'lmaydi. Har qanday noaniqlik (rol yo'q, sub yo'q,
  // bog'lanmagan, bir nechta yozuv, nofaol) → ma'lumot QAYTMAYDI (fail-closed).
  // ---------------------------------------------------------------------

  private async resolveSelfInvestor(requester: Requester): Promise<Investor> {
    const roles = (requester?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    if (!roles.includes(Roles.INVESTOR)) {
      this.forbidden('Investor roli kerak');
    }
    const userId = this.normalizeLinkedUserId(requester?.id);
    if (!userId) {
      this.forbidden('Investor profili mavjud emas');
    }

    const rows = await this.investorRepo.find({
      where: { user_id: userId, isDeleted: false },
      order: { id: 'ASC' },
      take: 2,
    });
    if (rows.length === 0) {
      this.notFound("Investor profili bu foydalanuvchiga bog'lanmagan");
    }
    if (rows.length > 1) {
      // Qaysi biri "men" ekanini taxmin qilmaymiz — admin tuzatishi kerak.
      this.conflict(
        "Bu foydalanuvchiga bir nechta investor profili bog'langan",
      );
    }
    const investor = rows[0];
    if (investor.status !== Status.ACTIVE) {
      this.forbidden('Investor profili faol emas');
    }
    return investor;
  }

  private toSelfProfile(investor: Investor): SelfInvestorProfile {
    return {
      id: String(investor.id),
      name: investor.name,
      phone_number: investor.phone_number,
      status: investor.status,
      share_percent:
        investor.share_percent === null || investor.share_percent === undefined
          ? null
          : Number(investor.share_percent),
      profit_basis: isProfitBasis(investor.profit_basis)
        ? investor.profit_basis
        : DEFAULT_PROFIT_BASIS,
      created_at: investor.createdAt,
    };
  }

  private toSelfInvestment(row: Investment): SelfInvestment {
    return {
      id: String(row.id),
      amount: Number(row.amount),
      invested_at: row.invested_at,
      branch_id: row.branch_id ? String(row.branch_id) : null,
      created_at: row.createdAt,
    };
  }

  private toSelfProfit(row: ProfitShare): SelfProfitShare {
    return {
      id: String(row.id),
      amount: Number(row.amount),
      percentage: Number(row.percentage),
      period_start: row.period_start,
      period_end: row.period_end,
      is_paid: Boolean(row.is_paid),
      paid_at: row.paid_at ?? null,
      created_at: row.createdAt,
    };
  }

  /**
   * Investor ulushi — kunlik, birinchi shart boshidan bugungacha
   * (`finance.pnl.series` + `computeAccrual`). Moliya javob bermasa — 503:
   * nol ko'rsatish («foyda yo'q») noto'g'ri bo'lardi.
   */
  private async loadAccrual(investorId: string): Promise<{
    terms: InvestorShareTerm[];
    accrual: Accrual;
    throughDay: string | null;
  }> {
    const terms = await this.activeTerms(investorId);
    const empty: Accrual = { months: [], totalCents: 0, totalBasisCents: 0 };
    const fromDay = terms.length ? String(terms[0].effective_from) : null;
    if (!fromDay || fromDay > this.todayDay()) {
      return { terms, accrual: empty, throughDay: null };
    }
    let response: { data?: { to_day?: unknown; items?: unknown } } | null;
    try {
      response = await rmqSend(
        this.financeClient,
        { cmd: 'finance.pnl.series' },
        { from_day: fromDay, granularity: 'day' },
        // Gateway dashboard timeout — 8 s: 2 × 3,5 s + kutish undan oshmaydi.
        { timeoutMs: 3500, retries: 1 },
      );
    } catch {
      throw new RpcException(
        errorRes(
          "Kompaniya foydasi hozir olinmadi — birozdan keyin qayta urinib ko'ring",
          503,
        ),
      );
    }
    const data = response?.data ?? {};
    const days: DailyPnlLike[] = (Array.isArray(data.items) ? data.items : [])
      .map((row: { period?: unknown; gross?: unknown; net?: unknown }) => ({
        period: typeof row?.period === 'string' ? row.period : '',
        gross: Number(row?.gross) || 0,
        net: Number(row?.net) || 0,
      }))
      .filter((row) => isDayKey(row.period));
    return {
      terms,
      accrual: computeAccrual(
        terms.map((term) => this.toTermRow(term)),
        days,
      ),
      throughDay: typeof data.to_day === 'string' ? data.to_day : null,
    };
  }

  /**
   * Dashboard kartalari: «Mening investitsiyam» (total_invested), «Ulush»,
   * «To'langan foyda» (total_paid_profit — haqiqatan to'langan),
   * «Kutilayotgan foyda» (total_unpaid_profit = hisoblangan − to'langan).
   * Faqat shu investorning yozuvlari (soft-delete'lar hisobga kirmaydi).
   */
  private async buildInvestorSummary(
    investor: Investor,
    loaded: Awaited<ReturnType<InvestorServiceService['loadAccrual']>>,
  ): Promise<InvestorSummary> {
    const id = String(investor.id);
    const [investmentAgg, profitAgg, latestProfit] = await Promise.all([
      this.investmentRepo
        .createQueryBuilder('investment')
        .select('COALESCE(SUM(investment.amount), 0)', 'total')
        .addSelect('COUNT(investment.id)', 'count')
        .addSelect('MIN(investment.invested_at)', 'first_at')
        .addSelect('MAX(investment.invested_at)', 'last_at')
        .where('investment.investor_id = :investorId', { investorId: id })
        .andWhere('investment.isDeleted = :isDeleted', { isDeleted: false })
        .getRawOne<{
          total: string | null;
          count: string | null;
          first_at: Date | string | null;
          last_at: Date | string | null;
        }>(),
      this.profitShareRepo
        .createQueryBuilder('profit')
        .select(
          'COALESCE(SUM(CASE WHEN profit.is_paid = true THEN profit.amount ELSE 0 END), 0)',
          'paid',
        )
        .addSelect(
          'COALESCE(SUM(CASE WHEN profit.is_paid = false THEN profit.amount ELSE 0 END), 0)',
          'unpaid',
        )
        .addSelect('COUNT(profit.id)', 'count')
        .addSelect('MAX(profit.paid_at)', 'last_paid_at')
        .where('profit.investor_id = :investorId', { investorId: id })
        .andWhere('profit.isDeleted = :isDeleted', { isDeleted: false })
        .getRawOne<{
          paid: string | null;
          unpaid: string | null;
          count: string | null;
          last_paid_at: Date | string | null;
        }>(),
      this.profitShareRepo.findOne({
        where: { investor_id: id, isDeleted: false },
        order: { period_end: 'DESC', createdAt: 'DESC' },
      }),
    ]);

    const paidCents = toCents(profitAgg?.paid);
    const pendingCents = toCents(profitAgg?.unpaid);
    const accruedCents = loaded.accrual.totalCents;
    const open = loaded.terms.find((term) => !term.effective_to);
    return {
      total_invested: fromCents(toCents(investmentAgg?.total)),
      investments_count: Number(investmentAgg?.count ?? 0) || 0,
      first_invested_at: toDateOrNull(investmentAgg?.first_at),
      last_invested_at: toDateOrNull(investmentAgg?.last_at),
      total_paid_profit: fromCents(paidCents),
      total_unpaid_profit: fromCents(accruedCents - paidCents),
      total_profit: fromCents(accruedCents),
      accrued_profit: fromCents(accruedCents),
      accrued_basis: fromCents(loaded.accrual.totalBasisCents),
      accrued_through: loaded.throughDay,
      share_started_at: loaded.terms.length
        ? String(loaded.terms[0].effective_from)
        : null,
      profit_basis: open
        ? this.toTermRow(open).profit_basis
        : isProfitBasis(investor.profit_basis)
          ? investor.profit_basis
          : DEFAULT_PROFIT_BASIS,
      pending_payout_amount: fromCents(pendingCents),
      profit_shares_count: Number(profitAgg?.count ?? 0) || 0,
      current_percentage: latestProfit ? Number(latestProfit.percentage) : null,
      last_paid_at: toDateOrNull(profitAgg?.last_paid_at),
    };
  }

  private normalizeMonths(raw: unknown): number {
    if (raw === undefined || raw === null || raw === '') {
      return MONTHLY_DEFAULT;
    }
    const months = Number(raw);
    if (!Number.isInteger(months) || months < 1 || months > MONTHLY_MAX) {
      this.badRequest(
        `months 1 dan ${MONTHLY_MAX} gacha butun son bo'lishi kerak`,
      );
    }
    return months;
  }

  /**
   * Oylik foyda grafigi: oxirgi `months` ta Toshkent oyi (joriy oy ham),
   * bo'sh oylar 0 bilan. Har oy — shu oyda HISOBLANGAN ulush; «To'langan» /
   * «Kutilmoqda» bo'linmasi — butun to'lovlar eski oydan boshlab
   * taqsimlanganda (`allocatePaid`).
   */
  buildMonthlyProfits(
    accrual: Accrual,
    paidCents: number,
    months: number,
    now: Date = new Date(),
  ): MonthlyProfitPoint[] {
    const shiftedNow = new Date(now.getTime() + TASHKENT_OFFSET_MS);
    const year = shiftedNow.getUTCFullYear();
    const month = shiftedNow.getUTCMonth();
    const keys: string[] = [];
    for (let i = months - 1; i >= 0; i -= 1) {
      const monthStart = new Date(Date.UTC(year, month - i, 1));
      keys.push(
        `${monthStart.getUTCFullYear()}-${String(
          monthStart.getUTCMonth() + 1,
        ).padStart(2, '0')}`,
      );
    }

    const byMonth = new Map(accrual.months.map((row) => [row.month, row]));
    const paidByMonth = allocatePaid(accrual.months, paidCents);
    return keys.map((key) => {
      const row = byMonth.get(key);
      const accrued = row?.accruedCents ?? 0;
      const paid = paidByMonth.get(key) ?? 0;
      return {
        month: key,
        accrued_amount: fromCents(accrued),
        basis_amount: fromCents(row?.basisCents ?? 0),
        paid_amount: fromCents(paid),
        unpaid_amount: fromCents(accrued - paid),
        total_amount: fromCents(accrued),
        share_percent: row ? row.sharePercent : null,
        profit_basis: row ? row.profitBasis : null,
      };
    });
  }

  private async buildDashboard(investor: Investor, monthsRaw: unknown) {
    const months = this.normalizeMonths(monthsRaw);
    const loaded = await this.loadAccrual(investor.id);
    const summary = await this.buildInvestorSummary(investor, loaded);
    const items = this.buildMonthlyProfits(
      loaded.accrual,
      toCents(summary.total_paid_profit),
      months,
    );
    return {
      investor: this.toSelfProfile(investor),
      summary,
      monthly: { months, items },
      share_terms: loaded.terms.map((term) => this.toSelfTerm(term)),
    };
  }

  /** GET /investors/me — o'z profili + kartalar uchun yig'indi. */
  async getMyProfile(requester: Requester) {
    const investor = await this.resolveSelfInvestor(requester);
    const loaded = await this.loadAccrual(investor.id);
    const summary = await this.buildInvestorSummary(investor, loaded);
    return successRes({ investor: this.toSelfProfile(investor), summary });
  }

  /** GET /investors/me/dashboard — kartalar + oylik foyda grafigi. */
  async getMyDashboard(requester: Requester, months?: unknown) {
    const investor = await this.resolveSelfInvestor(requester);
    return successRes(await this.buildDashboard(investor, months));
  }

  /** GET /investors/me/investments — faqat o'z investitsiyalari. */
  async getMyInvestments(
    requester: Requester,
    query?: Pick<InvestmentQuery, 'from_date' | 'to_date' | 'page' | 'limit'>,
  ) {
    const investor = await this.resolveSelfInvestor(requester);
    const res = await this.findAllInvestments({
      investor_id: investor.id,
      from_date: query?.from_date,
      to_date: query?.to_date,
      page: query?.page,
      limit: query?.limit,
    });
    const data = res.data as {
      items: Investment[];
      meta: unknown;
      summary: unknown;
    };
    return successRes({
      items: data.items.map((row) => this.toSelfInvestment(row)),
      meta: data.meta,
      summary: data.summary,
    });
  }

  /** GET /investors/me/profits — foyda tarixi (faqat o'ziniki). */
  async getMyProfits(
    requester: Requester,
    query?: Pick<ProfitQuery, 'is_paid' | 'page' | 'limit'>,
  ) {
    const investor = await this.resolveSelfInvestor(requester);
    const res = await this.findAllProfits({
      investor_id: investor.id,
      is_paid: query?.is_paid,
      page: query?.page,
      limit: query?.limit,
    });
    const data = res.data as {
      items: ProfitShare[];
      meta: unknown;
      summary: unknown;
    };
    return successRes({
      items: data.items.map((row) => this.toSelfProfit(row)),
      meta: data.meta,
      summary: data.summary,
    });
  }

  /**
   * GET /investors/:investor_id/dashboard — superadmin/admin nazorati uchun
   * (TC7): investor ko'radigan AYNAN shu ko'rinish.
   */
  async getInvestorDashboard(investorId: string, months?: unknown) {
    const investor = await this.getInvestorOrThrow(investorId);
    return successRes(await this.buildDashboard(investor, months));
  }
}
