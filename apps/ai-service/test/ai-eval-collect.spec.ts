import {
  COLLECT_SQL,
  UNEDITED_SAMPLE_SQL,
  confirmedPreview,
  hasUnnamedOrder,
  maskCandidateText,
  maskDeep,
  nameVariants,
  namesOf,
  parseIntFlag,
  scrubCorrections,
} from '../../../scripts/ai-eval-collect';

/** scripts/ai-eval-collect.ts — prod nomzodlarining PII tozalanishi (#641). */
describe('ai-eval-collect: PII', () => {
  it('namesOf: customer_name satr ham, {ai, final} tuzatish ham (operator yozgani)', () => {
    expect(
      namesOf([
        [{ customer_name: 'Ali' }],
        [
          {
            field_corrections: {
              customer_name: { ai: 'Vali', final: 'Valijon Karimov' },
            },
          },
        ],
      ]).sort(),
    ).toEqual(['Ali', 'Vali', 'Valijon Karimov']);
  });

  it('maskCandidateText: butun so‘z, katta-kichik harfsiz, eng uzuni birinchi', () => {
    expect(
      maskCandidateText('Alisher, ali va Ali Valiyev keldi', [
        'Ali',
        'Ali Valiyev',
      ]),
    ).toBe('Alisher, [ISM] va [ISM] keldi');
    expect(maskCandidateText('A.B (test)', ['A.B'])).toBe('[ISM] (test)');
  });

  it('maskDeep: JSON tuzilmasi buzilmaydi (raqamlar satr ichida maskalanadi)', () => {
    expect(
      maskDeep({ a: ['tel 998901234567', 5], b: { c: 'Ali' } }, ['Ali']),
    ).toEqual({ a: ['tel [RAQAM]', 5], b: { c: '[ISM]' } });
  });

  it('scrubCorrections: izoh, operator, telefon maskasi tashlanadi', () => {
    expect(
      scrubCorrections([
        {
          item_index: 0,
          field_corrections: {
            comment: { ai: null, final: 'x' },
            operator: { ai: null, final: 'y' },
            phone_number: { ai: '+99890*****67', final: '+99891*****11' },
            district_id: { ai: '1', final: '2' },
          },
        },
      ]),
    ).toEqual([
      {
        item_index: 0,
        field_corrections: { district_id: { ai: '1', final: '2' } },
      },
    ]);
  });

  it('confirmedPreview: faqat tasdiqlangan index va ruxsat etilgan kalitlar (hash/telefon/izoh yo‘q)', () => {
    expect(
      confirmedPreview(
        [
          {
            index: 0,
            customer_name: 'Ali',
            phone_sha256: 'h',
            phone_masked: '+99890*****67',
            extra_sha256: 'h2',
            comment: 'c',
            operator: 'o',
            district_id: '10',
            total_price: 5,
          },
          { index: 1, customer_name: 'Tashlangan' },
        ],
        [{ item_index: 0 }],
      ),
    ).toEqual([
      { index: 0, customer_name: 'Ali', district_id: '10', total_price: 5 },
    ]);
  });

  it('namuna SQL: deterministik (seed), NULL edited_fields "tahrirlanmagan" emas', () => {
    expect(UNEDITED_SAMPLE_SQL).not.toMatch(/random\(\)/);
    expect(UNEDITED_SAMPLE_SQL).toContain('md5($4::text || d.id::text)');
    expect(UNEDITED_SAMPLE_SQL).toContain('i.edited_fields IS NULL');
    expect(UNEDITED_SAMPLE_SQL).toContain('i.item_index IS NULL');
  });
});

