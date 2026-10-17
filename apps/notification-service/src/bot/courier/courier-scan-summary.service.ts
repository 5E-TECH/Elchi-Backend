import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  rmqSend,
} from '@app/common';
import { successRes } from '../../../../../libs/common/helpers/response';
import { NotificationInboxService } from '../../notification-inbox.service';
import { COURIER_ACTIONS } from './courier-cards';

/** Bitta "Tayyor" da hisobga olinadigan eng ko'p buyurtma. */
export const SCAN_DONE_MAX_ORDERS = 200;

const ID_RE = /^\d{1,20}$/;

type OrderListResponse = {
  data?: { data?: unknown; items?: unknown } | unknown[];
};

function rowsOf(response: OrderListResponse | null): unknown[] {
  const data = response?.data;
  if (Array.isArray(data)) return data;
  const nested = data as { data?: unknown; items?: unknown } | undefined;
  if (Array.isArray(nested?.data)) return nested.data;
  if (Array.isArray(nested?.items)) return nested.items;
  return [];
}

/**
 * (MWYaqprw #6) Skan Mini App'ida "✅ Tayyor" — botga xulosa xabari:
 * "N ta buyurtma qabul qilindi" + "📋 Topshiriqlarim" (`/ishim` 1-sahifa).
 *
 * Son mijozdan OLINMAYDI: Mini App skan qilgan id'larni yuboradi, server esa
 * faqat HOZIR shu kuryerda yo'lda (`on the road`) turganlarini sanaydi —
 * boshqa kuryerniki yoki o'ylab topilgan id hisobga kirmaydi. Xabar
 * `notification.dispatch` orqali (in-app + kuryerning shaxsiy Telegram'i);
 * kuryer bog'lanmagan bo'lsa Telegram `skipped`, in-app baribir yoziladi.
 */
@Injectable()
export class CourierScanSummaryService {
  private readonly logger = new Logger(CourierScanSummaryService.name);

  constructor(
    @Inject('ORDER') private readonly orders: ClientProxy,
    private readonly moduleRef: ModuleRef,
  ) {}

  async summarize(payload: { courier_id?: unknown; order_ids?: unknown }) {
    const courierId =
      typeof payload?.courier_id === 'string' ? payload.courier_id.trim() : '';
    if (!ID_RE.test(courierId)) {
      throw new RpcException({ statusCode: 401, message: 'Unauthorized' });
    }
    const raw = Array.isArray(payload?.order_ids) ? payload.order_ids : [];
    const ids = [
      ...new Set(
        raw
          .map((id) => (typeof id === 'string' ? id.trim() : String(id ?? '')))
          .filter((id) => ID_RE.test(id)),
      ),
    ];
    if (!ids.length || ids.length > SCAN_DONE_MAX_ORDERS) {
      throw new RpcException({
        statusCode: 400,
        message: `order_ids: 1..${SCAN_DONE_MAX_ORDERS} ta buyurtma id`,
      });
    }

    const response = await rmqSend<OrderListResponse>(
      this.orders,
      { cmd: 'order.find_all' },
      {
        query: {
          courier_ids: [courierId],
          status: ['on the road'],
          fetch_all: true,
        },
      },
      { timeoutMs: 8_000, retries: 1 },
    );
    const mine = new Set(
      rowsOf(response).map((row) => {
        const id = (row as { id?: unknown } | null)?.id;
        return typeof id === 'string' || typeof id === 'number'
          ? String(id)
          : '';
      }),
    );
    const accepted = ids.filter((id) => mine.has(id));
    const ignored = ids.length - accepted.length;

    const lines = [`✅ ${accepted.length} ta buyurtma qabul qilindi.`];
    if (ignored) {
      lines.push(
        `⚠️ ${ignored} tasi sizda yo'lda emas — hisobga olinmadi (kabinetda tekshiring).`,
      );
    }
    const inbox = this.moduleRef.get(NotificationInboxService, {
      strict: false,
    });
    await inbox.dispatch({
      type: 'courier.scan_summary',
      category: NotificationCategory.SYSTEM,
      priority: NotificationPriority.NORMAL,
      title: '📷 Skan yakunlandi',
      body: lines.join('\n'),
      recipient_id: courierId,
      channels: [NotificationChannel.IN_APP, NotificationChannel.TELEGRAM],
      data: {
        accepted: accepted.length,
        ignored,
        telegram_buttons: [
          [
            {
              text: '📋 Topshiriqlarim',
              action: COURIER_ACTIONS.page,
              payload: { page: 1 },
              one_shot: false,
            },
          ],
        ],
      },
    } as never);
    this.logger.log(
      `skan xulosasi: kuryer=${courierId} qabul=${accepted.length} e'tiborsiz=${ignored}`,
    );
    return successRes(
      { accepted: accepted.length, ignored },
      200,
      'Skan xulosasi yuborildi',
    );
  }
}
