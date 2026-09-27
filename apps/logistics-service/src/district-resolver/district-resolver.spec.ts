import { Logger } from '@nestjs/common';
import type { RmqContext } from '@nestjs/microservices';
import type { Repository } from 'typeorm';
import {
  GEO_FUZZY_MIN,
  GEO_SUBSTRING_MIN,
  bestSubstringSim,
  normGeo,
  simRatio,
} from '@app/common';
import type { RmqService } from '@app/common';
import { regions as seedRegions } from '../data/regions-districts.data';
import type { District } from '../entities/district.entity';
import type { Region } from '../entities/region.entity';
import { LogisticsServiceController } from '../logistics-service.controller';
import type { LogisticsServiceService } from '../logistics-service.service';
import {
  DISTRICT_RESOLVE_MAX_ITEMS,
  DistrictResolverService,
  geoBigrams,
  mayReachGeoSubstringMin,
  resolveDistrictText,
} from './district-resolver.service';
import type {
  DistrictResolveByTextPayload,
  DistrictSnapshot,
  DistrictSnapshotDistrict,
  DistrictTextQuery,
  DistrictTextResolution,
} from './district-resolver.types';

/**
 * AnKM7xmy — tuman rezolyutsiyasi. ⚠️ DB, DataSource, RMQ va Claude YO'Q:
 * snapshot seed faylidan (`regions-districts.data.ts`, 14 viloyat / 181
 * tuman) sintetik id bilan quriladi — nomlar XOM ("Toshkent ", "Andijon ").
 */

type Mutate = (s: {
  regions: { id: string; name: string; sato_code: string | null }[];
  districts: DistrictSnapshotDistrict[];
}) => void;

function buildSnapshot(opts?: {
  trim?: boolean;
  mutate?: Mutate;
}): DistrictSnapshot {
  const fix = (s: string) => (opts?.trim ? s.trim() : s);
  const regions: { id: string; name: string; sato_code: string | null }[] = [];
  const districts: DistrictSnapshotDistrict[] = [];
  let districtId = 1000;
  seedRegions.forEach((r, i) => {
    const regionId = String(i + 1);
    regions.push({ id: regionId, name: fix(r.name), sato_code: r.sato_code });
    for (const d of r.districts) {
      districtId += 1;
      districts.push({
        id: String(districtId),
        name: fix(d.name),
        sato_code: d.sato_code,
        region_id: regionId,
      });
    }
  });
  const snapshot = { regions, districts };
  opts?.mutate?.(snapshot);
  return snapshot;
}

const SNAP = buildSnapshot();

function regionIdBySato(snap: DistrictSnapshot, sato: string): string {
  const row = snap.regions.find((r) => r.sato_code === sato);
  if (!row) throw new Error(`region ${sato} not in snapshot`);
  return row.id;
}

function districtBySato(
  snap: DistrictSnapshot,
  sato: string,
): DistrictSnapshotDistrict {
  const row = snap.districts.find((d) => d.sato_code === sato);
  if (!row) throw new Error(`district ${sato} not in snapshot`);
  return row;
}

function districtByName(
  snap: DistrictSnapshot,
  name: string,
): DistrictSnapshotDistrict {
  const row = snap.districts.find((d) => d.name.trim() === name);
  if (!row) throw new Error(`district ${name} not in snapshot`);
  return row;
}

/** Nomzodlar orasida shu viloyat SOATO prefiksli tuman bormi. */
function candidateSatos(
  snap: DistrictSnapshot,
  res: DistrictTextResolution,
): string[] {
  return res.candidates.map(
    (c) => snap.districts.find((d) => d.id === c.id)?.sato_code ?? 'null',
  );
}

function resolve(
  q: DistrictTextQuery,
  snap: DistrictSnapshot = SNAP,
  warn: (msg: string) => void = () => undefined,
): DistrictTextResolution {
  return resolveDistrictText(q, snap, warn);
}

