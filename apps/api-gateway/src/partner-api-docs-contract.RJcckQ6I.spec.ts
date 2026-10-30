/// <reference types="jest" />
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CreatePartnerShipmentRequestDto } from './dto/partner-shipment.swagger.dto';
import { CreatePartnerMarketRequestDto } from './dto/partner-market.swagger.dto';

/**
 * T1 K4 (RJcckQ6I) — hamkor hujjati (docs/public/MARKETPLACE_API.md) va
 * gateway DTO'lari AJRALMASIN: §5.1 / §5.2 jadvalidagi maydonlar to'plami
 * DTO'dagi (Swagger) maydonlar to'plamiga teng bo'lishi shart. Yangi maydon
 * DTO'ga qo'shilib hujjatga yozilmasa (yoki aksincha) — shu test yiqiladi.
 */
/** `@nestjs/swagger` `DECORATORS.API_MODEL_PROPERTIES_ARRAY` (paket eksport qilmaydi). */
const SWAGGER_PROPS = 'swagger/apiModelPropertiesArray';

const DOC = readFileSync(
  join(__dirname, '../../../docs/public/MARKETPLACE_API.md'),
  'utf8',
);

/** `### <heading>` bo'limidagi BIRINCHI jadvalning 1-ustunidagi `maydon`lar. */
function tableFields(heading: string): string[] {
  const start = DOC.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = DOC.slice(start + heading.length);
  const section = rest.slice(0, rest.search(/\n### /));
  const fields = new Set<string>();
  for (const line of section.split('\n')) {
    const cell = /^\|([^|]+)\|/.exec(line)?.[1];
    if (!cell) continue;
    for (const [, name] of cell.matchAll(/`([a-z_]+)(?:\.[a-z_]+|\[\])?`/g)) {
      fields.add(name);
    }
  }
  return [...fields].sort();
}

function dtoFields(dto: new () => unknown): string[] {
  const props = (Reflect.getMetadata(SWAGGER_PROPS, dto.prototype) ??
    []) as string[];
  const fields = props.map((p) => p.replace(/^:/, '')).sort();
  // Bo'sh ro'yxatlar "teng" bo'lib qolmasin (metadata kaliti o'zgarsa).
  expect(fields.length).toBeGreaterThan(3);
  return fields;
}

describe('MARKETPLACE_API.md ↔ gateway DTO (T1 K4)', () => {
  it('§5.2 jadvali = CreatePartnerShipmentRequestDto maydonlari', () => {
    expect(tableFields('### 5.2 Buyurtmani topshirish')).toEqual(
      dtoFields(CreatePartnerShipmentRequestDto),
    );
  });

  it('§5.1 jadvali = CreatePartnerMarketRequestDto maydonlari', () => {
    expect(tableFields("### 5.1 Sotuvchini ro'yxatga olish")).toEqual(
      dtoFields(CreatePartnerMarketRequestDto),
    );
  });

  it('kod izohlarida eski docs/PARTNER_API.md havolasi qolmagan', () => {
    // Fayl o'chirilgan — hujjat yagona: docs/public/MARKETPLACE_API.md.
    expect(DOC).not.toContain('PARTNER_API.md');
  });
});
