import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { firstValueFrom, timeout } from 'rxjs';

interface JwtUser {
  sub: string;
  username: string;
  roles?: string[];
}

@ApiTags('Analytics')
@Controller('analytics')
export class AnalyticsGatewayController {
  constructor(@Inject('ANALYTICS') private readonly analyticsClient: ClientProxy) {}

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
}
