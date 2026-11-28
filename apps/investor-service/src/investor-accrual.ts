import type { ProfitBasis } from '@app/common';

/**
 * INVESTOR ULUSHI HISOBI — sof funksiyalar (DB/RMQ yo'q).
 *
 * BeePost `investor-ledger.service` naqshi (ega 2026-11-28): har ISH KUNI
 * o'sha kunda amal qilgan ulush sharti bilan hisoblanadi:
 *
 *   kunlik ulush = round(asos × ulush% / 100)   (tiyinda)
 *   asos         = shart 'net' bo'lsa — o'sha kungi sof foyda
 *                  (daromad − xarajat), 'gross' bo'lsa — daromad.
 *
 * Shart boshlanishidan oldingi kunlar hisobga kirmaydi. ZARAR HAM BO'LISHILADI
 * (ega 2026-11-28 tasdiqladi, BeePost bilan bir xil): sof foyda manfiy kunda
 * ulush ham manfiy — investor zarar ulushini ko'taradi. Hisob chiziqli, ya'ni
 * kunlik yig'indi = davr sof foydasi × ulush%; jami manfiy bo'lsa (zarar
 * foydadan ko'p), keyingi foyda avval shu zararni qoplaydi. Yaxlitlash
 * simmetrik `Math.round`. Pul — tiyinlarda butun son (float drift yo'q).
 */

export type ShareTermLike = {
  share_percent: number;
  profit_basis: ProfitBasis;
  /** `YYYY-MM-DD`, inklyuziv. */
  effective_from: string;
  /** `YYYY-MM-DD`, eksklyuziv; `null` — ochiq. */
  effective_to: string | null;
};

/** `finance.pnl.series` (kunlik) bandi — so'mda. */
export type DailyPnlLike = {
  period: string;
  gross: number;
  net: number;
};

export type AccrualMonth = {
  /** `YYYY-MM`. */
  month: string;
  /** Investor amal qilgan kunlardagi asos (sof foyda yoki daromad), tiyin. */
  basisCents: number;
  /** Shu oyda hisoblangan ulush, tiyin. */
  accruedCents: number;
  /** Oyning oxirgi hisoblangan kunidagi ulush foizi. */
  sharePercent: number;
  profitBasis: ProfitBasis;
};

export type Accrual = {
  /** Xronologik (eski → yangi), faqat shart amal qilgan kun bo'lgan oylar. */
  months: AccrualMonth[];
  totalCents: number;
  totalBasisCents: number;
};

