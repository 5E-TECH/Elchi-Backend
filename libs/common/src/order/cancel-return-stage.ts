/**
 * BEKOR HOLATLARI — bekor qilingan posilkaning JOY BOSQICHLARI (5Yy6r6UI BG1,
 * M0EPcJVf BG3). Gateway (`stage` so'rov parametri) va order-service (hisob,
 * filtr) uchun YAGONA ro'yxat; hisob qoidasi —
 * `apps/order-service/src/cancel-return/cancel-return.ts`.
 */
export const CANCEL_RETURN_STAGES = [
  'courier',
  'in_transit',
  'branch',
  'hq',
  'market',
] as const;
export type CancelReturnStage = (typeof CANCEL_RETURN_STAGES)[number];

const isCancelReturnStage = (value: string): value is CancelReturnStage =>
  (CANCEL_RETURN_STAGES as readonly string[]).includes(value);

/**
 * M0EPcJVf (BG3) — `stage` so'rov parametri: vergul bilan ro'yxat yoki massiv
 * (`courier,in_transit,branch,hq,market`, harf farqsiz). Bo'sh — `stages: null`
 * (filtr yo'q). Noma'lum qiymatlar `invalid` da (chaqiruvchi 400 qaytaradi).
 */
export function parseCancelReturnStages(raw: unknown): {
  stages: CancelReturnStage[] | null;
  invalid: string[];
} {
  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value: unknown) =>
      typeof value === 'string' || typeof value === 'number'
        ? String(value).split(',')
        : [],
    )
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const stages = [...new Set(values.filter(isCancelReturnStage))];
  return {
    stages: stages.length ? stages : null,
    invalid: values.filter((value) => !isCancelReturnStage(value)),
  };
}
