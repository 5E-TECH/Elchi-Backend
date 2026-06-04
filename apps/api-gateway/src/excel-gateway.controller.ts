import {
  Controller,
  GatewayTimeoutException,
  Get,
  Inject,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  buildXlsx,
  excelDate,
  excelNumber,
  ExcelColumn,
} from './excel/excel.util';

const EXPORT_TIMEOUT = 20000;
const MAX_ROWS = 50000; // hard ceiling so an export can't run unbounded
const PAGE_SIZE = 500;

interface EnrichedOrderRow {
  id: string;
  address?: string | null;
  total_price?: number;
  paid_amount?: number;
  to_be_paid?: number;
  status?: string;
  createdAt?: string;
  courier_id?: string | null;
  market?: { name?: string } | null;
  customer?: {
    name?: string;
    phone_number?: string;
    district?: { name?: string } | null;
    region?: { name?: string } | null;
  } | null;
  district?: { name?: string } | null;
  region?: { name?: string } | null;
}

@ApiTags('Excel Export')
@ApiBearerAuth()
@Controller('export')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ExcelGatewayController {
  constructor(
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
  ) {}

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
  @ApiOperation({ summary: 'Buyurtmalarni Excel (.xlsx) ga eksport qilish' })
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
  ): Promise<void> {
    const baseQuery = {
      status,
      market_id,
      region_id,
      courier_id,
      branch_id,
      from_date,
      to_date,
    };

    const rows: EnrichedOrderRow[] = [];
    for (let page = 1; rows.length < MAX_ROWS; page++) {
      const res2 = await this.send<{
        data?: EnrichedOrderRow[];
        total?: number;
      }>(this.orderClient, 'order.find_all_enriched', {
        query: { ...baseQuery, page, limit: PAGE_SIZE },
      });
      const batch = res2?.data ?? [];
      rows.push(...batch);
      const total = res2?.total ?? rows.length;
      if (batch.length < PAGE_SIZE || rows.length >= total) break;
    }

    const columns: ExcelColumn[] = [
      { header: 'ID', key: 'id', width: 12 },
      { header: 'Market', key: 'market', width: 22 },
      { header: 'Mijoz', key: 'customer', width: 22 },
      { header: 'Telefon', key: 'phone', width: 16 },
      { header: 'Viloyat', key: 'region', width: 16 },
      { header: 'Tuman', key: 'district', width: 16 },
      { header: 'Manzil', key: 'address', width: 28 },
      { header: 'Jami narx', key: 'total_price', width: 14 },
      { header: "To'langan", key: 'paid_amount', width: 14 },
      { header: "To'lanishi kerak", key: 'to_be_paid', width: 16 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Sana', key: 'created_at', width: 20 },
      { header: 'Kuryer ID', key: 'courier_id', width: 14 },
    ];

    const mapped = rows.slice(0, MAX_ROWS).map((o) => ({
      id: o.id,
      market: o.market?.name ?? '',
      customer: o.customer?.name ?? '',
      phone: o.customer?.phone_number ?? '',
      region: o.region?.name ?? o.customer?.region?.name ?? '',
      district: o.district?.name ?? o.customer?.district?.name ?? '',
      address: o.address ?? '',
      total_price: excelNumber(o.total_price),
      paid_amount: excelNumber(o.paid_amount),
      to_be_paid: excelNumber(o.to_be_paid),
      status: o.status ?? '',
      created_at: excelDate(o.createdAt),
      courier_id: o.courier_id ?? '',
    }));

    const buf = await buildXlsx('Buyurtmalar', columns, mapped);
    this.sendFile(res, 'orders.xlsx', buf);
  }

  @Get('cashbox-history.xlsx')
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiOperation({ summary: 'Kassa tarixini Excel (.xlsx) ga eksport qilish' })
  @ApiQuery({ name: 'cashbox_id', required: false, type: String })
  @ApiQuery({ name: 'operation_type', required: false, type: String })
  @ApiQuery({ name: 'source_type', required: false, type: String })
  async exportCashboxHistory(
    @Res() res: Response,
    @Query('cashbox_id') cashbox_id?: string,
    @Query('operation_type') operation_type?: string,
    @Query('source_type') source_type?: string,
  ): Promise<void> {
    // page=0/limit=0 → service returns the full (unpaginated) history.
    const result = await this.send<{
      data?: { items?: Array<Record<string, unknown>> };
    }>(this.financeClient, 'finance.history.find_all', {
      cashbox_id,
      operation_type,
      source_type,
      page: 0,
      limit: 0,
    });
    const items = (result?.data?.items ?? []).slice(0, MAX_ROWS);

    const columns: ExcelColumn[] = [
      { header: 'Sana', key: 'date', width: 20 },
      { header: 'Amal turi', key: 'operation_type', width: 14 },
      { header: 'Manba', key: 'source_type', width: 18 },
      { header: 'Summa', key: 'amount', width: 14 },
      { header: 'Balans', key: 'balance_after', width: 14 },
      { header: 'Naqd balans', key: 'balance_cash_after', width: 14 },
      { header: 'Karta balans', key: 'balance_card_after', width: 14 },
      { header: "To'lov usuli", key: 'payment_method', width: 14 },
      { header: 'Izoh', key: 'comment', width: 24 },
      { header: 'Kassa ID', key: 'cashbox_id', width: 12 },
    ];

    const mapped = items.map((h) => ({
      date: excelDate(h.payment_date ?? h.createdAt),
      operation_type: h.operation_type ?? '',
      source_type: h.source_type ?? '',
      amount: excelNumber(h.amount),
      balance_after: excelNumber(h.balance_after),
      balance_cash_after: excelNumber(h.balance_cash_after),
      balance_card_after: excelNumber(h.balance_card_after),
      payment_method: h.payment_method ?? '',
      comment: h.comment ?? '',
      cashbox_id: h.cashbox_id ?? '',
    }));

    const buf = await buildXlsx('Kassa tarixi', columns, mapped);
    this.sendFile(res, 'cashbox-history.xlsx', buf);
  }

  @Get('shifts.xlsx')
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiOperation({ summary: 'Smenalarni Excel (.xlsx) ga eksport qilish' })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'opened_by', required: false, type: String })
  @ApiQuery({ name: 'from_date', required: false, type: String })
  @ApiQuery({ name: 'to_date', required: false, type: String })
  async exportShifts(
    @Res() res: Response,
    @Query('status') status?: string,
    @Query('opened_by') opened_by?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
  ): Promise<void> {
    const baseQuery = { status, opened_by, from_date, to_date };

    const items: Array<Record<string, unknown>> = [];
    for (let page = 1; items.length < MAX_ROWS; page++) {
      const result = await this.send<{
        data?: {
          items?: Array<Record<string, unknown>>;
          pagination?: { total?: number };
        };
      }>(this.financeClient, 'finance.shift.find_all', {
        ...baseQuery,
        page,
        limit: PAGE_SIZE,
      });
      const batch = result?.data?.items ?? [];
      items.push(...batch);
      const total = result?.data?.pagination?.total ?? items.length;
      if (batch.length < PAGE_SIZE || items.length >= total) break;
    }

    const columns: ExcelColumn[] = [
      { header: 'ID', key: 'id', width: 12 },
      { header: 'Ochilgan', key: 'opened_at', width: 20 },
      { header: 'Yopilgan', key: 'closed_at', width: 20 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Ochilish naqd', key: 'opening_balance_cash', width: 16 },
      { header: 'Ochilish karta', key: 'opening_balance_card', width: 16 },
      { header: 'Yopilish naqd', key: 'closing_balance_cash', width: 16 },
      { header: 'Yopilish karta', key: 'closing_balance_card', width: 16 },
      { header: 'Kirim naqd', key: 'total_income_cash', width: 14 },
      { header: 'Kirim karta', key: 'total_income_card', width: 14 },
      { header: 'Chiqim naqd', key: 'total_expense_cash', width: 14 },
      { header: 'Chiqim karta', key: 'total_expense_card', width: 14 },
      { header: 'Izoh', key: 'comment', width: 24 },
    ];

    const mapped = items.slice(0, MAX_ROWS).map((s) => ({
      id: s.id ?? '',
      opened_at: excelDate(s.opened_at),
      closed_at: excelDate(s.closed_at),
      status: s.status ?? '',
      opening_balance_cash: excelNumber(s.opening_balance_cash),
      opening_balance_card: excelNumber(s.opening_balance_card),
      closing_balance_cash: excelNumber(s.closing_balance_cash),
      closing_balance_card: excelNumber(s.closing_balance_card),
      total_income_cash: excelNumber(s.total_income_cash),
      total_income_card: excelNumber(s.total_income_card),
      total_expense_cash: excelNumber(s.total_expense_cash),
      total_expense_card: excelNumber(s.total_expense_card),
      comment: s.comment ?? '',
    }));

    const buf = await buildXlsx('Smenalar', columns, mapped);
    this.sendFile(res, 'shifts.xlsx', buf);
  }
}
