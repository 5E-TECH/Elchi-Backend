import { Order_status } from '@app/common';
import {
  computeCoverageExemptions,
  coverageExemptionCandidateBranchIds,
  coverageExemptionDeleteQuery,
  coverageExemptionInsertQuery,
  coverageExemptionRetargetQuery,
  isCoverageExemptionEligible,
  isOpenCustodyRow,
  parseOpenCustodyPage,
  responsibleBranchId,
  summarizeCoverageExemptions,
  type OpenCustodyRow,
} from './district-coverage-exemption';

/**
 * Tuman qamrovi imtiyozi (ega qarori, 2026-11-02) — sof qoida: ko'chish
 * paytida eski filial / uning kuryeri qo'lidagi ochiq buyurtma eski filialda
 * tugaydi; HQ, MARKET, marketga jo'natilgan bekor va yakunlangan holatlar,
 * ko'chishdan keyin ham xizmat qiladigan filial va noma'lum filial —
 * imtiyozsiz. Yo'ldagi (SENT) partiya — borayotgan filialniki.
 */
type Branch = { id: string; type: string; region_id: string | null };

const branch = (id: string, overrides: Partial<Branch> = {}): Branch => ({
  id,
  type: 'REGIONAL',
  region_id: '1',
  ...overrides,
});

const row = (overrides: Partial<OpenCustodyRow> = {}): OpenCustodyRow => ({
  id: '101',
  district_id: '5',
  region_id: '1',
  status: Order_status.RECEIVED,
  holder_type: 'BRANCH',
  holder_branch_id: '10',
  holder_courier_id: null,
  branch_id: '10',
  courier_id: null,
  current_batch_id: null,
  batch_destination_branch_id: null,
  ...overrides,
});

// Viloyat 1 da filiallar 10 (P) va 11 (B); viloyat 2 da — 20; HQ — 1.
const branchesById = new Map<string, Branch | null>([
  ['1', branch('1', { type: 'HQ', region_id: '1' })],
  ['10', branch('10')],
  ['11', branch('11')],
  ['20', branch('20', { region_id: '2' })],
]);

/** Tuman 5: viloyat 1, xizmat filiali yo'q. */
const district5 = (overrides: Record<string, unknown> = {}) => ({
  id: '5',
  region_id: '1',
  assigned_region: null,
  serving_branch_id: null,
  ...overrides,
});

describe('responsibleBranchId', () => {
  it('BRANCH / COURIER qo‘lida — holder_branch_id', () => {
    expect(
      responsibleBranchId({
        holder_type: 'BRANCH',
        holder_branch_id: '10',
        branch_id: '99',
      }),
    ).toBe('10');
    expect(
      responsibleBranchId({
        holder_type: 'courier',
        holder_branch_id: '010',
        branch_id: '99',
      }),
    ).toBe('10');
  });

  it('HQ / MARKET / null qo‘lida yoki holder_branch_id yo‘q — branch_id', () => {
    expect(
      responsibleBranchId({
        holder_type: 'HQ',
        holder_branch_id: '10',
        branch_id: '1',
      }),
    ).toBe('1');
    expect(
      responsibleBranchId({
        holder_type: 'BRANCH',
        holder_branch_id: null,
        branch_id: '11',
      }),
    ).toBe('11');
    expect(
      responsibleBranchId({
        holder_type: null,
        holder_branch_id: null,
        branch_id: '12',
      }),
    ).toBe('12');
  });

  it('⭐ yo‘ldagi (SENT) partiya — borayotgan filial (qo‘l filialidan ustun)', () => {
    // HQ → filial 10 FORWARD: custody hali HQ da.
    expect(
      responsibleBranchId({
        holder_type: 'HQ',
        holder_branch_id: null,
        branch_id: '1',
        batch_destination_branch_id: '10',
      }),
    ).toBe('10');
    // Filial 10 → HQ RETURN: buyurtma HQ ga ketyapti.
    expect(
      responsibleBranchId({
        holder_type: 'BRANCH',
        holder_branch_id: '10',
        branch_id: '10',
        batch_destination_branch_id: '1',
      }),
    ).toBe('1');
  });

  it('partiya maydoni null / yo‘q / yaroqsiz — avvalgi qoida', () => {
    expect(
      responsibleBranchId({
        holder_type: 'BRANCH',
        holder_branch_id: '10',
        branch_id: '99',
        batch_destination_branch_id: null,
      }),
    ).toBe('10');
    expect(
      responsibleBranchId({
        holder_type: 'BRANCH',
        holder_branch_id: '10',
        branch_id: '99',
      }),
    ).toBe('10');
    expect(
      responsibleBranchId({
        holder_type: 'BRANCH',
        holder_branch_id: '10',
        branch_id: '99',
        batch_destination_branch_id: 'abc',
      }),
    ).toBe('10');
  });

  it('hech biri yo‘q / yaroqsiz — null', () => {
    expect(
      responsibleBranchId({
        holder_type: 'BRANCH',
        holder_branch_id: 'abc',
        branch_id: '0',
      }),
    ).toBeNull();
  });
});