describe('ai-eval-collect: PII (review B1–B3)', () => {
  it('B1: operator ismi yig‘iladi va #/@ bilan ham maskalanadi', () => {
    const names = namesOf([
      [{ customer_name: 'Ali', operator: 'sevinch' }],
      [{ field_corrections: { operator: { ai: 'sevinch', final: 'Malika' } } }],
    ]);
    expect(names.sort()).toEqual(['Ali', 'Malika', 'sevinch']);
    expect(
      maskCandidateText('Mutaxassis: #sevinch, Operator: Malika', names),
    ).toBe('Mutaxassis: #[ISM], Operator: [ISM]');
  });

  it('B3: o‘zbek/rus qo‘shimchalari va apostrof variantlari', () => {
    expect(
      maskCandidateText('Alisherga yetkazing, Alisherning uyi', ['Alisher']),
    ).toBe('[ISM]ga yetkazing, [ISM]ning uyi');
    for (const v of ['Gʻulomjon', 'G‘ulomjon', 'G’ulomjon', "G'ulomjon"]) {
      expect(maskCandidateText(`${v} aka`, ["G'ulomjon"])).toBe('[ISM] aka');
    }
    expect(maskCandidateText('Малике позвоните', ['Малик'])).toBe(
      '[ISM]е позвоните',
    );
    expect(maskCandidateText('Alisher keldi', ['Ali'])).toBe('Alisher keldi');
  });

  it('B3: uy/kvartira (kirill ham) va nuqta/slash bilan telefon', () => {
    expect(maskCandidateText('дом 12, кв 5, kvartira 7, 12-дом', [])).toBe(
      'дом [N], кв [N], kvartira [N], [N]-дом',
    );
    for (const t of ['90.123.45.67', '901.23.45.67', '90/123/45/67']) {
      expect(maskCandidateText(`tel ${t}`, [])).toBe('tel [RAQAM]');
    }
  });

  it('maskDeep: raqam ko‘rinishidagi telefon maskalanadi, narx emas', () => {
    expect(
      maskDeep({ a: 998901234567, b: 901234567, c: 150000000 }, []),
    ).toEqual({
      a: '[RAQAM]',
      b: '[RAQAM]',
      c: 150000000,
    });
  });
});

