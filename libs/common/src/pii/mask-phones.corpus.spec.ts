import { maskPhones, maskPhonesForLog, unmaskPhones } from './mask-phones';

/**
 * #647 review korpuslari: maxfiylik (telefonning hamma yozilishi
 * maskalanadi) va summa saqlash (narx/id telefon deb yutilmaydi). Sintetik
 * ma'lumot. KNOWN_*_GAPS — hali qamralmagan holatlar (regressiya emas, dev'da
 * ham shunday); ro'yxat faqat qisqaradi: gap tuzatilsa test yiqiladi va
 * holatni ro'yxatdan olib tashlash SHART (jimgina o'tib ketmaydi).
 */
type C = { id: string; text: string; phones: string[]; keep?: string[] };
type Case = { text: string; phones: string[]; keep?: string[]; tag?: string };
const P = (n: string) => `+998${n}`;
const NB = '\u00a0';
const NNB = '\u202f';

const PRIVACY_CASES: C[] = [
  // A. prefixed
  {
    id: 'A01 +998 12 contiguous',
    text: 'Aziza +998901234567 Chilonzor 9-kvartal',
    phones: [P('901234567')],
  },
  {
    id: 'A02 998 12 contiguous',
    text: '998931112233 Sergeli, 5-uy',
    phones: [P('931112233')],
  },
  {
    id: 'A03 +998 2-3-2-2 spaces',
    text: '+998 90 123 45 67 Dilnoza, Yunusobod',
    phones: [P('901234567')],
  },
  {
    id: 'A04 +998 (91) 234-56-78',
    text: '+998 (91) 234-56-78 Bekzod',
    phones: [P('912345678')],
  },
  {
    id: 'A05 +998(93)5556677',
    text: 'mijoz +998(93)5556677',
    phones: [P('935556677')],
  },
  {
    id: 'A06 +998 dashes',
    text: '+998-94-111-22-33 Olmazor',
    phones: [P('941112233')],
  },
  {
    id: 'A07 +998 dots',
    text: '+998.95.333.44.55 Bektemir',
    phones: [P('953334455')],
  },
  {
    id: 'A08 +998 2-3-4',
    text: '+998 97 765 4321 Shayxontohur',
    phones: [P('977654321')],
  },
  {
    id: 'A09 +998 2-7',
    text: '+998 98 1234567 Mirobod',
    phones: [P('981234567')],
  },
  {
    id: 'A10 +998 9 contiguous',
    text: '+998 991234567 Uchtepa',
    phones: [P('991234567')],
  },
  { id: 'A11 +998 33', text: '+998 33 123 45 67', phones: [P('331234567')] },
  { id: 'A12 +998 20', text: '+998 20 123 45 67', phones: [P('201234567')] },
  { id: 'A13 +998 77', text: '+998 77 123 45 67', phones: [P('771234567')] },
  { id: 'A14 +998 88', text: '+998 88 123 45 67', phones: [P('881234567')] },
  { id: 'A15 +998 50', text: '+998 50 123 45 67', phones: [P('501234567')] },
  { id: 'A16 +998 55', text: '+998 55 123 45 67', phones: [P('551234567')] },
  {
    id: 'A17 +998 71 landline',
    text: '+998 71 234 56 78',
    phones: [P('712345678')],
  },
  { id: 'A18 +998 62', text: '+998 62 223 45 67', phones: [P('622234567')] },
  { id: 'A19 +998 69', text: '+998 69 223 45 67', phones: [P('692234567')] },
  {
    id: 'A20 +998 3-2-2-2',
    text: 'raqam +998 901 23 45 67 Nurota',
    phones: [P('901234567')],
  },
  {
    id: 'A21 +998 3-3-3',
    text: '+998 901 234 567 Navoiy',
    phones: [P('901234567')],
  },
  {
    id: 'A22 +998 3-2-2-2 dashes',
    text: '+998-901-23-45-67',
    phones: [P('901234567')],
  },
  {
    id: 'A23 998 (90) 123-45-67',
    text: '998 (90) 123-45-67',
    phones: [P('901234567')],
  },
  {
    id: 'A24 (+998) 90 123 45 67',
    text: '(+998) 90 123 45 67',
    phones: [P('901234567')],
  },
  {
    id: 'A25 + 998 space after plus',
    text: '+ 998 90 123 45 67',
    phones: [P('901234567')],
  },
  {
    id: 'A26 spaces inside parens',
    text: '+998 ( 90 ) 123-45-67',
    phones: [P('901234567')],
  },
  {
    id: 'A27 spaced dashes',
    text: '+998 90 123 - 45 - 67',
    phones: [P('901234567')],
  },
  {
    id: 'A28 double spaces',
    text: '+998  90  123  45  67',
    phones: [P('901234567')],
  },
  { id: 'A29 NBSP', text: '+998 90 123 45 67', phones: [P('901234567')] },
  {
    id: 'A30 narrow NBSP',
    text: '+998 90 123 45 67',
    phones: [P('901234567')],
  },
  { id: 'A31 slashes', text: '+998/90/123/45/67', phones: [P('901234567')] },
  { id: 'A32 2-2-2-3', text: '+998 90 12 34 567', phones: [P('901234567')] },
  { id: 'A33 2-4-3', text: '+998 90 1234 567', phones: [P('901234567')] },
  { id: 'A34 (90)-123', text: '+998 (90)-123-45-67', phones: [P('901234567')] },
  {
    id: 'A35 sentence end',
    text: 'Qo‘ng‘iroq qiling: +998 90 123 45 67.',
    phones: [P('901234567')],
  },
  // B. local
  {
    id: 'B36 9 contiguous at start',
    text: '901234567 Aziza, Chilonzor 5',
    phones: [P('901234567')],
  },
  {
    id: 'B37 at end',
    text: 'Yunusobod 14-kv, 90 123 45 67',
    phones: [P('901234567')],
  },
  { id: 'B38 dashes', text: '90-123-45-67', phones: [P('901234567')] },
  { id: 'B39 dots', text: '90.123.45.67', phones: [P('901234567')] },
  {
    id: 'B40 (90) 123-45-67',
    text: '(90) 123-45-67',
    phones: [P('901234567')],
  },
  { id: 'B41 (90)123-45-67', text: '(90)123-45-67', phones: [P('901234567')] },
  {
    id: 'B42 8 (90) 123-45-67',
    text: '8 (90) 123-45-67',
    phones: [P('901234567')],
  },
  {
    id: 'B43 8-90-123-45-67',
    text: '8-90-123-45-67',
    phones: [P('901234567')],
  },
  { id: 'B44 0901234567', text: '0901234567', phones: [P('901234567')] },
  { id: 'B45 8901234567', text: '8901234567', phones: [P('901234567')] },
  {
    id: 'B46 3-2-2-2 local',
    text: '901 23 45 67 Chust',
    phones: [P('901234567')],
  },
  { id: 'B47 2-7 space', text: '90 1234567', phones: [P('901234567')] },
  { id: 'B48 2-7 dash', text: '90-1234567', phones: [P('901234567')] },
  { id: 'B49 2-3-4', text: '90 123 4567', phones: [P('901234567')] },
  { id: 'B50 (90) 1234567', text: '(90) 1234567', phones: [P('901234567')] },
  { id: 'B51 8(90)1234567', text: '8(90)1234567', phones: [P('901234567')] },
  {
    id: 'B52 0 (90) 123 45 67',
    text: '0 (90) 123 45 67',
    phones: [P('901234567')],
  },
  { id: 'B53 90 123-45-67', text: '90 123-45-67', phones: [P('901234567')] },
  {
    id: 'B54 3-3-3 no word',
    text: 'Aziza 901 234 567 Chilonzor',
    phones: [P('901234567')],
  },
  {
    id: 'B55 3-3-3 dashes no word',
    text: 'Aziza 901-234-567',
    phones: [P('901234567')],
  },
  { id: 'B56 2-2-2-3 local', text: '90 12 34 567', phones: [P('901234567')] },
  { id: 'B57 en dash', text: '90–123–45–67', phones: [P('901234567')] },
  { id: 'B58 slashes local', text: '90/123/45/67', phones: [P('901234567')] },
  { id: 'B59 double space', text: '90  123 45 67', phones: [P('901234567')] },
  { id: 'B60 NBSP local', text: '90 123 45 67', phones: [P('901234567')] },
  {
    id: 'B61 3-3-3 local Cyrillic around',
    text: 'Азиза 901 234 567 Чиланзар',
    phones: [P('901234567')],
  },
  // C. labels
  { id: 'C62 tel:', text: 'tel: 901234567', phones: [P('901234567')] },
  {
    id: 'C63 тел.:',
    text: 'тел.: +998 90 123 45 67',
    phones: [P('901234567')],
  },
  { id: 'C64 Тел:', text: 'Тел: 90-123-45-67', phones: [P('901234567')] },
  { id: 'C65 nomer:', text: 'nomer: 93 456 78 90', phones: [P('934567890')] },
  { id: 'C66 raqam', text: 'raqam 97 765 43 21', phones: [P('977654321')] },
  {
    id: 'C67 aloqa uchun',
    text: 'aloqa uchun 99 888 77 66',
    phones: [P('998887766')],
  },
  {
    id: 'C68 WhatsApp',
    text: 'WhatsApp: +998 91 234 56 78',
    phones: [P('912345678')],
  },
  {
    id: 'C69 Telegram + phone',
    text: 'Telegram @aziza_shop, 94 111 22 33',
    phones: [P('941112233')],
  },
  { id: 'C70 tg:', text: 'tg: +998 95 333 44 55', phones: [P('953334455')] },
  {
    id: 'C71 Номер:',
    text: 'Номер: +998 (93) 555-66-77',
    phones: [P('935556677')],
  },
  {
    id: 'C72 Позвонить',
    text: 'Позвонить: 8 (97) 123-45-67',
    phones: [P('971234567')],
  },
  { id: 'C73 т.ф.', text: 'т.ф. 99-888-77-66', phones: [P('998887766')] },
  { id: 'C74 моб.', text: 'моб. 998 90 123 45 67', phones: [P('901234567')] },
  { id: 'C75 emoji phone', text: '📞 90 123 45 67', phones: [P('901234567')] },
  { id: 'C76 emoji +998', text: '☎️+998901234567', phones: [P('901234567')] },
  { id: 'C77 tel:+998', text: 'tel:+998901234567', phones: [P('901234567')] },
  {
    id: 'C78 t.me link',
    text: 'https://t.me/+998901234567',
    phones: [P('901234567')],
  },
  {
    id: 'C79 wa.me link',
    text: 'wa.me/998901234567',
    phones: [P('901234567')],
  },
  { id: 'C80 tel 3-3-3', text: 'tel 901 234 567', phones: [P('901234567')] },
  {
    id: 'C81 telefoni: 3-3-3',
    text: 'telefoni: 901 234 567',
    phones: [P('901234567')],
  },
  {
    id: 'C82 nomeri 3-3-3',
    text: 'nomeri 901 234 567',
    phones: [P('901234567')],
  },
  {
    id: 'C83 raqamim 3-3-3',
    text: 'raqamim 901 234 567',
    phones: [P('901234567')],
  },
  {
    id: 'C84 aloqa: 3-3-3',
    text: 'aloqa: 901 234 567',
    phones: [P('901234567')],
  },
  {
    id: 'C85 Телефон: 3-3-3',
    text: 'Телефон: 901 234 567',
    phones: [P('901234567')],
  },
  {
    id: 'C86 номер телефона 3-3-3',
    text: 'номер телефона 901 234 567',
    phones: [P('901234567')],
  },
  { id: 'C87 моб: 3-3-3', text: 'моб: 901 234 567', phones: [P('901234567')] },
  {
    id: 'C88 WhatsApp 3-3-3',
    text: 'WhatsApp 901 234 567',
    phones: [P('901234567')],
  },
  {
    id: 'C89 Тел.: 3-3-3 dashes',
    text: 'Тел.: 901-234-567',
    phones: [P('901234567')],
  },
  {
    id: 'C90 tel. raqam: 3-3-3',
    text: 'tel. raqam: 901 234 567',
    phones: [P('901234567')],
  },
  {
    id: 'C91 Tel: (capital) 3-3-3',
    text: 'Tel: 901 234 567',
    phones: [P('901234567')],
  },
  // D. two phones
  {
    id: 'D92 comma',
    text: '90 123 45 67, 91 234 56 78',
    phones: [P('901234567'), P('912345678')],
  },
  {
    id: 'D93 slash contiguous',
    text: '901234567/912345678',
    phones: [P('901234567'), P('912345678')],
  },
  {
    id: 'D94 slash spaced',
    text: '90 123 45 67 / 91 234 56 78',
    phones: [P('901234567'), P('912345678')],
  },
  {
    id: 'D95 yoki',
    text: '90-123-45-67 yoki 93-123-45-67',
    phones: [P('901234567'), P('931234567')],
  },
  {
    id: 'D96 +998 comma no space',
    text: '+998901234567,+998911234567',
    phones: [P('901234567'), P('911234567')],
  },
  {
    id: 'D97 semicolon',
    text: '+998 90 123 45 67;+998 91 234 56 78',
    phones: [P('901234567'), P('912345678')],
  },
  {
    id: 'D98 comma contiguous',
    text: '901234567, 912345678',
    phones: [P('901234567'), P('912345678')],
  },
  {
    id: 'D99 tel: a / b',
    text: 'tel: 901234567 / 977654321',
    phones: [P('901234567'), P('977654321')],
  },
  {
    id: 'D100 va',
    text: '+998 90 123 45 67 va +998 91 234 56 78',
    phones: [P('901234567'), P('912345678')],
  },
  {
    id: 'D101 dash between',
    text: '901234567-912345678',
    phones: [P('901234567'), P('912345678')],
  },
  {
    id: 'D102 3-2-2-2 two with slash',
    text: '901 23 45 67 / 911 23 45 67',
    phones: [P('901234567'), P('911234567')],
  },
  {
    id: 'D103 3-3-3 two after tel',
    text: 'tel: 901 234 567, 911 234 567',
    phones: [P('901234567'), P('911234567')],
  },
  // E. suffixes
  {
    id: 'E104 ga suffix',
    text: '901234567ga qo‘ng‘iroq qiling',
    phones: [P('901234567')],
  },
  {
    id: 'E105 ga word',
    text: '+998 90 123 45 67 ga yetkazib bering',
    phones: [P('901234567')],
  },
  {
    id: 'E106 dan suffix',
    text: '90 123 45 67dan so‘rang',
    phones: [P('901234567')],
  },
  // F. next to amounts / words starting like money words
  {
    id: 'F107 ga 150 ming',
    text: '90 123 45 67 ga 150 ming',
    phones: [P('901234567')],
    keep: ['150 ming'],
  },
  {
    id: 'F108 phone then 150 ming',
    text: '90 123 45 67 150 ming',
    phones: [P('901234567')],
    keep: ['150 ming'],
  },
  {
    id: 'F109 amount then phone',
    text: '150 000 so‘m 90 123 45 67',
    phones: [P('901234567')],
    keep: ['150 000 so‘m'],
  },
  {
    id: 'F110 narxi 250 ming, tel',
    text: 'narxi 250 ming, tel 901234567',
    phones: [P('901234567')],
    keep: ['250 ming'],
  },
  {
    id: 'F111 raqamiga 150 000',
    text: '901234567 raqamiga 150 000 so‘m',
    phones: [P('901234567')],
    keep: ['150 000 so‘m'],
  },
  {
    id: 'F112 1 500 000 so‘m, tel',
    text: '1 500 000 so‘m, tel 93 456 78 90',
    phones: [P('934567890')],
    keep: ['1 500 000 so‘m'],
  },
  {
    id: 'F113 4 mln 200, nomer',
    text: '4 mln 200, nomer 99 111 22 33',
    phones: [P('991112233')],
    keep: ['4 mln 200'],
  },
  {
    id: 'F114 150k, phone',
    text: '150k, 977654321',
    phones: [P('977654321')],
    keep: ['150k'],
  },
  {
    id: 'F115 Телефон … сумма заказа',
    text: 'Телефон 90 123 45 67 сумма заказа 350 000',
    phones: [P('901234567')],
    keep: ['350 000'],
  },
  {
    id: 'F116 tel … summa',
    text: 'tel 901234567 summa 200 ming',
    phones: [P('901234567')],
    keep: ['200 ming'],
  },
  {
    id: 'F117 +998 … сумка',
    text: '+998901234567 сумка женская 1 шт',
    phones: [P('901234567')],
  },
  {
    id: 'F118 … sumka',
    text: '901234567 sumka qora 2 ta',
    phones: [P('901234567')],
  },
  {
    id: 'F119 … mingbuloq tumani',
    text: '90 123 45 67 mingbuloq tumani',
    phones: [P('901234567')],
  },
  {
    id: 'F120 +998 3-2-2-2 Sumka',
    text: '+998 901 23 45 67 Sumka 2 ta',
    phones: [P('901234567')],
  },
  {
    id: 'F121 3-2-2-2 Сумма',
    text: '901 23 45 67 Сумма 300 000',
    phones: [P('901234567')],
    keep: ['300 000'],
  },
  {
    id: 'F122 Номер 3-3-3 Сумма',
    text: 'Номер 901 234 567 Сумма: 450 000',
    phones: [P('901234567')],
    keep: ['450 000'],
  },
  {
    id: 'F123 Tel … somsa',
    text: 'Tel 90 123 45 67 somsa 20 dona',
    phones: [P('901234567')],
  },
  {
    id: 'F124 3-2-2-2 Mingbuloq',
    text: '901 23 45 67 Mingbuloq tumani',
    phones: [P('901234567')],
  },
  {
    id: 'F125 +998 … summasi',
    text: '+998 90 123 45 67 summasi 120 ming',
    phones: [P('901234567')],
    keep: ['120 ming'],
  },
  {
    id: 'F126 +998 3-3-3 … sumka',
    text: '+998 901 234 567 sumka',
    phones: [P('901234567')],
  },
  {
    id: 'F127 +998 … сумма',
    text: '+998 (90) 123-45-67 сумма 250000',
    phones: [P('901234567')],
    keep: ['250000'],
  },
  {
    id: 'F128 phone ming rahmat',
    text: '90 123 45 67 ming rahmat',
    phones: [P('901234567')],
  },
  {
    id: 'F129 phone then Mln capital',
    text: '+998 901 23 45 67 Mln emas',
    phones: [P('901234567')],
  },
  {
    id: 'F130 phone then k (kilo?)',
    text: '90 123 45 67 k',
    phones: [P('901234567')],
  },
  // G. Cyrillic / multi-line
  {
    id: 'G131 Cyrillic around',
    text: 'Тошкент ш., Юнусобод, тел 90 123 45 67, Азиза',
    phones: [P('901234567')],
  },
  {
    id: 'G132 Заказ +998 ()',
    text: 'Заказ: 2 шт, адрес Чиланзар, +998 (90) 123-45-67',
    phones: [P('901234567')],
  },
  {
    id: 'G133 рақам',
    text: 'Фарғона, Марғилон, рақам 93 123 45 67',
    phones: [P('931234567')],
  },
  {
    id: 'G134 Мурожаат учун',
    text: 'Мурожаат учун: 99 888 77 66',
    phones: [P('998887766')],
  },
  {
    id: 'G135 Мингбулоқ before phone',
    text: 'Наманган, Мингбулоқ тумани 90 123 45 67',
    phones: [P('901234567')],
  },
  {
    id: 'G136 3-2-2-2 Мингбулоқ after',
    text: '901 23 45 67 Мингбулоқ',
    phones: [P('901234567')],
  },
  {
    id: 'G137 multi-line',
    text: 'Aziza\n+998 90 123 45 67\nChilonzor 5\n150 000 so‘m',
    phones: [P('901234567')],
    keep: ['150 000 so‘m'],
  },
  {
    id: 'G138 multi-line 3-3-3 after Тел',
    text: 'Тел:\n901 234 567',
    phones: [P('901234567')],
  },
  {
    id: 'G139 phone at line start after newline',
    text: 'Buyurtma\n901 23 45 67\nNamangan',
    phones: [P('901234567')],
  },
  {
    id: 'G140 мингбулок lowercase 2-3-2-2',
    text: '90 123 45 67 мингбулоқ',
    phones: [P('901234567')],
  },
  // #647 round 2 (N1, N2, S1, S3, S4)
  {
    id: 'N1a Jamila',
    text: 'Jamila 901234567 Chilonzor 5-uy',
    phones: [P('901234567')],
  },
  {
    id: 'N1b Nurjamila',
    text: 'Nurjamila 901234567',
    phones: [P('901234567')],
  },
  {
    id: 'N1c Summaya',
    text: 'Summaya 901234567',
    phones: [P('901234567')],
  },
  {
    id: 'N1d Jamiyat',
    text: 'Jamiyat 901234567',
    phones: [P('901234567')],
  },
  {
    id: 'N1e Buyurtmachi raqami',
    text: 'Buyurtmachi raqami 901234567',
    phones: [P('901234567')],
  },
  {
    id: 'N1f Заказчика номер',
    text: 'Заказчика номер 901234567',
    phones: [P('901234567')],
  },
  {
    id: 'N1g Kuyov raqami',
    text: 'Kuyov raqami 901234567',
    phones: [P('901234567')],
  },
  {
    id: 'N1h Uy raqami',
    text: 'Uy raqami 901234567',
    phones: [P('901234567')],
  },
  {
    id: 'N1i Бизнес центр',
    text: 'Бизнес центр 901234567',
    phones: [P('901234567')],
  },
  {
    id: 'N1j Tel … ming rahmat',
    text: 'Tel 901234567 ming rahmat',
    phones: [P('901234567')],
  },
  {
    id: 'N1k name … ming rahmat',
    text: 'Aziza 901234567 ming rahmat',
    phones: [P('901234567')],
  },
  {
    id: 'N1l Mijoz Jamila',
    text: 'Mijoz Jamila 901234567',
    phones: [P('901234567')],
  },
  {
    id: "N1m To'lovchi",
    text: "To'lovchi 901234567",
    phones: [P('901234567')],
  },
  {
    id: 'N2a 90 123-45-67',
    text: '90 123-45-67',
    phones: [P('901234567')],
  },
  {
    id: 'N2b (90) 123-45-67',
    text: '(90) 123-45-67',
    phones: [P('901234567')],
  },
  {
    id: 'N2c 90/123/45/67',
    text: '90/123/45/67',
    phones: [P('901234567')],
  },
  {
    id: 'N2d 90.123.45.67',
    text: '90.123.45.67',
    phones: [P('901234567')],
  },
  {
    id: 'N2e 90 123 4567',
    text: '90 123 4567',
    phones: [P('901234567')],
  },
  {
    id: 'N2f a/b contiguous',
    text: '901234567/912345678',
    phones: [P('901234567'), P('912345678')],
  },
  {
    id: 'N2g +998 2-3-2-2',
    text: '+998 90 123 45 67',
    phones: [P('901234567')],
  },
  {
    id: 'N2h tel + date-like groups',
    text: 'tel 90 000 12 11',
    phones: [P('900001211')],
  },
  {
    id: 'N2i a/b 2-3-2-2 no spaces',
    text: '90 123 45 67/91 234 56 78',
    phones: [P('901234567'), P('912345678')],
  },
  {
    id: 'S1a tel … 3-2-2-2.',
    text: 'Mijoz Aziza, tel 901 23 45 67.',
    phones: [P('901234567')],
  },
  {
    id: 'S1b 3-2-2-2 dashes.',
    text: 'Aziza 901-23-45-67.',
    phones: [P('901234567')],
  },
  {
    id: 'S1c 3-2-2-2. Chilonzor',
    text: 'Aziza 901 23 45 67. Chilonzor',
    phones: [P('901234567')],
  },
  {
    id: 'S1d Tel.901',
    text: 'Tel.901 23 45 67',
    phones: [P('901234567')],
  },
  {
    id: 'S1e тел.901',
    text: 'тел.901 23 45 67',
    phones: [P('901234567')],
  },
  {
    id: 'S3a list 3-3-3 yoki',
    text: 'tel 901 234 567 yoki 911 234 567',
    phones: [P('901234567'), P('911234567')],
  },
  {
    id: 'S3b list 3-3-3 ;',
    text: 'tel: 901 234 567; 911 234 567; 931 234 567',
    phones: [P('901234567'), P('911234567'), P('931234567')],
  },
  {
    id: 'S3c Tel 1 / Tel 2',
    text: 'Tel 1: 901 234 567, Tel 2: 911 234 567',
    phones: [P('901234567'), P('911234567')],
  },
  {
    id: 'S3d Tel1:',
    text: 'Tel1: 901 234 567',
    phones: [P('901234567')],
  },
  {
    id: 'S3e Tel (WhatsApp):',
    text: 'Tel (WhatsApp): 901 234 567',
    phones: [P('901234567')],
  },
  {
    id: 'S3f 0 + 3-3-3',
    text: '0 901 234 567',
    phones: [P('901234567')],
  },
  {
    id: 'S3g 8 + 3-3-3',
    text: '8 901 234 567',
    phones: [P('901234567')],
  },
  {
    id: 'S3h 0901 23 45 67',
    text: '0901 23 45 67',
    phones: [P('901234567')],
  },
  {
    id: 'S4a Tel: …000',
    text: 'Tel: 991000000',
    phones: [P('991000000')],
  },
  {
    id: 'S4b nomer …000',
    text: 'Aziza nomer 901234000',
    phones: [P('901234000')],
  },
  {
    id: 'S4c name …000 (no phone word)',
    text: 'Aziza 901234000',
    phones: [P('901234000')],
  },
  // #647 round 3 (N4): ikkinchi telefon `/ - .` bilan yopishgan — birinchisi
  // sana deb qolmaydi.
  {
    id: 'N4a Tel: dashes / dashes',
    text: 'Tel: 90-123-12-11/93-765-43-21',
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4b spaces / dashes',
    text: '90 123 12 11/93-765-43-21',
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4c name spaces / dots',
    text: 'Aziza 90 123 12 11/93.765.43.21',
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4d spaces - dashes',
    text: '90 123 12 11-93-765-43-21',
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4e spaces . dashes',
    text: '90 123 12 11.93-765-43-21',
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4f Tel: spaces / dashes',
    text: 'Tel: 90 123 12 11/93-765-43-21',
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4g Telefon: dashes / dashes',
    text: 'Telefon: 90-123-25-11/97-111-22-33',
    phones: [P('901232511'), P('971112233')],
  },
  {
    id: 'N4h dashes / dashes',
    text: '90-123-12-11/93-765-43-21',
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4i spaces / 2 spaces',
    text: '90 123 12 11/93  765 43 21',
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4j spaces / spaced dash',
    text: '90 123 12 11/93 - 765-43-21',
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4k spaces / NBSP dashes',
    text: `90 123 12 11/93${NB}-${NB}765-43-21`,
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4l spaces / NNBSP',
    text: `90 123 12 11/93${NNB}765${NNB}43${NNB}21`,
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4m spaces / NNBSP dashes',
    text: `Aziza 90 123 12 11/93${NNB}-${NNB}765-43-21`,
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4r Tel: NNBSP / dashes',
    text: `Tel: 90${NNB}123${NNB}12${NNB}11/93-765-43-21`,
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4s NNBSP-grouped date-like phone (no word)',
    text: `90${NNB}123${NNB}12${NNB}11/93-765-43-21`,
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4n Tel: 75 000 14.11 (phone word wins)',
    text: 'Tel: 75 000 14.11',
    phones: [P('750001411')],
  },
  {
    id: 'N4o list 2-3-2-2 / 2-3-2-2',
    text: '90 123 45 67/91 234 56 78',
    phones: [P('901234567'), P('912345678')],
  },
  {
    id: 'N4p list comma',
    text: '90 123 12 11, 93 765 43 21',
    phones: [P('901231211'), P('937654321')],
  },
  {
    id: 'N4q list /+998',
    text: '90 123 12 11/+998 93 765 43 21',
    phones: [P('901231211'), P('937654321')],
  },
];

