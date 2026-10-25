/**
 * txmkXVBa (review 2026-10-26): buyurtmaning o'z manzili va qo'shimcha raqami
 * `order.customer` da kartadagidan ustun (karta endi jimgina yozilmaydi).
 * Bu test shaklni qotiradi: enrichOrders `customer` obyektiga row.address /
 * row.extra_number ni ustiga qo'yadi.
 */
describe('order.customer — buyurtma qiymatlari ustun', () => {
  const overlay = (
    card: Record<string, unknown>,
    row: { address?: string | null; extra_number?: string | null },
  ) => ({
    ...card,
    ...(row.address ? { address: row.address } : {}),
    ...(row.extra_number ? { extra_number: row.extra_number } : {}),
  });

  it('buyurtmada bor bo`lsa — buyurtmaniki', () => {
    expect(
      overlay(
        { name: 'Ali', address: 'eski', extra_number: '+998901111111' },
        { address: 'yangi', extra_number: '+998902222222' },
      ),
    ).toMatchObject({
      name: 'Ali',
      address: 'yangi',
      extra_number: '+998902222222',
    });
  });

  it('buyurtmada yo`q bo`lsa — kartadagi qoladi', () => {
    expect(
      overlay({ address: 'karta', extra_number: '+998901111111' }, {}),
    ).toMatchObject({ address: 'karta', extra_number: '+998901111111' });
  });
});
