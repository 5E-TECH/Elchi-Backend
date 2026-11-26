import {
  BadRequestException,
  Controller,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import {
  Cashbox_type,
  FinancialSource_type,
  Roles as RoleEnum,
  businessDayKey,
  businessDayRange,
} from '@app/common';
import { XLSX_MIME } from '@app/report-kit';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  EXPENSE_CATEGORY_NONE,
  isExpenseCategory,
} from '@app/common/finance/expense-category';
import { orderExportSubtitle } from './order-export/order-export-subtitle';
import {
  buildOrdersAccountsXlsx,
  toOrdersAccountsRow,
  type OrdersAccountsRow,
} from './order-export/orders-accounts-xlsx';
import { buildCashboxHistoryReport } from './excel/finance-reports/cashbox-history.report';
import {
  buildCashboxReport,
  type CashboxBalances,
} from './excel/finance-reports/cashbox-report.report';
import { buildFinancialBalanceReport } from './excel/finance-reports/financial-balance.report';
import {
  asText,
  dateTimeText,
  isoDayText,
  numberOrNull,
  periodText,
  sameMoney,
  toAmount,
} from './excel/finance-reports/report-labels';
import {
  fetchBranchName,
  fetchBranchNames,
  fetchUserNames,
} from './excel/finance-reports/report-names';
import { buildShiftsReport } from './excel/finance-reports/shifts.report';

const EXPORT_TIMEOUT = 20000;
const MAX_ROWS = 50000; // hard ceiling so an export can't run unbounded
const PAGE_SIZE = 500;
const BRANCH_LOOKUP_TIMEOUT = 8000;
/** finance-service `findFinancialBalanceHistory` bitta sahifani 200 bilan cheklaydi. */
const FINANCIAL_BALANCE_PAGE_SIZE = 200;
const FINANCIAL_SOURCE_TYPES = new Set<string>(
  Object.values(FinancialSource_type),
);

interface JwtUser {
  sub: string;
  roles?: string[];
  branch_id?: string | null;
}

type RawRow = Record<string, unknown>;

/** Kassa hisoboti (B5/B6) doirasi: asosiy kassa yoki menejerning filiali. */
interface CashboxReportScope {
  kind: 'main' | 'branch';
  /** Kassa egasi: '0' — MAIN, aks holda filial ID si. */
  ownerId: string;
  cashboxType: Cashbox_type;
}
/** Markaziy asosiy (MAIN) kassaning `user_id` si. */
const MAIN_CASHBOX_OWNER_ID = '0';
export const CASHBOX_REPORT_BRANCH_ONLY_MESSAGE =
  "Siz faqat o'z filialingiz kassasi hisobotini yuklay olasiz";
export const CASHBOX_REPORT_MAIN_ONLY_MESSAGE =
  'Bu hisobot faqat asosiy kassa uchun';
export const SHIFT_NOT_FOUND_MESSAGE = 'Smena topilmadi';

/** RPC / HTTP xatosining holat kodi (aniqlanmasa — null). */
const errorStatus = (error: unknown): number | null => {
  if (!error || typeof error !== 'object') return null;
  const source = error as {
    statusCode?: unknown;
    status?: unknown;
    error?: { statusCode?: unknown } | null;
  };
  for (const value of [
    source.statusCode,
    source.status,
    source.error?.statusCode,
  ]) {
    if (typeof value === 'number') return value;
  }
  return null;
};

type EnrichedOrderRow = Record<string, unknown>;

