import { of } from 'rxjs';
import { InvestorServiceService } from './investor-service.service';

/**
 * «Foydalanuvchi qo'shish» → Investor (BeePost `POST /users/investor`
 * naqshi) — `investor.login.attach`: gateway investor LOGINI yaratgach shu
 * telefondagi investor yozuvi loginga bog'lanadi, yozuv yo'q bo'lsa —
 * yaratiladi. `dry_run` — login yaratilishidan oldingi tekshiruv.
 */
type Row = {
  id: string;
  user_id: string;
  name: string;
  phone_number: string;
  isDeleted: boolean;
  share_percent?: number | null;
};

function makeService(rows: Row[] = []) {
  const investorRepo: any = {
    findOne: jest.fn(({ where }: { where: Partial<Row> }) =>
      Promise.resolve(
        rows.find(
          (row) =>
            !row.isDeleted &&
            (where.phone_number === undefined ||
              row.phone_number === where.phone_number),
        ) ?? null,
      ),
    ),
    find: jest.fn(({ where }: { where: Partial<Row> }) =>
      Promise.resolve(
        rows.filter((row) => !row.isDeleted && row.user_id === where.user_id),
      ),
    ),
    create: jest.fn((value: Partial<Row>) => ({ ...value })),
    save: jest.fn((value: Partial<Row>) =>
      Promise.resolve({ id: value.id ?? '50', ...value }),
    ),
  };
  const activityLog: any = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const service = new InvestorServiceService(
    investorRepo,
    {} as any,
    {} as any,
    activityLog,
    { send: jest.fn(() => of({})) } as any,
  );
  return { service, investorRepo, activityLog };
}

const statusOf = (err: unknown): number | undefined =>
  (err as any)?.getError?.()?.statusCode;

const SA = { id: '1', roles: ['superadmin'] };
const PHONE = '+998901234567';
const unlinked: Row = {
  id: '5',
  user_id: '0',
  name: 'Ali Investor',
  phone_number: PHONE,
  isDeleted: false,
};

describe('investor.login.attach — login ↔ investor yozuvi', () => {
  it('⭐ yozuv yo‘q — yangi investor shu login bilan yaratiladi', async () => {
    const { service, investorRepo, activityLog } = makeService();

    const res: any = await service.attachLogin(
      { user_id: '31', name: 'ali investor', phone_number: PHONE },
      SA,
    );

    expect(res.statusCode).toBe(201);
    expect(investorRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: '31',
        name: 'Ali Investor',
        phone_number: PHONE,
      }),
    );
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: 'Investor', user_id: '1' }),
    );
  });

  it('⭐ loginsiz yozuv (OPS «Yangi investor») — shu loginga bog‘lanadi, yangi yozuv yo‘q', async () => {
    const { service, investorRepo, activityLog } = makeService([
      { ...unlinked },
    ]);

    const res: any = await service.attachLogin(
      { user_id: '31', name: 'Boshqa Ism', phone_number: PHONE },
      SA,
    );

    expect(res.statusCode).toBe(200);
    expect(investorRepo.create).not.toHaveBeenCalled();
    expect(investorRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '5', user_id: '31', name: 'Ali Investor' }),
    );
    expect(activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: 'Investor', entity_id: '5' }),
    );
  });

  it('⭐ telefon boshqa loginga bog‘langan — 409 (dry_run da ham), saqlanmaydi', async () => {
    const { service, investorRepo } = makeService([
      { ...unlinked, user_id: '77' },
    ]);

    const dry = await service
      .attachLogin({ phone_number: PHONE, dry_run: true }, SA)
      .catch((e: unknown) => e);
    const real = await service
      .attachLogin({ user_id: '31', phone_number: PHONE }, SA)
      .catch((e: unknown) => e);

    expect(statusOf(dry)).toBe(409);
    expect(statusOf(real)).toBe(409);
    expect(investorRepo.save).not.toHaveBeenCalled();
  });

  it('dry_run — hech narsa yozmaydi, bog‘lanadigan yozuv id’sini qaytaradi', async () => {
    const empty = makeService();
    const withRow = makeService([{ ...unlinked }]);

    const none: any = await empty.service.attachLogin(
      { phone_number: PHONE, dry_run: true },
      SA,
    );
    const found: any = await withRow.service.attachLogin(
      { phone_number: PHONE, dry_run: true },
      SA,
    );

    expect(none.data).toEqual({ investor_id: null });
    expect(found.data).toEqual({ investor_id: '5' });
    expect(empty.investorRepo.save).not.toHaveBeenCalled();
    expect(withRow.investorRepo.save).not.toHaveBeenCalled();
  });

  it('login boshqa investorga bog‘langan — 400, saqlanmaydi', async () => {
    const { service, investorRepo } = makeService([
      { ...unlinked, id: '8', user_id: '31', phone_number: '+998907654321' },
    ]);

    const err = await service
      .attachLogin({ user_id: '31', name: 'Ali', phone_number: PHONE }, SA)
      .catch((e: unknown) => e);

    expect(statusOf(err)).toBe(400);
    expect(investorRepo.save).not.toHaveBeenCalled();
  });

  it('noto‘g‘ri telefon / user_id — 400', async () => {
    const { service } = makeService();

    const phone = await service
      .attachLogin({ user_id: '31', phone_number: '901234567' }, SA)
      .catch((e: unknown) => e);
    const user = await service
      .attachLogin({ user_id: '0', phone_number: PHONE }, SA)
      .catch((e: unknown) => e);

    expect(statusOf(phone)).toBe(400);
    expect(statusOf(user)).toBe(400);
  });
});

