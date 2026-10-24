import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Roles as RoleEnum } from '@app/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { firstValueFrom, timeout } from 'rxjs';

interface JwtUser {
  sub: string;
  username: string;
  roles?: string[];
  branch_id?: string;
}

/** GET /analytics/dashboard ga kira oladigan rollar (investor/customer — yo'q). */
export const DASHBOARD_ROLES = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.MANAGER,
  RoleEnum.BRANCH,
  RoleEnum.REGISTRATOR,
  RoleEnum.OPERATOR,
  RoleEnum.COURIER,
  RoleEnum.MARKET,
  RoleEnum.MARKET_OPERATOR,
] as const;

/** (6CYRjoZG) Filial id — bigint (raqamli satr). */
const BRANCH_ID_RE = /^[0-9]{1,19}$/;

@ApiTags('Analytics')
@Controller('analytics')
export class AnalyticsGatewayController {
  constructor(
    @Inject('ANALYTICS') private readonly analyticsClient: ClientProxy,
  ) {}

  private toRequester(req: { user: JwtUser }) {
    return {
      id: req.user.sub,
      roles: req.user.roles ?? [],
      branch_id: req.user.branch_id,
    };
  }

  @Get('dashboard')
  // Default-deny (ukulko6O, EgizXSKW): ilgari faqat JwtAuthGuard edi — har
  // qanday login qilgan rol (investor, customer) dashboardni olardi. Rolga
  // xos kesim servisda; bu yerda kim umuman kira olishi.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...DASHBOARD_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Dashboard statistics by requester role',
    description:
      "Admin/filial kesimi javobida qo'shimcha: orders.lostRevenue (l9NNdsCH, bekor summasi), " +
      'targets {successRate} (l9NNdsCH), previous {from,to,acceptedCount,soldAndPaid,cancelled,totalRevenue,profit,lostRevenue} ' +
      'va series[14] {date,…} (DwrMygfo; registratorda moliyaviy maydonlarsiz; «Barchasi»da previous=null).',
  })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  @ApiQuery({ name: 'start_day', required: false, type: String })
  @ApiQuery({ name: 'end_day', required: false, type: String })
  @ApiQuery({ name: 'all', required: false, type: Boolean })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['today', 'week', 'month'],
  })
  @ApiQuery({
    name: 'branch_id',
    required: false,
    type: String,
    description:
      "(6CYRjoZG) Faqat SUPERADMIN/ADMIN: tanlangan filial kesimi (/branches/:id «Filial ko'rsatkichlari»). " +
      "Javobga qo'shimcha: branch_id, dailyRevenue {data[], summary}, statusDistribution {distribution, total}, " +
      "topCouriers[] + topCouriersMeta, branchDashboard. Boshqa rollarda e'tiborsiz (o'z kesimi).",
  })
  getDashboard(
    @Req() req: { user: JwtUser },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('period') period?: string,
    @Query('start_day') startDay?: string,
    @Query('end_day') endDay?: string,
    @Query('all') all?: string,
    @Query('branch_id') branchId?: string,
  ) {
    const resolvedStartDate = startDate ?? startDay;
    const resolvedEndDate = endDate ?? endDay;
    // (6CYRjoZG) noto'g'ri id — 400 (servisga yetib bormaydi).
    const trimmedBranchId = typeof branchId === 'string' ? branchId.trim() : '';
    if (trimmedBranchId && !BRANCH_ID_RE.test(trimmedBranchId)) {
      throw new BadRequestException("branch_id noto'g'ri");
    }
    return firstValueFrom(
      this.analyticsClient
        .send(
          { cmd: 'analytics.dashboard' },
          {
            requester: this.toRequester(req),
            filter: {
              startDate: resolvedStartDate,
              endDate: resolvedEndDate,
              period,
              all: all === 'true',
              ...(trimmedBranchId ? { branch_id: trimmedBranchId } : {}),
            },
          },
        )
        .pipe(timeout(8000)),
    );
  }

  // Company-wide financial reports — SUPERADMIN/ADMIN only (audit 2026-06-07:
  // these were JwtAuthGuard-only, leaking full financials to every role).
  @Get('revenue')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revenue stats by period' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  @ApiQuery({ name: 'start_day', required: false, type: String })
  @ApiQuery({ name: 'end_day', required: false, type: String })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['daily', 'weekly', 'monthly', 'yearly'],
  })
  @ApiQuery({
    name: 'all',
    required: false,
    type: Boolean,
    description:
      "(XdKajqLe) «Barchasi»: dashboard bilan AYNI oyna (eng so'nggi 366 kun). Javobda clamped, effective_from, effective_to, max_span_days.",
  })
  getRevenue(
    @Req() req: { user: JwtUser },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('period') period = 'daily',
    @Query('start_day') startDay?: string,
    @Query('end_day') endDay?: string,
    @Query('all') all?: string,
  ) {
    const resolvedStartDate = startDate ?? startDay;
    const resolvedEndDate = endDate ?? endDay;
    return firstValueFrom(
      this.analyticsClient
        .send(
          { cmd: 'analytics.revenue' },
          {
            requester: this.toRequester(req),
            filter: {
              startDate: resolvedStartDate,
              endDate: resolvedEndDate,
              period,
              ...(all === 'true' ? { all: true } : {}),
            },
          },
        )
        .pipe(timeout(8000)),
    );
  }

  @Get('kpi')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'KPI stats report',
    description:
      "Javobda: deliveryCount (yrLt5oMi — 0 bo'lsa SLA «o'lchanmagan»), previous {from,to,averageOrderValue," +
      'averageFulfillmentHours,onTimeRate,deliveryCount,cancellationRate} va series[14] {date,…} (DwrMygfo).',
  })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  @ApiQuery({ name: 'start_day', required: false, type: String })
  @ApiQuery({ name: 'end_day', required: false, type: String })
  @ApiQuery({
    name: 'all',
    required: false,
    type: Boolean,
    description:
      "(XdKajqLe) «Barchasi»: dashboard bilan AYNI oyna (eng so'nggi 366 kun). Javobda clamped, effective_from, effective_to, max_span_days.",
  })
  getKpi(
    @Req() req: { user: JwtUser },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('start_day') startDay?: string,
    @Query('end_day') endDay?: string,
    @Query('all') all?: string,
  ) {
    const resolvedStartDate = startDate ?? startDay;
    const resolvedEndDate = endDate ?? endDay;
    return firstValueFrom(
      this.analyticsClient
        .send(
          { cmd: 'analytics.kpi' },
          {
            requester: this.toRequester(req),
            filter: {
              startDate: resolvedStartDate,
              endDate: resolvedEndDate,
              ...(all === 'true' ? { all: true } : {}),
            },
          },
        )
        .pipe(timeout(10000)),
    );
  }

  @Get('reports/orders')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Order report' })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  getOrderReport(
    @Req() req: { user: JwtUser },
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return firstValueFrom(
      this.analyticsClient
        .send(
          { cmd: 'analytics.report.orders' },
          {
            requester: this.toRequester(req),
            filter: { fromDate, toDate },
          },
        )
        .pipe(timeout(12000)),
    );
  }

  @Get('reports/finance')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Finance report' })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getFinanceReport(
    @Req() req: { user: JwtUser },
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return firstValueFrom(
      this.analyticsClient
        .send(
          { cmd: 'analytics.report.finance' },
          {
            requester: this.toRequester(req),
            filter: { fromDate, toDate, page, limit },
          },
        )
        .pipe(timeout(12000)),
    );
  }

  @Get('reports/couriers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.MANAGER,
    RoleEnum.BRANCH,
    RoleEnum.REGISTRATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Courier report (operational staff only)' })
  @ApiQuery({ name: 'fromDate', required: false, type: String })
  @ApiQuery({ name: 'toDate', required: false, type: String })
  getCourierReport(
    @Req() req: { user: JwtUser },
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return firstValueFrom(
      this.analyticsClient
        .send(
          { cmd: 'analytics.report.couriers' },
          {
            requester: this.toRequester(req),
            filter: { fromDate, toDate },
          },
        )
        .pipe(timeout(12000)),
    );
  }
}
