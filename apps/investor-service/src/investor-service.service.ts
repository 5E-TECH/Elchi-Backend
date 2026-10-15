import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, ILike, In, MoreThanOrEqual, Repository } from 'typeorm';
import {
  ActivityAction,
  ActivityLogQuery,
  ActivityLogService,
  Cashbox_type,
  FinancialSource_type,
  Roles,
  Status,
  TASHKENT_OFFSET_MINUTES,
  rmqSend,
} from '@app/common';
import { Investor } from './entities/investor.entity';
import { Investment } from './entities/investment.entity';
import { ProfitShare } from './entities/profit-share.entity';
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
  created_at: Date;
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
  total_paid_profit: number;
  total_unpaid_profit: number;
  total_profit: number;
  profit_shares_count: number;
  current_percentage: number | null;
  last_paid_at: Date | null;
};

export type MonthlyProfitPoint = {
  month: string;
  paid_amount: number;
  unpaid_amount: number;
  total_amount: number;
};

/** vpKijXce: oylik foyda grafigi oynasi (oy). */
const MONTHLY_DEFAULT = 12;
const MONTHLY_MAX = 36;
const TASHKENT_OFFSET_MS = TASHKENT_OFFSET_MINUTES * 60 * 1000;
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

/** `date` tushgan Toshkent oyi — 'YYYY-MM'. */
function tashkentMonthKey(date: Date): string {
  const shifted = new Date(date.getTime() + TASHKENT_OFFSET_MS);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${month}`;
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
      this.badRequest('user_id already linked to another investor');
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
      this.badRequest(`${fieldName} is invalid`);
    }
    return parsed;
  }

  private validateUzPhoneNumber(phone: string): void {
    const normalized = String(phone).trim();
    if (!/^\+998\d{9}$/.test(normalized)) {
      this.badRequest("phone_number must be in '+998XXXXXXXXX' format");
    }
  }

  private async getInvestorOrThrow(id: string): Promise<Investor> {
    const investor = await this.investorRepo.findOne({
      where: { id: String(id), isDeleted: false },
    });
    if (!investor) {
      this.notFound('investor not found');
    }
    return investor;
  }

  private async getInvestmentOrThrow(id: string): Promise<Investment> {
    const investment = await this.investmentRepo.findOne({
      where: { id: String(id), isDeleted: false },
    });
    if (!investment) {
      this.notFound('investment not found');
    }
    return investment;
  }

  async createInvestor(
    dto: CreateInvestorDto,
    requester?: { id?: string; roles?: string[] } | null,
  ) {
    const name = String(dto.name ?? '').trim();
    const phoneNumber = String(dto.phone_number ?? '').trim();
    if (!name) {
      this.badRequest('name is required');
    }
    if (!phoneNumber) {
      this.badRequest('phone_number is required');
    }
    this.validateUzPhoneNumber(phoneNumber);

    const exists = await this.investorRepo.findOne({
      where: { phone_number: phoneNumber, isDeleted: false },
    });
    if (exists) {
      this.badRequest('phone_number already exists');
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
        this.badRequest('user_id must be a positive integer');
      }
      await this.assertUserIdFree(normalized);
      linkedUserId = normalized;
    }

    const investor = this.investorRepo.create({
      user_id: linkedUserId,
      name,
      phone_number: phoneNumber,
      status: (dto.status as Status) ?? Status.ACTIVE,
      description: dto.description ? String(dto.description).trim() : null,
    });

    const saved = await this.investorRepo.save(investor);

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
        this.badRequest('status must be active or inactive');
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
    const [investments, profits] = await Promise.all([
      this.investmentRepo.find({
        where: { investor_id: investor.id, isDeleted: false },
        order: { invested_at: 'DESC' },
      }),
      this.profitShareRepo.find({
        where: { investor_id: investor.id, isDeleted: false },
        order: { period_start: 'DESC' },
      }),
    ]);

    return successRes({
      ...investor,
      investments,
      profit_shares: profits,
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
      const name = String(dto.name).trim();
      if (!name) {
        this.badRequest('name cannot be empty');
      }
      investor.name = name;
    }
    if (dto.phone_number !== undefined) {
      const phoneNumber = String(dto.phone_number ?? '').trim();
      if (!phoneNumber) {
        this.badRequest('phone_number cannot be empty');
      }
      this.validateUzPhoneNumber(phoneNumber);

      if (phoneNumber !== investor.phone_number) {
        const exists = await this.investorRepo.findOne({
          where: { phone_number: phoneNumber, isDeleted: false },
        });
        if (exists) {
          this.badRequest('phone_number already exists');
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
        this.badRequest('status must be active or inactive');
      }
      investor.status = dto.status;
    }
    // vpKijXce: login bilan bog'lash / uzish (null yoki '' → '0').
    if (dto.user_id !== undefined) {
      if (dto.user_id === null || String(dto.user_id).trim() === '') {
        investor.user_id = '0';
      } else {
        const normalized = this.normalizeLinkedUserId(dto.user_id);
        if (!normalized) {
          this.badRequest('user_id must be a positive integer');
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
      this.badRequest('investor_id is required');
    }
    await this.getInvestorOrThrow(investor_id);

    const amount = Number(dto.amount ?? 0);
    if (!(amount > 0)) {
      this.badRequest('amount must be greater than 0');
    }

    const investedAt = this.parseDate(dto.invested_at, 'invested_at');
    if (!investedAt) {
      this.badRequest('invested_at is required');
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
      this.badRequest('from_date must be less than or equal to to_date');
    }
    if (fromDate && toDate) {
      where.invested_at = Between(fromDate, toDate);
    } else if (fromDate) {
      where.invested_at = Between(fromDate, new Date());
    } else if (toDate) {
      where.invested_at = Between(new Date(0), toDate);
    }

    const [items, total] = await this.investmentRepo.findAndCount({
      where,
      order: { invested_at: 'DESC' },
      skip,
      take: limit,
    });

    const totalAmountRaw = await this.investmentRepo
      .createQueryBuilder('investment')
      .select('COALESCE(SUM(investment.amount), 0)', 'total')
      .where('investment.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere(
        query?.investor_id ? 'investment.investor_id = :investor_id' : '1=1',
        {
          investor_id: query?.investor_id
            ? String(query.investor_id)
            : undefined,
        },
      )
      .getRawOne<{ total: string }>();

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
      this.notFound('investment not found for this investor');
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
        this.badRequest('investor_id cannot be empty');
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
        this.badRequest('amount must be greater than 0');
      }
      investment.amount = amount;
    }

    if (dto.invested_at !== undefined) {
      const investedAt = this.parseDate(dto.invested_at, 'invested_at');
      if (!investedAt) {
        this.badRequest('invested_at is required');
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
      this.badRequest('investor_id is required');
    }
    await this.getInvestorOrThrow(investor_id);

    const amount = Number(dto.amount ?? 0);
    if (!(amount >= 0)) {
      this.badRequest('amount must be greater than or equal to 0');
    }

    const percentage = Number(dto.percentage ?? 0);
    if (percentage < 0 || percentage > 100) {
      this.badRequest('percentage must be between 0 and 100');
    }

    const period_start = this.parseDate(dto.period_start, 'period_start');
    const period_end = this.parseDate(dto.period_end, 'period_end');
    if (!period_start || !period_end) {
      this.badRequest('period_start and period_end are required');
    }
    if (period_start > period_end) {
      this.badRequest('period_start must be less than or equal to period_end');
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
      this.badRequest('period_start and period_end are required');
    }
    if (period_start > period_end) {
      this.badRequest('period_start must be less than or equal to period_end');
    }

    const percentage = Number(input?.percentage ?? 0);
    if (percentage < 0 || percentage > 100) {
      this.badRequest('percentage must be between 0 and 100');
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
      this.notFound('profit share not found');
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
      const dedupToken = `investor-profit:${String(row.id)}`;
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
      this.forbidden('investor role required');
    }
    const userId = this.normalizeLinkedUserId(requester?.id);
    if (!userId) {
      this.forbidden('investor profile is not available');
    }

    const rows = await this.investorRepo.find({
      where: { user_id: userId, isDeleted: false },
      order: { id: 'ASC' },
      take: 2,
    });
    if (rows.length === 0) {
      this.notFound('investor profile not linked to this user');
    }
    if (rows.length > 1) {
      // Qaysi biri "men" ekanini taxmin qilmaymiz — admin tuzatishi kerak.
      this.conflict('multiple investor profiles linked to this user');
    }
    const investor = rows[0];
    if (investor.status !== Status.ACTIVE) {
      this.forbidden('investor profile is inactive');
    }
    return investor;
  }

  private toSelfProfile(investor: Investor): SelfInvestorProfile {
    return {
      id: String(investor.id),
      name: investor.name,
      phone_number: investor.phone_number,
      status: investor.status,
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
   * Dashboard kartalari: "Mening investitsiyam" (total_invested), "Ulush
   * foizi" (current_percentage — oxirgi davr foiz stavkasi), "To'langan foyda"
   * (total_paid_profit), "Kutilayotgan foyda" (total_unpaid_profit).
   * Faqat shu investorning yozuvlari (soft-delete'lar hisobga kirmaydi).
   */
  private async buildInvestorSummary(
    investorId: string,
  ): Promise<InvestorSummary> {
    const id = String(investorId);
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
    const unpaidCents = toCents(profitAgg?.unpaid);
    return {
      total_invested: fromCents(toCents(investmentAgg?.total)),
      investments_count: Number(investmentAgg?.count ?? 0) || 0,
      first_invested_at: toDateOrNull(investmentAgg?.first_at),
      last_invested_at: toDateOrNull(investmentAgg?.last_at),
      total_paid_profit: fromCents(paidCents),
      total_unpaid_profit: fromCents(unpaidCents),
      total_profit: fromCents(paidCents + unpaidCents),
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
      this.badRequest(`months must be an integer between 1 and ${MONTHLY_MAX}`);
    }
    return months;
  }

  /**
   * Oylik foyda grafigi: oxirgi `months` ta Toshkent oyi (joriy oy ham),
   * bo'sh oylar 0 bilan. Oy — foyda DAVRINING oxiri (period_end) bo'yicha.
   */
  async buildMonthlyProfits(
    investorId: string,
    months: number,
    now: Date = new Date(),
  ): Promise<MonthlyProfitPoint[]> {
    const shiftedNow = new Date(now.getTime() + TASHKENT_OFFSET_MS);
    const year = shiftedNow.getUTCFullYear();
    const month = shiftedNow.getUTCMonth();
    const rangeStart = new Date(
      Date.UTC(year, month - (months - 1), 1) - TASHKENT_OFFSET_MS,
    );

    const keys: string[] = [];
    for (let i = months - 1; i >= 0; i -= 1) {
      const monthStart = new Date(Date.UTC(year, month - i, 1));
      keys.push(
        `${monthStart.getUTCFullYear()}-${String(
          monthStart.getUTCMonth() + 1,
        ).padStart(2, '0')}`,
      );
    }

    const rows = await this.profitShareRepo.find({
      where: {
        investor_id: String(investorId),
        isDeleted: false,
        period_end: MoreThanOrEqual(rangeStart),
      },
      order: { period_end: 'ASC' },
    });

    const buckets = new Map<string, { paid: number; unpaid: number }>(
      keys.map((key) => [key, { paid: 0, unpaid: 0 }]),
    );
    for (const row of rows) {
      const end = toDateOrNull(row.period_end);
      if (!end) {
        continue;
      }
      const bucket = buckets.get(tashkentMonthKey(end));
      if (!bucket) {
        // Oynadan tashqari (masalan kelajak davri) — grafikka kirmaydi.
        continue;
      }
      if (row.is_paid) {
        bucket.paid += toCents(row.amount);
      } else {
        bucket.unpaid += toCents(row.amount);
      }
    }

    return keys.map((key) => {
      const bucket = buckets.get(key) ?? { paid: 0, unpaid: 0 };
      return {
        month: key,
        paid_amount: fromCents(bucket.paid),
        unpaid_amount: fromCents(bucket.unpaid),
        total_amount: fromCents(bucket.paid + bucket.unpaid),
      };
    });
  }

  private async buildDashboard(investor: Investor, monthsRaw: unknown) {
    const months = this.normalizeMonths(monthsRaw);
    const [summary, items] = await Promise.all([
      this.buildInvestorSummary(investor.id),
      this.buildMonthlyProfits(investor.id, months),
    ]);
    return {
      investor: this.toSelfProfile(investor),
      summary,
      monthly: { months, items },
    };
  }

  /** GET /investors/me — o'z profili + kartalar uchun yig'indi. */
  async getMyProfile(requester: Requester) {
    const investor = await this.resolveSelfInvestor(requester);
    const summary = await this.buildInvestorSummary(investor.id);
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
