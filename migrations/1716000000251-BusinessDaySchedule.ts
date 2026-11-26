import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (xhiXv3w3) «Kun almashish soati» endi butun tizimning ISH KUNI: dashboard,
 * hisobotlar, moliya kunlari, Excel va kunlik pochtalar shu chegarada.
 * Qiymat shakli `{ time }` → `{ time, schedule: [{ from, time }] }`
 * (`libs/common/src/time/business-day.ts`).
 *
 * Eski kunlar QAYTA HISOBLANMAYDI (ega 2026-11-02): oldin qo'yilgan soat
 * (faqat qabul oynasiga ta'sir qilardi) shu migratsiya ishlagan paytdan
 * keyingi birinchi kun almashishidan qoida bo'ladi — `planBusinessDayChange`
 * bilan AYNI qoida (kamida 5 daqiqa keyin, joriy kundan keyingi kun). Soat
 * `00:00` yoki qator yo'q — hech narsa o'zgarmaydi (qoida yo'q = yarim tun).
 *
 * Faqat bitta sozlama qatori (`order_settings`), band jadval qulfi yo'q.
 * Qayta yurgizish xatosiz: `schedule` bor qator o'tkazib yuboriladi.
 *
 * down(): `schedule` olib tashlanadi — soat yana faqat qabul oynasiga.
 */
const KEY = 'intake.day_change_time';
const OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEAD_MS = 5 * 60 * 1000;

function firstEffectiveDay(time: string, now: Date): string | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes === 0) return null;
  const offset = minutes < 720 ? minutes : minutes - 1440;
  // Joriy ish kuni — eski qoida (Toshkent yarim tuni) bo'yicha.
  const todayMs = Date.parse(
    `${new Date(now.getTime() + OFFSET_MS).toISOString().slice(0, 10)}T00:00:00.000Z`,
  );
  for (let day = 1; day <= 3; day += 1) {
    const keyMs = todayMs + day * DAY_MS;
    const startMs = keyMs - OFFSET_MS + offset * 60_000;
    if (startMs >= now.getTime() + LEAD_MS) {
      return new Date(keyMs).toISOString().slice(0, 10);
    }
  }
  return null;
}

export class BusinessDaySchedule1716000000251 implements MigrationInterface {
  name = 'BusinessDaySchedule1716000000251';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ id: string; value: unknown }> = await queryRunner.query(
      `SELECT "id"::text AS id, "value" FROM "order_schema"."order_settings"
        WHERE "key" = $1`,
      [KEY],
    );
    for (const row of rows) {
      const value =
        row.value && typeof row.value === 'object'
          ? (row.value as { time?: unknown; schedule?: unknown })
          : {};
      if (Array.isArray(value.schedule)) continue;
      const time = typeof value.time === 'string' ? value.time.trim() : '';
      const from = firstEffectiveDay(time, new Date());
      const next = {
        time: from ? time : '00:00',
        schedule: from ? [{ from, time }] : [],
      };
      await queryRunner.query(
        `UPDATE "order_schema"."order_settings"
            SET "value" = $2::jsonb, "updatedAt" = now()
          WHERE "id" = $1`,
        [row.id, JSON.stringify(next)],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "order_schema"."order_settings"
          SET "value" = "value" - 'schedule'
        WHERE "key" = $1`,
      [KEY],
    );
  }
}