const amountsOnly: { id: string; text: string; keep: string }[] = [
  { id: 'M1', text: 'atir 150 000 so‘m', keep: '150 000 so‘m' },
  { id: 'M2', text: 'narxi 901234567 so‘m', keep: '901234567 so‘m' },
  { id: 'M3', text: 'jami 1 500 000', keep: '1 500 000' },
  { id: 'M4', text: '4 mln 200', keep: '4 mln 200' },
  { id: 'M5', text: 'narxi 150k', keep: '150k' },
  { id: 'M6', text: 'muzlatgich 915 500 000', keep: '915 500 000' },
  { id: 'M7', text: 'narxi 915500000 so‘m', keep: '915500000 so‘m' },
];

const AMOUNT_CASES: Case[] = [
  // --- realistic orders: phone + price/qty/address ---
  {
    text: "Aziza 90 123 45 67, Toshkent Chilonzor 9-kvartal 12-uy 45-xonadon, ko'ylak 2 ta 150 000 so'm",
    phones: [P('901234567')],
    keep: ['9-kvartal 12-uy 45-xonadon', "2 ta 150 000 so'm"],
  },
  {
    text: 'Bobur +998 91 234 56 78, Samarqand, krossovka 42 razmer 1 500 000',
    phones: [P('912345678')],
    keep: ['42 razmer 1 500 000'],
  },
  {
    text: "Narxi 1.500.000 so'm, tel 93 555 66 77",
    phones: [P('935556677')],
    keep: ["1.500.000 so'm"],
  },
  {
    text: "150000so'm atir 3 ta, Andijon Asaka, 998901112233",
    phones: [P('901112233')],
    keep: ["150000so'm atir 3 ta"],
  },
  {
    text: "150 ming, 2 dona, Farg'ona Quva 5-mavze 33-uy, 97 765 43 21",
    phones: [P('977654321')],
    keep: ['150 ming, 2 dona', '5-mavze 33-uy'],
  },
  {
    text: "Jami 1,5 mln so'm. Tel: 88 123 45 67",
    phones: [P('881234567')],
    keep: ["1,5 mln so'm"],
  },
  {
    text: '2 ta 75 000 = 150 000. Mijoz 50 111 22 33 Namangan Chust',
    phones: [P('501112233')],
    keep: ['2 ta 75 000 = 150 000'],
  },
  {
    text: 'Muzlatgich Artel 4 mln 200, Qarshi, tel 99 123 45 67',
    phones: [P('991234567')],
    keep: ['4 mln 200'],
  },
  {
    text: 'Televizor $150, Buxoro, 94 111 22 33',
    phones: [P('941112233')],
    keep: ['$150'],
  },
  {
    text: 'Telefon iPhone 15 150$ Navoiy 95 222 33 44',
    phones: [P('952223344')],
    keep: ['iPhone 15 150$'],
  },
  {
    text: 'Заказ №123456789 от 14.11.2026, 12 345 678 сум, тел +998 90 765 43 21',
    phones: [P('907654321')],
    keep: ['№123456789', '14.11.2026', '12 345 678 сум'],
  },
  {
    text: 'Buyurtma #123456789, 14.11.2026 soat 14:30, Xorazm Urganch, 33 444 55 66',
    phones: [P('334445566')],
    keep: ['#123456789', '14.11.2026 soat 14:30'],
  },
  {
    text: 'Pochta indeksi 100017, Toshkent Yunusobod 19-mavze 12-uy, 90 987 65 43',
    phones: [P('909876543')],
    keep: ['100017', '19-mavze 12-uy'],
  },
  {
    text: "SOATO 1726262, Yangiyo'l, karta 8600 **** **** 1234, 91 000 11 22",
    phones: [P('910001122')],
    keep: ['1726262', '8600 **** **** 1234'],
  },
  {
    text: "Karta oxirgi 4 raqami 4521, summa 2 350 000 so'm, 99 888 77 66",
    phones: [P('998887766')],
    keep: ['4521', "2 350 000 so'm"],
  },
  {
    text: '4 mln 200 ming, Jizzax, 2 ta konditsioner, 93 123 45 67',
    phones: [P('931234567')],
    keep: ['4 mln 200 ming'],
  },
  {
    text: '150k atir, 3ta, 90 111 22 33',
    phones: [P('901112233')],
    keep: ['150k atir, 3ta'],
  },
  {
    text: 'Summa 1 250 000 сўм, тел 90 123 45 67',
    phones: [P('901234567')],
    keep: ['1 250 000 сўм'],
  },
  {
    text: 'Цена 950 000 сум, доставка 30 000 сум, тел 8 (90) 123-45-67',
    phones: [P('901234567')],
    keep: ['950 000 сум', '30 000 сум'],
  },
  {
    text: '12 345 678 сум за 3 шт, Ташкент',
    phones: [],
    keep: ['12 345 678 сум'],
  },
  {
    text: "5 kg 120 000 so'm, 3 kg 75 000, 77 111 22 33",
    phones: [P('771112233')],
    keep: ["5 kg 120 000 so'm, 3 kg 75 000"],
  },
  {
    text: 'Ijara 1 oy 4 500 000, depozit 9 000 000, 90 123 45 67',
    phones: [P('901234567')],
    keep: ['4 500 000', '9 000 000'],
  },
  {
    text: 'Narx: 1 500 000, chegirma 10%, jami 1 350 000',
    phones: [],
    keep: ['1 500 000', '1 350 000'],
  },
  {
    text: "Yetkazish 25 000 so'm, mahsulot 975 000 so'm, umumiy 1 000 000 so'm",
    phones: [],
    keep: ["975 000 so'm", "1 000 000 so'm"],
  },
  {
    text: "150 000 so'm\n90 123 45 67\nToshkent sh. Mirobod t. Afrosiyob ko'chasi 7/1, 23-xonadon",
    phones: [P('901234567')],
    keep: ["150 000 so'm", '7/1, 23-xonadon'],
  },
  {
    text: "Mijoz: Dilshod, 909876543, Qo'qon, 2 dona 99 000",
    phones: [P('909876543')],
    keep: ['2 dona 99 000'],
  },
  {
    text: 'Telefon: 77 123 45 67, narx 799 000',
    phones: [P('771234567')],
    keep: ['799 000'],
  },
  {
    text: 'Тел: +998 (71) 123-45-67, сумма 2 500 000 сум',
    phones: [P('711234567')],
    keep: ['2 500 000 сум'],
  },
  {
    text: '998 90 123 45 67 Gulnora, 3 ta 33 000',
    phones: [P('901234567')],
    keep: ['3 ta 33 000'],
  },
  {
    text: 'Pul 1 500 000 + 250 000 = 1 750 000',
    phones: [],
    keep: ['1 500 000 + 250 000 = 1 750 000'],
  },
  {
    text: "Bo'lib to'lash 12 oy, oyiga 450 000, jami 5 400 000",
    phones: [],
    keep: ['450 000', '5 400 000'],
  },
  {
    text: 'Chegirma kodi 2026, 3 ta 50 000',
    phones: [],
    keep: ['2026, 3 ta 50 000'],
  },
  {
    text: 'Muddati 14.11.2026 — 20.11.2026, soat 9:00 dan 18:00 gacha',
    phones: [],
    keep: ['14.11.2026 — 20.11.2026', '9:00 dan 18:00'],
  },
  {
    text: 'Uy raqami 123, kvartira 45, podezd 3, qavat 9',
    phones: [],
    keep: ['123, kvartira 45'],
  },
  {
    text: 'Pochta 100 100, Toshkent; Andijon 170100, Asaka t.',
    phones: [],
    keep: ['100 100', '170100'],
  },
  { text: 'Narxi 900 000 000', phones: [], keep: ['900 000 000'] },
  { text: 'Narxi 915 500 000', phones: [], keep: ['915 500 000'] },
  {
    text: "Samsung telefon 2 ta 3 500 000 so'm",
    phones: [],
    keep: ["3 500 000 so'm"],
  },
  { text: 'Telefon 1 250 000', phones: [], keep: ['1 250 000'] },
  {
    text: 'Telefon Redmi Note 13 256 GB 2 990 000',
    phones: [],
    keep: ['13 256 GB 2 990 000'],
  },
  {
    text: '4 ta 1 125 000 dan, jami 4 500 000',
    phones: [],
    keep: ['1 125 000', '4 500 000'],
  },
  {
    text: 'Shartnoma №2026-11-14/905, 1 dona',
    phones: [],
    keep: ['2026-11-14/905'],
  },
  { text: 'Chek №000123456, 2 ta 45 000', phones: [], keep: ['000123456'] },
  {
    text: 'Trek kodi 201234567890, Toshkent',
    phones: [],
    keep: ['201234567890'],
  },
  {
    text: 'Shtrix-kod 4780012345678, 1 dona',
    phones: [],
    keep: ['4780012345678'],
  },
  {
    text: '1 dona 205 000, 2 dona 410 000',
    phones: [],
    keep: ['205 000', '410 000'],
  },
  {
    text: "Narxi 33 000 so'm, 50 000 so'm",
    phones: [],
    keep: ["33 000 so'm, 50 000 so'm"],
  },
  { text: "Jami 95 500 so'm", phones: [], keep: ["95 500 so'm"] },
  { text: "Kurs 12 850 so'm/$", phones: [], keep: ['12 850'] },
  {
    text: '3 x 150 000 = 450 000',
    phones: [],
    keep: ['3 x 150 000 = 450 000'],
  },
  { text: 'Mahsulot kodi 7701234, 2 ta', phones: [], keep: ['7701234'] },
  {
    text: 'Narx 99 000, 2 ta, Termiz, 93 777 88 99',
    phones: [P('937778899')],
    keep: ['99 000, 2 ta'],
  },
  {
    text: "1 500 000 so'm 90 123 45 67",
    phones: [P('901234567')],
    keep: ["1 500 000 so'm"],
  },
  {
    text: "90 123 45 67 150 000 so'm",
    phones: [P('901234567')],
    keep: ["150 000 so'm"],
  },
  {
    text: 'Telefon 90 123 45 67 1 dona 150 000',
    phones: [P('901234567')],
    keep: ['1 dona 150 000'],
  },
  { text: '901234567 1 dona', phones: [P('901234567')], keep: ['1 dona'] },
  {
    text: 'Hisob raqami 20208000905123456001, MFO 00873',
    phones: [],
    keep: ['20208000905123456001', '00873'],
  },
  {
    text: 'Lokatsiya 41.311081, 69.240562',
    phones: [],
    keep: ['41.311081, 69.240562'],
  },
  {
    text: '2 ta 75 000, 1 ta 1 200 000, jami 1 350 000',
    phones: [],
    keep: ['1 200 000', '1 350 000'],
  },
  {
    text: "Kvartira 335 000 000 so'm, Sergeli",
    phones: [],
    keep: ["335 000 000 so'm"],
  },
  {
    text: "Kvartira 335000000 so'm, Sergeli",
    phones: [],
    keep: ["335000000 so'm"],
    tag: "9-digit price + so'm",
  },
  { text: "Avto 901 234 567 so'm", phones: [], keep: ["901 234 567 so'm"] },
  {
    text: '1 500 000 сум + доставка 25 000',
    phones: [],
    keep: ['1 500 000 сум', '25 000'],
  },
  { text: '150 000 сўм, 2 дона, Наманган', phones: [], keep: ['150 000 сўм'] },
  { text: '45 000 рублей / 150$', phones: [], keep: ['45 000', '150$'] },
  {
    text: 'Narxi 2 000 000 + yetkazish 30 000 = 2 030 000',
    phones: [],
    keep: ['2 000 000', '2 030 000'],
  },

  // --- 9-digit prices / ids without spaces (shape = phone) ---
  {
    text: 'Mashina Malibu 2 narxi 335000000',
    phones: [],
    keep: ['335000000'],
    tag: 'pre-existing',
  },
  {
    text: 'Narxi 905000000',
    phones: [],
    keep: ['905000000'],
    tag: 'pre-existing',
  },
  {
    text: 'Jami: 205000000',
    phones: [],
    keep: ['205000000'],
    tag: 'pre-existing',
  },
  {
    text: "Narxi 905000000 So'm",
    phones: [],
    keep: ["905000000 So'm"],
    tag: 'case',
  },
  {
    text: "Narxi 905000000 SO'M",
    phones: [],
    keep: ["905000000 SO'M"],
    tag: 'case',
  },
  {
    text: 'Narxi 905000000 Sum',
    phones: [],
    keep: ['905000000 Sum'],
    tag: 'case',
  },
  {
    text: 'Narxi 905000000 СУМ',
    phones: [],
    keep: ['905000000 СУМ'],
    tag: 'case',
  },
  {
    text: 'Narxi 905000000 UZS',
    phones: [],
    keep: ['905000000 UZS'],
    tag: 'word',
  },
  {
    text: 'Narxi 905000000 soʼm',
    phones: [],
    keep: ['905000000 soʼm'],
    tag: 'U+02BC',
  },
  {
    text: `Narxi 905000000${NB}so'm`,
    phones: [],
    keep: [`905000000${NB}so'm`],
    tag: 'NBSP',
  },
  {
    text: "Narxi 905000000  so'm",
    phones: [],
    keep: ["905000000  so'm"],
    tag: '2 spaces',
  },
  {
    text: 'Narxi 905000000 mlrd',
    phones: [],
    keep: ['905000000 mlrd'],
    tag: 'word',
  },
  { text: "Narxi 905000000 so'm", phones: [], keep: ["905000000 so'm"] },
  { text: 'Narxi 905000000 сўм', phones: [], keep: ['905000000 сўм'] },
  {
    text: 'STIR 551234567, hisob-faktura',
    phones: [],
    keep: ['551234567'],
    tag: 'pre-existing id',
  },
  {
    text: 'Buyurtma #905123456',
    phones: [],
    keep: ['#905123456'],
    tag: 'pre-existing id',
  },
  {
    text: 'Trek EE905123456UZ',
    phones: [],
    keep: ['EE905123456UZ'],
    tag: 'pre-existing id',
  },
  {
    text: 'ID 771234567 buyurtma',
    phones: [],
    keep: ['771234567'],
    tag: 'pre-existing id',
  },

  // --- new alt-pattern shapes (3-2-2-2 / 3-3-3) on non-phones ---
  {
    text: 'Nike Air Max 270 41 42 43 razmerlar bor, 2 ta 850 000',
    phones: [],
    keep: ['270 41 42 43', '850 000'],
    tag: 'A3 model+sizes',
  },
  {
    text: 'New Balance 990 40 41 42 razmer',
    phones: [],
    keep: ['990 40 41 42'],
    tag: 'A3 model+sizes',
  },
  {
    text: 'New Balance 550 41 42 43, 1 200 000',
    phones: [],
    keep: ['550 41 42 43'],
    tag: 'A3 model+sizes',
  },
  {
    text: 'Заказ №771 14.11.26, 2 шт 150 000 сум',
    phones: [],
    keep: ['771 14.11.26'],
    tag: 'A3 id+date',
  },
  {
    text: 'Uy 205 12.11.26 da yetkazing',
    phones: [],
    keep: ['205 12.11.26'],
    tag: 'A3 house+date',
  },
  {
    text: 'Razmerlar: 200 50 60 70',
    phones: [],
    keep: ['200 50 60 70'],
    tag: 'A3 sizes',
  },
  {
    text: 'Buyurtma raqami 901 234 567, summa 150 000',
    phones: [],
    keep: ['901 234 567'],
    tag: 'A4 order no',
  },
  {
    text: 'Номер заказа 771 234 567',
    phones: [],
    keep: ['771 234 567'],
    tag: 'A4 order no',
  },
  {
    text: 'Uy raqami 205 000 000?',
    phones: [],
    keep: ['205 000 000'],
    tag: 'A4',
  },
  { text: "tel 905 000 000 so'm", phones: [], keep: ["905 000 000 so'm"] },
  { text: 'Telefon narxi 935 500 000', phones: [], keep: ['935 500 000'] },
  {
    text: 'Telefon 935 500 000',
    phones: [],
    keep: ['935 500 000'],
    tag: 'A4 product+price',
  },

  // --- phones that must still be masked (privacy) next to money-like words ---
  {
    text: 'Tel 901234567 sumka 2 ta',
    phones: [P('901234567')],
    tag: 'privacy: sumka',
  },
  {
    text: 'Tel 90 123 45 67 ming rahmat',
    phones: [P('901234567')],
    tag: 'privacy: ming rahmat',
  },
  {
    text: '901 23 45 67 Mingbuloq',
    phones: [P('901234567')],
    tag: 'privacy: Mingbuloq',
  },
  { text: '+998 90 123 45 67 Kosonsoy', phones: [P('901234567')] },
  { text: '901234567 Sumka', phones: [P('901234567')] },
  // #647 round 2
  {
    text: 'narxi 901234567 so‘m',
    phones: [],
    keep: ['901234567'],
    tag: 'round 2',
  },
  {
    text: 'Buyurtma raqami 901 234 567',
    phones: [],
    keep: ['901 234 567'],
    tag: 'round 2',
  },
  {
    text: 'Uy raqami 205 000 000',
    phones: [],
    keep: ['205 000 000'],
    tag: 'round 2',
  },
  { text: '#901234567', phones: [], keep: ['#901234567'], tag: 'round 2' },
  { text: '№ 901234567', phones: [], keep: ['№ 901234567'], tag: 'round 2' },
  {
    text: 'Narxi 90 000 12/11 da olib keling',
    phones: [],
    keep: ['90 000 12/11'],
    tag: 'round 2',
  },
  {
    text: '2 ta 50 000 25/11 kuni',
    phones: [],
    keep: ['50 000 25/11'],
    tag: 'round 2',
  },
  {
    text: 'Jami 99 000 01/12',
    phones: [],
    keep: ['99 000 01/12'],
    tag: 'round 2',
  },
  {
    text: 'Atir 75 000 14/11/2026 gacha',
    phones: [],
    keep: ['75 000 14/11/2026'],
    tag: 'round 2',
  },
  {
    text: 'Atir 75 000 14/11',
    phones: [],
    keep: ['75 000 14/11'],
    tag: 'round 2',
  },
  {
    text: 'Mahsulot 65 000 15/11 gacha',
    phones: [],
    keep: ['65 000 15/11'],
    tag: 'round 2',
  },
  {
    text: 'Narxi 70 000  12 11',
    phones: [],
    keep: ['70 000  12 11'],
    tag: 'round 2',
  },
  {
    text: 'Atir 75 000 – 14 – 11',
    phones: [],
    keep: ['75 000 – 14 – 11'],
    tag: 'round 2',
  },
  {
    text: 'Atir 75 000 14.11.2026',
    phones: [],
    keep: ['75 000 14.11.2026'],
    tag: 'round 2',
  },
  {
    text: '2 ta 50 000 25.11 kuni',
    phones: [],
    keep: ['50 000 25.11'],
    tag: 'round 2',
  },
  {
    text: 'Atir 90 500 – 14 – 11',
    phones: [],
    keep: ['90 500 – 14 – 11'],
    tag: 'round 2',
  },
  {
    text: 'Jami: 90 500 12 11',
    phones: [],
    keep: ['90 500 12 11'],
    tag: 'round 2',
  },
  {
    text: 'Atir 90 500 2026-11-14 gacha',
    phones: [],
    keep: ['90 500 2026-11-14'],
    tag: 'round 2',
  },
  {
    text: 'Pasport AA 901234567',
    phones: [],
    keep: ['AA 901234567'],
    tag: 'round 2',
  },
  { text: 'INN 301234567', phones: [], keep: ['301234567'], tag: 'round 2' },
  {
    text: 'Televizor 905 450 990',
    phones: [],
    keep: ['905 450 990'],
    tag: 'round 2',
  },
  {
    text: 'Телевизор 905 450 990',
    phones: [],
    keep: ['905 450 990'],
    tag: 'round 2',
  },
  {
    text: 'Telefon 905000000',
    phones: [],
    keep: ['905000000'],
    tag: 'round 2',
  },
  {
    text: 'Buyurtma # 2 789 957 18 10 22',
    phones: [],
    keep: ['2 789 957 18 10 22'],
    tag: 'round 2',
  },
  {
    text: 'Narxi 8 905 000 000',
    phones: [],
    keep: ['8 905 000 000'],
    tag: 'round 2',
  },
  {
    text: 'Narxi 8 901 234 567 so‘m',
    phones: [],
    keep: ['8 901 234 567'],
    tag: 'round 2',
  },
  {
    text: 'tel: 901 234 567, 905 000 000 so‘m',
    phones: [P('901234567')],
    keep: ['905 000 000 so‘m'],
    tag: 'round 2',
  },
  // --- #647 round 3 (N3): 8+kod bilan boshlanadigan va yaxlit CC000 narx + sana ---
  {
    text: 'Narxi 850 000 25/11 kuni',
    phones: [],
    keep: ['850 000 25/11'],
    tag: 'round 3',
  },
  {
    text: 'Atir 890 000 14/11',
    phones: [],
    keep: ['890 000 14/11'],
    tag: 'round 3',
  },
  {
    text: 'Jami 899 000 01/12',
    phones: [],
    keep: ['899 000 01/12'],
    tag: 'round 3',
  },
  {
    text: 'Atir 875 000 14/11/2026 gacha',
    phones: [],
    keep: ['875 000 14/11/2026'],
    tag: 'round 3',
  },
  {
    text: 'Atir 75000 14/11',
    phones: [],
    keep: ['75000 14/11'],
    tag: 'round 3',
  },
  {
    text: '2 ta 50000 25/11 kuni',
    phones: [],
    keep: ['50000 25/11'],
    tag: 'round 3',
  },
  {
    text: 'Narxi 90000 12/11 da olib keling',
    phones: [],
    keep: ['90000 12/11'],
    tag: 'round 3',
  },
  {
    text: 'Narxi 75000  14 11',
    phones: [],
    keep: ['75000  14 11'],
    tag: 'round 3',
  },
  {
    text: `Atir 850${NB}000 14.11`,
    phones: [],
    keep: [`850${NB}000 14.11`],
    tag: 'round 3',
  },
  {
    text: `Atir 850${NNB}000 14.11`,
    phones: [],
    keep: [`850${NNB}000 14.11`],
    tag: 'round 3',
  },
  {
    text: `Narxi 75000${NB}${NB}14 11`,
    phones: [],
    keep: [`75000${NB}${NB}14 11`],
    tag: 'round 3',
  },
  {
    text: `Atir 75000${NNB}14/11`,
    phones: [],
    keep: [`75000${NNB}14/11`],
    tag: 'round 3',
  },
  {
    text: 'Narxi 850 000 – 25 – 11 kuni',
    phones: [],
    keep: ['850 000 – 25 – 11'],
    tag: 'round 3',
  },
  // dev (21190eef) ham maskalagan: yaxlit/8-prefiksli shakl dev tanigan
  // ajratgich bilan — telefon (maxfiylik dev'dan pasaymaydi).
  {
    text: 'Aziza 90123 14.11',
    phones: [P('901231411')],
    tag: 'round 3',
  },
  {
    text: 'Aziza 890 123 14.11',
    phones: [P('901231411')],
    tag: 'round 3',
  },
  {
    text: 'Aziza 90000 14 11',
    phones: [P('900001411')],
    tag: 'round 3',
  },
  {
    text: 'Aziza 890 123 14 11',
    phones: [P('901231411')],
    tag: 'round 3',
  },
  {
    text: '8-90-123-14-11 Chilonzor',
    phones: [P('901231411')],
    tag: 'round 3',
  },
  {
    text: '+998 90 000 14/11',
    phones: [P('900001411')],
    tag: 'round 3',
  },
  {
    text: 'Aziza 0 (90) 000 14 11',
    phones: [P('900001411')],
    tag: 'round 3',
  },
];

