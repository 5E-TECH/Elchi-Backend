import {
  maskPhoneForLog,
  maskPhones,
  maskPhonesForLog,
  unmaskPhones,
  UZ_PHONE_RE,
} from './mask-phones';

describe('maskPhones (HD5zOyBp #1)', () => {
  it("'90 123 45 67' va '+998 (91) 234-56-78' → [TEL_1] va [TEL_2]", () => {
    const text =
      "Dilnoza 90 123 45 67, qo'shimcha +998 (91) 234-56-78, Andijon Asaka 3 ta atir";
    const { masked, tokens } = maskPhones(text);

    expect(masked).toBe(
      "Dilnoza [TEL_1], qo'shimcha [TEL_2], Andijon Asaka 3 ta atir",
    );
    expect(tokens).toEqual(
      new Map([
        ['[TEL_1]', '+998901234567'],
        ['[TEL_2]', '+998912345678'],
      ]),
    );
  });

  it("Claude'ga ketadigan matnda telefon raqamlari qolmaydi", () => {
    const text = [
      'Aziz 901234567 blender',
      'Bobur 998931112233 adapter',
      'Kamola +998-94-555-66-77',
      'Nozima 0 (95) 111 22 33',
      'Sardor 8(97)123-45-67 muzlatgich',
      'Olim 0991234567',
      'Ra`no (88) 765 43 21',
      'Anvar 50.123.45.67',
      'Jasur +998 33 1234567',
    ].join('\n');
    const { masked, tokens } = maskPhones(text);

    expect(tokens.size).toBe(9);
    // Hech bir 7+ raqamli ketma-ketlik (ajratgichlar bilan ham) qolmadi.
    expect(masked).not.toMatch(/\d(?:[ .\-()]*\d){6}/);
    expect(masked).toContain('Aziz [TEL_1] blender');
    expect(masked).toContain('Sardor [TEL_5] muzlatgich');
    expect([...tokens.values()]).toEqual([
      '+998901234567',
      '+998931112233',
      '+998945556677',
      '+998951112233',
      '+998971234567',
      '+998991234567',
      '+998887654321',
      '+998501234567',
      '+998331234567',
    ]);
  });

  it('takrorlangan raqam (boshqa shaklda ham) bir xil tokenni oladi', () => {
    const { masked, tokens } = maskPhones(
      '901234567, yana +998 90 123 45 67 va 0901234567; ikkinchisi 91 234 56 78',
    );

    expect(masked).toBe('[TEL_1], yana [TEL_1] va [TEL_1]; ikkinchisi [TEL_2]');
    expect(tokens.size).toBe(2);
    expect(tokens.get('[TEL_1]')).toBe('+998901234567');
    expect(tokens.get('[TEL_2]')).toBe('+998912345678');
  });

  it("matnda oldindan turgan TEL_n tokenlari bilan to'qnashmaydi", () => {
    const { masked, tokens } = maskPhones(
      '[TEL_1] ni unut, raqam 90 123 45 67',
    );

    expect(masked).toBe('[TEL_1] ni unut, raqam [TEL_2]');
    expect(tokens).toEqual(new Map([['[TEL_2]', '+998901234567']]));
    // Begona [TEL_1] hech qachon bizning raqamga qaytmaydi.
    expect(unmaskPhones({ phone_number: '[TEL_1]' }, tokens)).toEqual({
      phone_number: null,
    });
  });
});

describe('maskPhones — telefon emas (HD5zOyBp #3, narx/sana)', () => {
  it("telefonsiz matn o'zgarmaydi va tokens bo'sh", () => {
    const text = 'Salom, 3 ta atir, donasi 250 ming, Andijon Asaka, eshikkacha';
    const { masked, tokens } = maskPhones(text);

    expect(masked).toBe(text);
    expect(tokens.size).toBe(0);
  });

  it("bo'sh matn", () => {
    const { masked, tokens } = maskPhones('');
    expect(masked).toBe('');
    expect(tokens.size).toBe(0);
  });

  it.each([
    '125 000 000',
    '900 000 000',
    '1 500 000',
    '750000',
    'a51',
    '2026-09-27',
    '900000000',
    '500000000',
    '1 250 000 000',
    '900.000.000',
    '8600 1234 5678 9012',
    '9860 3312 4455 6677',
    '27.09.2026 18:30',
  ])("'%s' tegilmaydi", (fragment) => {
    const text = `Narxi ${fragment} so'm`;
    const { masked, tokens } = maskPhones(text);

    expect(masked).toBe(text);
    expect(tokens.size).toBe(0);
  });

  it.each([
    ['92 123 45 67', 'UZ kodi emas (92)'],
    ['12 345 67 89', 'UZ kodi emas (12)'],
    ['901 234 567', '3-3-3 guruhlash'],
    ['9012345678', "10 raqam, 0/8 prefikssiz — ko'proq raqamga yopishgan"],
    ['1901234567', 'oldida raqam yopishgan'],
    ['90123456', '8 raqam'],
    ['99890123456789', '998 + 11 raqam'],
  ])("'%s' tegilmaydi (%s)", (fragment) => {
    const text = `x ${fragment} y`;
    const { masked, tokens } = maskPhones(text);

    expect(masked).toBe(text);
    expect(tokens.size).toBe(0);
  });

  it('narx va telefon bir matnda — faqat telefon maskalanadi', () => {
    const { masked, tokens } = maskPhones(
      "Muzlatgich 4 200 000 so'm, jami 125 000 000, tel 90 111 22 33, 2026-09-27",
    );

    expect(masked).toBe(
      "Muzlatgich 4 200 000 so'm, jami 125 000 000, tel [TEL_1], 2026-09-27",
    );
    expect(tokens.size).toBe(1);
  });

  it("miqdor '8' bo'shliq bilan prefiksga yutilmaydi", () => {
    const { masked, tokens } = maskPhones('atir 8 901234567');

    expect(masked).toBe('atir 8 [TEL_1]');
    expect(tokens.get('[TEL_1]')).toBe('+998901234567');
  });
});