describe('isOpenCustodyRow', () => {
  it.each([
    Order_status.NEW,
    Order_status.RECEIVED,
    Order_status.WAITING,
    Order_status.WAITING_CUSTOMER,
    Order_status.ON_THE_ROAD,
    // Shartnoma v2: filial menejeri / kuryer WAITING ga qaytara oladi.
    Order_status.CANCELLED,
    Order_status.SOLD,
  ])('ochiq holat %s — true', (status) => {
    expect(isOpenCustodyRow({ status, holder_type: 'BRANCH' })).toBe(true);
  });

  it.each([
    Order_status.CANCELLED_SENT,
    Order_status.PAID,
    Order_status.PARTLY_PAID,
    Order_status.CLOSED,
    Order_status.RETURNED_TO_MARKET,
    Order_status.CREATED,
  ])('bekor / yakunlangan holat %s — false', (status) => {
    expect(isOpenCustodyRow({ status, holder_type: 'BRANCH' })).toBe(false);
  });

  it('MARKET qo‘lida — false', () => {
    expect(
      isOpenCustodyRow({
        status: Order_status.RECEIVED,
        holder_type: 'MARKET',
      }),
    ).toBe(false);
  });
});

describe('computeCoverageExemptions', () => {
  const compute = (
    rows: OpenCustodyRow[],
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    branches: ReadonlyMap<string, Branch | null> = branchesById,
  ) =>
    computeCoverageExemptions({ rows, before, after, branchesById: branches });

  // Xizmat filiali ko'chishi: P (10) → B (11).
  const servingMoveBefore = district5({ serving_branch_id: '10' });
  const servingMoveAfter = district5({ serving_branch_id: '11' });

  it('⭐ filial qo‘lidagi (WAITING) buyurtma — eski filialga imtiyoz', () => {
    expect(
      compute(
        [row({ status: Order_status.WAITING })],
        servingMoveBefore,
        servingMoveAfter,
      ),
    ).toEqual([{ order_id: '101', branch_id: '10', district_id: '5' }]);
  });

  it('⭐ kuryer qo‘lidagi buyurtma — kuryer filialiga imtiyoz', () => {
    expect(
      compute(
        [
          row({
            status: Order_status.ON_THE_ROAD,
            holder_type: 'COURIER',
            holder_branch_id: '10',
            holder_courier_id: '44',
            courier_id: '44',
            branch_id: '10',
          }),
        ],
        servingMoveBefore,
        servingMoveAfter,
      ),
    ).toEqual([{ order_id: '101', branch_id: '10', district_id: '5' }]);
  });

  it('⭐ HQ → eski filial yo‘lda (on the road, BRANCH, kuryersiz) — imtiyoz', () => {
    expect(
      compute(
        [
          row({
            status: Order_status.ON_THE_ROAD,
            holder_type: 'BRANCH',
            holder_branch_id: '10',
            branch_id: '10',
            current_batch_id: '900',
          }),
        ],
        servingMoveBefore,
        servingMoveAfter,
      ),
    ).toEqual([{ order_id: '101', branch_id: '10', district_id: '5' }]);
  });

  it('⭐ HQ → eski filial FORWARD partiyasi yo‘lda (custody HQ da) — eski filialga imtiyoz', () => {
    expect(
      compute(
        [
          row({
            status: Order_status.ON_THE_ROAD,
            holder_type: 'HQ',
            holder_branch_id: null,
            branch_id: '1',
            current_batch_id: '900',
            batch_destination_branch_id: '10',
          }),
        ],
        servingMoveBefore,
        servingMoveAfter,
      ),
    ).toEqual([{ order_id: '101', branch_id: '10', district_id: '5' }]);
  });

  it('⭐ eski filial → HQ partiyasi yo‘lda — eski filialga imtiyoz yo‘q (HQ — hech qachon)', () => {
    expect(
      compute(
        [
          row({
            status: Order_status.WAITING,
            current_batch_id: '901',
            batch_destination_branch_id: '1',
          }),
        ],
        servingMoveBefore,
        servingMoveAfter,
      ),
    ).toEqual([]);
  });

  it('jo‘natilmagan (PENDING) partiya — buyurtma hali manba filialda: imtiyoz', () => {
    expect(
      compute(
        [row({ current_batch_id: '902', batch_destination_branch_id: null })],
        servingMoveBefore,
        servingMoveAfter,
      ),
    ).toEqual([{ order_id: '101', branch_id: '10', district_id: '5' }]);
  });

  it('⭐ targetDistrictId — imtiyozda ko‘chishdan keyingi tuman (birlashtirishda B)', () => {
    expect(
      computeCoverageExemptions({
        rows: [row()],
        before: servingMoveBefore,
        after: servingMoveAfter,
        branchesById,
        targetDistrictId: '06',
      }),
    ).toEqual([{ order_id: '101', branch_id: '10', district_id: '6' }]);
  });

  it('MARKET qo‘lida — imtiyoz yo‘q', () => {
    expect(
      compute(
        [row({ holder_type: 'MARKET', holder_branch_id: null })],
        servingMoveBefore,
        servingMoveAfter,
      ),
    ).toEqual([]);
  });

  it.each([Order_status.CANCELLED, Order_status.SOLD])(
    '⭐ filial qo‘lidagi %s (WAITING ga qaytarilishi mumkin) — imtiyoz',
    (status) => {
      expect(
        compute([row({ status })], servingMoveBefore, servingMoveAfter),
      ).toEqual([{ order_id: '101', branch_id: '10', district_id: '5' }]);
    },
  );

  it('marketga jo‘natilgan bekor (cancelled (sent)) — imtiyoz yo‘q', () => {
    expect(
      compute(
        [row({ status: Order_status.CANCELLED_SENT })],
        servingMoveBefore,
        servingMoveAfter,
      ),
    ).toEqual([]);
  });

  it.each([
    Order_status.PAID,
    Order_status.PARTLY_PAID,
    Order_status.CLOSED,
    Order_status.RETURNED_TO_MARKET,
  ])(
    'yakunlangan holat (%s) — imtiyoz yo‘q (shartnoma ham filtrlaydi)',
    (status) => {
      expect(
        compute([row({ status })], servingMoveBefore, servingMoveAfter),
      ).toEqual([]);
    },
  );

  it('HQ filiali — hech qachon imtiyozli emas', () => {
    expect(
      compute(
        [row({ holder_type: 'HQ', holder_branch_id: null, branch_id: '1' })],
        district5({ region_id: '1' }),
        district5({ region_id: '1', assigned_region: '2' }),
      ),
    ).toEqual([]);
    // HQ BRANCH sifatida ko'rsatilgan bo'lsa ham.
    expect(
      compute(
        [row({ holder_branch_id: '1', branch_id: '1' })],
        district5(),
        district5({ assigned_region: '2' }),
      ),
    ).toEqual([]);
  });

  it('ko‘chishdan keyin ham xizmat qiladigan filial — imtiyoz yo‘q', () => {
    // Xizmat filiali bo'shatildi, lekin filial 10 viloyati — tuman viloyati.
    expect(
      compute(
        [row()],
        servingMoveBefore,
        district5({ serving_branch_id: null }),
      ),
    ).toEqual([]);
    // Viloyat o'zgarmadi (assigned_region = region_id).
    expect(
      compute([row()], district5(), district5({ assigned_region: '1' })),
    ).toEqual([]);
  });

  it('ko‘chishdan OLDIN xizmat qilmagan filial — imtiyoz yo‘q', () => {
    // P → B ko'chishida uchinchi filial (viloyat 1, filial 12) — oldin ham
    // xizmat qilmasdi (tuman 10 niki edi).
    const branches = new Map(branchesById).set('12', branch('12'));
    expect(
      compute(
        [row({ holder_branch_id: '12', branch_id: '12' })],
        servingMoveBefore,
        servingMoveAfter,
        branches,
      ),
    ).toEqual([]);
  });

  it('⭐ xizmat filiali P → B: faqat P qo‘lidagilar, B qo‘lidagi — yo‘q', () => {
    expect(
      compute(
        [
          row({ id: '101' }),
          row({ id: '102', holder_branch_id: '11', branch_id: '11' }),
        ],
        servingMoveBefore,
        servingMoveAfter,
      ),
    ).toEqual([{ order_id: '101', branch_id: '10', district_id: '5' }]);
  });

  it('⭐ viloyat ko‘chishi, xizmat filialisiz: eski viloyat filiallari imtiyozli', () => {
    // Viloyat 1 → 2: 10 va 11 (viloyat 1) yo'qotadi, 20 (viloyat 2) yutadi.
    expect(
      compute(
        [
          row({ id: '101' }),
          row({ id: '102', holder_branch_id: '11', branch_id: '11' }),
          row({ id: '103', holder_branch_id: '20', branch_id: '20' }),
        ],
        district5(),
        district5({ assigned_region: '2' }),
      ),
    ).toEqual([
      { order_id: '101', branch_id: '10', district_id: '5' },
      { order_id: '102', branch_id: '11', district_id: '5' },
    ]);
  });

  it('⭐ viloyat ko‘chishi, xizmat filiali bor edi (bo‘shatiladi): faqat o‘sha filial', () => {
    expect(
      compute(
        [
          row({ id: '101' }),
          row({ id: '102', holder_branch_id: '11', branch_id: '11' }),
        ],
        servingMoveBefore,
        district5({ assigned_region: '2', serving_branch_id: null }),
      ),
    ).toEqual([{ order_id: '101', branch_id: '10', district_id: '5' }]);
  });

  it('xizmat filiali biriktirildi (null → B): viloyatdagi boshqa filiallar imtiyozli', () => {
    expect(
      compute(
        [
          row({ id: '101' }),
          row({ id: '102', holder_branch_id: '11', branch_id: '11' }),
        ],
        district5(),
        district5({ serving_branch_id: '11' }),
      ),
    ).toEqual([{ order_id: '101', branch_id: '10', district_id: '5' }]);
  });

  it('noma‘lum filial (qatori yo‘q / null) — imtiyoz yo‘q', () => {
    const branches = new Map<string, Branch | null>([['10', null]]);
    expect(
      compute([row()], servingMoveBefore, servingMoveAfter, branches),
    ).toEqual([]);
    expect(
      compute(
        [row({ holder_branch_id: '77', branch_id: '77' })],
        servingMoveBefore,
        servingMoveAfter,
      ),
    ).toEqual([]);
  });

  it('qo‘l filiali bo‘lmasa branch_id mas‘ul (holder_type null)', () => {
    expect(
      compute(
        [row({ holder_type: null, holder_branch_id: null, branch_id: '10' })],
        servingMoveBefore,
        servingMoveAfter,
      ),
    ).toEqual([{ order_id: '101', branch_id: '10', district_id: '5' }]);
  });

  it('takroriy qator — bitta imtiyoz; yaroqsiz id — tashlanadi', () => {
    expect(
      compute(
        [row(), row(), row({ id: 'x' })],
        servingMoveBefore,
        servingMoveAfter,
      ),
    ).toEqual([{ order_id: '101', branch_id: '10', district_id: '5' }]);
  });

  it('isCoverageExemptionEligible: filial mas‘ul filial bo‘lmasa — false', () => {
    expect(
      isCoverageExemptionEligible({
        row: row({ holder_branch_id: '11', branch_id: '11' }),
        before: servingMoveBefore,
        after: servingMoveAfter,
        branch: branch('10'),
      }),
    ).toBe(false);
  });
});

