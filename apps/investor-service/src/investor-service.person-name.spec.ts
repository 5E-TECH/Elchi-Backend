import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Status } from '@app/common';
import { InvestorServiceService } from './investor-service.service';

/**
 * Ega qarori 2026-11-04: «ism so'ragan har qanday joyda birinchi harf katta —
 * kichik kiritsak ham». Investor — shaxs (forma «Investor ismi», «Ism va
 * familiya»): `POST /investors` va `PATCH /investors/:id` da nom
 * `normalizePersonName` bilan saqlanadi. Eski yozuvlar ko'chirilmaydi:
 * o'zgarmagan ism tegilmaydi.
 */
type Row = Record<string, unknown>;

const STORED = {
  id: '7',
  user_id: '0',
  name: 'akmal karimov',
  phone_number: '+998901112233',
  status: Status.ACTIVE,
  description: null,
  isDeleted: false,
};

function makeService(stored: Row | null = null) {
  const investorRepo = {
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(stored && where.id === stored.id ? { ...stored } : null),
    ),
    create: jest.fn((dto: Row) => ({ ...dto })),
    save: jest.fn((row: Row) =>
      Promise.resolve({ id: row.id ?? '99', ...row }),
    ),
  };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const financeClient = { send: jest.fn(() => of({ data: {} })) };
  const service = new InvestorServiceService(
    investorRepo as never,
    {} as never, // investment
    {} as never, // profit share
    activityLog as never,
    financeClient as never,
  );
  return { service, investorRepo };
}

describe('2026-11-04 — investor nomi (odam ismi)', () => {
  it('POST /investors: «akmal  karimov» → «Akmal Karimov»', async () => {
    const t = makeService();
    await t.service.createInvestor({
      name: '  akmal  karimov ',
      phone_number: '+998901234567',
    });
    expect(t.investorRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Akmal Karimov' }),
    );
  });

  it('POST /investors: faqat bo`shliq — 400 «Nomi majburiy» (avvalgidek)', async () => {
    const t = makeService();
    const error: unknown = await t.service
      .createInvestor({
        name: '   ',
        phone_number: '+998901234567',
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 400,
      message: 'Nomi majburiy',
    });
    expect(t.investorRepo.save).not.toHaveBeenCalled();
  });

  it('PATCH /investors/:id: yangi ism «vali valiyev» → «Vali Valiyev»', async () => {
    const t = makeService(STORED);
    await t.service.updateInvestor('7', { name: 'vali valiyev' });
    expect(t.investorRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Vali Valiyev' }),
    );
  });

  it('PATCH /investors/:id: o`zgarmagan eski (kichik harfli) ism tegilmaydi — ko`chirish yo`q', async () => {
    const t = makeService(STORED);
    await t.service.updateInvestor('7', {
      name: 'akmal karimov',
      description: 'yangi izoh',
    });
    expect(t.investorRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'akmal karimov',
        description: 'yangi izoh',
      }),
    );
  });
});
