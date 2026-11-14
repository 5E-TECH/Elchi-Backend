/// <reference types="jest" />
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CARRIER_PUBLIC_ORDER_STATUSES,
  CarrierOrderStatusRequestDto,
  CarrierPartlySoldItemDto,
  CarrierReturnRequestDto,
  CarrierScanRequestDto,
} from './dto/carrier.swagger.dto';
import { toCarrierOrderView } from './carrier-order-view';
import { toCarrierCashboxView } from './carrier-cashbox-view';

/**
 * Carrier API hujjati (docs/public/CARRIER_API.md) va gateway DTO'lari
 * AJRALMASIN (`partner-api-docs-contract.RJcckQ6I.spec.ts` naqshi). Hujjatni
 * tashqi kompaniya o'qib kod yozadi — DTO'ga maydon qo'shilib hujjatga
 * yozilmasa (yoki aksincha) shu test yiqiladi.
 */
const SWAGGER_PROPS = 'swagger/apiModelPropertiesArray';

const DOC = readFileSync(
  join(__dirname, '../../../docs/public/CARRIER_API.md'),
  'utf8',
);

/** `### <heading>` bo'limidagi jadvallar; har biri 1-ustundagi `maydon`lar. */
function sectionTables(heading: string): string[][] {
  const start = DOC.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = DOC.slice(start + heading.length);
  const end = rest.search(/\n### |\n## /);
  const section = end >= 0 ? rest.slice(0, end) : rest;

  const tables: string[][] = [];
  let current: Set<string> | null = null;
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) {
      if (current) tables.push([...current].sort());
      current = null;
      continue;
    }
    current ??= new Set<string>();
    const cell = /^\|([^|]+)\|/.exec(line)?.[1] ?? '';
    for (const [, name] of cell.matchAll(/`([a-z_]+)`/g)) {
      current.add(name);
    }
  }
  if (current) tables.push([...current].sort());
  return tables;
}

function dtoFields(dto: new () => unknown): string[] {
  const props = (Reflect.getMetadata(SWAGGER_PROPS, dto.prototype) ??
    []) as string[];
  const fields = props.map((p) => p.replace(/^:/, '')).sort();
  expect(fields.length).toBeGreaterThan(0);
  return fields;
}

describe('CARRIER_API.md ↔ gateway DTO', () => {
  it('§5.1 jadvali = CarrierScanRequestDto', () => {
    expect(sectionTables('### 5.1 Posilkani skanerlash')[0]).toEqual(
      dtoFields(CarrierScanRequestDto),
    );
  });

  it('§5.2 1-jadval = CarrierOrderStatusRequestDto, 2-jadval = items[] elementi', () => {
    const [body, item] = sectionTables('### 5.2 Holatni yuborish');
    expect(body).toEqual(dtoFields(CarrierOrderStatusRequestDto));
    expect(item).toEqual(dtoFields(CarrierPartlySoldItemDto));
  });

  it('§5.2 statuslar jadvali = OCHIQ statuslar (rollback yashirin — hujjatda yo‘q)', () => {
    const tables = sectionTables('### 5.2 Holatni yuborish');
    const statusTable = tables[2];
    expect(statusTable).toEqual([...CARRIER_PUBLIC_ORDER_STATUSES].sort());
  });

  it('§4 buyurtma obyekti jadvali = toCarrierOrderView kalitlari', () => {
    const [table] = sectionTables('## 4. Buyurtma obyekti');
    const keys = Object.keys(toCarrierOrderView({ id: '1' })).sort();
    expect(table).toEqual(keys);
  });

  it('§5.4 kassa: 1-jadval = javob maydonlari, 2-jadval = history elementi', () => {
    const [data] = sectionTables('### 5.4 Kassa');
    expect(data).toEqual(
      [...Object.keys(toCarrierCashboxView({})), 'from', 'to'].sort(),
    );
  });

  it('§5.5 qaytarish jadvali = CarrierReturnRequestDto', () => {
    expect(
      sectionTables('### 5.5 Bekor qilingan posilkalarni qaytarish')[0],
    ).toEqual(dtoFields(CarrierReturnRequestDto));
  });

  it('§5.4 kassa tarixi jadvali = toCarrierCashboxView history kalitlari', () => {
    const table = sectionTables('### 5.4 Kassa')[1];
    const entry = toCarrierCashboxView({
      data: { cashboxHistory: [{ id: 1 }] },
    }).history[0];
    expect(table).toEqual(Object.keys(entry).sort());
  });
});
