/* eslint-disable @typescript-eslint/require-await -- spec mock'lari: async soxta implementatsiyalar */
import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { NOTIFICATION_TYPES, NotificationChannel } from '@app/common';
import { DispatchNotificationDto } from '../dto/dispatch-notification.dto';
import { NotificationInboxService } from '../notification-inbox.service';
import { SMS_FORBIDDEN_VARS } from '../sms/sms-template.service';
import {
  NotificationTemplateService,
  TemplateRenderError,
  defaultUzTemplates,
  pickTemplate,
  renderTemplate,
  templateSmsMeta,
} from './notification-template.service';

/**
 * C4R3YyvH — bildirishnoma shablonlari (uch til): fail-closed render, til
 * zanjiri, PII, SMS bo'laklari, katalog qamrovi va dispatch'ga ulanish.
 */
const tpl = (
  lang: 'uz' | 'ru' | 'en',
  title: string,
  body: string | null = null,
  extra: Record<string, unknown> = {},
) => ({
  id: `${lang}-${title}`,
  code: 'order.sold',
  lang,
  channel: null,
  title,
  body,
  required_vars: [] as string[],
  is_active: true,
  ...extra,
});

describe('C4R3YyvH — renderTemplate (fail-closed)', () => {
  it('required_vars dan biri data’da yo‘q → XATO, bo‘sh satr QO‘YILMAYDI', () => {
    const template = {
      title: 'Buyurtma #{{order_number}}',
      body: 'Hurmatli {{customer_label}}, buyurtmangiz sotildi',
      required_vars: ['order_number', 'customer_label'],
    };
    expect(() => renderTemplate(template, { order_number: '12' })).toThrow(
      TemplateRenderError,
    );
    try {
      renderTemplate(template, { order_number: '12', customer_label: '  ' });
    } catch (error) {
      expect((error as TemplateRenderError).missing).toEqual([
        'customer_label',
      ]);
    }
    expect(
      renderTemplate(template, { order_number: '12', customer_label: 'mijoz' }),
    ).toEqual({
      title: 'Buyurtma #12',
      body: 'Hurmatli mijoz, buyurtmangiz sotildi',
    });
  });

  it('required_vars da yo‘q, lekin matnda bor o‘zgaruvchi ham majburiy; obyekt qiymat — yo‘q deb hisoblanadi', () => {
    expect(() =>
      renderTemplate(
        { title: '{{a}}', body: null, required_vars: [] },
        { a: { nested: 1 } },
      ),
    ).toThrow(TemplateRenderError);
    expect(
      renderTemplate(
        { title: '#{{a}}', body: null, required_vars: [] },
        { a: 5 },
      ),
    ).toEqual({ title: '#5', body: null });
  });
});

describe('C4R3YyvH — til zanjiri (pickTemplate)', () => {
  const rows = [tpl('uz', 'UZ'), tpl('ru', 'RU')];

  it('til `ru` → ruscha; `en` yo‘q → `uz`; noma’lum til → `uz`', () => {
    expect(pickTemplate(rows, 'ru')?.title).toBe('RU');
    expect(pickTemplate(rows, 'en')?.title).toBe('UZ');
    expect(pickTemplate(rows, 'kk')?.title).toBe('UZ');
    expect(pickTemplate([tpl('ru', 'RU')], 'uz')).toBeNull();
  });

  it('kanal shabloni umumiydan ustun, yo‘q bo‘lsa umumiy', () => {
    const withSms = [...rows, tpl('ru', 'RU-SMS', null, { channel: 'sms' })];
    expect(pickTemplate(withSms, 'ru', 'sms')?.title).toBe('RU-SMS');
    expect(pickTemplate(withSms, 'ru', 'telegram')?.title).toBe('RU');
    expect(pickTemplate(withSms, 'en', 'sms')?.title).toBe('UZ');
  });
});

describe('C4R3YyvH — SMS bo‘laklari (DIQQAT a)', () => {
  it('lotin matn — 160 belgi qoidasi (GSM-7)', () => {
    expect(templateSmsMeta('a'.repeat(160), null)).toMatchObject({
      encoding: 'GSM-7',
      parts: 1,
    });
    expect(templateSmsMeta('a'.repeat(161), null)).toMatchObject({
      encoding: 'GSM-7',
      parts: 2,
    });
  });

  it('kirill matn — UCS-2, 70 belgi qoidasi (~2,3x qimmat)', () => {
    expect(templateSmsMeta('б'.repeat(70), null)).toMatchObject({
      encoding: 'UCS-2',
      parts: 1,
    });
    expect(templateSmsMeta('б'.repeat(71), null)).toMatchObject({
      encoding: 'UCS-2',
      parts: 2,
    });
  });
});