describe('«Ulush (%)» — share_percent (BeePost investor formasi)', () => {
  it('⭐ yangi investor ulush bilan yaratiladi', async () => {
    const { service, investorRepo } = makeService();

    await service.attachLogin(
      { user_id: '31', name: 'Ali', phone_number: PHONE, share_percent: 12.5 },
      SA,
    );

    expect(investorRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: '31', share_percent: 12.5 }),
    );
  });

  it('ulush kiritilmasa — null', async () => {
    const { service, investorRepo } = makeService();

    await service.attachLogin(
      { user_id: '31', name: 'Ali', phone_number: PHONE },
      SA,
    );

    expect(investorRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ share_percent: null }),
    );
  });

  it('⭐ loginsiz yozuvga bog‘langanda ulush ham yoziladi', async () => {
    const { service, investorRepo } = makeService([{ ...unlinked }]);

    await service.attachLogin(
      { user_id: '31', phone_number: PHONE, share_percent: 30 },
      SA,
    );

    expect(investorRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '5', user_id: '31', share_percent: 30 }),
    );
  });

  it('shu loginga bog‘langan yozuv — ulush o‘zgarsa saqlanadi, o‘zgarmasa yo‘q', async () => {
    const linked = { ...unlinked, user_id: '31', share_percent: 10 };
    const same = makeService([{ ...linked }]);
    const changed = makeService([{ ...linked }]);

    const sameRes: any = await same.service.attachLogin(
      { user_id: '31', phone_number: PHONE, share_percent: 10 },
      SA,
    );
    await changed.service.attachLogin(
      { user_id: '31', phone_number: PHONE, share_percent: 15 },
      SA,
    );

    expect(sameRes.message).toBe('investor already linked');
    expect(same.investorRepo.save).not.toHaveBeenCalled();
    expect(changed.investorRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '5', share_percent: 15 }),
    );
  });

  it.each([[101], [-1], ['abc'], [12.345]])(
    'noto‘g‘ri ulush %p — dry_run da ham 400, hech narsa yozilmaydi',
    async (share) => {
      const { service, investorRepo } = makeService();

      const dry = await service
        .attachLogin(
          { phone_number: PHONE, share_percent: share, dry_run: true },
          SA,
        )
        .catch((e: unknown) => e);

      expect(statusOf(dry)).toBe(400);
      expect(investorRepo.save).not.toHaveBeenCalled();
    },
  );
});
