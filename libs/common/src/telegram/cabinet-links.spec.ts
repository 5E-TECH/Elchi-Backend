import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  DEFAULT_CABINET_URL,
  ORDER_LIST_QUERY_KEYS,
  WEB_ROUTES,
  cabinetBaseUrl,
  cabinetLinks,
  resetCabinetBaseUrlWarning,
} from './cabinet-links';
import { Logger } from '@nestjs/common';

/**
 * PIJN1lGp — botdagi «🌐 Kabinetda …» havolalari FE sahifalariga mos. `WEB_ROUTES`
 * FE `src/app/lib/routes.tsx` / `design/kit/route-map.json` bilan sinxron
 * (veb manzili o'zgarsa — shu ro'yxat va FE `botLinks.test.ts` birga
 * yangilanadi).
 */
const BASE = 'https://admin.elchi.test';

/** `/orders/edit/:orderId` → `/orders/edit/[^/?#]+` (yo'l qismi uchun). */
const routeRegex = (route: string) =>
  new RegExp(`^${route.replace(/:[a-z]+/gi, '[^/?#]+')}$`);
const pathOf = (url: string) => new URL(url).pathname;

describe('PIJN1lGp — cabinetLinks', () => {
  const links = cabinetLinks(BASE);

  it('⭐ «Kabinetda yaratish» — `/new-orders/create` (eski `/orders/create` emas)', () => {
    expect(links.orderCreate()).toBe(`${BASE}/new-orders/create`);
  });

  it('⭐ guruh kartasi — buyurtma tafsiloti `/orders/edit/<id>`', () => {
    expect(links.orderDetail('81')).toBe(`${BASE}/orders/edit/81`);
  });

  it('⭐ kuryer kartasi — kuryer ro‘yxati `orderSearch=EL-…` bilan (eski `search` kaliti emas)', () => {
    const url = new URL(links.courierOrder('81'));
    expect(url.pathname).toBe(WEB_ROUTES.orders);
    expect(url.searchParams.get(ORDER_LIST_QUERY_KEYS.search)).toBe(
      'EL-100081',
    );
    expect(url.searchParams.get(ORDER_LIST_QUERY_KEYS.status)).toBe('waiting');
    expect(url.searchParams.has('search')).toBe(false);
  });

  it('bosh sahifa, o‘z kassasi, smena hisoboti — hozirgi yo‘llar', () => {
    expect(links.home()).toBe(`${BASE}/`);
    expect(links.selfCashbox()).toBe(`${BASE}/cash-box`);
    expect(links.shiftReport('7')).toBe(`${BASE}/payments/shifts/7`);
  });

  it('⭐ har havola `WEB_ROUTES` dagi sahifaga mos', () => {
    const urls = [
      links.home(),
      links.orderCreate(),
      links.orderDetail('81'),
      links.courierOrder('81'),
      links.selfCashbox(),
      links.shiftReport('7'),
    ];
    const routes = Object.values(WEB_ROUTES).map(routeRegex);
    for (const url of urls) {
      expect(url.startsWith(BASE)).toBe(true);
      expect(routes.some((re) => re.test(pathOf(url)))).toBe(true);
    }
  });

  it('⭐ `WEB_ROUTES` — FE route-map.json dagi aniq satrlar (16f27da8)', () => {
    // FE design/kit/route-map.json dan (peer tekshiruvi): o'zgarsa — shu ro'yxat
    // va FE botLinks.test.ts birga yangilanadi.
    const ROUTE_MAP = [
      '/',
      '/orders',
      '/orders/edit/:orderId',
      '/new-orders',
      '/new-orders/create',
      '/cash-box',
      '/payments',
      '/payments/shifts/:id',
      '/courier-bulk',
    ];
    for (const route of Object.values(WEB_ROUTES)) {
      expect(ROUTE_MAP).toContain(route);
    }
  });

  it('asos: oxirgi `/` olinadi; https emas yoki bo‘sh — sukut', () => {
    expect(cabinetBaseUrl(`${BASE}///`)).toBe(BASE);
    expect(cabinetBaseUrl('http://evil.test')).toBe(DEFAULT_CABINET_URL);
    expect(cabinetBaseUrl('javascript:alert(1)')).toBe(DEFAULT_CABINET_URL);
    expect(cabinetBaseUrl(undefined)).toBe(DEFAULT_CABINET_URL);
  });

  it('⭐ kodda eski yo‘llar qolmagan: `/orders/create` va `/orders?search=`', () => {
    const root = join(__dirname, '..', '..', '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== 'node_modules') walk(full);
          continue;
        }
        if (!full.endsWith('.ts') || full.endsWith('.spec.ts')) continue;
        const text = readFileSync(full, 'utf8');
        if (/['"`/]orders\/create\b|\/orders\?search=/.test(text)) {
          offenders.push(relative(root, full));
        }
      }
    };
    walk(join(root, 'apps', 'notification-service', 'src'));
    walk(join(root, 'apps', 'finance-service', 'src'));
    walk(join(root, 'libs', 'common', 'src'));
    expect(offenders).toEqual([]);
  });

  it('yaroqsiz ELCHI_CABINET_URL — jarayonda BIR marta ogohlantirish; bo‘sh qiymatda yo‘q', () => {
    resetCabinetBaseUrlWarning();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    cabinetBaseUrl(undefined);
    cabinetBaseUrl('');
    expect(warn).not.toHaveBeenCalled();
    expect(cabinetBaseUrl('http://admin.elchi.test')).toBe(DEFAULT_CABINET_URL);
    cabinetBaseUrl('http://admin.elchi.test');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/ELCHI_CABINET_URL yaroqsiz/);
    warn.mockRestore();
  });
});