describe('coverageExemptionCandidateBranchIds', () => {
  it('faqat ochiq qatorlarning mas‘ul filiallari, takrorsiz', () => {
    expect(
      coverageExemptionCandidateBranchIds([
        row({ id: '1' }),
        row({ id: '2' }),
        row({ id: '3', holder_branch_id: '11', branch_id: '11' }),
        row({
          id: '4',
          status: Order_status.CANCELLED_SENT,
          holder_branch_id: '12',
          branch_id: '12',
        }),
        row({
          id: '5',
          holder_type: 'MARKET',
          holder_branch_id: null,
          branch_id: '13',
        }),
        // Yo'ldagi partiya — borayotgan filial.
        row({ id: '6', batch_destination_branch_id: '20' }),
      ]),
    ).toEqual(['10', '11', '20']);
  });
});

describe('parseOpenCustodyPage', () => {
  const rawRow = {
    id: '101',
    district_id: '5',
    region_id: '1',
    status: 'received',
    holder_type: 'BRANCH',
    holder_branch_id: '10',
    holder_courier_id: null,
    branch_id: '10',
    courier_id: null,
    current_batch_id: null,
    batch_destination_branch_id: null,
  };

  it('successRes konverti — qatorlar va next_after_id', () => {
    expect(
      parseOpenCustodyPage({
        statusCode: 200,
        message: 'ok',
        data: { rows: [rawRow], next_after_id: '101' },
      }),
    ).toEqual({ rows: [rawRow], next_after_id: '101' });
    expect(
      parseOpenCustodyPage({
        statusCode: 200,
        data: { rows: [], next_after_id: null },
      }),
    ).toEqual({ rows: [], next_after_id: null });
  });

  it('batch_destination_branch_id: yo‘q (eski order-service) — null; bor — kanonik', () => {
    const legacy: Record<string, unknown> = { ...rawRow };
    delete legacy.batch_destination_branch_id;
    expect(
      parseOpenCustodyPage({
        statusCode: 200,
        data: { rows: [legacy], next_after_id: null },
      })?.rows[0].batch_destination_branch_id,
    ).toBeNull();
    expect(
      parseOpenCustodyPage({
        statusCode: 200,
        data: {
          rows: [
            {
              ...rawRow,
              current_batch_id: '900',
              batch_destination_branch_id: '010',
            },
          ],
          next_after_id: null,
        },
      })?.rows[0],
    ).toMatchObject({
      current_batch_id: '900',
      batch_destination_branch_id: '10',
    });
  });

  it.each([
    ['null', null],
    ['xato statusi', { statusCode: 400, data: { rows: [] } }],
    ['rows massiv emas', { statusCode: 200, data: { rows: 'x' } }],
    ['data yo‘q', { statusCode: 200 }],
    [
      'yaroqsiz next_after_id',
      { statusCode: 200, data: { rows: [], next_after_id: 'abc' } },
    ],
    [
      'yaroqsiz qator id',
      {
        statusCode: 200,
        data: { rows: [{ ...rawRow, id: 'x' }], next_after_id: null },
      },
    ],
    [
      'yaroqsiz batch_destination_branch_id (manba filialniki bo‘lib qolmasin)',
      {
        statusCode: 200,
        data: {
          rows: [{ ...rawRow, batch_destination_branch_id: 'abc' }],
          next_after_id: null,
        },
      },
    ],
  ])('%s — null (fail closed)', (_label, response) => {
    expect(parseOpenCustodyPage(response)).toBeNull();
  });
});

