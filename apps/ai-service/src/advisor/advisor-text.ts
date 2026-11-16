import {
  WEB_ROUTES,
  type AiAdvisorCandidate,
  type AiAdvisorCashboxRef,
} from '@app/common';

/** Bo'lim yo'llari — yagona manba `WEB_ROUTES` (FE route-map bilan solishtiriladi). */
const shiftHref = (id: string) =>
  WEB_ROUTES.shiftReport.replace(':id', encodeURIComponent(id));
const cashDetailHref = (ownerId: string) =>
  WEB_ROUTES.cashDetail.replace(':id', encodeURIComponent(ownerId));

/**
 * BE-5 — server matnlari (`title`) va bo'limga havolalar (§5.1, §5.6,
 * §9.3, §10). FE asosan `rule_key + facts` dan i18n bilan quradi; `title`
 * — Telegram/inbox bilan bir xil o'zbekcha zaxira matn.
 *
 * ⚠️ PII yo'q: telefon, chek oluvchi/to'lovchi ismi matnga kirmaydi.
 */

export const TITLE_MAX = 200;
const MINUS = '−';

/** «1 024 000», «−18 000» (guruhlar bo'sh joy bilan, so'mgacha yaxlit). */
export function formatSom(value: number | null | undefined): string {
  const n = Math.round(Number(value ?? 0));
  const abs = Math.abs(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return n < 0 ? `${MINUS}${abs}` : abs;
}

/** `YYYY-MM-DD` → «20.10.2026». */
export function formatDay(day: unknown): string {
  const m =
    typeof day === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** Koeffitsiyent «3,4». */
export function formatRatio(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(1).replace('.', ',') : '';
}

export interface AdvisorLink {
  kind: string;
  href: string;
  entity_id: string | null;
  primary: boolean;
}

const nameOf = (ref: unknown, fallback: string): string => {
  const r = ref as { name?: unknown; id?: unknown } | null | undefined;
  if (r && typeof r.name === 'string' && r.name.trim()) return r.name.trim();
  if (r && (typeof r.id === 'string' || typeof r.id === 'number'))
    return `#${String(r.id)}`;
  return fallback;
};

/** «Samarqand filiali kassasi» → «…kassasida» (§4.2 sarlavha namunasi). */
const inCashbox = (ref: unknown): string => {
  const name = nameOf(ref, '');
  if (!name) return 'Kassada';
  if (/kassa$/i.test(name)) return `${name}da`;
  if (/kassasi$/i.test(name)) return `${name}da`;
  return `${name} kassasida`;
};

const clip = (s: string) =>
  s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s;

/** Ogohlantirish sarlavhasi (§5.1 `title`). */
export function advisorTitle(c: AiAdvisorCandidate): string {
  const f = c.facts;
  switch (c.rule_key) {
    case 'R1': {
      // §4.2/§7.2: «Samarqand filiali kassasida 3 smena ketma-ket kamomad:
      // −445 000 so'm» / «… smena kamomadi: −120 000 so'm». Ketma-ketlikda
      // N va summa — uzluksiz manfiy qator (birlashgan yakka kamomadlarsiz).
      const where = inCashbox(f.cashbox);
      if (f.trigger === 'consecutive_negative') {
        const n = Number(f.streak_length ?? f.shifts_count);
        const sum = Number(f.streak_total ?? f.total_difference);
        return clip(
          `${where} ${n} smena ketma-ket kamomad: ${formatSom(sum)} so'm`,
        );
      }
      return clip(
        `${where} smena kamomadi: ${formatSom(Number(f.last_difference))} so'm`,
      );
    }
    case 'R3': {
      const where = nameOf(f.branch ?? f.cashbox, 'Kassa');
      const category = nameOf(f.category, 'xarajat');
      const ratio = formatRatio(f.ratio_to_median);
      // scope=category — statistika butun tizim bo'yicha (openapi FactsR3.scope).
      const basis =
        f.scope === 'category' ? "tizim bo'yicha odatdagidan" : 'odatdagidan';
      return clip(
        `${where} · ${category}: ${formatSom(Number(f.amount))} so'm${ratio ? ` — ${basis} ${ratio} barobar` : ''}`,
      );
    }
    case 'R6':
      return clip(
        f.period === 'week'
          ? `${formatDay(f.from)}–${formatDay(f.to)} haftasida sof foyda ${formatSom(Number(f.net))} so'm`
          : `${formatDay(f.from)} kuni sof foyda ${formatSom(Number(f.net))} so'm`,
      );
    default:
      return clip(`Ogohlantirish ${c.rule_key}`);
  }
}

/** `operation` havolasi: tarix qatori (FE `?history=`, Q11). */
export function operationHref(
  cashbox: AiAdvisorCashboxRef | undefined,
  historyId: string,
): string {
  if (cashbox?.type === 'branch') {
    return `${cashDetailHref(cashbox.owner_id)}?type=branch&history=${encodeURIComponent(historyId)}`;
  }
  return `${WEB_ROUTES.mainCashbox}?history=${encodeURIComponent(historyId)}`;
}

/** Bo'limga havolalar (§5.6). Bittasi `primary`. Pul amali yo'q. */
export function advisorLinks(c: AiAdvisorCandidate): AdvisorLink[] {
  const f = c.facts;
  switch (c.rule_key) {
    case 'R1': {
      const links: AdvisorLink[] = [];
      const shiftId =
        typeof f.last_shift_id === 'string' ? f.last_shift_id : null;
      if (shiftId) {
        links.push({
          kind: 'shift_report',
          href: shiftHref(shiftId),
          entity_id: shiftId,
          primary: true,
        });
      }
      const cb = f.cashbox as AiAdvisorCashboxRef | undefined;
      if (cb?.type === 'branch') {
        links.push({
          kind: 'branch_cashbox',
          href: `${cashDetailHref(cb.owner_id)}?type=branch`,
          entity_id: cb.owner_id,
          primary: !shiftId,
        });
      } else {
        links.push({
          kind: 'main_cashbox',
          href: WEB_ROUTES.mainCashbox,
          entity_id: null,
          primary: !shiftId,
        });
      }
      return links;
    }
    case 'R3': {
      const id = typeof f.history_id === 'string' ? f.history_id : '';
      return id
        ? [
            {
              kind: 'operation',
              href: operationHref(
                f.cashbox as AiAdvisorCashboxRef | undefined,
                id,
              ),
              entity_id: id,
              primary: true,
            },
          ]
        : [];
    }
    case 'R6': {
      const from = typeof f.from === 'string' ? f.from : '';
      const to = typeof f.to === 'string' ? f.to : '';
      return [
        {
          kind: 'financial_balance',
          href: `${WEB_ROUTES.financialBalance}?tab=history&financialBalanceHistoryFrom=${from}&financialBalanceHistoryTo=${to}`,
          entity_id: null,
          primary: true,
        },
      ];
    }
    default:
      return [];
  }
}

/** Dalil qatorlariga `href` (finance `null` qaytaradi — yo'l ai-service'da). */
export function withEvidenceHrefs(
  c: AiAdvisorCandidate,
): Record<string, unknown> {
  if (c.rule_key !== 'R3') return c.evidence;
  const cashbox = c.facts.cashbox as AiAdvisorCashboxRef | undefined;
  const rows =
    (c.evidence.rows as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    ...c.evidence,
    // Har qator O'Z kassasi bilan (finance `cashbox` — ichki, REST'da yo'q).
    rows: rows.map(({ cashbox: own, ...r }) => ({
      ...r,
      href:
        typeof r.history_id === 'string'
          ? operationHref(
              (own as AiAdvisorCashboxRef | undefined) ?? cashbox,
              r.history_id,
            )
          : null,
    })),
  };
}