describe('resolveDistrictText (AnKM7xmy)', () => {
  describe('checklist #1 — "Toshkent shahri Xonobod"', () => {
    it('viloyat = Toshkent shahri, tuman null, Andijon nomzodi YO`Q', () => {
      const res = resolve({
        region_name: 'Toshkent shahri',
        district_name: 'Xonobod',
      });
      expect(res.region_id).toBe(regionIdBySato(SNAP, '1726'));
      expect(res.region_label).toBe('Toshkent shahri');
      expect(res.region_given).toBe(true);
      expect(res.district_id).toBeNull();
      expect(res.candidates).toEqual([]);
      expect(candidateSatos(SNAP, res).some((s) => s.startsWith('1703'))).toBe(
        false,
      );
      expect(res.reason).toBe('district_not_found');
    });

    it('qulfsiz "Xonobod" esa Andijondagi Xonobod`ni topadi (qulf ishlayotganini isbotlaydi)', () => {
      const res = resolve({ district_name: 'Xonobod' });
      expect(res.district_id).toBe(districtBySato(SNAP, '1703408').id);
    });
  });

  describe('checklist #2 — "Toshkent shahri Mirobod"', () => {
    it('Mirobod (1726273) avto-tanlanadi, Mirzaobod (Sirdaryo) TANLANMAYDI', () => {
      const res = resolve({
        region_name: 'Toshkent shahri',
        district_name: 'Mirobod',
      });
      expect(res.district_id).toBe(districtBySato(SNAP, '1726273').id);
      expect(res.region_id).toBe(regionIdBySato(SNAP, '1726'));
      expect(res.candidates).toEqual([]);
      expect(res.district_label).toBe('Toshkent shahri, Mirobod');
      expect(res.reason).toBeUndefined();
    });

    it('to`liq manzil ichida ham ("Toshkent shahri Mirobod tumani")', () => {
      const res = resolve({
        region_name: 'Toshkent sh.',
        district_name: 'Toshkent shahri Mirobod tumani',
      });
      expect(res.district_id).toBe(districtBySato(SNAP, '1726273').id);
    });
  });

  describe('checklist #3 — viloyatsiz "Mirzaobod"', () => {
    it('avto-tanlanmaydi: Mirzaobod + Mirobod nomzod, cross_region_confusable', () => {
      const res = resolve({ district_name: 'Mirzaobod' });
      expect(res.district_id).toBeNull();
      expect(res.region_id).toBeNull();
      expect(res.region_given).toBe(false);
      const ids = res.candidates.map((c) => c.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          districtBySato(SNAP, '1724228').id,
          districtBySato(SNAP, '1726273').id,
        ]),
      );
      expect(res.reason).toBe('cross_region_confusable');
      expect(res.candidates).toEqual(
        expect.arrayContaining([
          {
            id: districtBySato(SNAP, '1724228').id,
            label: 'Sirdaryo viloyati, Mirzaobod',
            region_name: 'Sirdaryo',
            district_name: 'Mirzaobod',
          },
          {
            id: districtBySato(SNAP, '1726273').id,
            label: 'Toshkent shahri, Mirobod',
            region_name: 'Toshkent shahri',
            district_name: 'Mirobod',
          },
        ]),
      );
    });

    it('viloyat berilsa ("Sirdaryo" + "Mirzaobod") — avto-tanlanadi', () => {
      const res = resolve({
        region_name: 'Sirdaryo viloyati',
        district_name: 'Mirzaobod',
      });
      expect(res.district_id).toBe(districtBySato(SNAP, '1724228').id);
      expect(res.region_id).toBe(regionIdBySato(SNAP, '1724'));
    });
  });

  describe('checklist #4 — "Andijon xojaobd" (imlo xatosi)', () => {
    const xojaobod = districtBySato(SNAP, '1703236');
    const andijonTuman = districtBySato(SNAP, '1703203');

    it('3-usul (fuzzy): Xo`jaobod (1703236) avto-tanlanadi', () => {
      const res = resolve({ region_name: 'Andijon', district_name: 'xojaobd' });
      expect(res.district_id).toBe(xojaobod.id);
      expect(res.region_id).toBe(regionIdBySato(SNAP, '1703'));
      expect(res.district_label).toBe("Andijon viloyati, Xo'jaobod");
      expect(res.district_name).toBe("Xo'jaobod");
      expect(res.candidates).toEqual([]);
    });

    it('district_name ichida viloyat so`zi bo`lsa ham Andijon TUMANi tanlanmaydi', () => {
      const res = resolve({
        region_name: 'Andijon',
        district_name: 'Andijon xojaobd',
      });
      expect(res.district_id).toBe(xojaobod.id);
      expect(res.district_id).not.toBe(andijonTuman.id);
      expect(res.candidates.map((c) => c.id)).not.toContain(andijonTuman.id);
    });

    it('faqat full_address berilsa — 4-usul (fuzzy-substring) topadi', () => {
      const res = resolve({
        region_name: 'Andijon',
        full_address: 'Andijon viloyati xojaobd tumani, Navbahor MFY 12-uy',
      });
      expect(res.district_id).toBe(xojaobod.id);
    });

    it('"Andijon viloyati Andijon tumani" — ikkinchi "Andijon" TUMAN', () => {
      const res = resolve({
        region_name: 'Andijon viloyati',
        district_name: 'Andijon tumani',
      });
      expect(res.district_id).toBe(andijonTuman.id);
    });
  });

  describe('checklist #5 — yalang`och "Toshkent"', () => {
    it('region_id null (NOANIQ), region_ambiguous', () => {
      const res = resolve({ region_name: 'Toshkent' });
      expect(res.region_id).toBeNull();
      expect(res.region_given).toBe(false);
      expect(res.district_id).toBeNull();
      expect(res.candidates).toEqual([]);
      expect(res.reason).toBe('region_ambiguous');
    });

    it('tuman matndan hal qiladi: "Toshkent" + "Chilonzor" → 1726294, viloyat tumandan', () => {
      const res = resolve({
        region_name: 'Toshkent',
        district_name: 'Chilonzor',
      });
      expect(res.district_id).toBe(districtBySato(SNAP, '1726294').id);
      expect(res.region_id).toBe(regionIdBySato(SNAP, '1726'));
      expect(res.region_label).toBe('Toshkent shahri');
      expect(res.region_given).toBe(false);
    });

    it('"Toshkent viloyati" va "Toshkent shahri" markerlari viloyatni QULFLAYDI', () => {
      expect(resolve({ region_name: 'Toshkent viloyati' }).region_id).toBe(
        regionIdBySato(SNAP, '1727'),
      );
      expect(resolve({ region_name: 'Тошкент шаҳри' }).region_id).toBe(
        regionIdBySato(SNAP, '1726'),
      );
    });

    it('tuman matni ham yalang`och "Toshkent" — "Toshkent tumani" (1727) TAXMIN qilinmaydi', () => {
      const toshkentTumani = districtBySato(SNAP, '1727265');
      for (const q of [
        { district_name: 'Toshkent' },
        { region_name: 'Toshkent', district_name: 'Toshkent' },
        { region_name: 'Toshkent', district_name: 'Toshkent shahri' },
        { district_name: 'Tashkent' },
      ]) {
        const res = resolve(q);
        expect(res.district_id).toBeNull();
        expect(res.region_id).toBeNull();
        expect(res.reason).toBe('region_ambiguous');
        expect(res.candidates.map((c) => c.id)).toEqual([toshkentTumani.id]);
      }
    });

    it('nazorat: "Toshkent tumani" aniq aytilsa yoki viloyat qulflangan bo`lsa — tanlanadi', () => {
      const toshkentTumani = districtBySato(SNAP, '1727265');
      expect(resolve({ district_name: 'Toshkent tumani' }).district_id).toBe(
        toshkentTumani.id,
      );
      expect(
        resolve({ region_name: 'Toshkent viloyati', district_name: 'Toshkent' })
          .district_id,
      ).toBe(toshkentTumani.id);
    });
  });

  describe('checklist #6 — viloyat qulfi (cross-region oqmaydi)', () => {
    it('"Toshkent viloyati Chirchiq" → 1727419, Chiroqchi (Qashqadaryo) chiqmaydi', () => {
      const res = resolve({
        region_name: 'Toshkent viloyati',
        district_name: 'Chirchiq',
      });
      expect(res.district_id).toBe(districtBySato(SNAP, '1727419').id);
      expect(res.candidates).toEqual([]);
      expect(res.region_label).toBe('Toshkent viloyati');
      expect(res.region_name).toBe('Toshkent');
      expect(res.district_label).toBe('Toshkent viloyati, Chirchiq');
    });

    it('TUZATISH: "Qashqadaryo" + "Kogon" → tuman null, Buxoro nomzodi YO`Q', () => {
      const res = resolve({
        region_name: 'Qashqadaryo',
        district_name: 'Kogon',
      });
      expect(res.district_id).toBeNull();
      expect(res.region_id).toBe(regionIdBySato(SNAP, '1710'));
      expect(candidateSatos(SNAP, res).some((s) => s.startsWith('1706'))).toBe(
        false,
      );
      expect(candidateSatos(SNAP, res).every((s) => s.startsWith('1710'))).toBe(
        true,
      );
      expect(res.reason).toBe('cross_region_confusable');
    });

    it('TUZATISH: "Toshkent viloyati" + "Zarafshon" → tuman null, Navoiy nomzodi YO`Q', () => {
      const res = resolve({
        region_name: 'Toshkent viloyati',
        district_name: 'Zarafshon',
      });
      expect(res.district_id).toBeNull();
      expect(res.region_id).toBe(regionIdBySato(SNAP, '1727'));
      expect(candidateSatos(SNAP, res).some((s) => s.startsWith('1712'))).toBe(
        false,
      );
    });

    it('nazorat: "Qashqadaryo" + "Koson" (aniq nom) avto-tanlanadi', () => {
      const res = resolve({
        region_name: 'Qashqadaryo',
        district_name: 'Koson',
      });
      expect(res.district_id).toBe(districtBySato(SNAP, '1710229').id);
    });

    it('nazorat: qulf ichidagi imlo xatosi ("Qashqadaryo" + "Kosan") avto-tanlanadi', () => {
      const res = resolve({
        region_name: 'Qashqadaryo',
        district_name: 'Kosan',
      });
      expect(res.district_id).toBe(districtBySato(SNAP, '1710229').id);
    });
  });

  describe('checklist #7 — SOATO darvozasi (R3)', () => {
    it('soxta juftlik: tuman kodi viloyat prefiksiga mos emas → RAD, nomzodga tushadi', () => {
      const snap = buildSnapshot({
        mutate: (s) => {
          const d = s.districts.find((x) => x.sato_code === '1726294');
          if (d) d.sato_code = '1703999';
        },
      });
      const chilonzor = districtByName(snap, 'Chilonzor');
      const res = resolve(
        { region_name: 'Toshkent shahri', district_name: 'Chilonzor' },
        snap,
      );
      expect(res.district_id).toBeNull();
      expect(res.reason).toBe('sato_mismatch');
      expect(res.candidates.map((c) => c.id)).toEqual([chilonzor.id]);
      // Viloyat SAQLANADI.
      expect(res.region_id).toBe(regionIdBySato(snap, '1726'));
    });

    it('seed ma`lumotida 181/181 tuman SOATO prefiksiga mos', () => {
      const bad = SNAP.districts.filter((d) => {
        const region = SNAP.regions.find((r) => r.id === d.region_id);
        return !String(d.sato_code).startsWith(String(region?.sato_code));
      });
      expect(SNAP.districts).toHaveLength(181);
      expect(bad).toEqual([]);
    });
  });

  describe('checklist #8 — sato_code NULL (R4)', () => {
    const snap = buildSnapshot({
      mutate: (s) => {
        const d = s.districts.find((x) => x.sato_code === '1726294');
        if (d) d.sato_code = null;
      },
    });
    const chilonzor = districtByName(snap, 'Chilonzor');

    it('qulf bor: darvoza o`tkazib yuboriladi, avto-tanlanadi, WARN bir marta (district id bilan)', () => {
      const warn = jest.fn<void, [string]>();
      const res = resolve(
        { region_name: 'Toshkent shahri', district_name: 'Chilonzor' },
        snap,
        warn,
      );
      expect(res.district_id).toBe(chilonzor.id);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(`district ${chilonzor.id}`);
    });

    it('qulf yo`q: avto-tanlanmaydi — majburan nomzod + WARN', () => {
      const warn = jest.fn<void, [string]>();
      const res = resolve(
        { region_name: 'Toshkent', district_name: 'Chilonzor' },
        snap,
        warn,
      );
      expect(res.district_id).toBeNull();
      expect(res.candidates.map((c) => c.id)).toEqual([chilonzor.id]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(chilonzor.id);
    });

    it('viloyat sato_code NULL: WARN + qulfsiz qidiruv (nom bo`yicha taxmin YO`Q)', () => {
      const snapNullRegion = buildSnapshot({
        mutate: (s) => {
          const r = s.regions.find((x) => x.sato_code === '1703');
          if (r) r.sato_code = null;
        },
      });
      const warn = jest.fn<void, [string]>();
      const res = resolve(
        { region_name: 'Andijon', district_name: 'Xonobod' },
        snapNullRegion,
        warn,
      );
      expect(res.region_given).toBe(true);
      expect(res.region_id).toBeNull();
      expect(res.district_id).toBeNull();
      expect(res.candidates.map((c) => c.id)).toContain(
        districtBySato(snapNullRegion, '1703408').id,
      );
      expect(
        warn.mock.calls.some(([m]) => String(m).includes('SOATO 1703')),
      ).toBe(true);
    });

    it('SOATO yo`q bo`lsa tur nomdagi qo`shimchadan olinadi ("Samarqand shahri")', () => {
      const snapNull = buildSnapshot({
        mutate: (s) => {
          for (const d of s.districts) {
            if (d.sato_code === '1718401' || d.sato_code === '1718233') {
              d.sato_code = null;
            }
          }
        },
      });
      const res = resolve(
        { region_name: 'Samarqand', district_name: 'Samarqand shahri' },
        snapNull,
      );
      expect(res.district_id).toBe(
        districtByName(snapNull, 'Samarqand shahri').id,
      );
    });
  });

  describe('checklist #9 — place-signal (forceCandidate)', () => {
    const uzun = districtBySato(SNAP, '1722221');

    it('"Uzun ko`chasi 12" — oddiy ko`cha so`zi tumanga AYLANMAYDI', () => {
      const res = resolve({ address: "Uzun ko'chasi 12" });
      expect(res.district_id).toBeNull();
      expect(res.candidates.map((c) => c.id)).toEqual([uzun.id]);
      expect(res.reason).toBe('no_place_signal');
    });

    it('nazorat: "Uzun tumani, ..." — avto-tanlanadi', () => {
      const res = resolve({ address: 'Uzun tumani, Mustaqillik 5' });
      expect(res.district_id).toBe(uzun.id);
      expect(res.region_id).toBe(regionIdBySato(SNAP, '1722'));
    });
  });

  describe('checklist #10 — XOM seed nomlari ("Toshkent ", "Andijon ")', () => {
    const TRIMMED = buildSnapshot({ trim: true });
    const queries: DistrictTextQuery[] = [
      { region_name: 'Toshkent viloyati', district_name: 'Chirchiq' },
      { region_name: 'Toshkent ', district_name: 'Chilonzor ' },
      { region_name: 'Andijon ', district_name: 'xojaobd' },
      { region_name: 'Samarqand', district_name: 'Samarqand' },
      { district_name: 'Mirzaobod' },
      { region_name: 'Toshkent shahri', district_name: 'Xonobod' },
      { address: "Uzun ko'chasi 12" },
      { region_name: 'Qashqadaryo', district_name: 'Kogon' },
    ];

    it.each(queries)(
      'xom va trim qilingan snapshot bir xil natija: %j',
      (q) => {
        expect(resolve(q, SNAP)).toEqual(resolve(q, TRIMMED));
      },
    );

    it('yorliqlar trim qilingan, region_name = DB nomi (trim)', () => {
      expect(SNAP.regions.find((r) => r.sato_code === '1727')?.name).toBe(
        'Toshkent ',
      );
      const res = resolve({
        region_name: 'Toshkent viloyati',
        district_name: 'Chirchiq',
      });
      expect(res.region_label).toBe('Toshkent viloyati');
      expect(res.region_name).toBe('Toshkent');
      expect(res.district_label).toBe('Toshkent viloyati, Chirchiq');
      const amb = resolve({ region_name: 'Andijon', district_name: 'Andijon' });
      for (const c of amb.candidates) {
        expect(c.region_name).toBe('Andijon');
        expect(c.label.startsWith('Andijon viloyati, ')).toBe(true);
        expect(c.label).toBe(c.label.trim());
      }
    });
  });

  describe('checklist #11 — GENERATIV: viloyatlararo o`xshash juftliklar', () => {
    const EXPECTED = new Set([
      'Kogon|Koson',
      'Kogon shahri|Koson',
      'Mirobod|Mirzaobod',
      'Nurafshon|Zarafshon',
      'Andijon|Bandixon',
      'Andijon shahri|Bandixon',
      "Oltinko'l|Oltinsoy",
    ]);

    const pairs: [DistrictSnapshotDistrict, DistrictSnapshotDistrict][] = [];
    const ds = SNAP.districts;
    for (let i = 0; i < ds.length; i++) {
      for (let j = i + 1; j < ds.length; j++) {
        if (ds[i].region_id === ds[j].region_id) continue;
        const s = simRatio(normGeo(ds[i].name), normGeo(ds[j].name));
        if (s >= GEO_FUZZY_MIN) pairs.push([ds[i], ds[j]]);
      }
    }
    const key = ([a, b]: [
      DistrictSnapshotDistrict,
      DistrictSnapshotDistrict,
    ]) => [a.name.trim(), b.name.trim()].sort().join('|');

    it('soni <= 7 va aynan nomlangan to`plam', () => {
      expect(pairs.length).toBeLessThanOrEqual(7);
      expect(new Set(pairs.map(key))).toEqual(EXPECTED);
    });

    it.each(pairs.map((p) => [key(p), p] as const))(
      '%s — viloyatsiz hech biri avto-tanlanmaydi',
      (_label, [a, b]) => {
        for (const d of [a, b]) {
          const res = resolve({ district_name: d.name });
          expect(res.district_id).toBeNull();
          expect(res.candidates.length).toBeGreaterThan(0);
        }
      },
    );
  });

  describe('2-usul — manzildagi viloyat so`zi viloyat nomli tumanni tanlatmaydi', () => {
    it('"Toshkent Olmazor tumani" → Olmazor (Toshkent sh.), "Toshkent tumani" (1727) EMAS', () => {
      const res = resolve({
        region_name: 'Toshkent',
        address: 'Toshkent Olmazor tumani',
      });
      expect(res.district_id).toBe(districtBySato(SNAP, '1726280').id);
      expect(res.region_id).toBe(regionIdBySato(SNAP, '1726'));
    });

    it('"Samarqand Urgut tumani" → Urgut, "Samarqand" tumani EMAS', () => {
      const res = resolve({
        region_name: 'Samarqand',
        address: 'Samarqand Urgut tumani',
      });
      expect(res.district_id).toBe(districtBySato(SNAP, '1718236').id);
    });

    it('faqat viloyat nomli moslik qolsa — o`sha ("Andijon tumani, Oq yer MFY")', () => {
      const res = resolve({
        region_name: 'Andijon',
        address: 'Andijon tumani, Oq yer MFY',
      });
      expect(res.district_id).toBe(districtBySato(SNAP, '1703203').id);
    });

    it('"Toshkent shahar, ..." — "Toshkent tumani" avto-tanlanmaydi (region_ambiguous)', () => {
      const res = resolve({
        region_name: 'Toshkent',
        address: 'Toshkent shahar, Mustaqillik 5',
      });
      expect(res.district_id).toBeNull();
      expect(res.region_id).toBeNull();
      expect(res.reason).toBe('region_ambiguous');
    });
  });

  describe('R1 — shahar/tuman afzalligi (SOATO 5-belgisi)', () => {
    it('"Qarshi tumani" → Karshi (1710224), "Qarshi shahri" → 1710401', () => {
      expect(
        resolve({ region_name: 'Qashqadaryo', district_name: 'Qarshi tumani' })
          .district_id,
      ).toBe(districtBySato(SNAP, '1710224').id);
      expect(
        resolve({ region_name: 'Qashqadaryo', district_name: 'Qarshi shahri' })
          .district_id,
      ).toBe(districtBySato(SNAP, '1710401').id);
    });

    it('"Samarqand shahri" / "Samarqand tumani" / markersiz "Samarqand"', () => {
      expect(
        resolve({ region_name: 'Samarqand', district_name: 'Samarqand shahri' })
          .district_id,
      ).toBe(districtBySato(SNAP, '1718401').id);
      expect(
        resolve({ region_name: 'Samarqand', district_name: 'Samarqand tumani' })
          .district_id,
      ).toBe(districtBySato(SNAP, '1718233').id);
      const amb = resolve({
        region_name: 'Samarqand',
        district_name: 'Samarqand',
      });
      expect(amb.district_id).toBeNull();
      expect(amb.reason).toBe('district_ambiguous');
      expect(amb.candidates.map((c) => c.id).sort()).toEqual(
        [
          districtBySato(SNAP, '1718401').id,
          districtBySato(SNAP, '1718233').id,
        ].sort(),
      );
    });
  });

  describe('shartnoma invariantlari', () => {
    const sample: DistrictTextQuery[] = [
      { region_name: 'Toshkent shahri', district_name: 'Xonobod' },
      { district_name: 'Mirzaobod' },
      { region_name: 'Andijon', district_name: 'xojaobd' },
      { region_name: 'Samarqand', district_name: 'Samarqand' },
      { address: "Uzun ko'chasi 12" },
      {},
    ];

    it.each(sample)('candidates bo`lsa district_id null, <= 5 ta: %j', (q) => {
      const res = resolve(q);
      if (res.candidates.length) expect(res.district_id).toBeNull();
      expect(res.candidates.length).toBeLessThanOrEqual(5);
    });

    it('region_id HAR DOIM tumanning region_id si', () => {
      for (const d of SNAP.districts.slice(0, 40)) {
        const res = resolve({ district_name: d.name });
        if (res.district_id) {
          const picked = SNAP.districts.find((x) => x.id === res.district_id);
          expect(res.region_id).toBe(picked?.region_id);
        }
      }
    });

    it('bo`sh / noto`g`ri kirish xato tashlamaydi', () => {
      const bad = [null, undefined, 42, 'x', { region_name: 7 }, []];
      for (const q of bad) {
        const res = resolve(q as unknown as DistrictTextQuery);
        expect(res.district_id).toBeNull();
        expect(res.reason).toBe('district_not_found');
      }
    });

    it('300 belgidan uzun matn kesiladi, xato yo`q', () => {
      const res = resolve({
        region_name: 'Andijon',
        district_name: 'xojaobd',
        full_address: 'a'.repeat(5000),
      });
      expect(res.district_id).toBe(districtBySato(SNAP, '1703236').id);
    });

    it('WARN matnida manzil matni YO`Q (PII)', () => {
      const snap = buildSnapshot({
        mutate: (s) => {
          const d = s.districts.find((x) => x.sato_code === '1726294');
          if (d) d.sato_code = null;
        },
      });
      const warn = jest.fn<void, [string]>();
      resolve(
        {
          region_name: 'Toshkent shahri',
          district_name: 'Chilonzor',
          address: 'Bunyodkor 12-uy +998901234567',
        },
        snap,
        warn,
      );
      for (const [m] of warn.mock.calls) {
        expect(String(m)).not.toMatch(/Bunyodkor|998901234567/);
      }
    });
  });

  describe('4-usul CPU filtri (natijani o`zgartirmaydi)', () => {
    const corpora = [
      'andijonviloyatixojaobdtumaninavbahormfy12uy',
      'uzunkochasi12',
      'qashqadaryokosontumani',
      'toshkentmirzoulugbektumanibuyukipakyoli',
      'samarkandurgutrayon',
      'nukusqoraqalpogiston',
      'zzzzzzzzzzzz',
      'kattaqorgonshahrixiva',
    ];
    const needles = [
      ...new Set(
        SNAP.districts.map((d) => normGeo(d.name).replace(/\s+/g, '')),
      ),
    ].filter((n) => n.length >= 4);

    it('filtr "false" desa bestSubstringSim HAR DOIM < GEO_SUBSTRING_MIN', () => {
      for (const corpus of corpora) {
        const bigrams = new Set(geoBigrams(corpus));
        for (const needle of needles) {
          if (!mayReachGeoSubstringMin(bigrams, needle)) {
            expect(bestSubstringSim(corpus, needle)).toBeLessThan(
              GEO_SUBSTRING_MIN,
            );
          }
        }
      }
    });

    it('filtr ko`p ignani kesadi (CPU tejaladi)', () => {
      const bigrams = new Set(geoBigrams(corpora[0]));
      const passed = needles.filter((n) => mayReachGeoSubstringMin(bigrams, n));
      expect(passed.length).toBeLessThan(needles.length / 4);
    });
  });
});

