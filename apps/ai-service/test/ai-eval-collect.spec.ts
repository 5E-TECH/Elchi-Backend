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
