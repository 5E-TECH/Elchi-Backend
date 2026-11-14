/**
 * #646 review probe: sintetik so'rovlar (haqiqiy PII yo'q) — kutilgan natija
 * ikki snapshotda: SEED (regions-districts.data.ts — prod'dagi hozirgi
 * qatorlar) va FULL (seed + rasmiy SOATO ro'yxatidagi yetishmayotgan
 * qatorlar, D1 bajarilgandan keyingi holat).
 *
 * Kutilgan qiymat o'zgarsa — fixture'ni ataylab yangilang va PR'da sababini
 * yozing. Sweep testlari esa invariant: hech qachon BOSHQA tumanni
 * avto-tanlamaydi va qulflangan viloyatdan tashqariga chiqmaydi.
 */
import { Logger } from '@nestjs/common';
import { regions as seedRegions } from '../data/regions-districts.data';
import { satoRegions } from '../data/sato-codes';
import { resolveDistrictText } from './district-resolver.service';
import type { DistrictSnapshot } from './district-resolver.types';
import probeCases from './__fixtures__/resolver-probe-cases.json';

type Q = Parameters<typeof resolveDistrictText>[0];
interface Expected {
  sato: string | null;
  reason: string | null;
}
interface ProbeCase {
  q: Q;
  seed: Expected;
  full: Expected;
}

function buildSeed(): DistrictSnapshot {
  const regions: DistrictSnapshot['regions'] = [];
  const districts: DistrictSnapshot['districts'] = [];
  let did = 1000;
  seedRegions.forEach((r, i) => {
    const rid = String(i + 1);
    regions.push({ id: rid, name: r.name, sato_code: r.sato_code });
    for (const d of r.districts) {
      did += 1;
      districts.push({
        id: String(did),
        name: d.name,
        sato_code: d.sato_code,
        region_id: rid,
      });
    }
  });
  return { regions, districts };
}

function buildFull(base: DistrictSnapshot): DistrictSnapshot {
  const regions = base.regions.map((r) => ({ ...r }));
  const districts = base.districts.map((d) => ({ ...d }));
  const have = new Set(districts.map((d) => d.sato_code));
  let did = 5000;
  for (const off of satoRegions) {
    const region = regions.find((r) => r.sato_code === off.sato_code);
    if (!region) continue;
    for (const d of off.districts) {
      if (have.has(d.sato_code)) continue;
      did += 1;
      districts.push({
        id: String(did),
        name: d.name,
        sato_code: d.sato_code,
        region_id: region.id,
      });
    }
  }
  return { regions, districts };
}

const SEED = buildSeed();
const FULL = buildFull(SEED);

function run(snap: DistrictSnapshot, q: Q) {
  const res = resolveDistrictText(q, snap, () => undefined);
  const row = res.district_id
    ? snap.districts.find((d) => d.id === res.district_id)
    : undefined;
  const regionSato = res.region_id
    ? (snap.regions.find((r) => r.id === res.region_id)?.sato_code ?? null)
    : null;
  return {
    sato: row?.sato_code ?? null,
    reason: (res as { reason?: string | null }).reason ?? null,
    regionSato,
  };
}

const REGION_CANON: Record<string, string> = {
  '1703': 'Andijon',
  '1706': 'Buxoro',
  '1708': 'Jizzax',
  '1710': 'Qashqadaryo',
  '1712': 'Navoiy',
  '1714': 'Namangan',
  '1718': 'Samarqand',
  '1722': 'Surxondaryo',
  '1724': 'Sirdaryo',
  '1726': 'Toshkent shahri',
  '1727': 'Toshkent viloyati',
  '1730': "Farg'ona",
  '1733': 'Xorazm',
  '1735': "Qoraqalpog'iston",
};

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('district resolver — #646 probe cases', () => {
  const cases = probeCases as unknown as ProbeCase[];
  it.each(cases.map((c, i) => [i, c] as const))('case %i', (_i, c) => {
    const seed = run(SEED, c.q);
    const full = run(FULL, c.q);
    expect({ sato: seed.sato, reason: seed.reason }).toEqual(c.seed);
    expect({ sato: full.sato, reason: full.reason }).toEqual(c.full);
  });
});

describe('district resolver — sweep invariants', () => {
  for (const [label, snap] of [
    ['seed', SEED],
    ['full', FULL],
  ] as const) {
    it(`${label}: never auto-picks a different district`, () => {
      const wrong: string[] = [];
      for (const d of snap.districts) {
        const r = snap.regions.find((x) => x.id === d.region_id);
        const rname = REGION_CANON[r?.sato_code ?? ''];
        const nm = d.name.trim();
        const kindWord = d.sato_code?.[4] === '4' ? 'shahri' : 'tumani';
        const base = nm.replace(/ (shahri|tumani)$/, '');
        const qs: Q[] = [];
        for (const f of new Set([
          nm,
          nm.replace(/'/g, '‘'),
          nm.replace(/'/g, ''),
        ])) {
          for (const reg of [null, rname]) {
            qs.push({ region_name: reg, district_name: f });
            qs.push({
              region_name: reg,
              address: `${f}, Navoiy ko'chasi 5-uy`,
            });
            qs.push({
              region_name: reg,
              full_address: `${rname}, ${f}, 5-uy`,
            });
          }
        }
        qs.push(
          {
            region_name: rname,
            full_address: `${rname} viloyati, ${base} ${kindWord}, Mustaqillik ko'chasi 5-uy`,
          },
          { region_name: rname, address: `${base} ${kindWord}, 5-uy` },
          {
            region_name: null,
            full_address: `${base} ${kindWord}, Navro'z MFY, 5-uy`,
          },
          { region_name: rname, district_name: `${base} ${kindWord}` },
        );
        for (const q of qs) {
          const res = run(snap, q);
          if (res.sato && res.sato !== d.sato_code) {
            wrong.push(
              `${nm}=${d.sato_code} ${JSON.stringify(q)} -> ${res.sato}`,
            );
          }
        }
      }
      expect(wrong).toEqual([]);
    });

    it(`${label}: locked region never auto-picks outside it`, () => {
      const leaks: string[] = [];
      for (const d of snap.districts) {
        const own = snap.regions.find((x) => x.id === d.region_id)?.sato_code;
        for (const [sato, name] of Object.entries(REGION_CANON)) {
          if (sato === own) continue;
          const res = run(snap, {
            region_name: name,
            district_name: d.name,
          });
          const tashkentPool =
            (sato === '1726' || sato === '1727') &&
            (res.regionSato === '1726' || res.regionSato === '1727');
          if (res.sato && res.regionSato !== sato && !tashkentPool) {
            leaks.push(`${d.name} in ${name} -> ${res.sato}`);
          }
        }
      }
      expect(leaks).toEqual([]);
    });
  }
});