export function toCents(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** `day` ga amal qiladigan shart (oraliqlar kesishmaydi deb faraz qilinadi). */
export function termForDay<T extends ShareTermLike>(
  terms: readonly T[],
  day: string,
): T | null {
  for (const term of terms) {
    if (
      term.effective_from <= day &&
      (term.effective_to === null || day < term.effective_to)
    ) {
      return term;
    }
  }
  return null;
}

export function computeAccrual(
  terms: readonly ShareTermLike[],
  days: readonly DailyPnlLike[],
): Accrual {
  const byMonth = new Map<string, AccrualMonth>();
  let totalCents = 0;
  let totalBasisCents = 0;
  const sorted = [...days].sort((a, b) => a.period.localeCompare(b.period));
  for (const day of sorted) {
    const term = termForDay(terms, day.period);
    if (!term) continue;
    const basisCents = toCents(
      term.profit_basis === 'gross' ? day.gross : day.net,
    );
    const shareCents = Math.round(
      (basisCents * Number(term.share_percent)) / 100,
    );
    const month = day.period.slice(0, 7);
    const bucket = byMonth.get(month) ?? {
      month,
      basisCents: 0,
      accruedCents: 0,
      sharePercent: Number(term.share_percent),
      profitBasis: term.profit_basis,
    };
    bucket.basisCents += basisCents;
    bucket.accruedCents += shareCents;
    bucket.sharePercent = Number(term.share_percent);
    bucket.profitBasis = term.profit_basis;
    byMonth.set(month, bucket);
    totalCents += shareCents;
    totalBasisCents += basisCents;
  }
  return {
    months: [...byMonth.values()].sort((a, b) =>
      a.month.localeCompare(b.month),
    ),
    totalCents,
    totalBasisCents,
  };
}

/**
 * To'langan pulni oylarga taqsimlash (FIFO): eng eski oyning musbat ulushi
 * birinchi «yopiladi». Grafikdagi «To'langan» / «Kutilmoqda» bo'linmasi shu.
 * Zarar oyi (manfiy ulush) to'lov olmaydi. Ortiqcha to'lov hech qaysi oyga
 * tushmaydi (yig'indida «qoldiq» manfiy bo'lib ko'rinadi).
 */
export function allocatePaid(
  months: readonly { month: string; accruedCents: number }[],
  paidCents: number,
): Map<string, number> {
  const result = new Map<string, number>();
  let left = Math.max(0, paidCents);
  for (const row of months) {
    const take = row.accruedCents > 0 ? Math.min(left, row.accruedCents) : 0;
    result.set(row.month, take);
    left -= take;
  }
  return result;
}

// ─────────────────────── ulush shartini o'zgartirish ───────────────────────

export type TermRow = ShareTermLike & { id: string };

export type TermChange = {
  share_percent: number;
  profit_basis: ProfitBasis;
  effective_from: string;
};

export type TermPlan =
  | { kind: 'noop' }
  | { kind: 'error'; message: string }
  | {
      kind: 'apply';
      /** Tartib bilan bajariladi (yopish — yangisini ochishdan OLDIN). */
      updates: Array<{ id: string; patch: Partial<ShareTermLike> }>;
      insert: Omit<ShareTermLike, 'effective_to'> | null;
    };

/**
 * Yangi shartni qo'llash rejasi (`terms` — o'chirilmagan, `effective_from`
 * bo'yicha o'sib boruvchi):
 *  - shart yo'q → yangi ochiq shart;
 *  - sana ochiq shart boshidan KEYIN → ochiq shart shu sanada yopiladi,
 *    yangisi ochiladi (o'tgan kunlar eski shart bilan qoladi);
 *  - sana ochiq shart boshiga teng yoki OLDIN → ochiq shart joyida
 *    tuzatiladi (xato kiritilgan foiz/asos/sanani to'g'rilash); oldingi
 *    yopiq shart bo'lsa, uning oxiri yangi boshga suriladi, lekin uning
 *    boshidan oldinga o'tib bo'lmaydi.
 */
export function planShareTermChange(
  terms: readonly TermRow[],
  change: TermChange,
): TermPlan {
  const open = terms.find((term) => term.effective_to === null) ?? null;
  const same = (term: ShareTermLike) =>
    Number(term.share_percent) === change.share_percent &&
    term.profit_basis === change.profit_basis;

  if (!open) {
    const last = terms[terms.length - 1];
    if (last?.effective_to && change.effective_from < last.effective_to) {
      return {
        kind: 'error',
        message: `Sana oldingi ulush davri tugagan kundan (${last.effective_to}) oldin bo'lmasligi kerak`,
      };
    }
    return {
      kind: 'apply',
      updates: [],
      insert: {
        share_percent: change.share_percent,
        profit_basis: change.profit_basis,
        effective_from: change.effective_from,
      },
    };
  }

  if (change.effective_from > open.effective_from) {
    if (same(open)) return { kind: 'noop' };
    return {
      kind: 'apply',
      updates: [
        { id: open.id, patch: { effective_to: change.effective_from } },
      ],
      insert: {
        share_percent: change.share_percent,
        profit_basis: change.profit_basis,
        effective_from: change.effective_from,
      },
    };
  }

  if (change.effective_from === open.effective_from && same(open)) {
    return { kind: 'noop' };
  }

  const index = terms.indexOf(open);
  const previous = index > 0 ? terms[index - 1] : null;
  if (previous && change.effective_from <= previous.effective_from) {
    return {
      kind: 'error',
      message: `Sana oldingi ulush davri boshlanishidan (${previous.effective_from}) keyin bo'lishi kerak`,
    };
  }
  const updates: Array<{ id: string; patch: Partial<ShareTermLike> }> = [];
  if (previous && change.effective_from !== open.effective_from) {
    updates.push({
      id: previous.id,
      patch: { effective_to: change.effective_from },
    });
  }
  updates.push({
    id: open.id,
    patch: {
      share_percent: change.share_percent,
      profit_basis: change.profit_basis,
      effective_from: change.effective_from,
    },
  });
  return { kind: 'apply', updates, insert: null };
}

/**
 * «Investorlik sanasi»ni tuzatish — BIRINCHI shartning boshi (oldinga ham,
 * orqaga ham). Birinchi shart yopiq bo'lsa, yangi bosh uning oxiridan oldin
 * bo'lishi shart.
 */
export function planStartChange(
  terms: readonly TermRow[],
  startDay: string,
): TermPlan {
  const first = terms[0];
  if (!first) {
    return {
      kind: 'error',
      message: "Investorda ulush sharti yo'q — avval «Ulush (%)» ni kiriting",
    };
  }
  if (first.effective_to !== null && startDay >= first.effective_to) {
    return {
      kind: 'error',
      message: `Investorlik sanasi birinchi ulush davri tugashidan (${first.effective_to}) oldin bo'lishi kerak`,
    };
  }
  if (startDay === first.effective_from) return { kind: 'noop' };
  return {
    kind: 'apply',
    updates: [{ id: first.id, patch: { effective_from: startDay } }],
    insert: null,
  };
}
