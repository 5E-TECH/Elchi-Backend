import { PlayMobileAdapter } from './playmobile.adapter';
import type { SmsPort } from '../sms.port';

/**
 * 8auPBa1O #8 — ikkinchi provayder skeleti port shakliga mos (provayder
 * almashtirilganda yadro o'zgarmaydi). Real so'rov YO'Q — fetch mock.
 */
describe('PlayMobileAdapter (port shape, 8auPBa1O #8)', () => {
  const creds = { login: 'l', password: 'p', sender: 'S' };

  it('SmsPort: send/parseDeliveryReport/getBalance', async () => {
    const port: SmsPort = new PlayMobileAdapter(creds, jest.fn() as never);
    expect(port.provider).toBe('playmobile');
    await expect(port.getBalance()).resolves.toBeNull();
  });

  it('recipient — 12 raqam 998XXXXXXXXX (+ siz), message-id BIZNIKI (≤40 belgi)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const adapter = new PlayMobileAdapter(creds, fetchMock as never);
    const clientMessageId = 'camp-12-998901234567-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const result = await adapter.send({
      to: '+998901234567',
      text: 'Salom',
      messageClass: 'transactional',
      clientMessageId,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const [message] = body.messages;
    expect(message.recipient).toBe('998901234567');
    expect(message.recipient).toHaveLength(12);
    expect(message['message-id'].length).toBeLessThanOrEqual(40);
    expect(result.providerMessageId).toBe(message['message-id']);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toMatch(/^Basic /);
  });

  it('5xx → retryable, 4xx → terminal', async () => {
    const make = (status: number) =>
      new PlayMobileAdapter(
        creds,
        jest.fn().mockResolvedValue({ ok: false, status }) as never,
      ).send({
        to: '+998901234567',
        text: 't',
        messageClass: 'transactional',
        clientMessageId: 'c',
      });
    await expect(make(503)).rejects.toMatchObject({ retryable: true });
    await expect(make(400)).rejects.toMatchObject({ retryable: false });
  });

  it('DLR BIZNING cmid bo‘yicha va yagona lug‘atga (NotDelivered → not_delivered)', () => {
    const adapter = new PlayMobileAdapter(creds, jest.fn() as never);
    expect(
      adapter.parseDeliveryReport({
        query: { cmid: 'notif-1' },
        body: { status: 'NotDelivered' },
      }),
    ).toMatchObject({ clientMessageId: 'notif-1', status: 'not_delivered' });
    expect(
      adapter.parseDeliveryReport({ query: {}, body: { status: 'Delivered' } }),
    ).toBeNull();
  });
});
