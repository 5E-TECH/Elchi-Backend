import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, ILike, In, Repository } from 'typeorm';
import { Status } from '@app/common';
import { Investor } from './entities/investor.entity';
import { Investment } from './entities/investment.entity';
import { ProfitShare } from './entities/profit-share.entity';
import { errorRes, successRes } from '../../../libs/common/helpers/response';

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

@Injectable()
export class InvestorServiceService {
  constructor(
    @InjectRepository(Investor) private readonly investorRepo: Repository<Investor>,
    @InjectRepository(Investment) private readonly investmentRepo: Repository<Investment>,
    @InjectRepository(ProfitShare) private readonly profitShareRepo: Repository<ProfitShare>,
  ) {}

  private badRequest(message: string): never {
    throw new RpcException(errorRes(message, 400));
  }

  private notFound(message: string): never {
    throw new RpcException(errorRes(message, 404));
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

  private parseDate(value: string | undefined, fieldName: string): Date | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      this.badRequest(`${fieldName} is invalid`);
    }
    return parsed;
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

  async createInvestor(dto: Partial<Investor>) {
    const name = String(dto.name ?? '').trim();
    const email = String(dto.email ?? '').trim().toLowerCase();
    if (!name) {
      this.badRequest('name is required');
    }
    if (!email) {
      this.badRequest('email is required');
    }

    const exists = await this.investorRepo.findOne({
      where: { email, isDeleted: false },
    });
    if (exists) {
      this.badRequest('email already exists');
    }

    const investor = this.investorRepo.create({
      user_id: dto.user_id ? String(dto.user_id) : '0',
      name,
      email,
      phone_number: dto.phone_number ? String(dto.phone_number).trim() : null,
      status: (dto.status as Status) ?? Status.ACTIVE,
      description: dto.description ? String(dto.description).trim() : null,
    });

    const saved = await this.investorRepo.save(investor);
    return successRes(saved, 201, 'investor created');
  }

  async findAllInvestors(query: InvestorQuery) {
    const { search, status } = query ?? {};
    const { page, limit, skip } = this.normalizePagination(query?.page, query?.limit);

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
            { ...where, email: ILike(`%${search.trim()}%`) },
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

    const investmentsMap = investments.reduce<Record<string, Investment[]>>((acc, row) => {
      const key = String(row.investor_id);
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(row);
      return acc;
    }, {});

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

  async updateInvestor(id: string, dto: Partial<Investor>) {
    const investor = await this.getInvestorOrThrow(id);

    if (dto.email && dto.email.trim().toLowerCase() !== investor.email) {
      const exists = await this.investorRepo.findOne({
        where: { email: dto.email.trim().toLowerCase(), isDeleted: false },
      });
      if (exists) {
        this.badRequest('email already exists');
      }
      investor.email = dto.email.trim().toLowerCase();
    }

    if (dto.name !== undefined) {
      const name = String(dto.name).trim();
      if (!name) {
        this.badRequest('name cannot be empty');
      }
      investor.name = name;
    }
    if (dto.phone_number !== undefined) {
      investor.phone_number = dto.phone_number ? String(dto.phone_number).trim() : null;
    }
    if (dto.description !== undefined) {
      investor.description = dto.description ? String(dto.description).trim() : null;
    }
    if (dto.status !== undefined) {
      if (![Status.ACTIVE, Status.INACTIVE].includes(dto.status as Status)) {
        this.badRequest('status must be active or inactive');
      }
      investor.status = dto.status as Status;
    }

    const saved = await this.investorRepo.save(investor);
    return successRes(saved, 200, 'investor updated');
  }

  async deleteInvestor(id: string) {
    const investor = await this.getInvestorOrThrow(id);
    investor.isDeleted = true;
    investor.status = Status.INACTIVE;
    await this.investorRepo.save(investor);
    return successRes({ id }, 200, 'investor deleted');
  }

  async createInvestment(dto: Partial<Investment>) {
    const investor_id = String(dto.investor_id ?? '').trim();
    if (!investor_id) {
      this.badRequest('investor_id is required');
    }
    await this.getInvestorOrThrow(investor_id);

    const amount = Number(dto.amount ?? 0);
    if (!(amount > 0)) {
      this.badRequest('amount must be greater than 0');
    }

    const investedAt = this.parseDate(
      dto.invested_at ? new Date(dto.invested_at).toISOString() : undefined,
      'invested_at',
    );
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
    return successRes(saved, 201, 'investment created');
  }

  async findAllInvestments(query: InvestmentQuery) {
    const { page, limit, skip } = this.normalizePagination(query?.page, query?.limit);
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

    return successRes({
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  }

  async findInvestmentsByInvestor(investor_id: string, query?: Pick<InvestmentQuery, 'page' | 'limit'>) {
    await this.getInvestorOrThrow(investor_id);
    return this.findAllInvestments({
      investor_id,
      page: query?.page,
      limit: query?.limit,
    });
  }

  async createProfitShare(dto: Partial<ProfitShare>) {
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

    const period_start = this.parseDate(
      dto.period_start ? new Date(dto.period_start).toISOString() : undefined,
      'period_start',
    );
    const period_end = this.parseDate(
      dto.period_end ? new Date(dto.period_end).toISOString() : undefined,
      'period_end',
    );
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
    return successRes(saved, 201, 'profit share created');
  }

  async calculateProfit(input: {
    investor_id?: string;
    period_start: string;
    period_end: string;
    percentage: number;
    description?: string;
  }) {
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

    const result: ProfitShare[] = [];
    for (const investor of investors) {
      const investments = await this.investmentRepo.find({
        where: {
          isDeleted: false,
          investor_id: investor.id,
          invested_at: Between(new Date(0), period_end),
        },
      });
      const totalInvestment = investments.reduce((acc, item) => acc + Number(item.amount), 0);
      const amount = Number(((totalInvestment * percentage) / 100).toFixed(2));

      const row = this.profitShareRepo.create({
        investor_id: investor.id,
        amount,
        percentage,
        period_start,
        period_end,
        is_paid: false,
        paid_at: null,
        description: input?.description ? String(input.description).trim() : null,
      });
      result.push(await this.profitShareRepo.save(row));
    }

    return successRes(
      {
        calculated_count: result.length,
        items: result,
      },
      201,
      'profit calculated',
    );
  }

  async findProfitByInvestor(investor_id: string, query?: Pick<ProfitQuery, 'is_paid' | 'page' | 'limit'>) {
    await this.getInvestorOrThrow(investor_id);
    return this.findAllProfits({
      investor_id,
      is_paid: query?.is_paid,
      page: query?.page,
      limit: query?.limit,
    });
  }

  async findAllProfits(query?: ProfitQuery) {
    const { page, limit, skip } = this.normalizePagination(query?.page, query?.limit);
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

    return successRes({
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  }

  async markProfitPaid(id: string) {
    const row = await this.profitShareRepo.findOne({
      where: { id: String(id), isDeleted: false },
    });
    if (!row) {
      this.notFound('profit share not found');
    }

    row.is_paid = true;
    row.paid_at = new Date();
    const saved = await this.profitShareRepo.save(row);
    return successRes(saved, 200, 'profit marked as paid');
  }
}
