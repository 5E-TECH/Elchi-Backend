import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Cashbox_type, Order_status, PaymentMethod, Roles } from '../../enums';
import { UZ_PHONE_RE } from '../pii/mask-phones';
import {
  ActivityDescribeUz,
  moneyUz,
  orderStatusUz,
  roleUz,
} from './describe-uz';

/**
 * 2WRzdWpZ — jurnal gaplari (description) va o'zbekcha yordamchilar.
 */
describe('o`zbekcha yordamchilar (2WRzdWpZ)', () => {
  it('orderStatusUz — har bir Order_status uchun yorliq bor, kod qaytmaydi', () => {
    for (const code of Object.values(Order_status)) {
      expect(orderStatusUz(code)).not.toBe(code);
    }
    expect(orderStatusUz(Order_status.CANCELLED)).toBe('Bekor qilindi');
    expect(orderStatusUz('mystery')).toBe('mystery');
    expect(orderStatusUz(null)).toBe('-');
  });

  it('roleUz — har bir Roles uchun yorliq bor', () => {
    for (const code of Object.values(Roles)) {
      expect(roleUz(code)).not.toBe(code);
    }
    expect(roleUz(Roles.CUSTOMER)).toBe('Mijoz');
  });

  it('TC4 moneyUz — ming ajratgichi bilan, so`m', () => {
    expect(moneyUz(150000)).toBe("150 000 so'm");
    expect(moneyUz(1500000)).toBe("1 500 000 so'm");
    expect(moneyUz('250000.00')).toBe("250 000 so'm"); // Postgres numeric
    expect(moneyUz(999)).toBe("999 so'm");
    expect(moneyUz(-5000)).toBe("-5 000 so'm");
    expect(moneyUz(1500.5)).toBe("1 500,50 so'm");
    expect(moneyUz(0)).toBe("0 so'm");
    expect(moneyUz(undefined)).toBe('-');
    expect(moneyUz('abc')).toBe('-');
  });
});

