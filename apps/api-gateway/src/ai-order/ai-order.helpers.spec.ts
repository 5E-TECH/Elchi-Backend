import {
  type ArgumentsHost,
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BaseRpcExceptionFilter,
  type RmqContext,
  RpcException,
} from '@nestjs/microservices';
import { firstValueFrom, TimeoutError } from 'rxjs';
import {
  executeIdempotent,
  type IdempotencyService,
  type RmqService,
} from '@app/common';
import {
  AI_CONFIRM_CONCURRENCY,
  AI_CONFIRM_DEADLINE_MS,
  AI_CONFIRM_REASON_TEXT,
  AI_DEDUPE_PREFIX,
  AI_DEDUPE_TTL_MS,
  AI_PARSE_REASON_MESSAGES,
  AI_PARSE_TOTAL_BUDGET_MS,
  AI_RESOLVE_TIMEOUT_MS,
  type AiSignatureOrderInput,
  aiOrderSignature,
  runInLanes,
  toConfirmFailure,
  toParseFailure,
} from './ai-order.helpers';
import { AI_VERIFY_REASON_TEXT } from './verify-ai-orders';

/**
 * Servis handler'i tashlagan xato gateway'ga QANDAY shaklda yetib keladi:
 * Nest RPC filtri (order-service'da global filtr YO'Q — sukutdagi
 * `BaseRpcExceptionFilter`) + RMQ JSON (ClientRMQ `serializeError` uni
 * o'zgartirmaydi).
 */
async function overRmq(thrown: unknown): Promise<unknown> {
  const filter = new BaseRpcExceptionFilter();
  try {
    await firstValueFrom(filter.catch(thrown, {} as ArgumentsHost));
  } catch (wire: unknown) {
    return JSON.parse(JSON.stringify(wire)) as unknown;
  }
  throw new Error('filtr xato qaytarmadi');
}

/**
 * order-service `order.create` ning `in_progress` holatida HAQIQIY
 * `executeIdempotent` tashlagan xato (kalit boshqa so'rovda band).
 * `markReplay` — order-service `ai-dedupe:` kalitiga beradigan opsiya.
 */
async function inProgressThrown(markReplay: boolean): Promise<unknown> {
  const rmq = { ack: jest.fn(), nack: jest.fn(), nackForError: jest.fn() };
  const idem = {
    tryAcquire: jest.fn().mockResolvedValue({ status: 'in_progress' }),
  };
  try {
    await executeIdempotent(
      rmq as unknown as RmqService,
      idem as unknown as IdempotencyService,
      {} as RmqContext,
      {
        requestId: `${AI_DEDUPE_PREFIX}abc`,
        pattern: 'order.create',
        ...(markReplay ? { markReplay: true } : {}),
      },
      () => ({ data: { id: '1' } }),
    );
  } catch (thrown: unknown) {
    expect(rmq.nack).toHaveBeenCalledTimes(1);
    expect(rmq.ack).not.toHaveBeenCalled();
    return thrown;
  }
  throw new Error('executeIdempotent xato tashlamadi');
}

