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