describe('ActivityDescribeUz — gaplar (2WRzdWpZ)', () => {
  it('TC3 bekor qilish: o`zbekcha gap + buyurtma raqami', () => {
    expect(ActivityDescribeUz.orderCancelled('100439')).toBe(
      'Buyurtma #100439 bekor qilindi',
    );
  });

  it('status o`zgarishi o`zbekcha yorliqlar bilan', () => {
    expect(
      ActivityDescribeUz.orderStatusChanged(
        12,
        Order_status.NEW,
        Order_status.RECEIVED,
      ),
    ).toBe('Buyurtma #12 holati: Yangi → Qabul qilindi');
    // Bekor qilishga o'tish ham "bekor" so'zini o'z ichiga oladi (TC7 qidiruvi).
    expect(
      ActivityDescribeUz.orderStatusChanged(
        12,
        Order_status.WAITING,
        Order_status.CANCELLED,
      ).toLowerCase(),
    ).toContain('bekor');
  });

  it('yaratish va sotish — summa bilan', () => {
    expect(ActivityDescribeUz.orderCreated('7', 150000)).toBe(
      "Buyurtma #7 yaratildi — 150 000 so'm",
    );
    expect(ActivityDescribeUz.orderCreated('7', 0)).toBe(
      'Buyurtma #7 yaratildi',
    );
    expect(ActivityDescribeUz.orderSold('7', 250000)).toBe(
      "Buyurtma #7 sotildi — 250 000 so'm",
    );
  });

  it('TC4 kassa chiqimi: summa ming ajratgichi bilan', () => {
    expect(
      ActivityDescribeUz.cashboxExpense(
        1250000,
        Cashbox_type.MAIN,
        PaymentMethod.CASH,
      ),
    ).toBe("Kassadan chiqim: 1 250 000 so'm (Asosiy kassa, naqd)");
    expect(ActivityDescribeUz.cashboxIncome(50000, Cashbox_type.BRANCH)).toBe(
      "Kassaga kirim: 50 000 so'm (Filial kassasi)",
    );
  });

  it('TC5 login: "<Ism> tizimga kirdi"', () => {
    expect(
      ActivityDescribeUz.login({ name: 'Ali Valiyev', role: Roles.ADMIN }),
    ).toBe('Ali Valiyev tizimga kirdi');
    expect(
      ActivityDescribeUz.login({
        name: 'Ali Valiyev',
        role: Roles.MARKET,
        method: 'otp',
      }),
    ).toBe('Ali Valiyev tizimga kirdi (SMS kod)');
  });

  it('TC6 login: MIJOZ ismi gapga tushmaydi — rol yoziladi', () => {
    const text = ActivityDescribeUz.login({
      name: 'Dilnoza Karimova',
      role: Roles.CUSTOMER,
      method: 'otp',
    });
    expect(text).toBe('Mijoz tizimga kirdi (SMS kod)');
    expect(text).not.toContain('Dilnoza');
  });

  it('auth_failure: sabab o`zbekcha, telefon yo`q', () => {
    expect(ActivityDescribeUz.authFailure('bad_password')).toBe(
      "Kirish urinishi muvaffaqiyatsiz: noto'g'ri parol",
    );
  });

  it('filiallararo jo`natma', () => {
    expect(
      ActivityDescribeUz.branchTransferCreated({
        batchId: '12',
        fromBranchId: '3',
        toBranchId: '5',
        orderCount: 4,
      }),
    ).toBe("Jo'natma #12 yaratildi: Filial #3 → Filial #5, 4 ta buyurtma");
  });

  /**
   * TC6 QULF: quruvchilarning HECH BIRI telefon/ism/manzil qabul qilmaydi —
   * har biriga eng "yomon" kirish (ID o'rnida telefon emas, balki odatiy ID)
   * beriladi va natijada telefon nomzodi ham, manzil ham yo'qligi tekshiriladi.
   * Yangi quruvchi qo'shilsa, u shu ro'yxatga tushadi (Object.keys).
   */
  it('TC6 hech bir gapda telefon nomzodi yoki manzil yo`q', () => {
    const outputs: Record<string, string> = {
      orderCreated: ActivityDescribeUz.orderCreated('100439', 150000),
      orderStatusChanged: ActivityDescribeUz.orderStatusChanged(
        '100439',
        Order_status.ON_THE_ROAD,
        Order_status.WAITING_CUSTOMER,
      ),
      orderCancelled: ActivityDescribeUz.orderCancelled('100439'),
      orderSold: ActivityDescribeUz.orderSold('100439', 150000),
      orderPartlySold: ActivityDescribeUz.orderPartlySold('100439', 90000),
      orderUpdated: ActivityDescribeUz.orderUpdated('100439'),
      cashboxIncome: ActivityDescribeUz.cashboxIncome(150000, 'main', 'cash'),
      cashboxExpense: ActivityDescribeUz.cashboxExpense(150000, 'main', 'cash'),
      courierPayment: ActivityDescribeUz.courierPayment('301', 150000, 'cash'),
      branchToMainPayment: ActivityDescribeUz.branchToMainPayment(
        '77',
        150000,
        'cash',
      ),
      marketPayment: ActivityDescribeUz.marketPayment('501', 150000, 'click'),
      operatorPayment: ActivityDescribeUz.operatorPayment('42', 150000),
      branchTransferCreated: ActivityDescribeUz.branchTransferCreated({
        batchId: '12',
        fromBranchId: '3',
        toBranchId: '5',
        orderCount: 4,
      }),
      branchReturnCreated: ActivityDescribeUz.branchReturnCreated({
        batchId: '12',
        fromBranchId: '3',
        orderCount: 4,
      }),
      courierTransferred: ActivityDescribeUz.courierTransferred(
        '301',
        '3',
        '5',
      ),
      login: ActivityDescribeUz.login({ name: 'Ali', role: Roles.ADMIN }),
      authFailure: ActivityDescribeUz.authFailure('user_not_found'),
    };
    // Har bir quruvchi qamralgan — yangisi qo'shilsa test uni ham talab qiladi.
    expect(Object.keys(outputs).sort()).toEqual(
      Object.keys(ActivityDescribeUz).sort(),
    );
    for (const [name, text] of Object.entries(outputs)) {
      expect({ name, phone: UZ_PHONE_RE.test(text) }).toEqual({
        name,
        phone: false,
      });
      expect(text).not.toMatch(/ko'cha|ko‘cha|mahalla|uy\s*\d|kv\.|manzil/i);
      // Qisqa va barqaror shakl.
      expect(text.length).toBeLessThan(120);
    }
  });

  it('TC6 quruvchilar PII parametrini qabul QILMAYDI (imzo darajasida)', () => {
    // Funksiya parametrlari — faqat ID, summa, status, rol, usul. `phone`,
    // `address`, `customer`, `comment` kabi nomlar umuman yo'q.
    const src = readFileSync(join(__dirname, 'describe-uz.ts'), 'utf8');
    const builderBlock = src.slice(
      src.indexOf('export const ActivityDescribeUz'),
    );
    expect(builderBlock).not.toMatch(
      /\b(phone\w*|address\w*|customer\w*|comment\w*|note\w*)\??\s*:/i,
    );
  });
});

/**
 * TC9: yorliq jadvallari va `orderStatusUz`/`moneyUz`/`roleUz` FAQAT
 * libs/common da. Servislarda qayta e'lon qilinsa — test yiqiladi.
 */
describe('TC9 yordamchilar bitta joyda (servislarda takrorlanmagan)', () => {
  const appsDir = join(__dirname, '..', '..', '..', '..', 'apps');

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        return name === 'node_modules' ? [] : walk(full);
      }
      return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
    });

  it('apps/ da orderStatusUz/moneyUz/roleUz ning o`z ta`rifi yo`q', () => {
    const files = walk(appsDir);
    expect(files.length).toBeGreaterThan(100); // test soxta emas
    const offenders = files.filter((file) =>
      /(?:function|const)\s+(?:orderStatusUz|moneyUz|roleUz|ORDER_STATUS_UZ|ROLE_UZ)\b/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