describe('ai-order.helpers', () => {
  describe('konstantalar (PLAN C8/C10 — B2-T5a shular bilan ishlaydi)', () => {
    it('qiymatlar kelishilganidek', () => {
      expect(AI_CONFIRM_CONCURRENCY).toBe(3);
      expect(AI_CONFIRM_DEADLINE_MS).toBe(75_000);
      expect(AI_DEDUPE_TTL_MS).toBe(600_000);
      expect(AI_DEDUPE_PREFIX).toBe('ai-dedupe:');
      expect(AI_RESOLVE_TIMEOUT_MS).toBe(25_000);
      expect(AI_PARSE_TOTAL_BUDGET_MS).toBe(85_000);
      // extract 60s + preview 25s = 85s < frontend 90s.
      expect(60_000 + AI_RESOLVE_TIMEOUT_MS).toBeLessThanOrEqual(
        AI_PARSE_TOTAL_BUDGET_MS,
      );
    });

    it('AI_CONFIRM_REASON_TEXT har C10 kodi uchun matnga ega', () => {
      const codes = [
        'district_not_found',
        'district_mismatch',
        'product_not_found',
        'product_foreign',
        'duplicate_in_batch',
        'duplicate_recent',
        'duplicate_in_progress',
        'validation_unavailable',
        'create_failed',
        'timeout_unknown',
        'not_started',
      ];
      expect(Object.keys(AI_CONFIRM_REASON_TEXT).sort()).toEqual(
        [...codes].sort(),
      );
      for (const code of codes) {
        expect(
          AI_CONFIRM_REASON_TEXT[code as keyof typeof AI_CONFIRM_REASON_TEXT],
        ).toEqual(expect.any(String));
      }
      expect(AI_CONFIRM_REASON_TEXT.district_not_found).toBe(
        AI_VERIFY_REASON_TEXT.district_not_found,
      );
      expect(Object.isFrozen(AI_CONFIRM_REASON_TEXT)).toBe(true);
    });
  });

  describe('toParseFailure', () => {
    it.each([
      ['truncated', 'Matn juda katta — 10 tadan qismlarga bo‘lib yuboring'],
      ['network', 'AI javob bermadi — qayta urinib ko‘ring'],
      ['ai_error', 'AI javob bermadi — qayta urinib ko‘ring'],
      ['disabled', 'AI hozir o‘chiq — qo‘lda kiriting'],
      ['refused', 'AI bu matnni qayta ishlamadi — qo‘lda kiriting'],
      ['cap_exceeded', 'AI kunlik limiti tugadi — qo‘lda kiriting'],
      ['no_market', 'Operator hech qaysi marketga biriktirilmagan'],
    ])('%s → o‘z matni', (reason, message) => {
      expect(toParseFailure({ reason })).toEqual({
        ok: false,
        reason,
        message,
      });
    });

    it('NsxoDSmm #11: truncated / network / disabled — uch xil matn', () => {
      const messages = new Set(
        (['truncated', 'network', 'disabled'] as const).map(
          (reason) => toParseFailure({ reason }).message,
        ),
      );
      expect(messages.size).toBe(3);
    });

    it('bVeyEuIR #9: cap_exceeded "limit" deydi, "o‘chiq" demaydi', () => {
      const { message } = toParseFailure({ reason: 'cap_exceeded' });
      expect(message).toContain('limiti');
      expect(message).not.toBe(AI_PARSE_REASON_MESSAGES.disabled);
    });

    it('invalid_json → ai_error (PLAN 5.5)', () => {
      expect(toParseFailure({ reason: 'invalid_json' })).toEqual({
        ok: false,
        reason: 'ai_error',
        message: AI_PARSE_REASON_MESSAGES.ai_error,
      });
    });

    it.each([['ai_off'], ['insufficient'], ['weird'], [''], [undefined]])(
      'noma’lum sabab (%s) → ai_error; ai_off/insufficient hech qachon chiqmaydi',
      (reason) => {
        expect(toParseFailure({ reason })).toMatchObject({
          ok: false,
          reason: 'ai_error',
        });
      },
    );

    it('null / undefined kirishda ham ai_error', () => {
      expect(toParseFailure(null).reason).toBe('ai_error');
      expect(toParseFailure(undefined).reason).toBe('ai_error');
    });

    it('cap_exceeded: scope va reset_at saqlanadi', () => {
      expect(
        toParseFailure({
          ok: false,
          reason: 'cap_exceeded',
          scope: 'global',
          reset_at: '2026-09-27T19:00:00.000Z',
        } as { reason: string; scope: string; reset_at: string }),
      ).toEqual({
        ok: false,
        reason: 'cap_exceeded',
        message: AI_PARSE_REASON_MESSAGES.cap_exceeded,
        scope: 'global',
        reset_at: '2026-09-27T19:00:00.000Z',
      });
    });

    it('boshqa sabablarda scope/reset_at tashlanadi; xom qo‘shimcha maydonlar chiqmaydi', () => {
      const out = toParseFailure({
        reason: 'network',
        scope: 'global',
        reset_at: '2026-09-27T19:00:00.000Z',
        orders: [{ phone_number: '+998901234567' }],
      } as { reason: string; scope: string; reset_at: string });
      expect(out).toEqual({
        ok: false,
        reason: 'network',
        message: AI_PARSE_REASON_MESSAGES.network,
      });
    });
  });

  describe('toConfirmFailure', () => {
    it('GatewayTimeoutException → timeout_unknown', () => {
      expect(
        toConfirmFailure(
          new GatewayTimeoutException('Order service response timeout'),
        ),
      ).toEqual({
        code: 'timeout_unknown',
        reason:
          'Natija noma’lum — buyurtma yaratilgan bo‘lishi mumkin. “Yangi buyurtmalar”ni tekshiring, qayta yubormang',
      });
    });

    it('rxjs TimeoutError → timeout_unknown', () => {
      expect(toConfirmFailure(new TimeoutError())).toMatchObject({
        code: 'timeout_unknown',
      });
      const named = Object.assign(new Error('Timeout has occurred'), {
        name: 'TimeoutError',
      });
      expect(toConfirmFailure(named)).toMatchObject({
        code: 'timeout_unknown',
      });
    });

    describe('RMQ orqali kelgan haqiqiy shakllar', () => {
      let loggerError: jest.SpyInstance;
      beforeEach(() => {
        // handleUnknownError xatoni jurnalga yozadi — test chiqishi toza qolsin.
        loggerError = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
      });
      afterEach(() => loggerError.mockRestore());

      it("in_progress RpcException({statusCode:409, message:'Idempotency in_progress …'}) → duplicate_in_progress", async () => {
        const wire = await overRmq(
          new RpcException({
            statusCode: 409,
            message:
              'Idempotency in_progress for order.create:ai-dedupe:abc, message requeued',
          }),
        );
        expect(wire).toEqual({
          statusCode: 409,
          message:
            'Idempotency in_progress for order.create:ai-dedupe:abc, message requeued',
        });
        expect(toConfirmFailure(wire)).toEqual({
          code: 'duplicate_in_progress',
          reason: AI_CONFIRM_REASON_TEXT.duplicate_in_progress,
        });
      });

      it('wgqxS0Cp #13 / C10: executeIdempotent (markReplay) in_progress → Nest filtri + JSON → duplicate_in_progress (409 tarmog‘idan OLDIN)', async () => {
        const thrown = await inProgressThrown(true);
        expect(thrown).toBeInstanceOf(RpcException);

        const wire = await overRmq(thrown);
        // Asl matn va 409 RMQ'dan o'tadi (Nest `Internal server error` ga
        // aylantirmaydi).
        expect(wire).toEqual({
          statusCode: 409,
          message:
            'Idempotency in_progress for order.create:ai-dedupe:abc, message requeued',
        });
        const out = toConfirmFailure(wire);
        expect(out).toEqual({
          code: 'duplicate_in_progress',
          reason: AI_CONFIRM_REASON_TEXT.duplicate_in_progress,
        });
        expect(out.reason).toBe(
          'Xuddi shu buyurtma hozir yaratilmoqda — “Yangi buyurtmalar”ni tekshiring, qayta yubormang',
        );
        // Handler xatosi sifatida jurnalga yozilmaydi (noma'lum xato emas).
        expect(loggerError).not.toHaveBeenCalled();
      });

      it("in_progress oddiy Error bo'lib tashlansa (markReplay'siz; matn yo'qoladi) — 'yaratilmadi' EMAS, timeout_unknown", async () => {
        const thrown = await inProgressThrown(false);
        expect(thrown).not.toBeInstanceOf(RpcException);
        expect((thrown as Error).message).toBe(
          'Idempotency in_progress for order.create:ai-dedupe:abc, message requeued',
        );
        const wire = await overRmq(thrown);
        // Nest asl matnni yashiradi — gateway in_progress'ni ko'ra olmaydi.
        expect(wire).toEqual({
          status: 'error',
          message: 'Internal server error',
        });
        const out = toConfirmFailure(wire);
        expect(out).toEqual({
          code: 'timeout_unknown',
          reason: AI_CONFIRM_REASON_TEXT.timeout_unknown,
        });
        expect(out.reason).not.toBe(AI_CONFIRM_REASON_TEXT.create_failed);
      });

      it('handler oddiy xato bilan yiqilsa (qayta navbatga qo‘yiladi, reclaimFailed qayta yaratadi) → timeout_unknown', async () => {
        const wire = await overRmq(
          new Error('QueryFailedError: connection terminated'),
        );
        expect(toConfirmFailure(wire)).toMatchObject({
          code: 'timeout_unknown',
        });
      });

      it("ataylab tashlangan RpcException('matn') — aniq xato, create_failed", async () => {
        const wire = await overRmq(new RpcException('Mahsulot topilmadi'));
        expect(wire).toEqual({
          status: 'error',
          message: 'Mahsulot topilmadi',
        });
        expect(toConfirmFailure(wire)).toEqual({
          code: 'create_failed',
          reason: AI_CONFIRM_REASON_TEXT.create_failed,
        });
      });

      it('RpcException 400 xabari o‘zgarmasdan o‘tadi', async () => {
        const wire = await overRmq(
          new RpcException({ statusCode: 400, message: 'Tuman topilmadi' }),
        );
        expect(toConfirmFailure(wire)).toEqual({
          code: 'create_failed',
          reason: 'Tuman topilmadi',
        });
      });
    });

    it("'Idempotency in_progress' matni har qanday shaklda → duplicate_in_progress", () => {
      expect(
        toConfirmFailure({
          status: 'error',
          message: 'Idempotency in_progress for order.create:x',
        }),
      ).toMatchObject({ code: 'duplicate_in_progress' });
      expect(
        toConfirmFailure({
          response: {
            statusCode: 409,
            message: 'Idempotency in_progress for order.create:x',
          },
        }),
      ).toMatchObject({ code: 'duplicate_in_progress' });
    });

    it('identity 409 (telefon boshqa rolda) → o‘sha o‘zbekcha matn', () => {
      const rpcError = {
        statusCode: 409,
        message: 'Bu telefon raqam boshqa rolda allaqachon mavjud',
        data: null,
      };
      expect(toConfirmFailure(rpcError)).toEqual({
        code: 'create_failed',
        reason: 'Bu telefon raqam boshqa rolda allaqachon mavjud',
      });
      expect(
        toConfirmFailure(
          new ConflictException(
            'Bu telefon raqam boshqa rolda allaqachon mavjud',
          ),
        ).reason,
      ).toBe('Bu telefon raqam boshqa rolda allaqachon mavjud');
    });

    it('telefon bilan bog‘liq bo‘lmagan 409 — umumiy matn', () => {
      expect(
        toConfirmFailure({ statusCode: 409, message: 'duplicate key value' }),
      ).toEqual({
        code: 'create_failed',
        reason: AI_CONFIRM_REASON_TEXT.create_failed,
      });
    });

    it('BadRequest xabari o‘zgarmasdan o‘tadi (gateway va RPC)', () => {
      expect(
        toConfirmFailure(
          new BadRequestException(
            'Filial xodimi hech qaysi filialga biriktirilmagan',
          ),
        ),
      ).toEqual({
        code: 'create_failed',
        reason: 'Filial xodimi hech qaysi filialga biriktirilmagan',
      });
      expect(
        toConfirmFailure({
          statusCode: 400,
          message: ['quantity must be positive', 'price invalid'],
        }),
      ).toEqual({
        code: 'create_failed',
        reason: 'quantity must be positive. price invalid',
      });
      expect(
        toConfirmFailure({
          response: { statusCode: 400, message: 'Mahsulot topilmadi' },
        }).reason,
      ).toBe('Mahsulot topilmadi');
    });

    it('juda uzun 400 xabari qisqartiriladi', () => {
      const { reason } = toConfirmFailure(
        new BadRequestException('x'.repeat(1000)),
      );
      expect(reason.length).toBeLessThanOrEqual(300);
    });

    it('boshqa xatolar → create_failed "Buyurtma yaratilmadi"; xom payload HECH QACHON chiqmaydi', () => {
      const leaky = {
        statusCode: 500,
        message: 'Internal server error',
        dto: { customer: { phone_number: '+998901234567' } },
        data: { address: 'Chilonzor 5-uy' },
      };
      for (const error of [
        leaky,
        new NotFoundException('Order not found'),
        new Error('socket hang up +998901234567'),
        // Gateway'ning O'Z xatosi (RMQ javobi emas) — noma'lum deb olinmaydi.
        new Error('Internal server error'),
        { status: 500, message: 'Internal server error' },
        'boom',
        null,
        undefined,
        42,
      ]) {
        const out = toConfirmFailure(error);
        expect(out).toEqual({
          code: 'create_failed',
          reason: 'Buyurtma yaratilmadi',
        });
        expect(JSON.stringify(out)).not.toContain('+998');
      }
    });
  });

  describe('aiOrderSignature', () => {
    const base: AiSignatureOrderInput = {
      customer: { phone_number: '+998901234567' },
      district_id: '101',
      total_price: 150000,
      where_deliver: 'center',
      items: [
        { product_id: '7', quantity: 2 },
        { product_name: ' Atir Qizil ', quantity: 1 },
      ],
    };

    it('sha256 hex (64 belgi) va deterministik', () => {
      const a = aiOrderSignature('12', base);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(aiOrderSignature('12', { ...base })).toBe(a);
    });

    it('itemlar tartibi, nom registri/bo‘shliqlari va narx yaxlitlanishi ahamiyatsiz', () => {
      const same: AiSignatureOrderInput = {
        ...base,
        total_price: 150000.4,
        items: [
          { product_name: 'atir qizil', quantity: 1 },
          { product_id: '7', quantity: 2 },
        ],
      };
      expect(aiOrderSignature('12', same)).toBe(aiOrderSignature('12', base));
    });

    it('ism/izoh/manzil/operator imzoga kirmaydi', () => {
      const withExtras = {
        ...base,
        customer: { ...base.customer, name: 'Boshqa ism' },
        comment: 'tezroq',
        address: 'Chilonzor',
        operator: '#7',
      } as AiSignatureOrderInput;
      expect(aiOrderSignature('12', withExtras)).toBe(
        aiOrderSignature('12', base),
      );
    });

    it.each([
      ['market', '13', base],
      [
        'telefon',
        '12',
        { ...base, customer: { phone_number: '+998901234568' } },
      ],
      ['tuman', '12', { ...base, district_id: '102' }],
      ['narx', '12', { ...base, total_price: 151000 }],
      ['yetkazish turi', '12', { ...base, where_deliver: 'address' }],
      [
        'miqdor',
        '12',
        {
          ...base,
          items: [
            { product_id: '7', quantity: 3 },
            { product_name: 'Atir Qizil', quantity: 1 },
          ],
        },
      ],
      [
        'mahsulot',
        '12',
        {
          ...base,
          items: [
            { product_id: '8', quantity: 2 },
            { product_name: 'Atir Qizil', quantity: 1 },
          ],
        },
      ],
    ])('%s farq qilsa imzo boshqa', (_title, market, order) => {
      expect(aiOrderSignature(market, order)).not.toBe(
        aiOrderSignature('12', base),
      );
    });

    it('product_id va product_name bir xil matn bo‘lsa ham farqlanadi', () => {
      const byId = { ...base, items: [{ product_id: '7', quantity: 1 }] };
      const byName = { ...base, items: [{ product_name: '7', quantity: 1 }] };
      expect(aiOrderSignature('12', byId)).not.toBe(
        aiOrderSignature('12', byName),
      );
    });
  });

  describe('runInLanes', () => {
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('bo‘sh ro‘yxat → []', async () => {
      await expect(
        runInLanes(
          [],
          () => 'x',
          3,
          Date.now() + 1000,
          () => Promise.resolve(1),
        ),
      ).resolves.toEqual([]);
    });

    it('natijalar KIRISH tartibida (ishlar turli vaqtda tugasa ham)', async () => {
      const items = [30, 10, 20, 5];
      const promise = runInLanes(
        items,
        (_item, index) => `lane-${index}`,
        3,
        Date.now() + 10_000,
        async (ms) => {
          await sleep(ms);
          return ms * 2;
        },
      );
      await jest.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toEqual([
        { status: 'done', value: 60 },
        { status: 'done', value: 20 },
        { status: 'done', value: 40 },
        { status: 'done', value: 10 },
      ]);
    });

    it('wgqxS0Cp: parallellik 3 dan oshmaydi, bir telefonli buyurtmalar ustma-ust tushmaydi', async () => {
      const phones = [
        '+998900000001',
        '+998900000002',
        '+998900000001',
        '+998900000003',
        '+998900000004',
        '+998900000001',
        '+998900000002',
        '+998900000005',
        '+998900000006',
        '+998900000003',
      ];
      let running = 0;
      let maxRunning = 0;
      const activeByPhone = new Map<string, number>();
      const startOrderByPhone = new Map<string, number[]>();
      let overlap = false;

      const promise = runInLanes(
        phones.map((phone, index) => ({ phone, index })),
        (item) => item.phone,
        AI_CONFIRM_CONCURRENCY,
        Date.now() + AI_CONFIRM_DEADLINE_MS,
        async (item) => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          const active = (activeByPhone.get(item.phone) ?? 0) + 1;
          activeByPhone.set(item.phone, active);
          if (active > 1) overlap = true;
          startOrderByPhone.set(item.phone, [
            ...(startOrderByPhone.get(item.phone) ?? []),
            item.index,
          ]);
          await sleep(10 + (item.index % 3) * 7);
          activeByPhone.set(item.phone, active - 1);
          running--;
          return item.index;
        },
      );
      await jest.advanceTimersByTimeAsync(5_000);
      const results = await promise;

      expect(maxRunning).toBeLessThanOrEqual(3);
      expect(maxRunning).toBe(3);
      expect(overlap).toBe(false);
      // Bir yo'lak ichida — kirish tartibida.
      expect(startOrderByPhone.get('+998900000001')).toEqual([0, 2, 5]);
      expect(startOrderByPhone.get('+998900000002')).toEqual([1, 6]);
      expect(results.map((r) => r.status === 'done' && r.value)).toEqual(
        phones.map((_p, index) => index),
      );
    });

    it('bitta ish yiqilsa qolganlari baribir bajariladi (9 ok + 1 error)', async () => {
      const items = Array.from({ length: 10 }, (_v, i) => i);
      const promise = runInLanes(
        items,
        (i) => `p${i % 4}`,
        3,
        Date.now() + 10_000,
        async (i) => {
          await sleep(5);
          if (i === 3) throw new Error('order 3 failed');
          return `order-${i}`;
        },
      );
      await jest.advanceTimersByTimeAsync(1_000);
      const results = await promise;

      expect(results).toHaveLength(10);
      expect(results.filter((r) => r.status === 'done')).toHaveLength(9);
      expect(results[3]).toEqual({
        status: 'error',
        error: expect.objectContaining({
          message: 'order 3 failed',
        }) as unknown,
      });
      expect(results[4]).toEqual({ status: 'done', value: 'order-4' });
    });

    it('sinxron throw qilgan worker ham error sifatida ushlanadi', async () => {
      const results = await runInLanes(
        [1, 2],
        String,
        2,
        Date.now() + 1_000,
        (i) => {
          if (i === 1) throw new Error('sync');
          return Promise.resolve(i);
        },
      );
      expect(results[0]).toMatchObject({ status: 'error' });
      expect(results[1]).toEqual({ status: 'done', value: 2 });
    });

    it('muddatgacha BOSHLANMAGAN ishlar not_started; boshlangani uzilmaydi', async () => {
      const started: number[] = [];
      const deadlineAt = Date.now() + 50;
      const promise = runInLanes(
        [0, 1, 2, 3],
        () => 'bitta-telefon',
        3,
        deadlineAt,
        async (i) => {
          started.push(i);
          await sleep(40);
          return i;
        },
      );
      await jest.advanceTimersByTimeAsync(1_000);
      const results = await promise;

      // 0 (t=0) va 1 (t=40) muddatdan oldin boshlandi; 2 (t=80) va 3 — yo'q.
      expect(started).toEqual([0, 1]);
      expect(results).toEqual([
        { status: 'done', value: 0 },
        { status: 'done', value: 1 },
        { status: 'not_started' },
        { status: 'not_started' },
      ]);
    });

    it('muddat allaqachon o‘tgan bo‘lsa hech narsa boshlanmaydi', async () => {
      const worker = jest.fn(() => Promise.resolve(1));
      const results = await runInLanes(
        ['a', 'b'],
        (s) => s,
        3,
        Date.now() - 1,
        worker,
      );
      expect(worker).not.toHaveBeenCalled();
      expect(results).toEqual([
        { status: 'not_started' },
        { status: 'not_started' },
      ]);
    });

    it('noto‘g‘ri concurrency (0 / NaN) — kamida 1 ta ishchi', async () => {
      for (const concurrency of [0, Number.NaN, -5]) {
        const results = await runInLanes(
          [1, 2],
          String,
          concurrency,
          Date.now() + 1_000,
          (i) => Promise.resolve(i),
        );
        expect(results).toEqual([
          { status: 'done', value: 1 },
          { status: 'done', value: 2 },
        ]);
      }
    });

    it('bo‘sh / xato beruvchi laneKey — har ish alohida yo‘lak', async () => {
      let running = 0;
      let maxRunning = 0;
      const promise = runInLanes(
        [1, 2, 3],
        (i) => {
          if (i === 3) throw new Error('bad key');
          return '';
        },
        3,
        Date.now() + 1_000,
        async (i) => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await sleep(10);
          running--;
          return i;
        },
      );
      await jest.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toHaveLength(3);
      expect(maxRunning).toBe(3);
    });
  });
});
