import { normGeo, translit } from './';

/**
 * I73soTpf. `translit` — kirill (o'zbek + rus) -> lotin va diakritik /
 * apostrof folding. Tuman nomi qaysi yozuvda kelmasin, DB'dagi lotin nom
 * bilan bir xil skeletga tushishi kerak.
 */
describe('translit', () => {
  it('I73soTpf #1: "Хўжаобод" va "Xo`jaobod" bir xil normGeo natijasini beradi', () => {
    const expected = 'xojaobod';
    expect(normGeo('Хўжаобод')).toBe(expected);
    expect(normGeo("Xo'jaobod")).toBe(expected);
    // U+02BB (o'zbek lotin rasmiy belgisi) va U+2019 (telefon klaviaturasi).
    expect(normGeo('Xo\u02bbjaobod')).toBe(expected);
    expect(normGeo('Xo\u2019jaobod')).toBe(expected);
    expect(normGeo('Хўжаобод тумани')).toBe(expected);
    expect(normGeo("Xo'jaobod tumani")).toBe(expected);
  });

  it('o`zbek kirill harflarini (ў, қ, ғ, ҳ) lotinga o`giradi', () => {
    expect(translit('Андижон')).toBe('andijon');
    expect(translit('Қашқадарё')).toBe('qashqadaryo');
    expect(translit('Ғиждувон')).toBe('gijduvon');
    expect(translit('Ҳазорасп')).toBe('hazorasp');
    expect(translit('Ўрта Чирчиқ')).toBe('orta chirchiq');
    expect(translit('Қорақалпоғистон')).toBe('qoraqalpogiston');
  });

  it('rus kirill harflarini (щ, ы, ъ, ь, ю, я, ц) lotinga o`giradi', () => {
    expect(translit('Ташкент')).toBe('tashkent');
    expect(translit('Сырдарья')).toBe('sirdarya');
    expect(translit('Щука')).toBe('shuka');
    expect(translit('Объект')).toBe('obekt');
    expect(translit('Юнусабад')).toBe('yunusabad');
    expect(translit('Цемент')).toBe('tsement');
  });

  it('nostandart lotin diakritiklarini (ö, ğ, ş, ç, ı, ø) tekislaydi', () => {
    expect(translit('Kattaqörğon')).toBe('kattaqorgon');
    expect(translit("Kattaqo'rg'on")).toBe('kattaqorgon');
    expect(translit('Şahrisabz')).toBe('shahrisabz');
    expect(translit('Çirçiq')).toBe('chirchiq');
    expect(translit('Qırğız')).toBe('qirgiz');
    expect(translit('Bøston')).toBe('boston');
  });

  it('barcha 7 xil apostrof belgisini olib tashlaydi', () => {
    for (const ch of [
      '\u0060',
      '\u02bc',
      '\u02bb',
      '\u0027',
      '\u2018',
      '\u2019',
      '\u02b9',
    ]) {
      expect(translit(`O${ch}g${ch}il`)).toBe('ogil');
    }
  });

  it('kichik harfga o`tkazadi, probellarni o`zgartirmaydi', () => {
    expect(translit('TOSHKENT Shahri')).toBe('toshkent shahri');
    expect(translit('  Andijon ')).toBe('  andijon ');
  });

  it('satr bo`lmagan qiymatda xato tashlamaydi — bo`sh satr', () => {
    expect(translit('')).toBe('');
    expect(translit(null)).toBe('');
    expect(translit(undefined)).toBe('');
    expect(translit(123 as unknown as string)).toBe('');
  });
});
