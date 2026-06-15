import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
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
}

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
    };
  }

  @Get('dashboard')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dashboard statistics by requester role' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  getDashboard(
    @Req() req: { user: JwtUser },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return firstValueFrom(
      this.analyticsClient
        .send(
          { cmd: 'analytics.dashboard' },
          {
            requester: this.toRequester(req),
            filter: { startDate, endDate },
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
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['daily', 'weekly', 'monthly', 'yearly'],
  })
  getRevenue(
    @Req() req: { user: JwtUser },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('period') period = 'daily',
  ) {
    return firstValueFrom(
      this.analyticsClient
        .send(
          { cmd: 'analytics.revenue' },
          {
            requester: this.toRequester(req),
            filter: { startDate, endDate, period },
          },
        )
        .pipe(timeout(8000)),
    );
  }

  @Get('kpi')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'KPI stats report' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  getKpi(
    @Req() req: { user: JwtUser },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return firstValueFrom(
      this.analyticsClient
        .send(
          { cmd: 'analytics.kpi' },
          {
            requester: this.toRequester(req),
            filter: { startDate, endDate },
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
