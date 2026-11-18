import { sanitizeForModel } from './assistant-sanitize';

/**
 * Modelga ketadigan tool natijasi: formatlangan summa telefonga aylanmasin
 * (log uchungina mo'ljallangan 3-3-3 manbasi ishlamaydi), telefon esa
 * avvalgidek maskalansin. Barcha qiymatlar sintetik.
 */
describe('sanitizeForModel — summa vs telefon', () => {
  it.each([
    "Ijara to'lovi 905 500 000",
    "Balans 905 000 000 so'm",
    'Kassa: 335 450 000',
    'Xarajat: 755 250 000',
    'Jami 1 586 000',
  ])('summani saqlaydi: %s', (text) => {
    expect(sanitizeForModel(text)).toBe(text);
  });

  it.each([
    ['Mijoz +998 90 123 45 67', '+99890*****67'],
    ['Tel: 90 123 45 67', '+99890*****67'],
    ['raqam 901234567 yozing', '+99890*****67'],
    ['Kuryer 93-765-43-21', '+99893*****21'],
  ])('telefonni maskalaydi: %s', (text, masked) => {
    const out = sanitizeForModel(text) as string;
    expect(out).toContain(masked);
  });

  // dev (maskPhonesForLog) bularni maskalardi — model yo'lida ham ochiq
  // ketmasin (summa so'zi/id/`…000` yonida bo'lmagan telefon).
  it.each([
    ['Aziza 901 234 567', '+99890*****67'],
    ['Kuryer Bobur 901 234 567', '+99890*****67'],
    ['Aziza 901-234-567', '+99890*****67'],
    ['Tel: 901\u2013234\u2013567', '+99890*****67'],
    ['Tel: 901  234  567', '+99890*****67'],
    ['Tel: 901 - 234 - 567', '+99890*****67'],
    ['Tel: 901/234/567', '+99890*****67'],
    ['Tel: 905 123 000', '+99890*****00'],
    ['Kuryer Bobur 97 395 23 05', '+99897*****05'],
    ['Kuryer Bobur 97\u2013395\u201323\u201305', '+99897*****05'],
    ['Kuryer Bobur 97/395/23/05', '+99897*****05'],
    ['Kuryer Bobur 97\u00A0395\u00A023\u00A005', '+99897*****05'],
    ['Aziza 8 97 395 23 05', '+99897*****05'],
    ['Aziza 8 97\u00A0395\u00A023\u00A005', '+99897*****05'],
    ['narx 90 123 12 11', '+99890*****11'],
    ['Aziza 90 000 12 11', '+99890*****11'],
    ['Razmer 901 23 45 67', '+99890*****67'],
    ['{"tel":"901 234 567"}', '+99890*****67'],
    // prefiks nomzodga qo'shilmagan `…000`: yorliq prefiksdan oldin
    ['Tel: 8 901234000', '+99890*****00'],
    ['aloqa: 0 901234000', '+99890*****00'],
    ['Tel: 8 901\u202F234\u202F000', '+99890*****00'],
    ['Aziza (+998) 901234000', '+99890*****00'],
    ['Aziza (+998) 901 234 000', '+99890*****00'],
    ['Telefon 8 939826000', '+99893*****00'],
  ])('dev maskalagan telefon ochiq ketmaydi: %s', (text, masked) => {
    expect(sanitizeForModel(text)).toContain(masked);
  });

  it.each([
    "Ijara \u00B7 Kommunal: 1 905 512 345 so'm",
    'Jami 1 905 512 345',
    "R7: chek so'mda emas (905 512 345 USD)",
    "R7: chek so'mda emas (905 512 345 EUR)",
    "R7: chek so'mda emas (905 512 345 RUB)",
    "Ijara: chek so'mda emas (905 512 345 valyuta), kiritilgan 1 000 so'm",
  ])('katta summa saqlanadi: %s', (text) => {
    expect(sanitizeForModel(text)).toBe(text);
  });

  it('ichki obyektdagi summa va telefon', () => {
    expect(
      sanitizeForModel({
        title: "Ijara to'lovi 905 500 000",
        note_text: 'Tel: 93 765 43 21',
      }),
    ).toEqual({
      title: "Ijara to'lovi 905 500 000",
      note_text: 'Tel: +99893*****21',
    });
  });
});