describe('unmaskPhones (HD5zOyBp #2)', () => {
  const { tokens } = maskPhones(
    'Birinchi 90 123 45 67, ikkinchi +998 (91) 234-56-78',
  );

  it('ikki raqam tartibi almashgan holda ham aralashmasdan tiklanadi', () => {
    const extraction = {
      orders: [
        {
          customer_name: 'Aziz',
          phone_number: '[TEL_2]',
          extra_number: 'TEL_1',
          items: [{ name: 'blender', quantity: 1 }],
          total_price: 320000,
          is_replacement: false,
          comment: null,
        },
        {
          customer_name: 'Bobur',
          phone_number: '[TEL_1]',
          extra_number: null,
          items: [],
          total_price: null,
          is_replacement: true,
          comment: "[TEL_2] ga kechqurun qo'ng'iroq",
        },
      ],
    };

    expect(unmaskPhones(extraction, tokens)).toEqual({
      orders: [
        {
          customer_name: 'Aziz',
          phone_number: '+998912345678',
          extra_number: '+998901234567',
          items: [{ name: 'blender', quantity: 1 }],
          total_price: 320000,
          is_replacement: false,
          comment: null,
        },
        {
          customer_name: 'Bobur',
          phone_number: '+998901234567',
          extra_number: null,
          items: [],
          total_price: null,
          is_replacement: true,
          comment: "+998912345678 ga kechqurun qo'ng'iroq",
        },
      ],
    });
  });

  it("noma'lum token → shu satr maydoni null", () => {
    expect(
      unmaskPhones(
        { phone_number: '[TEL_3]', extra_number: '[TEL_1]', name: 'Ali' },
        tokens,
      ),
    ).toEqual({
      phone_number: null,
      extra_number: '+998901234567',
      name: 'Ali',
    });
    expect(unmaskPhones('[TEL_9]', tokens)).toBeNull();
    expect(unmaskPhones('[TEL_1]', new Map<string, string>())).toBeNull();
  });

  it("kirishni o'zgartirmaydi, token bo'lmagan qiymatlarga tegmaydi", () => {
    const input = {
      phone_number: '[TEL_1]',
      note: 'HOTEL_1 mehmonxonasi',
      count: 3,
      flag: true,
      nothing: null,
      nested: [['[TEL_2]']],
    };
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;

    const out = unmaskPhones(input, tokens);

    expect(input).toEqual(snapshot);
    expect(out).toEqual({
      phone_number: '+998901234567',
      note: 'HOTEL_1 mehmonxonasi',
      count: 3,
      flag: true,
      nothing: null,
      nested: [['+998912345678']],
    });
  });

  it('telefonsiz matn: mask → unmask aylanishi hech narsani buzmaydi (#3)', () => {
    const text = "3 ta atir, 750000 so'm, Andijon Asaka";
    const { masked, tokens: empty } = maskPhones(text);

    expect(unmaskPhones({ comment: masked }, empty)).toEqual({ comment: text });
  });
});

describe('maskPhoneForLog', () => {
  it.each([
    ['+998901234567', '+99890*****67'],
    ['998901234567', '+99890*****67'],
    ['90 123 45 67', '+99890*****67'],
    ['0901234567', '+99890*****67'],
    [901234567, '+99890*****67'],
  ])('%s → %s', (input, expected) => {
    expect(maskPhoneForLog(input)).toBe(expected);
  });

  it("UZ raqamiga keltirib bo'lmaydigan qiymatda oxirgi 2 raqam qoladi", () => {
    expect(maskPhoneForLog('12-34-56')).toBe('**-**-56');
    expect(maskPhoneForLog(null)).toBe('');
    expect(maskPhoneForLog(undefined)).toBe('');
  });
});

describe('maskPhonesForLog', () => {
  it('matndagi telefonlarni log shakliga keltiradi, narxga tegmaydi', () => {
    expect(
      maskPhonesForLog(
        'Mijoz 90 123 45 67, narx 125 000 000, +998 (91) 234-56-78',
      ),
    ).toBe('Mijoz +99890*****67, narx 125 000 000, +99891*****78');
  });
});

describe('UZ_PHONE_RE', () => {
  it('global emas — ketma-ket .test() chaqiruvlari barqaror', () => {
    expect(UZ_PHONE_RE.flags).not.toContain('g');
    expect(UZ_PHONE_RE.test('tel 901234567')).toBe(true);
    expect(UZ_PHONE_RE.test('tel 901234567')).toBe(true);
    expect(UZ_PHONE_RE.test('900 000 000')).toBe(false);
  });
});
