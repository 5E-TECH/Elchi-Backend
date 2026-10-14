/* eslint-disable @typescript-eslint/require-await -- spec mock'lari: async soxta implementatsiyalar */
import { RpcException } from '@nestjs/microservices';
import {
  AUDIENCE_SAMPLE_SIZE,
  AudiencePreviewService,
} from './audience-preview.service';
import { AudienceSegmentService } from './audience-segment.service';
import { SEGMENT_KEYS } from './audience-request';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
  };
});

/**
 * ebSV5oyP — auditoriya konstruktori (backend): namuna (≤20, telefon
 * maskalangan), bo'sh auditoriya matni, buyurtmalar soni "gacha",
 * saqlangan segment (nom bilan, jonli son).
 */
const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException)
      return error.getError() as { statusCode: number; message: string };
    throw error;
  }
  throw new Error('expected RpcException');
};

const pushRepo = () => ({
  createQueryBuilder: jest.fn(() => {
    const qb: Record<string, jest.Mock> = {};
    qb.select = jest.fn(() => qb);
    qb.where = jest.fn(() => qb);
    qb.getRawOne = jest.fn(() => Promise.resolve({ count: '0' }));
    return qb;
  }),
});

describe('ebSV5oyP — preview namunasi va bo‘sh auditoriya', () => {
  let segmentsRepo: { findOne: jest.Mock };
  let service: AudiencePreviewService;

  beforeEach(() => {
    rmqSendMock.mockReset();
    segmentsRepo = { findOne: jest.fn() };
    service = new AudiencePreviewService(
      { send: jest.fn() } as never,
      pushRepo() as never,
      { get: jest.fn(() => undefined) } as never,
      segmentsRepo as never,
    );
  });

  const page = (n: number, withContact = false) => ({
    data: {
      items: Array.from({ length: n }, (_, i) => ({
        id: String(i + 1),
        role: 'customer',
        language: 'uz',
        phone_valid: true,
        ...(withContact
          ? {
              name: `Mijoz ${i + 1}`,
              phone: `+9989012374${String(i).padStart(2, '0')}`,
            }
          : {}),
      })),
      total: n,
      next_after_id: null,
      stats: { by_role: { customer: n }, with_valid_phone: n },
    },
  });

  it('TC4/TC5: with_sample — ≤20 qator, telefon `***NNNN`, to‘liq raqam va ism javobda YO‘Q', async () => {
    rmqSendMock.mockImplementation(
      (
        _c: unknown,
        _p: unknown,
        payload: { fields?: string; limit?: number },
      ) =>
        Promise.resolve(
          payload.fields === 'contact'
            ? page(Math.min(payload.limit ?? 0, 25), true)
            : page(25),
        ),
    );
    const res = (await service.preview({
      include_customers: true,
      segment: { region_id: '5' },
      with_sample: true,
    })) as { data: Record<string, any> };
    expect(res.data.total).toBe(25);
    expect(res.data.sample).toHaveLength(AUDIENCE_SAMPLE_SIZE);
    expect(res.data.sample[0]).toEqual({
      id: '1',
      role: 'customer',
      phone: '***7400',
    });
    const json = JSON.stringify(res.data);
    expect(json).not.toMatch(/\+998|99890|Mijoz \d/);
    // identity'dan namuna — aynan 20 ta, `contact` maydonlari bilan.
    const sampleCall = rmqSendMock.mock.calls.find(
      ([, , payload]) => payload.fields === 'contact',
    );
    expect(sampleCall?.[2]).toMatchObject({ limit: 20, with_total: false });
  });

  it('with_sample berilmasa — identity’dan kontakt so‘ralmaydi, `sample` yo‘q', async () => {
    rmqSendMock.mockResolvedValue(page(3));
    const res = (await service.preview({ roles: ['courier'] })) as {
      data: Record<string, unknown>;
    };
    expect(res.data.sample).toBeUndefined();
    expect(
      rmqSendMock.mock.calls.every(
        ([, , payload]) => payload.fields !== 'contact',
      ),
    ).toBe(true);
  });

  it('TC12: 0 ta — xom BadRequest emas, 200 + `empty_audience` va tushunarli matn', async () => {
    rmqSendMock.mockResolvedValue(page(0));
    const res = (await service.preview({
      include_customers: true,
      segment: { min_orders: 50 },
    })) as { data: Record<string, any> };
    expect(res.data.total).toBe(0);
    expect(res.data.warnings).toContain('empty_audience');
    expect(res.data.hint).toMatch(/topilmadi/);
    expect(res.data.dispatch_allowed).toBe(false);
  });

  it('TC1: filtrsiz — aniq 400 matni ("filtr tanlang" holati), son qaytmaydi', async () => {
    const error = await errorOf(service.preview({}));
    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/Auditoriya bo'sh/);
    expect(rmqSendMock).not.toHaveBeenCalled();
  });

  it('TC7: audience_segment_id — saqlangan shart bilan sanaydi; yo‘q segment 404', async () => {
    segmentsRepo.findOne.mockResolvedValue({
      id: '3',
      audience: {
        include_customers: true,
        segment: { region_id: '5', min_orders: 3, max_orders: 10 },
      },
    });
    rmqSendMock.mockResolvedValue(page(4));
    const res = (await service.preview({ audience_segment_id: '3' })) as {
      data: Record<string, unknown>;
    };
    expect(res.data.total).toBe(4);
    expect(rmqSendMock.mock.calls[0][2]).toMatchObject({
      include_customers: true,
      segment: { region_id: '5', min_orders: 3, max_orders: 10 },
    });
    segmentsRepo.findOne.mockResolvedValue(null);
    expect(
      (await errorOf(service.preview({ audience_segment_id: '9' }))).statusCode,
    ).toBe(404);
  });

  it('TC3: buyurtmalar soni "dan–gacha" — max_orders segment kaliti identity’ga uzatiladi', async () => {
    expect(SEGMENT_KEYS).toContain('max_orders');
    rmqSendMock.mockResolvedValue(page(2));
    await service.preview({
      include_customers: true,
      segment: { min_orders: 3, max_orders: 10 },
    });
    expect(rmqSendMock.mock.calls[0][2].segment).toEqual({
      min_orders: 3,
      max_orders: 10,
    });
  });
});

