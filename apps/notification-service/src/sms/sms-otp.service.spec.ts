import { RpcException } from '@nestjs/microservices';
import { SmsBlockedError } from './sms-gate.service';
import { SmsOtpService } from './sms-otp.service';

/**
 * rkz0yBxr #6/#7 — OTP SMS: `security` sinfi, 'otp' akkaunt/alfa-nomi,
 * alohida oqim. Real SMS yo'q — navbat (outbox) mock.
 */
describe('SmsOtpService (rkz0yBxr)', () => {
  let outbox: { enqueue: jest.Mock };
  let registry: { hasAccount: jest.Mock };
  let templates: { resolve: jest.Mock };
  const make = () =>
    new SmsOtpService(outbox as never, registry as never, templates as never);
  const input = {
    phone: '+998901234567',
    code: '123456',
    otp_id: '42',
    lang: 'uz',
  };

  beforeEach(() => {
    outbox = {
      enqueue: jest.fn().mockResolvedValue({
        queued: [{ id: '1' }],
        skipped: [],
        estimated_cost: null,
      }),
    };
    registry = { hasAccount: jest.fn().mockResolvedValue(true) };
    templates = { resolve: jest.fn().mockResolvedValue(null) };
  });

  it("security sinfi + 'otp' profil (reklama alfa-nomi EMAS) + barqaror client_message_id", async () => {
    await expect(make().send(input)).resolves.toEqual({ queued: true });
    expect(registry.hasAccount).toHaveBeenCalledWith('otp');
    const [[rows]] = outbox.enqueue.mock.calls as [[Array<{ text: string }>]];
    expect(rows).toEqual([
      expect.objectContaining({
        to: '+998901234567',
        messageClass: 'security',
        senderProfile: 'otp',
        clientMessageId: 'otp-42',
      }),
    ]);
    expect(rows[0].text).toContain('123456');
  });

  it("'otp' akkaunti sozlanmagan — 503, umumiy (reklama) akkauntga TUSHMAYDI", async () => {
    registry.hasAccount.mockResolvedValue(false);
    const error = await make()
      .send(input)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 503,
      reason: 'provider_not_configured',
    });
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('OTP kvotasi tugasa (alohida oqim) — aniq sabab bilan 503', async () => {
    outbox.enqueue.mockRejectedValue(
      new SmsBlockedError(
        'daily_cap_exceeded',
        'Kunlik OTP SMS kvotasi tugadi',
        { stream: 'otp' },
      ),
    );
    const error = await make()
      .send(input)
      .catch((e: unknown) => e);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 503,
      reason: 'daily_cap_exceeded',
    });
  });

  it("noto'g'ri kod/otp_id — 400, navbatga hech narsa", async () => {
    await expect(make().send({ ...input, code: 'abc' })).rejects.toBeInstanceOf(
      RpcException,
    );
    await expect(make().send({ ...input, otp_id: '' })).rejects.toBeInstanceOf(
      RpcException,
    );
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