@ApiTags('Excel Export')
@ApiBearerAuth()
@Controller('export')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ExcelGatewayController {
  constructor(
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    // fix3 C11: filial xodimi eksporti uchun filialni aniqlash. Oxirida va
    // @Optional — mavjud pozitsion konstruktor chaqiruvlari buzilmasin.
    @Optional() @Inject('BRANCH') private readonly branchClient?: ClientProxy,
    // GtAoqHlk: moliyaviy daftar eksportida "Kim kiritgan" ismi uchun.
    @Optional()
    @Inject('IDENTITY')
    private readonly identityClient?: ClientProxy,
  ) {}

  /** Kassa / moliya hisobotlaridagi qator chegarasi (spec'da kichraytiriladi). */
  private readonly reportRowLimit: number = MAX_ROWS;

  /**
   * Filial xodimining (MANAGER/REGISTRATOR/BRANCH) filiali: JWT `branch_id`,
   * bo'lmasa `branch.user.find_by_user`. Aniqlanmasa — 403 (fail-closed).
   */
  private async resolveStaffBranchId(user: JwtUser | undefined) {
    const jwtBranchId = String(user?.branch_id ?? '').trim();
    if (jwtBranchId) {
      return jwtBranchId;
    }
    const lookup: unknown =
      this.branchClient && user?.sub
        ? await firstValueFrom(
            this.branchClient
              .send(
                { cmd: 'branch.user.find_by_user' },
                {
                  user_id: user.sub,
                  requester: { id: user.sub, roles: user.roles ?? [] },
                },
              )
              .pipe(timeout(BRANCH_LOOKUP_TIMEOUT)),
          ).catch((err: unknown) => {
            if (err instanceof TimeoutError) {
              throw new GatewayTimeoutException('Branch service javob bermadi');
            }
            throw err;
          })
        : null;
    const rawBranchId = (lookup as { data?: { branch_id?: unknown } } | null)
      ?.data?.branch_id;
    const branchId =
      typeof rawBranchId === 'string' || typeof rawBranchId === 'number'
        ? String(rawBranchId).trim()
        : '';
    if (!branchId) {
      throw new ForbiddenException(
        'Filial xodimi hech qaysi filialga biriktirilmagan',
      );
    }
    return branchId;
  }

  private send<T>(
    client: ClientProxy,
    cmd: string,
    payload: unknown,
  ): Promise<T> {
    return firstValueFrom(
      client.send<T>({ cmd }, payload).pipe(timeout(EXPORT_TIMEOUT)),
    ).catch((err: unknown) => {
      if (err instanceof TimeoutError) {
        throw new GatewayTimeoutException('Export manbasi javob bermadi');
      }
      throw err;
    });
  }

  private sendFile(res: Response, fileName: string, buf: Buffer): void {
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': String(buf.length),
    });
    res.end(buf);
  }

  @Get('orders.xlsx')
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
    RoleEnum.BRANCH,
  )
  @ApiOperation({
    summary: 'Buyurtmalarni Excel (.xlsx) ga eksport qilish',
    description:
      "Hisob bilan: jami narx, marketga to'lanishi kerak / to'langan / qoldi (faqat SUPERADMIN/ADMIN — D5NxxpJW); holat o'zbekcha, kuryer ismi; 2-varaq — «Xulosa» (marketlar bilan hisob). 50 000 qatordan oshsa faylda DIQQAT.",
  })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiQuery({ name: 'courier_id', required: false, type: String })
  @ApiQuery({ name: 'branch_id', required: false, type: String })
  @ApiQuery({ name: 'from_date', required: false, type: String })
  @ApiQuery({ name: 'to_date', required: false, type: String })
  async exportOrders(
    @Res() res: Response,
    @Query('status') status?: string,
    @Query('market_id') market_id?: string,
    @Query('region_id') region_id?: string,
    @Query('courier_id') courier_id?: string,
    @Query('branch_id') branch_id?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Req() req?: { user?: JwtUser },
  ): Promise<void> {
    const roles = (req?.user?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    const isSystemPrivileged =
      roles.includes(RoleEnum.SUPERADMIN) || roles.includes(RoleEnum.ADMIN);
    // fix3 C11 (CODE-04): filial xodimi — FAQAT o'z filiali. Ilgari branch_id
    // so'rovdan olinardi: uni yubormasa BUTUN kompaniya buyurtmalari mijoz
    // ma'lumoti bilan eksport bo'lardi.
    const scopedBranchId = isSystemPrivileged
      ? branch_id
      : await this.resolveStaffBranchId(req?.user);

    /**
     * ⚠️ fix3 CODE-22: order-service `find_all` sana filtrini `start_day`/
     * `end_day` (Toshkent kuni), kuryerni `courier_ids` dan o'qiydi —
     * `from_date`/`to_date`/`courier_id` ni JIMGINA e'tiborsiz qoldirardi.
     */
    const baseQuery = {
      status,
      market_id,
      region_id,
      courier_ids: courier_id ? [courier_id] : undefined,
      branch_id: scopedBranchId,
      start_day: from_date,
      end_day: to_date,
    };

    // Boyitilgan qator og'ir (market, mijoz, mahsulotlar): darhol ixcham
    // qatorga o'giriladi, 50 000 talik ro'yxat xotirani to'ldirmasin.
    const rows: OrdersAccountsRow[] = [];
    const seen = new Set<string>();
    let fetched = 0;
    let total = 0;
    let subtitle = '';
    for (let page = 1; rows.length < MAX_ROWS; page++) {
      const res2 = await this.send<{
        data?: EnrichedOrderRow[];
        total?: number;
      }>(this.orderClient, 'order.find_all_enriched', {
        // xWsCAA5N: order-service sahifani sukut bo'yicha 100 bilan
        // cheklaydi — `max_limit`siz 1-sahifa 100 qator qaytib, sikl
        // (`batch.length < PAGE_SIZE`) shu yerda to'xtardi: eksportda 100 dan
        // ortiq buyurtma JIMGINA tushib qolardi.
        query: { ...baseQuery, page, limit: PAGE_SIZE, max_limit: PAGE_SIZE },
      });
      const batch = res2?.data ?? [];
      fetched += batch.length;
      total = Number(res2?.total ?? fetched) || 0;
      if (page === 1) {
        subtitle = orderExportSubtitle(
          {
            start_day: from_date,
            end_day: to_date,
            status,
            market_id,
            region_id,
            courier_id,
          },
          batch,
        );
      }
      for (const order of batch) {
        if (rows.length >= MAX_ROWS) break;
        // Eksport paytida sahifalar surilsa — bir buyurtma ikki marta
        // hisoblanmasin.
        const row = toOrdersAccountsRow(order, rows.length + 1);
        const id = String(row.id);
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        rows.push(row);
      }
      if (batch.length < PAGE_SIZE || fetched >= total) break;
    }

    const buf = await buildOrdersAccountsXlsx({
      rows,
      total,
      maxRows: MAX_ROWS,
      subtitle,
      // D5NxxpJW: filial xodimiga market hisobi (market tarifini ochadi) yo'q.
      marketMoney: isSystemPrivileged,
    });
    this.sendFile(res, 'orders.xlsx', buf);
  }

  @Get('cashbox-history.xlsx')
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiOperation({ summary: 'Kassa tarixini Excel (.xlsx) ga eksport qilish' })
  @ApiQuery({ name: 'cashbox_id', required: false, type: String })
  @ApiQuery({ name: 'operation_type', required: false, type: String })
  @ApiQuery({ name: 'source_type', required: false, type: String })
  @ApiQuery({ name: 'sourceTypes', required: false, type: String })
  @ApiQuery({ name: 'source_user_id', required: false, type: String })
  @ApiQuery({ name: 'user_id', required: false, type: String })
  @ApiQuery({ name: 'cashbox_type', required: false, type: String })
  @ApiQuery({ name: 'from_date', required: false, type: String })
  @ApiQuery({ name: 'to_date', required: false, type: String })
  async exportCashboxHistory(
    @Res() res: Response,
    @Query('cashbox_id') cashbox_id?: string,
    @Query('operation_type') operation_type?: string,
    @Query('source_type') source_type?: string,
    @Query('sourceTypes') sourceTypes?: string,
    @Query('source_user_id') source_user_id?: string,
    @Query('user_id') user_id?: string,
    @Query('cashbox_type') cashbox_type?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Req() req?: { user?: JwtUser },
  ): Promise<void> {
    // page=0/limit=0 → service returns the full (unpaginated) history.
    const result = await this.send<{
      data?: { items?: RawRow[]; pagination?: { total?: number } };
    }>(this.financeClient, 'finance.history.find_all', {
      cashbox_id,
      operation_type,
      source_type,
      sourceTypes,
      source_user_id,
      user_id,
      cashbox_type,
      from_date,
      to_date,
      page: 0,
      limit: 0,
      // (2026-11-26) «Yo'nalish» ustuni — kimdan → kimga.
      include_route: true,
    });
    const items = result?.data?.items ?? [];
    const hasBranch = items.some(
      (row) =>
        (row.cashbox as { cashbox_type?: unknown } | null | undefined)
          ?.cashbox_type === Cashbox_type.BRANCH ||
        Boolean(
          (row.route as { branch_id?: unknown } | null | undefined)?.branch_id,
        ),
    );
    const buf = await buildCashboxHistoryReport({
      items,
      total: Number(result?.data?.pagination?.total) || items.length,
      limit: this.reportRowLimit,
      filters: {
        cashbox_id,
        operation_type,
        source_type,
        sourceTypes,
        source_user_id,
        user_id,
        cashbox_type,
        from_date,
        to_date,
      },
      branchNames: hasBranch
        ? await fetchBranchNames(this.branchClient, this.requesterOf(req?.user))
        : new Map(),
    });
    this.sendFile(res, 'cashbox-history.xlsx', buf);
  }

  @Get('shifts.xlsx')
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiOperation({
    summary: 'Smenalarni Excel (.xlsx) ga eksport qilish',
    description:
      "(F7PWp6cK) Sana filtri GET /finance/shift bilan AYNI: 'YYYY-MM-DD' — Toshkent kalendar kuni, ikki chet ham kiradi (opened_at bo'yicha); to'liq ISO — aniq lahza.",
  })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'opened_by', required: false, type: String })
  @ApiQuery({
    name: 'from_date',
    required: false,
    type: String,
    description:
      "'YYYY-MM-DD' — Toshkent kunining 00:00 dan (kun kiradi); to'liq ISO — aniq lahza",
  })
  @ApiQuery({
    name: 'to_date',
    required: false,
    type: String,
    description:
      "'YYYY-MM-DD' — Toshkent kunining 23:59:59.999 gacha (kun kiradi); to'liq ISO — aniq lahza",
  })
  async exportShifts(
    @Res() res: Response,
    @Query('status') status?: string,
    @Query('opened_by') opened_by?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Req() req?: { user?: JwtUser },
  ): Promise<void> {
    const filters = { status, opened_by, from_date, to_date };

    // `id` bo'yicha: sahifalar orasida yangi smena ochilsa, siljigan qator
    // ikki marta tushmasin (jami — boshlangandagi son).
    const items = new Map<string, RawRow>();
    let total: number | null = null;
    let read = 0;
    for (let page = 1; items.size < this.reportRowLimit; page++) {
      const result = await this.send<{
        data?: { items?: RawRow[]; pagination?: { total?: number } };
      }>(this.financeClient, 'finance.shift.find_all', {
        ...filters,
        page,
        limit: PAGE_SIZE,
      });
      const batch = result?.data?.items ?? [];
      for (const row of batch) items.set(asText(row.id), row);
      read += batch.length;
      const found = result?.data?.pagination?.total ?? read;
      total ??= found;
      if (batch.length < PAGE_SIZE || read >= found) break;
    }

    const rows = [...items.values()];
    const hasBranch = rows.some((row) => {
      const owner = asText(row.cashbox_user_id).trim();
      return owner !== '' && owner !== MAIN_CASHBOX_OWNER_ID;
    });
    const buf = await buildShiftsReport({
      items: rows,
      total: total ?? rows.length,
      limit: this.reportRowLimit,
      filters,
      branchNames: hasBranch
        ? await fetchBranchNames(this.branchClient, this.requesterOf(req?.user))
        : new Map(),
    });
    this.sendFile(res, 'shifts.xlsx', buf);
  }

  /**
   * MOLIYAVIY DAFTAR EKSPORTI (GtAoqHlk) — Balans → Tarix jadvalining AYNAN
   * o'sha filtrlari (sana + manba turi) bilan; qatorlar soni jadvaldagi
   * `total` ga teng (MAX_ROWS chegarasigacha).
   */
  @Get('financial-balance.xlsx')
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiOperation({
    summary: 'Moliyaviy balans tarixini Excel (.xlsx) ga eksport qilish',
  })
  @ApiQuery({ name: 'source_type', required: false, type: String })
  @ApiQuery({ name: 'expense_category', required: false, type: String })
  @ApiQuery({ name: 'from_date', required: false, type: String })
  @ApiQuery({ name: 'to_date', required: false, type: String })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  async exportFinancialBalance(
    @Res() res: Response,
    @Query('source_type') source_type?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('expense_category') expense_category?: string,
  ): Promise<void> {
    // Noma'lum manba turi (eski havola) — "barcha manbalar", 500 emas.
    const filters = {
      source_type:
        source_type && FINANCIAL_SOURCE_TYPES.has(source_type)
          ? source_type
          : undefined,
      // ljVOuNz4 — jadval filtri bilan bir xil; noma'lum qiymat — filtrsiz.
      expense_category:
        expense_category === EXPENSE_CATEGORY_NONE ||
        isExpenseCategory(expense_category)
          ? expense_category
          : undefined,
      from_date: from_date ?? fromDate,
      to_date: to_date ?? toDate,
    };

    // `id` bo'yicha: sahifalar orasida yangi yozuv tushsa, siljigan qator ikki
    // marta olinmasin (jami va qoldiq zanjiri buzilardi); jami — boshlangandagi
    // son.
    const entries = new Map<string, RawRow>();
    let total: number | null = null;
    for (let offset = 0; entries.size < this.reportRowLimit;) {
      const result = await this.send<{
        data?: { items?: RawRow[]; total?: number };
      }>(this.financeClient, 'finance.financial_balance.history', {
        ...filters,
        limit: FINANCIAL_BALANCE_PAGE_SIZE,
        offset,
      });
      const batch = result?.data?.items ?? [];
      for (const row of batch) entries.set(asText(row.id), row);
      offset += batch.length;
      const found = Number(result?.data?.total ?? offset);
      total ??= found;
      if (batch.length < FINANCIAL_BALANCE_PAGE_SIZE || offset >= found) {
        break;
      }
    }

    const items = [...entries.values()];
    const names = await fetchUserNames(
      this.identityClient,
      items.map((row) => row.created_by),
    );
    const buf = await buildFinancialBalanceReport({
      items,
      total: total ?? items.length,
      limit: this.reportRowLimit,
      filters,
      actors: new Map(
        [...names].map(([id, name]) => [id, { id, name, role: null }]),
      ),
    });
    this.sendFile(res, 'financial-balance.xlsx', buf);
  }

  // ───────────────────────── kassa hisoboti (B5 / B6) ─────────────────────────

  private requesterOf(user: JwtUser | undefined) {
    return {
      id: String(user?.sub ?? ''),
      roles: this.rolesOf(user),
      branch_id: user?.branch_id ?? null,
    };
  }

  private rolesOf(user: JwtUser | undefined): string[] {
    return (user?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
  }

  /** So'rov parametri: bitta qiymat (takror / obyekt — 400). */
  private queryText(
    query: Record<string, unknown>,
    key: string,
  ): string | undefined {
    const value = query[key];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') {
      throw new BadRequestException(`${key} noto'g'ri`);
    }
    return value.trim() || undefined;
  }

  /**
   * Hisobot doirasi: SUPERADMIN / ADMIN — asosiy kassa; MANAGER — FAQAT o'z
   * filiali kassasi (JWT / branch_users, fail-closed). Boshqa kassa
   * parametr bilan so'ralsa — 403.
   */
  private async resolveCashboxReportScope(
    user: JwtUser | undefined,
    query: Record<string, unknown>,
  ): Promise<CashboxReportScope> {
    const roles = this.rolesOf(user);
    const privileged =
      roles.includes(RoleEnum.SUPERADMIN) || roles.includes(RoleEnum.ADMIN);
    if (!privileged && !roles.includes(RoleEnum.MANAGER)) {
      throw new ForbiddenException(CASHBOX_REPORT_BRANCH_ONLY_MESSAGE);
    }
    const scope: CashboxReportScope = privileged
      ? {
          kind: 'main',
          ownerId: MAIN_CASHBOX_OWNER_ID,
          cashboxType: Cashbox_type.MAIN,
        }
      : {
          kind: 'branch',
          ownerId: await this.resolveStaffBranchId(user),
          cashboxType: Cashbox_type.BRANCH,
        };
    const type = this.queryText(query, 'cashbox_type');
    const foreign =
      (type !== undefined && type !== String(scope.cashboxType)) ||
      ['branch_id', 'cashbox_user_id', 'user_id'].some((key) => {
        const value = this.queryText(query, key);
        return value !== undefined && value !== scope.ownerId;
      });
    if (foreign) throw this.cashboxReportForbidden(scope);
    return scope;
  }

  private cashboxReportForbidden(scope: CashboxReportScope) {
    return new ForbiddenException(
      scope.kind === 'main'
        ? CASHBOX_REPORT_MAIN_ONLY_MESSAGE
        : CASHBOX_REPORT_BRANCH_ONLY_MESSAGE,
    );
  }

  /** Shu doiradagi smena (boshqa kassaniki yoki yo'q — 404). */
  private async findReportShift(
    shiftId: string,
    scope: CashboxReportScope,
  ): Promise<{ id: string; openedAt: string; closedAt: string | null }> {
    if (!/^\d{1,19}$/.test(shiftId)) {
      throw new BadRequestException("shift_id raqam bo'lishi kerak");
    }
    const result = await this.send<{
      data?: { cashbox_user_id?: unknown; shift?: RawRow | null } | null;
    }>(this.financeClient, 'finance.shift.report', {
      shift_id: shiftId,
      cashbox_user_id: scope.ownerId,
    }).catch((error: unknown) => {
      if (errorStatus(error) === 404) {
        throw new NotFoundException(SHIFT_NOT_FOUND_MESSAGE);
      }
      throw error;
    });
    const shift = result?.data?.shift;
    const openedAt = asText(shift?.opened_at);
    // Doira finance'da tekshirilgan — bu ikkinchi qavat.
    if (
      !shift ||
      !openedAt ||
      asText(result?.data?.cashbox_user_id) !== scope.ownerId
    ) {
      throw new NotFoundException(SHIFT_NOT_FOUND_MESSAGE);
    }
    return {
      id: shiftId,
      openedAt,
      closedAt: asText(shift.closed_at) || null,
    };
  }

  /** Kassaning hozirgi qoldig'i (kassa hali ochilmagan bo'lsa — 0). */
  private async readReportCashbox(
    scope: CashboxReportScope,
  ): Promise<{ id: string | null; balances: CashboxBalances }> {
    const result = await this.send<{ data?: RawRow | null }>(
      this.financeClient,
      'finance.cashbox.find_by_user',
      { user_id: scope.ownerId, cashbox_type: scope.cashboxType },
    ).catch((error: unknown) => {
      if (errorStatus(error) === 404) return null;
      throw error;
    });
    const cashbox = result?.data;
    const isMain = scope.kind === 'main';
    return {
      id: asText(cashbox?.id) || null,
      balances: {
        total: toAmount(cashbox?.balance),
        // Filial kassasi bitta jami — naqd / karta qoldig'i ko'rsatilmaydi.
        cash: isMain ? toAmount(cashbox?.balance_cash) : null,
        card: isMain ? toAmount(cashbox?.balance_card) : null,
      },
    };
  }

  private async readReportHistory(
    scope: CashboxReportScope,
    period: { from_date?: string; to_date?: string },
    page: { page: number; limit: number } = { page: 0, limit: 0 },
  ): Promise<{ items: RawRow[]; total: number }> {
    const result = await this.send<{
      data?: { items?: RawRow[]; pagination?: { total?: number } };
    }>(this.financeClient, 'finance.history.find_all', {
      user_id: scope.ownerId,
      cashbox_type: scope.cashboxType,
      ...period,
      ...page,
    });
    const all = result?.data?.items ?? [];
    // Doira finance filtrida — bu ikkinchi qavat: begona kassa qatori faylga
    // hech qachon tushmasin.
    const items = all.filter((row) => {
      const cashbox = row.cashbox as RawRow | null | undefined;
      return (
        !cashbox ||
        (asText(cashbox.user_id) === scope.ownerId &&
          asText(cashbox.cashbox_type) === String(scope.cashboxType))
      );
    });
    const total = Number(result?.data?.pagination?.total) || all.length;
    return { items, total: total - (all.length - items.length) };
  }

  /**
   * Davr: smena oynasi (`opened_at … closed_at`, ochiq — hozirgacha) yoki
   * ISH kunlari (xhiXv3w3, kun almashish soati; sukut — Toshkent kunlari).
   * Hech narsa berilmasa — BUGUNGI ish kuni (butun tarix EMAS).
   */
  private reportPeriod(
    query: Record<string, unknown>,
    shift: { openedAt: string; closedAt: string | null } | null,
    now: Date,
  ) {
    const fromQuery = this.queryText(query, 'from_date');
    const toQuery = this.queryText(query, 'to_date');
    const today = businessDayKey(now);
    // Faqat `to_date` — o'sha kun; faqat `from_date` — hozirgacha.
    const from = shift
      ? shift.openedAt
      : (fromQuery ?? (toQuery ? isoDayText(toQuery) : today));
    const to = shift
      ? (shift.closedAt ?? undefined)
      : (toQuery ?? (fromQuery ? undefined : today));
    const range = businessDayRange(from || undefined, to);
    const start = range.start?.getTime() ?? NaN;
    const end = range.end ? range.end.getTime() : now.getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) {
      throw new BadRequestException(
        "from_date / to_date noto'g'ri (YYYY-MM-DD)",
      );
    }
    if (range.end && start > end) {
      throw new BadRequestException(
        "from_date to_date dan keyin bo'lishi mumkin emas",
      );
    }
    const untilNow = !range.end || end >= now.getTime();
    const firstDay = businessDayKey(new Date(start));
    const lastDay = businessDayKey(
      new Date(untilNow ? Math.max(start, now.getTime()) : end),
    );
    return {
      from,
      to,
      untilNow,
      text: periodText(firstDay, lastDay),
      fileDate: firstDay === lastDay ? firstDay : `${firstDay}_${lastDay}`,
    };
  }

  /**
   * KASSA HISOBOTI (B5 / B6) — kirim, chiqim va kassa balansi. Frontend
   * brauzerda yasagan `.xls` o'rniga (u butun tarixni olardi).
   */
  @Get('cashbox-report.xlsx')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiOperation({
    summary: 'Kassa hisoboti (.xlsx): kirim, chiqim va kassa balansi',
    description:
      "SUPERADMIN / ADMIN — asosiy kassa; MANAGER — FAQAT o'z filiali kassasi (bitta jami, naqd/karta qoldig'i yo'q). Boshqa kassa so'ralsa (`branch_id`, `cashbox_user_id`, `user_id`, `cashbox_type`, `cashbox_id`) — 403. " +
      "Davr: `shift_id` (smena oynasi, ochiq smena — hozirgacha; berilsa `from_date`/`to_date` e'tiborga olinmaydi) YOKI `from_date`/`to_date`. Faqat `from_date` — hozirgacha, faqat `to_date` — o'sha kun, hech biri — BUGUN (Toshkent). " +
      "Fayl nomi: `kassa-hisobot-<YYYY-MM-DD>.xlsx`, bir necha kunda `kassa-hisobot-<dan>_<gacha>.xlsx` (Content-Disposition). Balans nazorati («Kassa balansiga teng» / «Mos kelmadi: farq …») davr hozirgacha bo'lganda.",
  })
  @ApiQuery({
    name: 'shift_id',
    required: false,
    type: String,
    description:
      "Smena ID si (raqam). Shu kassaniki bo'lishi shart, aks holda 404",
  })
  @ApiQuery({
    name: 'from_date',
    required: false,
    type: String,
    example: '2026-11-18',
    description: "'YYYY-MM-DD' — Toshkent kunining boshidan (kun kiradi)",
  })
  @ApiQuery({
    name: 'to_date',
    required: false,
    type: String,
    example: '2026-11-24',
    description: "'YYYY-MM-DD' — Toshkent kunining oxirigacha (kun kiradi)",
  })
  @ApiProduces(XLSX_MIME)
  @ApiOkResponse({
    description: 'Excel fayl',
    content: { [XLSX_MIME]: { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiBadRequestResponse({ description: "Sana yoki shift_id noto'g'ri" })
  @ApiForbiddenResponse({
    description: "Rol yoki boshqa kassa so'ralgan; menejer filiali topilmadi",
  })
  @ApiNotFoundResponse({
    description: 'Smena topilmadi yoki boshqa kassaniki',
  })
  async exportCashboxReport(
    @Res() res: Response,
    @Query() rawQuery?: Record<string, unknown>,
    @Req() req?: { user?: JwtUser },
  ): Promise<void> {
    const query = rawQuery ?? {};
    const user = req?.user;
    const now = new Date();
    const scope = await this.resolveCashboxReportScope(user, query);
    const shiftId = this.queryText(query, 'shift_id');
    const shift = shiftId ? await this.findReportShift(shiftId, scope) : null;
    const period = this.reportPeriod(query, shift, now);

    const window = { from_date: period.from, to_date: period.to };
    let cashbox = await this.readReportCashbox(scope);
    const cashboxId = this.queryText(query, 'cashbox_id');
    if (cashboxId !== undefined && cashboxId !== cashbox.id) {
      throw this.cashboxReportForbidden(scope);
    }
    let history = await this.readReportHistory(scope, window);
    // Ikki o'qish orasida amal tushgan bo'lsa (oxirgi qator qoldig'i ≠ kassa) —
    // bir marta qayta o'qiymiz: soxta «Mos kelmadi» chiqmasin.
    if (period.untilNow && this.isStaleRead(history.items, cashbox.balances)) {
      cashbox = await this.readReportCashbox(scope);
      history = await this.readReportHistory(scope, window);
    }

    // O'tgan davrda amal yo'q — qoldiq davrdan oldingi oxirgi qatordan.
    const previous =
      !period.untilNow && !history.items.length
        ? await this.readPreviousBalance(scope, period.to)
        : undefined;
    const requester = this.requesterOf(user);
    // (2026-11-26, ega) Asosiy kassa: menejerlar filial kassasi orqali
    // marketlarga bergan pul — alohida bo'lim (balansga kirmaydi).
    const branchMarketItems =
      scope.kind === 'main'
        ? await this.readBranchMarketPayments(window)
        : null;
    const [branchNames, branchName] = await Promise.all([
      scope.kind === 'main' &&
      (history.items.some((row) => row.source_type === 'branch_to_main') ||
        Boolean(branchMarketItems?.length))
        ? fetchBranchNames(this.branchClient, requester)
        : new Map<string, string>(),
      scope.kind === 'branch'
        ? fetchBranchName(this.branchClient, scope.ownerId, requester)
        : null,
    ]);
    const clock = (value: string) => dateTimeText(value).replace(/\.\d{4}/, '');
    const buf = await buildCashboxReport({
      kind: scope.kind,
      branchName,
      items: history.items,
      total: history.total,
      limit: this.reportRowLimit,
      balances: cashbox.balances,
      untilNow: period.untilNow,
      previous,
      period: period.text,
      shiftLabel: shift
        ? `Smena №${shift.id} · ${clock(shift.openedAt)} — ${shift.closedAt ? clock(shift.closedAt) : 'hozirgacha'}`
        : null,
      branchNames,
      branchMarketItems,
      now,
    });
    this.sendFile(res, `kassa-hisobot-${period.fileDate}.xlsx`, buf);
  }

  /**
   * (2026-11-26, ega) Davrda FILIAL kassalaridan marketlarga chiqqan pul
   * (`market_payment` chiqimi): filial kassasidan to'lov va menejer yozgan
   * kuryer «Marketga o'tkazma»si, yo'nalishi bilan. Fail-open: xato — `null`
   * (bo'lim chizilmaydi, hisobotning o'zi chiqadi).
   */
  private async readBranchMarketPayments(period: {
    from_date?: string;
    to_date?: string;
  }): Promise<RawRow[] | null> {
    try {
      const result = await this.send<{ data?: { items?: RawRow[] } }>(
        this.financeClient,
        'finance.history.find_all',
        {
          cashbox_type: Cashbox_type.BRANCH,
          source_type: 'market_payment',
          operation_type: 'expense',
          ...period,
          page: 0,
          limit: 0,
          include_route: true,
        },
      );
      const items = result?.data?.items ?? [];
      // Ikkinchi qavat: faqat filial kassasi qatorlari.
      return items.filter(
        (row) =>
          asText((row.cashbox as RawRow | null | undefined)?.cashbox_type) ===
          String(Cashbox_type.BRANCH),
      );
    } catch {
      return null;
    }
  }

  /** Eng oxirgi qatordan keyingi qoldiq kassa qoldig'idan farq qiladimi. */
  private isStaleRead(
    items: readonly RawRow[],
    balances: CashboxBalances,
  ): boolean {
    if (!items.length) return false;
    const last = items.reduce((a, b) =>
      toAmount(b.id) > toAmount(a.id) ? b : a,
    );
    const after = numberOrNull(last.balance_after);
    return after !== null && !sameMoney(after, balances.total);
  }

  /** Davr oxirigacha bo'lgan eng so'nggi qoldiq (fail-open: null). */
  private async readPreviousBalance(
    scope: CashboxReportScope,
    to: string | undefined,
  ): Promise<CashboxBalances | null> {
    try {
      const { items } = await this.readReportHistory(
        scope,
        { to_date: to },
        { page: 1, limit: 1 },
      );
      if (!items.length) {
        const zero = scope.kind === 'main' ? 0 : null;
        return { total: 0, cash: zero, card: zero };
      }
      const isMain = scope.kind === 'main';
      return {
        total: toAmount(items[0].balance_after),
        cash: isMain ? numberOrNull(items[0].balance_cash_after) : null,
        card: isMain ? numberOrNull(items[0].balance_card_after) : null,
      };
    } catch {
      return null;
    }
  }
}