/**
 * Hali qamralmagan, narxdan farqlab bo'lmaydi; log'da (`maskPhonesForLog`)
 * baribir yashiriladi:
 * - prefikssiz 3-3-3 telefon so'zisiz (dev'da ham maskalanmasdi) —
 *   `Malibu 335 450 990` narx bo'lishi mumkin;
 * - `…000` bilan tugagan yaxlit 9 raqam telefon so'zisiz (dev maskalardi —
 *   ATAYLAB: `Malibu 335450000` narxini yo'qotish qimmatroq);
 * - NBSP/NNBSP bilan guruhlangan, oxiri sanaga o'xshash (`90 123 12 11`)
 *   prefikssiz telefon so'zisiz — dev ham maskalamagan (NBSP'ni tanimasdi),
 *   narx + sanadan (`90 500 12 11`) farqlab bo'lmaydi.
 */
const KNOWN_PRIVACY_GAPS: ReadonlySet<string> = new Set<string>([
  'B54 3-3-3 no word',
  'B55 3-3-3 dashes no word',
  'B61 3-3-3 local Cyrillic around',
  'S4c name …000 (no phone word)',
  'N4s NNBSP-grouped date-like phone (no word)',
]);
/** Hozircha bo'sh (STIR/Trek/ID #647 round 2 da tuzatildi). */
const KNOWN_AMOUNT_GAPS: ReadonlySet<string> = new Set<string>([]);