describe('ebSV5oyP — saqlangan segmentlar (AudienceSegmentService)', () => {
  let repo: Record<string, jest.Mock>;
  let preview: { preview: jest.Mock };
  let duplicate: unknown;
  const make = () =>
    new AudienceSegmentService(repo as never, preview as never);

  beforeEach(() => {
    duplicate = null;
    repo = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: Record<string, unknown>) => v),
      save: jest.fn(async (v: Record<string, unknown>) => ({
        id: '3',
        createdAt: new Date(),
        ...v,
      })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, jest.Mock> = {};
        qb.where = jest.fn(() => qb);
        qb.andWhere = jest.fn(() => qb);
        qb.getOne = jest.fn(async () => duplicate);
        return qb;
      }),
    };
    preview = {
      preview: jest.fn().mockResolvedValue({ data: { total: 42 } }),
    };
  });

  it('TC7: nom bilan saqlanadi — faqat SHART (recipient_ids/telefon emas), last_total jonli preview’dan', async () => {
    const res = (await make().create({
      name: '  Faol mijozlar  ',
      include_customers: true,
      segment: {
        region_id: '5',
        min_orders: 3,
        max_orders: 10,
        last_order_to: '',
      },
      recipient_ids: ['1', '2'],
      requester: { id: '25' },
    } as never)) as { statusCode: number; data: Record<string, unknown> };
    expect(res.statusCode).toBe(201);
    const saved = repo.save.mock.calls[0][0];
    expect(saved).toMatchObject({
      name: 'Faol mijozlar',
      audience: {
        include_customers: true,
        segment: { region_id: '5', min_orders: 3, max_orders: 10 },
      },
      last_total: 42,
      created_by: '25',
    });
    expect(JSON.stringify(saved.audience)).not.toMatch(
      /recipient_ids|last_order_to/,
    );
    expect(preview.preview).toHaveBeenCalledWith(saved.audience);
  });

  it('filtrsiz / mijoz qoidasi buzilgan / nomsiz — 400; takror nom — 409', async () => {
    for (const input of [
      { name: 'A' },
      { name: 'A', include_customers: true },
      { name: '', roles: ['courier'] },
    ]) {
      expect((await errorOf(make().create(input as never))).statusCode).toBe(
        400,
      );
    }
    duplicate = { id: '1' };
    expect(
      (
        await errorOf(
          make().create({ name: 'faol', roles: ['courier'] } as never),
        )
      ).statusCode,
    ).toBe(409);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('o‘chirish — soft delete; yo‘q — 404', async () => {
    await make().remove({ id: '3' });
    expect(repo.update).toHaveBeenCalledWith(
      { id: '3', isDeleted: false },
      { isDeleted: true },
    );
    repo.update.mockResolvedValue({ affected: 0 });
    expect((await errorOf(make().remove({ id: '3' }))).statusCode).toBe(404);
  });
});
