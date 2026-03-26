import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Roles, rmqSend } from '@app/common';
import { successRes } from '../../../libs/common/helpers/response';

interface RequesterContext {
  id: string;
  roles?: string[];
}

interface RevenueFilter {
  startDate?: string;
  endDate?: string;
  period?: string;
}

type RevenuePeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

@Injectable()
export class AnalyticsServiceService {
  constructor(@Inject('ORDER') private readonly orderClient: ClientProxy) {}

  private unwrap<T>(response: T | { data?: T }) {
    if (
      response &&
      typeof response === 'object' &&
      'data' in response
    ) {
      return (response as { data?: T }).data ?? response;
    }
    return response;
  }

  private normalizeDateRange(filter: { startDate?: string; endDate?: string }) {
    const { startDate, endDate } = filter;

    if (!startDate || !endDate) {
      const now = new Date();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return {
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      };
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (!startDate.includes('T')) {
      start.setHours(0, 0, 0, 0);
    }
    if (!endDate.includes('T')) {
      end.setHours(23, 59, 59, 999);
    }

    return {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };
  }

  private roleSet(requester?: RequesterContext) {
    return new Set((requester?.roles ?? []).map((role) => String(role).toLowerCase()));
  }

  private normalizeRevenuePeriod(period?: string): RevenuePeriod {
    const normalized = String(period ?? 'daily').toLowerCase();
    if (normalized === 'daily' || normalized === 'weekly' || normalized === 'monthly' || normalized === 'yearly') {
      return normalized;
    }
    return 'daily';
  }

  async getDashboard(
    requester: RequesterContext | undefined,
    filter: { startDate?: string; endDate?: string },
  ) {
    const normalized = this.normalizeDateRange(filter);
    const roles = this.roleSet(requester);

    if (roles.has(Roles.COURIER)) {
      const [myStat, couriers, topCouriers] = await Promise.all([
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.courier_stat' },
          { requester, ...normalized },
        ),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.courier_stats' },
          normalized,
        ),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.top_couriers' },
          {},
        ),
      ]);

      return successRes(
        {
          myStat: this.unwrap(myStat),
          couriers: this.unwrap(couriers),
          topCouriers: this.unwrap(topCouriers),
        },
        200,
        'Dashboard infos',
      );
    }

    if (roles.has(Roles.MARKET)) {
      const [myStat, markets, topMarkets] = await Promise.all([
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.market_stat' },
          { requester, ...normalized },
        ),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.market_stats' },
          normalized,
        ),
        rmqSend(
          this.orderClient,
          { cmd: 'order.analytics.top_markets' },
          {},
        ),
      ]);

      return successRes(
        {
          myStat: this.unwrap(myStat),
          markets: this.unwrap(markets),
          topMarkets: this.unwrap(topMarkets),
        },
        200,
        'Dashboard infos',
      );
    }

    const [orders, markets, couriers, topMarkets, topCouriers] = await Promise.all([
      rmqSend(this.orderClient, { cmd: 'order.analytics.overview' }, normalized),
      rmqSend(this.orderClient, { cmd: 'order.analytics.market_stats' }, normalized),
      rmqSend(this.orderClient, { cmd: 'order.analytics.courier_stats' }, normalized),
      rmqSend(this.orderClient, { cmd: 'order.analytics.top_markets' }, {}),
      rmqSend(this.orderClient, { cmd: 'order.analytics.top_couriers' }, {}),
    ]);

    return successRes(
      {
        orders: this.unwrap(orders),
        markets: this.unwrap(markets),
        couriers: this.unwrap(couriers),
        topMarkets: this.unwrap(topMarkets),
        topCouriers: this.unwrap(topCouriers),
      },
      200,
      'Dashboard infos',
    );
  }

  async getRevenueStats(
    _requester: RequesterContext | undefined,
    filter: RevenueFilter,
  ) {
    const normalized = this.normalizeDateRange(filter);
    const period = this.normalizeRevenuePeriod(filter.period);

    const revenue = await rmqSend(
      this.orderClient,
      { cmd: 'order.analytics.revenue' },
      { ...normalized, period },
    );

    return successRes(
      revenue,
      200,
      `Revenue stats (${period})`,
    );
  }
}