/** Log matnida milliy 9 raqam (ajratgichlarsiz ham) qolmaganmi. */
const logLeaks = (log: string, phones: string[]) =>
  phones.filter((p) => log.replace(/\D/g, '').includes(p.slice(4)));

describe('maskPhones — maxfiylik korpusi (#647)', () => {
  it.each(PRIVACY_CASES.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const { masked, tokens } = maskPhones(c.text);
    const got = [...tokens.values()];
    const missed = c.phones.filter((p) => !got.includes(p));
    if (KNOWN_PRIVACY_GAPS.has(c.id)) {
      // Gap hali ham ochiq — tuzatilgan bo'lsa ro'yxatdan olib tashlang.
      expect(missed).not.toEqual([]);
    } else {
      expect({ missed, masked }).toEqual({ missed: [], masked });
      for (const k of c.keep ?? []) expect(masked).toContain(k);
    }
    // Log maskalash HAR DOIM telefonni yashiradi (pul qo'riqchisisiz),
    // ma'lum gap'larda ham.
    expect(logLeaks(maskPhonesForLog(c.text), c.phones)).toEqual([]);
  });

  it('KNOWN_PRIVACY_GAPS dagi har bir id korpusda bor', () => {
    const ids = new Set(PRIVACY_CASES.map((c) => c.id));
    expect([...KNOWN_PRIVACY_GAPS].filter((id) => !ids.has(id))).toEqual([]);
  });

  it.each(amountsOnly.map((m) => [m.id, m] as const))(
    'summa %s saqlanadi',
    (_id, m) => {
      expect(maskPhones(m.text).masked).toContain(m.keep);
    },
  );
});