describe('coverageExemptionRetargetQuery / coverageExemptionDeleteQuery', () => {
  it('birlashtirish: A tumanli qatorlar faqat ko‘chgan buyurtmalar uchun B ga (takrorsiz id)', () => {
    const { sql, params } = coverageExemptionRetargetQuery('5', '6', [
      '101',
      '102',
      '101',
    ]);
    expect(sql).toContain(
      'UPDATE "logistics_schema"."district_coverage_exemptions"',
    );
    expect(sql).toContain('SET "district_id" = $2::bigint');
    expect(sql).toContain('WHERE "district_id" = $1::bigint');
    expect(sql).toContain('AND "order_id" = ANY($3::bigint[])');
    expect(sql).not.toContain('revoked_at');
    expect(params).toEqual(['5', '6', ['101', '102']]);
  });

  it('bekor bo‘lgan birlashtirish: faqat berilgan juftlar, shu tuman va shu manba', () => {
    const { sql, params } = coverageExemptionDeleteQuery(
      [
        { order_id: '101', branch_id: '10' },
        { order_id: '102', branch_id: '11' },
      ],
      '6',
      'district_merge',
    );
    expect(sql).toContain(
      'DELETE FROM "logistics_schema"."district_coverage_exemptions" AS e',
    );
    expect(sql).toContain('e."order_id" = t."order_id"');
    expect(sql).toContain('e."branch_id" = t."branch_id"');
    expect(sql).toContain('e."district_id" = $3::bigint');
    expect(sql).toContain('e."source" = $4');
    expect(params).toEqual([
      ['101', '102'],
      ['10', '11'],
      '6',
      'district_merge',
    ]);
  });
});