describe('C4R3YyvH — CI: katalogdagi HAR tur uchun `uz` shabloni', () => {
  it('defaultUzTemplates katalogni to‘liq qamraydi: uz, bo‘sh bo‘lmagan sarlavha, PII yo‘q', () => {
    const defaults = new Map(defaultUzTemplates().map((t) => [t.code, t]));
    for (const type of NOTIFICATION_TYPES) {
      const item = defaults.get(type.key);
      expect(item).toBeDefined();
      expect(item?.lang).toBe('uz');
      expect(item?.title.trim().length).toBeGreaterThan(0);
      expect(
        item?.required_vars.filter((v) =>
          (SMS_FORBIDDEN_VARS as readonly string[]).includes(v),
        ),
      ).toEqual([]);
    }
    expect(defaults.size).toBe(NOTIFICATION_TYPES.length);
  });
});

describe('C4R3YyvH — NotificationTemplateService', () => {
  let rows: Array<Record<string, unknown>>;
  let repo: Record<string, jest.Mock>;
  const make = () => new NotificationTemplateService(repo as never);

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    rows = [];
    repo = {
      find: jest.fn(async () => rows),
      findOne: jest.fn(async () => null),
      create: jest.fn((v: Record<string, unknown>) => v),
      save: jest.fn(async (v: Record<string, unknown>) => ({
        id: '1',
        updatedAt: new Date(),
        ...v,
      })),
    };
  });

  it('upsert: katalogda yo‘q code — 400; noto‘g‘ri til/kanal — 400', async () => {
    for (const input of [
      { code: 'no.such.type', lang: 'uz', title: 't' },
      { code: 'order.sold', lang: 'kk', title: 't' },
      { code: 'order.sold', lang: 'uz', channel: 'fax', title: 't' },
      { code: 'order.sold', lang: 'uz', title: '' },
    ]) {
      await expect(make().upsert(input)).rejects.toBeInstanceOf(RpcException);
    }
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('PII testi: SMS’ga ketadigan (umumiy va sms) shablonda mijoz ismi/manzili TAQIQLANGAN; telegram’da ruxsat', async () => {
    for (const channel of [null, 'sms']) {
      const error = await make()
        .upsert({
          code: 'order.sold',
          lang: 'uz',
          channel,
          title: 'Hurmatli {{customer_name}}',
          body: '{{address}}',
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RpcException);
      expect(JSON.stringify((error as RpcException).getError())).toMatch(/PII/);
    }
    await expect(
      make().upsert({
        code: 'order.sold',
        lang: 'uz',
        channel: 'telegram',
        title: 'Hurmatli {{customer_name}}',
      }),
    ).resolves.toMatchObject({ statusCode: 201 });
  });

  it('upsert: required_vars matndagi o‘zgaruvchilar bilan to‘ldiriladi, javobda encoding/parts', async () => {
    const res = (await make().upsert({
      code: 'order.sold',
      lang: 'ru',
      title: 'Заказ #{{order_number}} продан',
      required_vars: ['status'],
      requester: { id: '1' },
    })) as { data: Record<string, unknown> };
    expect(res.data).toMatchObject({
      code: 'order.sold',
      lang: 'ru',
      channel: null,
      required_vars: ['status', 'order_number'],
      encoding: 'UCS-2',
      parts: 1,
      updated_by: '1',
    });
  });

  it('list: DB’da uz yozuvi bor tur sukutlarda TAKRORLANMAYDI', async () => {
    rows = [
      {
        ...tpl('uz', 'Sotildi (DB)'),
        updatedAt: new Date(),
      },
    ];
    const res = (await make().list({})) as {
      data: { items: unknown[]; defaults: Array<{ code: string }> };
    };
    expect(res.data.items).toHaveLength(1);
    expect(res.data.defaults.map((d) => d.code)).not.toContain('order.sold');
    expect(res.data.defaults.length).toBe(NOTIFICATION_TYPES.length - 1);
  });

  it('forDispatch: DB’da shablon YO‘Q → null (xom DTO matni), til so‘ralmaydi', async () => {
    const languagesOf = jest.fn();
    expect(
      await make().forDispatch('order.sold', {}, ['1'], languagesOf),
    ).toBeNull();
    expect(languagesOf).not.toHaveBeenCalled();
  });

  it('forDispatch: ru → ruscha, en (shablon yo‘q) → uz; faqat uz shablon bo‘lsa til so‘ralmaydi', async () => {
    rows = [tpl('uz', 'Sotildi #{{n}}'), tpl('ru', 'Продан #{{n}}')];
    const languagesOf = jest.fn(
      async () =>
        new Map([
          ['1', 'ru'],
          ['2', 'en'],
          ['3', null],
        ]),
    );
    const texts = await make().forDispatch(
      'order.sold',
      { n: 7 },
      ['1', '2', '3'],
      languagesOf,
    );
    expect(texts?.textFor('1')).toEqual({ title: 'Продан #7', body: null });
    expect(texts?.textFor('2')).toEqual({ title: 'Sotildi #7', body: null });
    expect(texts?.textFor('3')).toEqual({ title: 'Sotildi #7', body: null });
    expect(texts?.stats).toMatchObject({
      applied: 3,
      fallback_raw: 0,
      by_lang: { ru: 1, en: 1, uz: 1 },
    });

    rows = [tpl('uz', 'Sotildi')];
    languagesOf.mockClear();
    await make().forDispatch('order.sold', {}, ['1'], languagesOf);
    expect(languagesOf).not.toHaveBeenCalled();
  });

  it('forDispatch: o‘zgaruvchi yetishmasa — o‘sha qabul qiluvchiga xom matn (null), sabab stats.errors da', async () => {
    rows = [tpl('uz', 'Sotildi #{{order_number}}')];
    const texts = await make().forDispatch('order.sold', {}, ['1'], jest.fn());
    expect(texts?.textFor('1')).toBeNull();
    expect(texts?.stats.fallback_raw).toBe(1);
    expect(texts?.stats.errors[0]).toMatch(/order_number/);
  });
});

describe('C4R3YyvH — dispatch: DB shablon matnni almashtiradi, yo‘q bo‘lsa xom matn', () => {
  let store: Map<string, Record<string, unknown>>;
  let templateRows: Array<Record<string, unknown>>;
  let contacts: jest.Mock;
  let service: NotificationInboxService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let nextId = 1;
    store = new Map();
    templateRows = [];
    const txRepo = {
      create: jest.fn((v: Record<string, unknown>) => ({ ...v })),
      insert: jest.fn((rows: Array<Record<string, unknown>>) =>
        Promise.resolve({
          identifiers: rows.map((row) => {
            const id = String(nextId++);
            store.set(id, { id, ...row });
            return { id };
          }),
        }),
      ),
      find: jest.fn(({ where }: { where: { id: { value: string[] } } }) =>
        Promise.resolve((where.id?.value ?? []).map((id) => store.get(id))),
      ),
    };
    const manager = { getRepository: () => txRepo };
    const repo = {
      manager: {
        transaction: (work: (m: unknown) => Promise<unknown>) => work(manager),
      },
      createQueryBuilder: () => {
        const qb: Record<string, jest.Mock> = {};
        for (const key of ['update', 'set', 'setParameter', 'whereInIds'])
          qb[key] = jest.fn(() => qb);
        qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
        return qb;
      },
    };
    contacts = jest.fn(
      async (ids: string[]) =>
        new Map(
          ids.map((id) => [id, { id, language: id === '11' ? 'ru' : 'uz' }]),
        ),
    );
    const templates = new NotificationTemplateService({
      find: jest.fn(async () => templateRows),
    } as never);
    service = new NotificationInboxService(
      repo as never,
      { send: jest.fn() } as never,
      { emit: jest.fn(() => of(null)) } as never,
      { sendNotification: jest.fn() } as never,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { enqueue: jest.fn() } as never,
      {
        assertFanout: jest.fn(),
        queueForNotifications: jest.fn(),
        contacts,
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      templates,
    );
  });

  const dto = (extra: Partial<DispatchNotificationDto> = {}) =>
    ({
      type: 'order.sold',
      title: 'Buyurtma sotildi',
      body: 'Buyurtma #77 sotildi.',
      data: { order_number: '77' },
      recipient_ids: ['11', '12'],
      channels: [NotificationChannel.IN_APP],
      ...extra,
    }) as DispatchNotificationDto;

  const textOf = (recipient: string) => {
    const row = [...store.values()].find((r) => r.recipient_id === recipient);
    return { title: row?.title, body: row?.body };
  };

  it('shablon umuman topilmasa — DTO’dagi xom title/body, dispatch yiqilmaydi', async () => {
    const res = (await service.dispatch(dto())) as {
      data: Record<string, unknown>;
    };
    expect(res.data.dispatched).toBe(2);
    expect(textOf('11')).toEqual({
      title: 'Buyurtma sotildi',
      body: 'Buyurtma #77 sotildi.',
    });
    expect(res.data.template).toBeUndefined();
    expect(contacts).not.toHaveBeenCalled();
  });

  it('ru foydalanuvchiga ruscha, uz ga o‘zbekcha shablon — qatorga renderlangan matn yoziladi', async () => {
    templateRows = [
      tpl('uz', 'Sotildi', '#{{order_number}} sotildi'),
      tpl('ru', 'Продан', 'Заказ #{{order_number}} продан'),
    ];
    const res = (await service.dispatch(dto())) as {
      data: Record<string, any>;
    };
    expect(textOf('11')).toEqual({
      title: 'Продан',
      body: 'Заказ #77 продан',
    });
    expect(textOf('12')).toEqual({ title: 'Sotildi', body: '#77 sotildi' });
    expect(res.data.template).toMatchObject({
      code: 'order.sold',
      applied: 2,
      by_lang: { ru: 1, uz: 1 },
    });
  });

  it('o‘zgaruvchi yetishmasa — asl (xom) matn, buzuq matn emas', async () => {
    templateRows = [tpl('uz', 'Sotildi', '#{{missing_var}}')];
    await service.dispatch(dto());
    expect(textOf('12')).toEqual({
      title: 'Buyurtma sotildi',
      body: 'Buyurtma #77 sotildi.',
    });
  });
});