/** Review round-2 (N1/N2/should-fix) — hammasi sintetik ma'lumot. */
describe('ai-eval-collect: PII (review round-2)', () => {
  const masked = (text: string, names: string[]): string =>
    maskCandidateText(text, names);

  it('N1a: rus kelishiklari (-а/-я/-ий bilan tugagan ismlar)', () => {
    for (const w of ['Малике', 'Малики', 'Малику', 'Маликой']) {
      expect(masked(`${w} позвоните`, ['Малика', 'Феруза'])).toMatch(
        /^\[ISM\]\S* позвоните$/,
      );
    }
    expect(masked('Ферузе передайте', ['Малика', 'Феруза'])).toBe(
      '[ISM]е передайте',
    );
    expect(masked('Дмитрию и для Дмитрия', ['Дмитрий'])).toBe(
      '[ISM]ю и для [ISM]я',
    );
    // Faqat o'zak (boshqa ism) maskalanmaydi.
    expect(masked('Малик пришёл', ['Малика'])).toBe('Малик пришёл');
  });

  it('N1b: kirill o‘zbek qo‘shimchalari', () => {
    expect(masked('Дилнозага, Дилнозанинг', ['Дилноза'])).toBe(
      '[ISM]га, [ISM]нинг',
    );
    expect(masked('Ферузахон, Ферузажон', ['Феруза'])).toBe(
      '[ISM]хон, [ISM]жон',
    );
    expect(masked('Шоҳруҳга, Шоҳруҳнинг', ['Шоҳруҳ'])).toBe(
      '[ISM]га, [ISM]нинг',
    );
  });

  it('N1c: ketma-ket qo‘shimchalar (3 tagacha) — dev regressiyasi', () => {
    for (const [w, suf] of [
      ['Dilnozaxonga', 'xonga'],
      ['Dilnozajonning', 'jonning'],
      ['Dilnozadek', 'dek'],
      ['Dilnozam', 'm'],
      ['Dilnozaopaga', 'opaga'],
    ]) {
      expect(masked(`${w} keldi`, ['Dilnoza'])).toBe(`[ISM]${suf} keldi`);
    }
    // Ismga o'xshash boshlanadigan boshqa so'z tegilmaydi.
    expect(masked('Dilnozabonu keldi', ['Dilnoza'])).toBe('Dilnozabonu keldi');
  });

  it('N1d: apostrof ikki tomonga ixtiyoriy', () => {
    expect(masked('Gulomjon aka', ["G'ulomjon"])).toBe('[ISM] aka');
    for (const v of ["G'ulomjon", 'Gʻulomjon', 'G`ulomjon', 'G´ulomjon']) {
      expect(masked(`${v} aka`, ['Gulomjon'])).toBe('[ISM] aka');
    }
    expect(masked('Ogiloy keldi', ["O'g'iloy"])).toBe('[ISM] keldi');
    expect(masked('O‘g‘iloyga', ["O'g'iloy"])).toBe('[ISM]ga');
  });

  it('N1e: ko‘p so‘zli ism — har so‘z alohida (murojaatlarsiz)', () => {
    expect(masked('Jasurga bering', ['Abdullayev Jasur'])).toBe(
      '[ISM]ga bering',
    );
    expect(masked('Abdullayev  Jasur keldi', ['Abdullayev Jasur'])).toBe(
      '[ISM] keldi',
    );
    expect(masked('opa keldi, mijoz kutyapti', ['Lola opa', 'Mijoz Ali'])).toBe(
      'opa keldi, mijoz kutyapti',
    );
  });

  it('N2: email, havolalar, @foydalanuvchi; #operator → #[ISM]', () => {
    expect(
      masked(
        'pochta test.user@example.com, t.me/test_user123, https://www.instagram.com/test.shop/ va @test_shop_uz. #sevinch',
        ['sevinch'],
      ),
    ).toBe('pochta [EMAIL], [LINK], [LINK] va @[USER]. #[ISM]');
    for (const l of [
      'telegram.me/abc',
      'instagr.am/abc',
      'facebook.com/abc',
      'vk.com/id123',
      'tiktok.com/@abc',
    ]) {
      expect(masked(`profil ${l}`, [])).toBe('profil [LINK]');
    }
    expect(masked('narx@100 emas', [])).toBe('narx@100 emas');
  });

  it('N2: tire/pastki chiziq ajratgichli telefon', () => {
    for (const t of ['90–765–43–21', '90—123—45—67', '90_123_45_67']) {
      expect(masked(`tel ${t}`, [])).toBe('tel [RAQAM]');
    }
    expect(masked('narx 1 500 000', [])).toBe('narx 1 500 000');
  });

  it('uy/xonadon raqami: qo‘shimcha, №/N/#, harf va /raqam', () => {
    expect(
      masked('12-uyda, 5-uyga, 12-xonadonga, 12-уйда, 3 хонадон', []),
    ).toBe('[N]-uyda, [N]-uyga, [N]-xonadonga, [N]-уйда, [N] хонадон');
    expect(masked('12a-uy, 12/3-uy, uy 12/3, #7 uy', [])).toBe(
      '[N]-uy, [N]-uy, uy [N], #[N] uy',
    );
    expect(
      masked('kvartiraga 5, kv №5, дом №12, д. 15, d.15, uy N 4', []),
    ).toBe('kvartiraga [N], kv №[N], дом №[N], д. [N], d.[N], uy N [N]');
    // Miqdor va mavze (kvartal) — uy raqami emas.
    expect(masked('uyga 2 ta, Chilonzor 19-kvartal, d 15', [])).toBe(
      'uyga 2 ta, Chilonzor 19-kvartal, d 15',
    );
  });

  it('pasport: 2 harf + 7 raqam', () => {
    expect(masked('pasport AA 1234567, AB1234567', [])).toBe(
      'pasport [HUJJAT], [HUJJAT]',
    );
    expect(masked('AA 12345678', [])).toBe('AA 12345678');
  });

  it('names_masked partial: ismsiz buyurtma aniqlanadi', () => {
    expect(
      hasUnnamedOrder({
        orders: [{ customer_name: 'Ali' }, { customer_name: '  ' }],
      }),
    ).toBe(true);
    expect(hasUnnamedOrder({ orders: [{ customer_name: 'Ali' }, {}] })).toBe(
      true,
    );
    expect(hasUnnamedOrder({ orders: [{ customer_name: 'Ali' }] })).toBe(false);
    expect(hasUnnamedOrder(null)).toBe(false);
  });

  it('--days/--limit: raqam emas yoki oraliqdan tashqari → null (jim sukut yo‘q)', () => {
    expect(parseIntFlag(null, 30, 1, 90)).toBe(30);
    expect(parseIntFlag('45', 30, 1, 90)).toBe(45);
    for (const bad of ['', 'abc', '30d', '-5', '1.5', '0', '91']) {
      expect(parseIntFlag(bad, 30, 1, 90)).toBeNull();
    }
  });
});

