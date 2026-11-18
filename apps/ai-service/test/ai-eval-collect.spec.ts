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

/** Review round-6 (L1, S1–S4) — hammasi sintetik ma'lumot. */
describe('ai-eval-collect: PII (review round-6)', () => {
  const masked = (text: string, names: string[]): string =>
    maskCandidateText(text, names);

  it('L1: havoladan keyingi telefon to‘liq [RAQAM] (birinchi guruh yutilmaydi)', () => {
    for (const [t, want] of [
      ['instagram.com/dilnoza_shop,90 742 90 47', '[LINK],[RAQAM]'],
      ['t.me/dilnoza_shop,90 742 90 47', '[LINK],[RAQAM]'],
      ['https://maps.app.goo.gl/AbC123,90 765 43 21', '[LINK],[RAQAM]'],
      ['https://maps.app.goo.gl/AbC1-90 931 38 51', '[LINK]-[RAQAM]'],
    ]) {
      expect(masked(t, [])).toBe(want);
    }
    // Koordinatali xarita havolasi butunligicha; havolalar orasidagi vergul.
    expect(
      masked(
        'google.com/maps/@41.31,69.23,17z/data=!3m1 va maps.google.com/?q=41.311081,69.240562',
        [],
      ),
    ).toBe('[LINK] va [LINK]');
    expect(masked('t.me/a_b, wa.me/998000000000', [])).toBe('[LINK], [LINK]');
  });

  it('L1: tuzatishlar va tasdiqlangan preview (maskDeep) orqali ham', () => {
    const addr = 'Chilonzor 9, instagram.com/dilnoza_shop,90 742 90 47';
    expect(
      maskDeep(
        scrubCorrections([
          {
            item_index: 0,
            field_corrections: { address: { ai: null, final: addr } },
          },
        ]),
        [],
      ),
    ).toEqual([
      {
        item_index: 0,
        field_corrections: {
          address: { ai: null, final: 'Chilonzor 9, [LINK],[RAQAM]' },
        },
      },
    ]);
    expect(
      maskDeep(
        confirmedPreview([{ index: 0, address: addr }], [{ item_index: 0 }]),
        [],
      ),
    ).toEqual([{ index: 0, address: 'Chilonzor 9, [LINK],[RAQAM]' }]);
  });

  it('S1: narx guruhi uy raqamiga aylanmaydi', () => {
    expect(
      masked(
        "Dostavka uyigacha 20 000 so'm, uyiga 25 000, xonadoniga 30 000, Narxi 1 586 000 uyiga yetkazib",
        [],
      ),
    ).toBe(
      "Dostavka uyigacha 20 000 so'm, uyiga 25 000, xonadoniga 30 000, Narxi 1 586 000 uyiga yetkazib",
    );
    expect(
      masked('12-uyi, uyiga 12, uy 120, Yunusobod 4 12-uy, дом 12 кв 5', []),
    ).toBe('[N]-uyi, uyiga [N], uy [N], Yunusobod 4 [N]-uy, дом [N] кв [N]');
  });

  it('S2: -hon/-honim va tireli murojaat ("Dilnoza-xon")', () => {
    expect(masked('Dilnozahonga bering', ['Dilnoza'])).toBe(
      '[ISM]honga bering',
    );
    expect(masked('Dilnoza opa keldi', ['Dilnozahon'])).toBe('[ISM] opa keldi');
    expect(masked('Dilnoza opaga bering', ['Dilnoza-xon'])).toBe(
      '[ISM] opaga bering',
    );
    expect(nameVariants(['Dilnoza-xon'])).toEqual(['Dilnoza-xon', 'Dilnoza']);
    expect(nameVariants(['Dilnozahonim'])).toContain('Dilnoza');
  });

  it('S3: rus kelishigidagi uy/kvartira', () => {
    expect(
      masked('в доме 5, квартире 7, в квартиру 9, квартиры 2 шт', []),
    ).toBe('в доме [N], квартире [N], в квартиру [N], квартиры 2 шт');
    expect(masked('дома никого нет', [])).toBe('дома никого нет');
  });

  it('S4: pasport — oldida umumiy 2 harfli so‘z bo‘lsa seriya emas', () => {
    expect(masked('Jami: 1 ta - 1500000, uy-1234567', [])).toBe(
      'Jami: 1 ta - 1500000, uy-1234567',
    );
    expect(masked('AA-1234567, AB №1234567, AA 1234567', [])).toBe(
      '[HUJJAT], [HUJJAT], [HUJJAT]',
    );
  });
});

/**
 * Review round-7 — dev bilan tenglik (dev maskalagan narsa ochilmasin).
 * Har holat maskCandidateText VA maskDeep (tuzatishlar, tasdiqlangan
 * preview) orqali. Hammasi sintetik.
 */
