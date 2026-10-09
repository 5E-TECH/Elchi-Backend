import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import * as common from '@app/common';
import {
  FREE_NOTIFICATION_TYPE_PREFIX,
  IsNotificationType,
  NOTIFICATION_TYPES,
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  findNotificationType,
  isKnownNotificationType,
  notificationTypeErrorMessage,
  renderNotificationGroupKey,
  resolveNotificationDefaults,
} from '@app/common';

/**
 * Eh8y21Ha — bildirishnoma turlari reyestri: yagona manba, fail-closed
 * validatsiya, katalogdan sukutlar.
 */
const ROOT = join(__dirname, '..', '..', '..', '..');

describe('NOTIFICATION_TYPES katalogi (Eh8y21Ha)', () => {
  it('TC1: @app/common dan eksport qilinadi', () => {
    expect(common.NOTIFICATION_TYPES).toBe(NOTIFICATION_TYPES);
    expect(typeof common.findNotificationType).toBe('function');
    expect(typeof common.IsNotificationType).toBe('function');
  });

  it('TC2: kamida 20 ta tur, har birida barcha maydonlar to‘liq, kalitlar takrorlanmaydi', () => {
    expect(NOTIFICATION_TYPES.length).toBeGreaterThanOrEqual(20);
    const keys = new Set<string>();
    for (const entry of NOTIFICATION_TYPES) {
      expect(entry.key).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(keys.has(entry.key)).toBe(false);
      keys.add(entry.key);
      expect(Object.values(NotificationCategory)).toContain(entry.category);
      expect(Object.values(NotificationPriority)).toContain(entry.priority);
      expect(entry.default_channels.length).toBeGreaterThan(0);
      entry.default_channels.forEach((channel) =>
        expect(Object.values(NotificationChannel)).toContain(channel),
      );
      expect(entry.default_channels).toContain(NotificationChannel.IN_APP);
      expect(entry.label_uz.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(entry.default_audience)).toBe(true);
      expect(typeof entry.user_can_mute).toBe('boolean');
      expect(
        entry.group_key_pattern === null ||
          typeof entry.group_key_pattern === 'string',
      ).toBe(true);
    }
  });

  it('kartadagi majburiy turlar ro‘yxati to‘liq', () => {
    for (const key of [
      'order.created',
      'order.accepted',
      'order.on_way',
      'order.sold',
      'order.cancelled',
      'order.partly_cancelled',
      'order.returned',
      'order.exchanged',
      'order.not_accepted',
      'finance.payment_received',
      'finance.settlement_closed',
      'finance.manual_expense',
      'branch.transfer_sent',
      'branch.transfer_received',
      'logistics.assigned',
      'logistics.return_approved',
      'account.password_changed',
      'account.login_new_device',
      'integration.sync_failed',
      'marketing.promo',
      'system.announcement',
    ]) {
      expect(findNotificationType(key)).toBeDefined();
    }
  });

  it('TC3: har `category` — migrations/1716000000008 dagi Postgres ENUM qiymatlaridan biri (yangi ENUM kerak emas)', () => {
    const sql = readFileSync(
      join(ROOT, 'migrations', '1716000000008-CreateNotifications.ts'),
      'utf8',
    );
    const match = /notifications_category_enum" AS ENUM\s*\(([^)]*)\)/.exec(
      sql,
    );
    expect(match).not.toBeNull();
    const dbValues = (match?.[1] ?? '')
      .split(',')
      .map((value) => value.trim().replace(/'/g, ''));
    for (const entry of NOTIFICATION_TYPES) {
      expect(dbValues).toContain(entry.category);
    }
  });

  it('`integration.sync_failed` va `ai.*` — category: system (enumda integration/ai yo‘q)', () => {
    expect(findNotificationType('integration.sync_failed')?.category).toBe(
      NotificationCategory.SYSTEM,
    );
    expect(findNotificationType('ai.cap_warning')?.category).toBe(
      NotificationCategory.SYSTEM,
    );
  });

  it('TC12: `critical` prioritetli turlarda user_can_mute=false', () => {
    const critical = NOTIFICATION_TYPES.filter(
      (entry) => entry.priority === NotificationPriority.CRITICAL,
    );
    expect(critical.length).toBeGreaterThan(0);
    critical.forEach((entry) => expect(entry.user_can_mute).toBe(false));
  });

  it('admin formasi yuboradigan `${category}.manual` — har 7 kategoriya uchun bor (eski klient buzilmaydi)', () => {
    for (const category of Object.values(NotificationCategory)) {
      expect(findNotificationType(`${category}.manual`)?.category).toBe(
        category,
      );
    }
  });
});

describe('type validatsiyasi — fail-closed (Eh8y21Ha TC4/TC5)', () => {
  class Dto {
    @IsNotificationType()
    type!: string;
  }
  const errorsOf = (type: unknown) =>
    validateSync(plainToInstance(Dto, { type }) as object);

  it('TC4: reyestrda yo‘q tur — xato, matnda ruxsat etilgan `x.` prefiksi tushuntiriladi', () => {
    for (const bad of ['asdf', 'order.unknown', 'x.', '', 'X order']) {
      expect(isKnownNotificationType(bad)).toBe(false);
    }
    const errors = errorsOf('asdf');
    expect(errors).toHaveLength(1);
    const message = Object.values(errors[0].constraints ?? {})[0];
    expect(message).toContain('"x."');
    expect(message).toContain('GET /notifications/types');
    expect(notificationTypeErrorMessage('asdf')).toContain('asdf');
  });

  it('TC5: `x.` prefiksli erkin tur o‘tadi (vaqtinchalik yo‘l ochiq)', () => {
    expect(FREE_NOTIFICATION_TYPE_PREFIX).toBe('x.');
    expect(isKnownNotificationType('x.bench')).toBe(true);
    expect(errorsOf('x.audit')).toHaveLength(0);
    expect(errorsOf('order.sold')).toHaveLength(0);
  });
});

describe('katalog sukutlari (Eh8y21Ha TC6/TC7/TC8)', () => {
  it('TC6/TC7: category/priority berilmasa katalogdan (qattiq SYSTEM/NORMAL emas)', () => {
    const resolved = resolveNotificationDefaults({
      type: 'order.cancelled',
      data: { order_id: '81' },
    });
    expect(resolved.category).toBe(NotificationCategory.ORDER);
    expect(resolved.priority).toBe(NotificationPriority.HIGH);
  });

  it('DTO qiymati DOIM ustun', () => {
    const resolved = resolveNotificationDefaults({
      type: 'order.cancelled',
      category: NotificationCategory.FINANCE,
      priority: NotificationPriority.LOW,
      group_key: 'custom',
      channels: [NotificationChannel.IN_APP],
    });
    expect(resolved).toEqual({
      category: NotificationCategory.FINANCE,
      priority: NotificationPriority.LOW,
      group_key: 'custom',
      channels: [NotificationChannel.IN_APP],
    });
  });

  it('TC8: group_key `group_key_pattern` + data dan; o‘zgaruvchi yetishmasa UMUMAN berilmaydi (bo‘sh satr emas)', () => {
    expect(
      resolveNotificationDefaults({
        type: 'order.sold',
        data: { order_id: 81 },
      }).group_key,
    ).toBe('order:81:status');
    for (const data of [
      undefined,
      {},
      { order_id: '' },
      { order_id: '  ' },
      { order_id: { nested: 1 } },
    ]) {
      expect(
        resolveNotificationDefaults({ type: 'order.sold', data }).group_key,
      ).toBeNull();
    }
    expect(renderNotificationGroupKey(null, { a: 1 })).toBeNull();
    // Pattern yo'q tur — group_key yo'q.
    expect(
      resolveNotificationDefaults({ type: 'system.announcement', data: {} })
        .group_key,
    ).toBeNull();
  });

  it('`x.` tur — eski sukutlar (SYSTEM / NORMAL / in_app+realtime)', () => {
    expect(resolveNotificationDefaults({ type: 'x.test' })).toEqual({
      category: NotificationCategory.SYSTEM,
      priority: NotificationPriority.NORMAL,
      group_key: null,
      channels: [NotificationChannel.IN_APP, NotificationChannel.REALTIME],
    });
  });
});

/**
 * TC10 (CI): repodagi `notification.dispatch` chaqiruvchi fayllardagi barcha
 * tur satrlari katalogda bor. Statik skan — yangi chaqiruvchi katalogga
 * qo'shilmagan tur yuborsa shu test yiqiladi (prodda 400 o'rniga).
 */
describe('CI: koddagi barcha dispatch `type` satrlari katalogda (Eh8y21Ha TC10)', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (name === 'node_modules' || name === 'dist') return [];
      return statSync(full).isDirectory() ? walk(full) : [full];
    });

  const DOMAIN_RE =
    /['"`]((?:order|finance|branch|logistics|account|system|marketing|integration|ai)\.[a-z_]+)['"`]/g;

  it('dispatch qiluvchi har fayldagi `{domen}.{hodisa}` literal — katalogda', () => {
    const callers = walk(join(ROOT, 'apps'))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .filter((file) => {
        const src = readFileSync(file, 'utf8');
        return (
          /notification\.dispatch/.test(src) &&
          // gateway/notification-service — qabul qiluvchi tomon, chaqiruvchi emas
          !file.includes(join('apps', 'notification-service')) &&
          !file.includes(join('apps', 'api-gateway'))
        );
      });
    // ai-service (ai.cap_*) va order-service (order.*) — kamida shular.
    expect(callers.some((file) => file.includes('ai-budget.notifier'))).toBe(
      true,
    );
    expect(
      callers.some((file) => file.includes('order-notification.service')),
    ).toBe(true);

    const unknown: string[] = [];
    let seen = 0;
    for (const file of callers) {
      const src = readFileSync(file, 'utf8');
      for (const match of src.matchAll(DOMAIN_RE)) {
        seen += 1;
        if (!isKnownNotificationType(match[1])) {
          unknown.push(`${file.replace(ROOT, '')}: ${match[1]}`);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(unknown).toEqual([]);
  });
});