describe('coverageExemptionInsertQuery / summarizeCoverageExemptions', () => {
  it('ON CONFLICT (order_id, branch_id) DO UPDATE (faqat tuman o‘zgarsa / bekor qilingan) + ustun massivlari', () => {
    const { sql, params } = coverageExemptionInsertQuery(
      [
        { order_id: '101', branch_id: '10', district_id: '5' },
        { order_id: '102', branch_id: '11', district_id: null },
      ],
      'district_update',
    );
    expect(sql).toContain('"logistics_schema"."district_coverage_exemptions"');
    expect(sql).toContain('ON CONFLICT ("order_id", "branch_id") DO UPDATE');
    expect(sql).toContain('"district_id" = EXCLUDED."district_id"');
    expect(sql).toContain('"revoked_at" = NULL');
    expect(sql).toContain(
      'WHERE e."district_id" IS DISTINCT FROM EXCLUDED."district_id"',
    );
    expect(sql).toContain('OR e."revoked_at" IS NOT NULL');
    expect(sql).toContain('RETURNING e."order_id"::text AS "order_id"');
    expect(params).toEqual([
      ['101', '102'],
      ['10', '11'],
      ['5', null],
      'district_update',
    ]);
  });

  it('bir so‘rovda takroriy (buyurtma, filial) — bittasi (oxirgisi) qoladi', () => {
    const { params } = coverageExemptionInsertQuery(
      [
        { order_id: '101', branch_id: '10', district_id: '5' },
        { order_id: '101', branch_id: '11', district_id: '5' },
        { order_id: '101', branch_id: '10', district_id: '6' },
      ],
      'district_merge',
    );
    expect(params).toEqual([
      ['101', '101'],
      ['10', '11'],
      ['6', '5'],
      'district_merge',
    ]);
  });

  it('xulosa: jami va filial bo‘yicha (son tartibida), tuman filtri', () => {
    const created = [
      { order_id: '101', branch_id: '10', district_id: '5' },
      { order_id: '102', branch_id: '9', district_id: '6' },
      { order_id: '103', branch_id: '10', district_id: '6' },
    ];
    expect(summarizeCoverageExemptions(created)).toEqual({
      created: 3,
      by_branch: [
        { branch_id: '9', count: 1 },
        { branch_id: '10', count: 2 },
      ],
    });
    expect(summarizeCoverageExemptions(created, '6')).toEqual({
      created: 2,
      by_branch: [
        { branch_id: '9', count: 1 },
        { branch_id: '10', count: 1 },
      ],
    });
    expect(summarizeCoverageExemptions([])).toEqual({
      created: 0,
      by_branch: [],
    });
  });
});
