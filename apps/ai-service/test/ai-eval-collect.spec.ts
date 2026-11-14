import {
  UNEDITED_SAMPLE_SQL,
  confirmedPreview,
  maskCandidateText,
  maskDeep,
  namesOf,
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
