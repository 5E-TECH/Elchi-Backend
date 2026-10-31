import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeSaleLegs } from './order-money';

/**
 * B824gOu5 — pickup haqi TASHRIFGA tegishli: sotuv oyoqlariga kirmaydi, ya'ni
 * saqlanish identiteti aynan avvalgidek. Haq `order_settlement` ga ham, market
 * tarifiga ham yozilmaydi (finance tomoni: `pickup-visit.B824gOu5.pg.spec.ts`).
 */
describe('computeSaleLegs — pickup haqi (B824gOu5)', () => {
  it.each([
    [
      {
        total: 200000,
        marketTariff: 30000,
        courierShare: 20000,
        branchShare: 0,
      },
    ],
    [
      {
        total: 150000.5,
        marketTariff: 25000,
        courierShare: 15000,
        branchShare: 5000,
      },
    ],
    // Tarif ulushlarni qoplamagan sotuv ham (HQ manfiy foyda).
    [
      {
        total: 90000,
        marketTariff: 10000,
        courierShare: 20000,
        branchShare: 0,
      },
    ],
  ])('identitet buzilmaydi: %j', (input) => {
    const legs = computeSaleLegs(input);
    expect(
      legs.marketReceivable +
        legs.courierKept +
        legs.branchKept +
        legs.hqProfit,
    ).toBeCloseTo(input.total, 2);
  });

  it('sotuv hisobi pickup summasini umuman bilmaydi', () => {
    const source = readFileSync(join(__dirname, 'order-money.ts'), 'utf8');
    expect(source).not.toMatch(/pickup/i);
  });
});