describe('maskPhones — summa korpusi (#647)', () => {
  it.each(AMOUNT_CASES.map((c, i) => [`${i} ${c.text}`, c] as const))(
    '%s',
    (_key, c) => {
      const { masked, tokens } = maskPhones(c.text);
      const got = [...tokens.values()];
      const result = {
        extra: got.filter((g) => !c.phones.includes(g)),
        missed: c.phones.filter((p) => !got.includes(p)),
        lost: (c.keep ?? []).filter((k) => !masked.includes(k)),
      };
      if (KNOWN_AMOUNT_GAPS.has(c.text)) {
        // Gap hali ham ochiq — tuzatilgan bo'lsa ro'yxatdan olib tashlang.
        expect(result).not.toEqual({ extra: [], missed: [], lost: [] });
        return;
      }
      expect(result).toEqual({ extra: [], missed: [], lost: [] });
      // Teskari yo'l: unmask asl matnni beradi, tokenlar birinchi uchrash tartibida.
      expect(unmaskPhones({ t: masked }, tokens).t).not.toBeNull();
      const order = [...masked.matchAll(/\[TEL_(\d+)\]/g)].map((x) =>
        Number(x[1]),
      );
      const first = order.filter((n, i) => order.indexOf(n) === i);
      expect(first).toEqual([...first].sort((a, b) => a - b));
    },
  );

  it('KNOWN_AMOUNT_GAPS dagi har bir matn korpusda bor', () => {
    const texts = new Set(AMOUNT_CASES.map((c) => c.text));
    expect([...KNOWN_AMOUNT_GAPS].filter((t) => !texts.has(t))).toEqual([]);
  });
});
