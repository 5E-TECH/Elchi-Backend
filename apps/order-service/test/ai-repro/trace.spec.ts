/**
 * Iz (trace): har yiqilgan holat uchun rezolver bosqichlaridagi aniq
 * qiymatlar (normGeo, simRatio, bestSubstringSim, place signal). Faqat
 * hisobot uchun — natija o'zgarmaydi. AI_REPRO_OUT ga trace.json yozadi.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  GEO_FUZZY_MIN,
  GEO_SUBSTRING_MIN,
  bestSubstringSim,
  normGeo,
  regionAlias,
  simRatio,
  translit,
} from '@app/common';

const PLACE_WORD_RE = /\b(tumani|tuman|shahri|shahar|shaharcha)\b/;
const CITY_WORD_RE = /\b(shahri|shahar)\b/;

const pairs: Array<[string, string, string]> = [
  ['D02', 'Мирабад', 'Mirobod'],
  ['D03', 'Алмазар', 'Olmazor'],
  ['D07', 'Коканд', "Qo'qon"],
  ['D11', 'Джизак', 'Jizzax'],
  ['D12', 'Алмалык', 'Olmaliq'],
  ['D13', 'Бекабад', 'Bekobod'],
  ['D18', 'Чиланзар', 'Chilonzor'],
  ['D19', 'Юнусабад', 'Yunusobod'],
  ['D21', 'Бухара', 'Buxoro'],
  ['H09', 'Кукон', "Qo'qon"],
  ['G05', "M.Ulug'bek", "Mirzo Ulug'bek"],
  ['F02', 'Forsh', 'Forish'],
  ['F03', 'Margilan', "Marg'ilon"],
  ['F09', 'Gulistan', 'Guliston'],
  ['F12', 'xojaobd', "Xo'jaobod"],
  ['E23', 'Mirobod', 'Mirzaobod'],
];

describe('trace', () => {
  it('yozadi', () => {
    const out: Record<string, unknown> = {
      thresholds: { GEO_FUZZY_MIN, GEO_SUBSTRING_MIN },
      sim: pairs.map(([id, a, b]) => {
        const ga = normGeo(a);
        const gb = normGeo(b);
        return {
          id,
          input: a,
          db: b,
          norm_input: ga,
          norm_db: gb,
          simRatio: Number(simRatio(ga, gb).toFixed(3)),
          bestSubstringSim: Number(
            bestSubstringSim(
              ga.replace(/\s+/g, ''),
              gb.replace(/\s+/g, ''),
            ).toFixed(3),
          ),
        };
      }),
      substring: [
        ['E11', 'Yuqori Chirchiq tumani', 'Chirchiq'],
        ['E12', 'Quyi Chirchiq', 'Chirchiq'],
        ['E13', "O'rta Chirchiq tumani", 'Chirchiq'],
        ['E22', 'Quvasoy shahri', 'Quva'],
        ['C12', 'Kosonsoy shaharchasi', 'Koson'],
      ].map(([id, dq, db]) => ({
        id,
        dq: normGeo(dq),
        db_geo: normGeo(db),
        dq_includes_db: normGeo(dq).includes(normGeo(db)),
      })),
      markers: [
        'Samarqand sh.',
        'Samarqand shaxri',
        'г. Самарканд',
        'Андижон шахри',
        'Kosonsoy shaharchasi',
        'Toshkent shahri',
      ].map((s) => ({
        input: s,
        translit: translit(s),
        normGeo: normGeo(s),
        city_marker: CITY_WORD_RE.test(translit(s)),
        place_word: PLACE_WORD_RE.test(translit(s)),
        regionAlias: regionAlias(s),
      })),
      place_signal: [
        ['F06 full_address', "Andijon shahri, Bo'ston ko'chasi 12-uy"],
        ['F07 full_address', "Navoiy ko'chasi 5"],
      ].map(([id, s]) => ({ id, place_word: PLACE_WORD_RE.test(translit(s)) })),
    };
    if (process.env.AI_REPRO_OUT) {
      writeFileSync(
        join(process.env.AI_REPRO_OUT, 'trace.json'),
        JSON.stringify(out, null, 2),
      );
    }
    expect(true).toBe(true);
  });
});
