/**
 * Buyurtma eksportlari banneri osti matni: «Davr: 16.11.2026 – 25.11.2026 ·
 * Holat: barchasi …». Faqat so'rov filtrlaridan; market / viloyat / tuman /
 * kuryer NOMI alohida RPC'siz — shu filtr bilan kelgan qatorlardan olinadi,
 * topilmasa bannerga qo'yilmaydi.
 */
import { toExcelDate } from '@app/report-kit';
import {
  ORDER_EXPORT_CANCEL_STAGE_LABELS,
  ORDER_EXPORT_STATUS_LABELS,
} from './orders-xlsx.export';

type Obj = Record<string, unknown>;

export interface OrderExportFilters {
  start_day?: string;
  end_day?: string;
  status?: string | string[];
  cancel_stage?: string | string[];
  market_id?: string;
  region_id?: string;
  district_id?: string;
  courier_id?: string;
  search?: string;
}

const MAX_LENGTH = 220;
const MAX_LABELS = 4;

const list = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value])
    .flatMap((item) => (typeof item === 'string' ? item.split(',') : []))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

const single = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/** `2026-11-16` (Toshkent kuni) yoki ISO lahza → `16.11.2026`; boshqasi — ''. */
export const exportDay = (value: unknown): string => {
  const raw = single(value);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (day) return `${day[3]}.${day[2]}.${day[1]}`;
  const at = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? toExcelDate(raw) : null;
  if (!at) return '';
  const iso = at.toISOString();
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
};

export const exportPeriod = (start: unknown, end: unknown): string => {
  const from = exportDay(start);
  const to = exportDay(end);
  if (from && to) return from === to ? from : `${from} – ${to}`;
  if (from) return `${from} dan`;
  if (to) return `${to} gacha`;
  return 'barchasi';
};

const joinLabels = (labels: string[]): string =>
  labels.length > MAX_LABELS
    ? `${labels.slice(0, MAX_LABELS).join(', ')} va yana ${labels.length - MAX_LABELS} ta`
    : labels.join(', ');

/** Filtr id'siga mos qatordagi nom (`row.market.name` …); topilmasa — ''. */
const nameOf = (rows: readonly Obj[], key: string, id: unknown): string => {
  const wanted = single(id);
  if (!wanted) return '';
  for (const row of rows) {
    const ref = row?.[key];
    if (!ref || typeof ref !== 'object') continue;
    const { id: refId, name } = ref as Obj;
    if (single(refId) === wanted && typeof name === 'string' && name.trim()) {
      return name.trim();
    }
  }
  return '';
};

export function orderExportSubtitle(
  filters: OrderExportFilters,
  rows: readonly Obj[] = [],
): string {
  const statuses = list(filters.status).map(
    (status) =>
      (ORDER_EXPORT_STATUS_LABELS as Readonly<Record<string, string>>)[
        status
      ] ?? status,
  );
  const stages = list(filters.cancel_stage).map(
    (stage) => ORDER_EXPORT_CANCEL_STAGE_LABELS[stage] ?? stage,
  );
  const search = single(filters.search).slice(0, 60);
  const market = nameOf(rows, 'market', filters.market_id);
  const region = nameOf(rows, 'region', filters.region_id);
  const district = nameOf(rows, 'district', filters.district_id);
  const courier = nameOf(rows, 'courier', filters.courier_id);
  return [
    `Davr: ${exportPeriod(filters.start_day, filters.end_day)}`,
    `Holat: ${joinLabels([...statuses, ...stages]) || 'barchasi'}`,
    market && `Market: ${market}`,
    region && `Viloyat: ${region}`,
    district && `Tuman: ${district}`,
    courier && `Kuryer: ${courier}`,
    search && `Qidiruv: ${search}`,
  ]
    .filter(Boolean)
    .join(' · ')
    .slice(0, MAX_LENGTH);
}
