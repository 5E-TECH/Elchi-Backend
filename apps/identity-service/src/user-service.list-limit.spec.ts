/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { UserServiceService } from './user-service.service';

/**
 * Qidiruv limitlari (2026-11-27, Dilshod: «To'lovlarga kirib marketga to'lov qilmoqchi bo'lsam shu market
 * chiqmiyabdi»): `normalizeQuery` (GET /users, /markets, /couriers, /market-operators, /logists) `limit` ni 100
 * bilan kesardi — frontend tanlash oynasi `limit=10000` so'rab, 101-marketni hech qachon olmasdi.
 */
describe('identity normalizeQuery — ro‘yxat limiti 100 bilan kesilmaydi', () => {
  const service = Object.create(UserServiceService.prototype);
  const normalize = (query: Record<string, unknown>) =>
    service.normalizeQuery(query) as {
      page: number;
      limit: number;
      skip: number;
    };

  it('sukut 10, sahifa 1', () => {
    expect(normalize({})).toMatchObject({ page: 1, limit: 10, skip: 0 });
  });

  it('limit 500 / 10000 — o‘zgarishsiz; 10000 dan katta — 10000', () => {
    expect(normalize({ limit: 500 }).limit).toBe(500);
    expect(normalize({ limit: '10000' }).limit).toBe(10_000);
    expect(normalize({ limit: 50_000 }).limit).toBe(10_000);
  });

  it('skip yangi limit bilan hisoblanadi', () => {
    expect(normalize({ page: 3, limit: 250 })).toMatchObject({
      page: 3,
      limit: 250,
      skip: 500,
    });
  });
});
