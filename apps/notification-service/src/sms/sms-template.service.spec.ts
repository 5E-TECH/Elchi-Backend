import { Logger } from '@nestjs/common';
import { SmsTemplateService, renderSmsTemplate } from './sms-template.service';

describe('renderSmsTemplate', () => {
  it('fills all variables', () => {
    expect(
      renderSmsTemplate(
        'Buyurtma #{{order_number}}: {{status}}',
        { order_number: 'EL-1', status: 'yetkazildi' },
        ['order_number'],
      ),
    ).toBe('Buyurtma #EL-1: yetkazildi');
  });

  it('a missing/blank required variable is an ERROR — no "Hurmatli , ..." texts', () => {
    expect(() =>
      renderSmsTemplate('Hurmatli {{x}}', { x: '  ' }, ['x']),
    ).toThrow(/x/);
    expect(() => renderSmsTemplate('Buyurtma #{{order_number}}', {})).toThrow(
      /order_number/,
    );
  });
});

describe('SmsTemplateService', () => {
  let repo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    find: jest.Mock;
  };
  let service: SmsTemplateService;
  beforeEach(() => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((v) => Promise.resolve({ id: '1', ...v })),
      create: jest.fn((v) => v),
      find: jest.fn(),
    };
    service = new SmsTemplateService(repo as never);
  });

  it('rejects PII variables (name/address/products) — PII minimum', async () => {
    await expect(
      service.upsert({
        code: 'order.x',
        message_class: 'transactional',
        lang: 'uz',
        text: 'Hurmatli {{customer_name}}',
      }),
    ).rejects.toThrow(/PII|shaxsiy/);
  });

  it('changing the text clears provider_template_id (operator re-approval)', async () => {
    repo.findOne.mockResolvedValue({
      id: '1',
      code: 'promo.a',
      lang: 'uz',
      text: 'eski',
      provider_template_id: 'P-1',
      is_active: true,
    });
    const changed = await service.upsert({
      code: 'promo.a',
      message_class: 'promo',
      lang: 'uz',
      text: 'yangi',
    });
    expect(changed.provider_template_id).toBeNull();
    expect(changed.needs_provider_approval).toBe(true);

    repo.findOne.mockResolvedValue({
      id: '1',
      code: 'promo.a',
      lang: 'uz',
      text: 'yangi',
      provider_template_id: 'P-2',
      is_active: true,
    });
    const same = await service.upsert({
      code: 'promo.a',
      message_class: 'promo',
      lang: 'uz',
      text: 'yangi',
    });
    expect(same.provider_template_id).toBe('P-2');
  });

  it('reports encoding/parts', async () => {
    const saved = await service.upsert({
      code: 'ru.x',
      message_class: 'transactional',
      lang: 'ru',
      text: 'Заказ доставлен',
    });
    expect(saved.encoding).toBe('UCS-2');
    expect(saved.parts).toBe(1);
  });

  it('picks the customer language, falls back to uz and logs it', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    repo.findOne
      .mockResolvedValueOnce({ code: 'otp.login', lang: 'ru', text: 'ru' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ code: 'otp.login', lang: 'uz', text: 'uz' });
    expect((await service.resolve('otp.login', 'ru'))?.lang).toBe('ru');
    expect((await service.resolve('otp.login', 'en'))?.lang).toBe('uz');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("'uz' ga fallback"),
    );
    warn.mockRestore();
  });
});