describe('DistrictResolverService.resolveBatch (checklist #12 — soxta repo, DB yo`q)', () => {
  function makeService() {
    const regionRows = SNAP.regions.map((r) => ({ ...r }));
    const districtRows = SNAP.districts.map((d) => ({
      ...d,
      // ⚠️ assigned_region HECH QACHON region_id sifatida ishlatilmaydi.
      assigned_region: '999',
    }));
    const regionRepo = { find: jest.fn().mockResolvedValue(regionRows) };
    const districtRepo = { find: jest.fn().mockResolvedValue(districtRows) };
    const service = new DistrictResolverService(
      regionRepo as unknown as Repository<Region>,
      districtRepo as unknown as Repository<District>,
    );
    return { service, regionRepo, districtRepo };
  }

  it('10 element — har bir repo `find` AYNAN bir marta, javob kirish tartibida', async () => {
    const { service, regionRepo, districtRepo } = makeService();
    const items: DistrictTextQuery[] = [
      { region_name: 'Toshkent shahri', district_name: 'Mirobod' },
      { region_name: 'Andijon', district_name: 'xojaobd' },
      { district_name: 'Mirzaobod' },
      { region_name: 'Toshkent viloyati', district_name: 'Chirchiq' },
      { region_name: 'Toshkent' },
      { address: "Uzun ko'chasi 12" },
      { region_name: 'Qashqadaryo', district_name: 'Qarshi tumani' },
      { region_name: 'Samarqand', district_name: 'Samarqand shahri' },
      { region_name: 'Toshkent shahri', district_name: 'Xonobod' },
      { region_name: 'Buxoro', district_name: "G'ijduvon" },
    ];
    const reply = await service.resolveBatch(items);

    expect(regionRepo.find).toHaveBeenCalledTimes(1);
    expect(districtRepo.find).toHaveBeenCalledTimes(1);
    expect(reply.statusCode).toBe(200);
    expect(reply.data).toHaveLength(10);
    expect(reply.data.map((r) => r.district_id)).toEqual([
      districtBySato(SNAP, '1726273').id,
      districtBySato(SNAP, '1703236').id,
      null,
      districtBySato(SNAP, '1727419').id,
      null,
      null,
      districtBySato(SNAP, '1710224').id,
      districtBySato(SNAP, '1718401').id,
      null,
      districtBySato(SNAP, '1706215').id,
    ]);
    // region_id — district.region_id (assigned_region '999' EMAS).
    expect(reply.data[0].region_id).toBe(regionIdBySato(SNAP, '1726'));
    expect(reply.data.some((r) => r.region_id === '999')).toBe(false);
  });

  it('bo`sh partiya — DB so`rovi YO`Q', async () => {
    const { service, regionRepo, districtRepo } = makeService();
    const reply = await service.resolveBatch([]);
    expect(reply).toEqual({ statusCode: 200, message: 'success', data: [] });
    expect(regionRepo.find).not.toHaveBeenCalled();
    expect(districtRepo.find).not.toHaveBeenCalled();
  });

  it(`${DISTRICT_RESOLVE_MAX_ITEMS} tadan ortig'i hisoblanmaydi, lekin uzunlik/tartib saqlanadi`, async () => {
    const { service } = makeService();
    const items = Array.from(
      { length: DISTRICT_RESOLVE_MAX_ITEMS + 2 },
      () => ({
        region_name: 'Toshkent viloyati',
        district_name: 'Chirchiq',
      }),
    );
    const reply = await service.resolveBatch(items);
    expect(reply.data).toHaveLength(DISTRICT_RESOLVE_MAX_ITEMS + 2);
    expect(reply.data[DISTRICT_RESOLVE_MAX_ITEMS - 1].district_id).toBe(
      districtBySato(SNAP, '1727419').id,
    );
    expect(reply.data[DISTRICT_RESOLVE_MAX_ITEMS].district_id).toBeNull();
    expect(reply.data[DISTRICT_RESOLVE_MAX_ITEMS + 1].reason).toBe(
      'district_not_found',
    );
  });

  it('bir xil WARN partiya ichida bir marta log qilinadi', async () => {
    const snap = buildSnapshot({
      mutate: (s) => {
        const d = s.districts.find((x) => x.sato_code === '1726294');
        if (d) d.sato_code = null;
      },
    });
    const service = new DistrictResolverService(
      {
        find: jest.fn().mockResolvedValue(snap.regions),
      } as unknown as Repository<Region>,
      {
        find: jest.fn().mockResolvedValue(snap.districts),
      } as unknown as Repository<District>,
    );
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const q = { region_name: 'Toshkent shahri', district_name: 'Chilonzor' };
      await service.resolveBatch([q, q, q]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('LogisticsServiceController logistics.district.resolve_by_text', () => {
  function makeController() {
    const rmqService = { ack: jest.fn(), nackForError: jest.fn() };
    const resolver = {
      resolveBatch: jest
        .fn()
        .mockResolvedValue({ statusCode: 200, message: 'success', data: [] }),
    };
    const controller = new LogisticsServiceController(
      rmqService as unknown as RmqService,
      {} as LogisticsServiceService,
      resolver as unknown as DistrictResolverService,
    );
    const context = { getPattern: () => 'x' } as unknown as RmqContext;
    return { controller, resolver, rmqService, context };
  }

  it('items massiv bo`lmasa — successRes([]), rezolver chaqirilmaydi', async () => {
    const { controller, resolver, rmqService, context } = makeController();
    const payloads: (DistrictResolveByTextPayload | undefined)[] = [
      undefined,
      {},
      { items: 'x' },
      { items: { a: 1 } },
    ];
    for (const payload of payloads) {
      await expect(
        controller.resolveDistrictsByText(payload, context),
      ).resolves.toEqual({ statusCode: 200, message: 'success', data: [] });
    }
    expect(resolver.resolveBatch).not.toHaveBeenCalled();
    expect(rmqService.ack).toHaveBeenCalledTimes(4);
  });

  it('items massiv bo`lsa — resolveBatch(items) va ack', async () => {
    const { controller, resolver, rmqService, context } = makeController();
    const items = [{ district_name: 'Chilonzor' }];
    await controller.resolveDistrictsByText({ items }, context);
    expect(resolver.resolveBatch).toHaveBeenCalledWith(items);
    expect(rmqService.ack).toHaveBeenCalledTimes(1);
  });
});