describe('ai-eval-collect: PII (review round-7, dev tengligi)', () => {
  const viaDeep = (text: string): string[] => {
    const corr = maskDeep(
      scrubCorrections([
        {
          item_index: 0,
          field_corrections: { address: { ai: null, final: text } },
        },
      ]),
      [],
    ) as { field_corrections: { address: { final: string } } }[];
    const prev = maskDeep(
      confirmedPreview([{ index: 0, address: text }], [{ item_index: 0 }]),
      [],
    ) as { address: string }[];
    return [corr[0].field_corrections.address.final, prev[0].address];
  };
  const expectAll = (text: string, want: string): void => {
    expect(maskCandidateText(text, [])).toBe(want);
    expect(viaDeep(text)).toEqual([want, want]);
  };

  it('B4: uy/xonadon raqamidan keyingi narx raqamni ochmaydi', () => {
    for (const [t, want] of [
      [
        "Chilonzor 12 kvartal uy 5 kv 45 250 000 so'm",
        "Chilonzor 12 kvartal uy [N] kv [N] 250 000 so'm",
      ],
      ["kv 45 150 000 so'm", "kv [N] 150 000 so'm"],
      ['uy 12 100 000', 'uy [N] 100 000'],
      ['дом 12 300 000 сум', 'дом [N] 300 000 сум'],
      ['кв 45 200 тыс', 'кв [N] 200 тыс'],
      ['dom 7 123', 'dom [N] 123'],
      ['uyga 1.500', 'uyga [N].500'],
      [
        "Sergeli, dom 15, kv 7 350.000 so'm",
        "Sergeli, dom [N], kv [N] 350.000 so'm",
      ],
      ["Olmazor uy 23 120 000 so'm", "Olmazor uy [N] 120 000 so'm"],
      ['kvartira 7 200 ming', 'kvartira [N] 200 ming'],
      [
        "Dilnoza 90 742 90 47\nToshkent Chilonzor 9-kvartal, uy 12 kv 45\n250 000 so'm\natir 1 ta",
        "Dilnoza [RAQAM]\nToshkent Chilonzor 9-kvartal, uy [N] kv [N]\n250 000 so'm\natir 1 ta",
      ],
    ]) {
      expectAll(t, want);
    }
    // S1 narx holatlari avvalgidek saqlanadi.
    expectAll(
      "Dostavka uyigacha 20 000 so'm, uyiga 25 000, xonadoniga 30 000, Narxi 1 586 000 uyiga yetkazib",
      "Dostavka uyigacha 20 000 so'm, uyiga 25 000, xonadoniga 30 000, Narxi 1 586 000 uyiga yetkazib",
    );
  });

  it('B3: umumiy 2 harfli so‘z + 7 raqam — raqam yopiq (dev: [HUJJAT])', () => {
    for (const [t, want] of [
      ['Tel: 90 123 45 67 va 2345678', 'Tel: [RAQAM] va [RAQAM]'],
      ['uy 2345678', 'uy [RAQAM]'],
      ['uy2345678', 'uy[RAQAM]'],
      ['tel uy 2345678', 'tel uy [RAQAM]'],
      ['ва 1234567', 'ва [RAQAM]'],
      ['кв 1234567', 'кв [RAQAM]'],
      // dev'dagidek ochiq (dev ham maskalamagan).
      ['Jami: 1 ta - 1500000', 'Jami: 1 ta - 1500000'],
      ['uy-1234567', 'uy-1234567'],
      // Pasport ajratgichi uy kalit so'zini yutmaydi (dev'dagidek).
      ['151-уй - 6356734', '[N]-уй - 6356734'],
      ['AA-1234567, AB №1234567', '[HUJJAT], [HUJJAT]'],
    ]) {
      expectAll(t, want);
    }
  });

  it('B1/B2: havola chegarasidagi telefon to‘liq [RAQAM]', () => {
    for (const [t, want] of [
      ['instagram.com/dilnoza_shop,90-742 90 47', '[LINK],[RAQAM]'],
      ['instagram.com/dilnoza_shop,90 742 90 47', '[LINK],[RAQAM]'],
      ['wa.me/90 742 90 47', '[LINK]/[RAQAM]'],
      ['api.whatsapp.com/send?phone=90 742 90 47', '[LINK]=[RAQAM]'],
      ['maps.app.goo.gl/AbC123.90 742 90 47', '[LINK].[RAQAM]'],
      ['https://maps.app.goo.gl/AbC1-90 931 38 51', '[LINK]-[RAQAM]'],
      ['Tel 98 710 45 85.maps.app.goo.gl/AbC123', 'Tel [RAQAM].[LINK]'],
      ['goo.gl/AbC12390 742 90 47', '[LINK][RAQAM]'],
      // Koordinata/zoom vergullari havola ichida; havolalar orasidagi vergul.
      [
        'google.com/maps/@41.31,69.23,17z/data=!3m1 va maps.google.com/?q=41.311081,69.240562, t.me/a_b.',
        '[LINK] va [LINK], [LINK].',
      ],
      ['yandex.uz/maps/?ll=69.24,-41.31&z=12', '[LINK]'],
    ]) {
      expectAll(t, want);
    }
  });

  it('havola [TEL_n] tokenini yutmaydi', () => {
    expectAll('https://wa.me/[TEL_1] yozing', '[LINK][TEL_1] yozing');
  });
});
