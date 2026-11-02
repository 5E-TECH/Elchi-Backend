import type { RmqContext } from '@nestjs/microservices';
import { RpcException } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import type { DataSource } from 'typeorm';
import { OrderServiceController } from '../order-service.controller';
import {
  POST_MEMBERSHIP_FIND_SQL,
  POST_MEMBERSHIP_MAX_POST_IDS,
  POST_MEMBERSHIP_MAX_ROWS,
  PostMembershipService,
  normalizePostIds,
} from './post-membership.service';

/**
 * `order.post_membership.find` — logistika eski pochta ro'yxati shu
 * javobga tayanadi: shakl { order_id, post_id, kind, joined_at, left_at,
 * next_post_id } (id'lar satr, vaqtlar ISO), `joined_at` tartibi.
 */
function rpcStatus(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return ((error as RpcException).getError() as { statusCode?: number })
      .statusCode;
  }
  return undefined;
}

describe('normalizePostIds', () => {
  it('satr va son qabul qilinadi, takrorlar olib tashlanadi', () => {
    expect(normalizePostIds(['12', 12, ' 7 ', '7'])).toEqual(['12', '7']);
  });

  it('bo`sh massiv — bo`sh', () => {
    expect(normalizePostIds([])).toEqual([]);
  });

  it.each([[undefined], [null], ['12'], [{ 0: '1' }]])(
    'massiv emas (%p) — 400',
    (raw) => {
      expect(rpcStatus(() => normalizePostIds(raw))).toBe(400);
    },
  );

  it.each([['abc'], ['0'], [''], [null], [{}], ['1'.repeat(19)]])(
    'noto`g`ri element (%p) — 400 (jim tashlanmaydi)',
    (bad) => {
      expect(rpcStatus(() => normalizePostIds(['1', bad]))).toBe(400);
    },
  );

  it(`ko'pi bilan ${POST_MEMBERSHIP_MAX_POST_IDS} ta pochta`, () => {
    const many = Array.from(
      { length: POST_MEMBERSHIP_MAX_POST_IDS + 1 },
      (_, i) => String(i + 1),
    );
    expect(rpcStatus(() => normalizePostIds(many))).toBe(400);
    expect(normalizePostIds(many.slice(1))).toHaveLength(
      POST_MEMBERSHIP_MAX_POST_IDS,
    );
  });
});

describe('PostMembershipService.findByPostIds', () => {
  const make = (query: jest.Mock) =>
    new PostMembershipService({ query } as unknown as DataSource);

  it('bo`sh ro`yxat — DB so`rovisiz bo`sh javob', async () => {
    const query = jest.fn();
    await expect(make(query).findByPostIds({ post_ids: [] })).resolves.toEqual({
      statusCode: 200,
      message: 'success',
      data: [],
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('SQL: post_id = ANY, joined_at tartibi, qator chegarasi', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await make(query).findByPostIds({ post_ids: ['5', 5, '6'] });
    expect(query).toHaveBeenCalledWith(POST_MEMBERSHIP_FIND_SQL, [
      ['5', '6'],
      POST_MEMBERSHIP_MAX_ROWS,
    ]);
    expect(POST_MEMBERSHIP_FIND_SQL).toContain(
      '"order_schema"."post_order_memberships"',
    );
    expect(POST_MEMBERSHIP_FIND_SQL).toContain(
      'WHERE m."post_id" = ANY($1::bigint[])',
    );
    expect(POST_MEMBERSHIP_FIND_SQL).toMatch(
      /ORDER BY m\."joined_at" ASC, m\."id" ASC\s+LIMIT \$2/,
    );
  });

  it('qatorlar shartnoma shakliga keltiriladi (ISO vaqt, satr id, null)', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        order_id: '100',
        post_id: '5',
        kind: 'DELIVERY',
        joined_at: new Date('2026-10-01T08:00:00.000Z'),
        left_at: new Date('2026-10-02T09:30:00.000Z'),
        next_post_id: '8',
      },
      {
        order_id: 101,
        post_id: 5,
        kind: 'CANCELED',
        joined_at: '2026-10-03T10:00:00.000Z',
        left_at: null,
        next_post_id: null,
      },
    ]);
    const res = await make(query).findByPostIds({ post_ids: ['5'] });
    expect(res.data).toEqual([
      {
        order_id: '100',
        post_id: '5',
        kind: 'DELIVERY',
        joined_at: '2026-10-01T08:00:00.000Z',
        left_at: '2026-10-02T09:30:00.000Z',
        next_post_id: '8',
      },
      {
        order_id: '101',
        post_id: '5',
        kind: 'CANCELED',
        joined_at: '2026-10-03T10:00:00.000Z',
        left_at: null,
        next_post_id: null,
      },
    ]);
  });

  it('jadval hali yo`q (42P01) — bo`sh javob (avvalgi xulq), xato emas', async () => {
    const query = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('relation does not exist'), { code: '42P01' }),
      );
    await expect(
      make(query).findByPostIds({ post_ids: ['5'] }),
    ).resolves.toMatchObject({ data: [] });
  });

  it('boshqa DB xatosi yuqoriga chiqadi', async () => {
    const query = jest.fn().mockRejectedValue(new Error('connection lost'));
    await expect(
      make(query).findByPostIds({ post_ids: ['5'] }),
    ).rejects.toThrow('connection lost');
  });

  it('noto`g`ri payload — 400 (DB so`rovisiz)', async () => {
    const query = jest.fn();
    await expect(make(query).findByPostIds(undefined)).rejects.toBeInstanceOf(
      RpcException,
    );
    expect(query).not.toHaveBeenCalled();
  });
});

describe('order.post_membership.find handleri', () => {
  const handler = Object.getOwnPropertyDescriptor(
    OrderServiceController.prototype,
    'findPostMemberships',
  )?.value as (
    data: { post_ids?: unknown } | undefined,
    context: RmqContext,
  ) => Promise<unknown>;
  // Haqiqiy `executeAndAck` kabi async: sinxron xato rad etilgan promise.
  const executeAndAck = async (
    _ctx: RmqContext,
    fn: () => Promise<unknown>,
  ): Promise<unknown> => fn();

  it("naqsh AYNAN { cmd: 'order.post_membership.find' }", () => {
    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([
      { cmd: 'order.post_membership.find' },
    ]);
  });

  it('payload servisga o`zgarishsiz uzatiladi', async () => {
    const result = { statusCode: 200, message: 'success', data: [] };
    const postMembership = {
      findByPostIds: jest.fn().mockResolvedValue(result),
    };
    await expect(
      handler.call({ executeAndAck, postMembership }, { post_ids: ['5'] }, {}),
    ).resolves.toBe(result);
    expect(postMembership.findByPostIds).toHaveBeenCalledWith({
      post_ids: ['5'],
    });
  });

  it('servis ulanmagan — 503 (jim bo`sh javob emas)', async () => {
    await expect(
      handler.call({ executeAndAck }, { post_ids: ['5'] }, {}),
    ).rejects.toBeInstanceOf(RpcException);
  });
});