/** Review round-3 (N3, should-fix) — hammasi sintetik ma'lumot. */
describe('ai-eval-collect: PII (review round-3)', () => {
  const masked = (text: string, names: string[]): string =>
    maskCandidateText(text, names);

  it('N3: uy/xonadon raqami — egalik qo‘shimchasi (-i/-si, -и/-си)', () => {
    expect(
      masked(
        'Yunusobod 4-kvartal 12-uyi 5-xonadoni, mo‘ljal: uyi 12, xonadoni 45, kvartirasi 7. Юнусобод 4-мавзе 12-уйи 5-хонадони',
        [],
      ),
    ).toBe(
      'Yunusobod 4-kvartal [N]-uyi [N]-xonadoni, mo‘ljal: uyi [N], xonadoni [N], kvartirasi [N]. Юнусобод 4-мавзе [N]-уйи [N]-хонадони',
    );
    expect(masked('12-uyida, 45-xonadonida, kvartirasiga 5', [])).toBe(
      '[N]-uyida, [N]-xonadonida, kvartirasiga [N]',
    );
    expect(masked('12-uyining, uyidan 9', [])).toBe('[N]-uyining, uyidan [N]');
  });

  it('N3: "12-a uy", "12 A uy", "kv-ra 5"', () => {
    expect(masked('12-a uy, 12 A uy, kv-ra 5, кв-ра 9, 5-kv-ra', [])).toBe(
      '[N] uy, [N] uy, kv-ra [N], кв-ра [N], [N]-kv-ra',
    );
    // Bog'lovchi / ko'paytirish belgisi uy raqamiga yutilmaydi; miqdor emas.
    expect(masked('дом 12 и кв 5, 1 x uy, uyiga 2 ta, uyi bor', [])).toBe(
      'дом [N] и кв [N], 1 x uy, uyiga 2 ta, uyi bor',
    );
  });

  it('N3: ismga yopishgan murojaat — yalang‘och ism ham maskalanadi', () => {
    expect(
      masked(
        'Dilnozaxon [TEL_1] Toshkent. Dilnoza opaga bering, Dilnozaning uyi',
        ['Dilnozaxon'],
      ),
    ).toBe('[ISM] [TEL_1] Toshkent. [ISM] opaga bering, [ISM]ning uyi');
    expect(masked('Феруза опага, Ферузанинг', ['Ферузажон'])).toBe(
      '[ISM] опага, [ISM]нинг',
    );
    expect(masked('Rustam aka, Rustamjonga', ['Rustamjon Karimov'])).toBe(
      '[ISM] aka, [ISM]ga',
    );
    expect(nameVariants(['Dilnozaxonim', 'Ферузажон', 'Alijon'])).toEqual(
      expect.arrayContaining(['Dilnoza', 'Феруза', 'Ali']),
    );
    // O'zak < 3 harf yoki murojaatning o'zi — alohida variant emas.
    expect(nameVariants(['Gojon', 'Opaxon'])).toEqual(['Opaxon', 'Gojon']);
    // Boshqa ism (Dilnozabonu) tegilmaydi.
    expect(masked('Dilnozabonu keldi', ['Dilnozaxon'])).toBe(
      'Dilnozabonu keldi',
    );
  });

  it('N3: kichraytuvchi -cha/-ча qo‘shimchasi', () => {
    expect(masked('Dilnozachaga bering', ['Dilnoza'])).toBe(
      '[ISM]chaga bering',
    );
    expect(masked('Ферузачага', ['Феруза'])).toBe('[ISM]чага');
  });

  it('xarita / WhatsApp havolalari → [LINK] (tinish belgisi saqlanadi)', () => {
    expect(
      masked(
        'joy: https://maps.app.goo.gl/AbCdEf123xyz, https://www.google.com/maps?q=41.311081,69.240562; yandex.uz/maps/-/CDabC9~x. 2gis.uz/tashkent/geo/7030000 va go.2gis.com/ab12c, wa.me/998000000000',
        [],
      ),
    ).toBe('joy: [LINK], [LINK]; [LINK]. [LINK] va [LINK], [LINK]');
    expect(
      masked(
        'https://maps.google.com/?q=41.3,69.2 va google.co.uz/maps/place/X, goo.gl/maps/abc.',
        [],
      ),
    ).toBe('[LINK] va [LINK], [LINK].');
    // Xarita bo'lmagan / domen ichida emas — tegilmaydi.
    expect(
      masked('t.meeting emas, google.com/search?q=a emas, yandex.uz emas', []),
    ).toBe('t.meeting emas, google.com/search?q=a emas, yandex.uz emas');
  });

  it('pasport: ajratgich bilan (tire, №)', () => {
    expect(
      masked(
        'pasport AA-1234567, AA №1234567, AA № 1234567, AA1234567, AB–7654321',
        [],
      ),
    ).toBe('pasport [HUJJAT], [HUJJAT], [HUJJAT], [HUJJAT], [HUJJAT]');
  });

  it('SQL: edited_fields JSON null/skalyar — jsonb_array_length faqat massivda', () => {
    for (const sql of [COLLECT_SQL, UNEDITED_SAMPLE_SQL]) {
      expect(sql).toMatch(
        /jsonb_typeof\(i\.edited_fields\) = 'array'\s+THEN jsonb_array_length\(i\.edited_fields\) > 0/,
      );
      expect(sql).not.toContain('COALESCE(i.edited_fields');
    }
    // Tahrirlanmagan namunada massiv bo'lmagan qiymat "solishtirib bo'lmadi".
    expect(UNEDITED_SAMPLE_SQL).toMatch(/ELSE true END\)/);
    expect(COLLECT_SQL).toMatch(/ELSE false END/);
  });
});
