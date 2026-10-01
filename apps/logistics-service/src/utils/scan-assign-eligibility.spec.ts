import { Order_status, Post_status } from '@app/common';
import {
  assessHqCourierScan,
  FINISHED_ORDER_STATUS_LABELS,
  finishedOrderMessage,
  SCAN_ASSIGN_MESSAGES,
  type HqCourierScanInput,
} from './scan-assign-eligibility';

/**
 * ITEM 5 — HQ kuryeri skani uchun sof qoidalar. HQ = '1', skanlayotgan
 * kuryer = 'c1'. Har bir qoida, qoidalarning ustunlik tartibi va har bir
 * holatning aniq kodi/matni qulflanadi.
 */
describe('assessHqCourierScan', () => {
  const assess = (
    order: HqCourierScanInput['order'],
    orderPost: HqCourierScanInput['orderPost'] = null,
  ) =>
    assessHqCourierScan({
      order,
      orderPost,
      hqBranchId: '1',
      requesterId: 'c1',
    });

  it('matnlar kelishilgan shartnomadagi kabi (aniq)', () => {
    expect(SCAN_ASSIGN_MESSAGES).toEqual({
      NOT_ACCEPTED_HQ:
        "Buyurtma hali HQ da qabul qilinmagan (holati: yangi) — uni kuryerga berib bo'lmaydi. Avval HQ registratori buyurtmani qabul qilishi kerak.",
      IN_TRANSIT:
        "Buyurtma yo'lda — filiallar orasidagi pochta yoki paket ichida. U qabul qilinmaguncha HQ kuryeri uni ololmaydi.",
      IN_BATCH:
        "Buyurtma paketga joylangan — paket jo'natilib qabul qilinmaguncha HQ kuryeri uni ololmaydi.",
      NOT_AT_HQ:
        'Buyurtma HQ da emas — boshqa filialda turibdi. HQ kuryeri faqat HQ da turgan buyurtmani oladi.',
      WITH_OTHER_COURIER: 'Order allaqachon boshqa courierga biriktirilgan',
      WRONG_STATUS:
        "Order holati noto'g'ri: faqat RECEIVED yoki WAITING_CUSTOMER bo'lishi kerak",
    });
  });

  describe('1. NEW', () => {
    it('HQ dagi NEW → 400 NOT_ACCEPTED_HQ', () => {
      expect(assess({ status: Order_status.NEW, branch_id: '1' })).toEqual({
        statusCode: 400,
        message: SCAN_ASSIGN_MESSAGES.NOT_ACCEPTED_HQ,
        reason: 'NOT_ACCEPTED',
      });
    });

    it('NEW + current_batch_id → baribir NOT_ACCEPTED_HQ (NEW g‘olib)', () => {
      expect(
        assess({
          status: Order_status.NEW,
          branch_id: '1',
          current_batch_id: 'b1',
        }),
      ).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: SCAN_ASSIGN_MESSAGES.NOT_ACCEPTED_HQ,
        }),
      );
    });

    it('boshqa filialdagi NEW ham NOT_ACCEPTED_HQ', () => {
      expect(
        assess({ status: Order_status.NEW, branch_id: '20' })?.reason,
      ).toBe('NOT_ACCEPTED');
    });
  });

  describe('2. yakunlangan holatlar', () => {
    const cases: Array<[Order_status, string]> = [
      [Order_status.SOLD, 'sotilgan'],
      [Order_status.PAID, "to'langan"],
      [Order_status.PARTLY_PAID, "qisman to'langan"],
      [Order_status.CANCELLED, 'bekor qilingan'],
      [Order_status.CANCELLED_SENT, "bekor qilinib pochtaga qo'shilgan"],
      [Order_status.RETURNED_TO_MARKET, 'marketga qaytarilgan'],
      [Order_status.CLOSED, 'yopilgan'],
    ];

    it.each(cases)('%s → 400 "Buyurtma %s — …"', (status, label) => {
      expect(FINISHED_ORDER_STATUS_LABELS[status]).toBe(label);
      expect(assess({ status, branch_id: '1' })).toEqual({
        statusCode: 400,
        message: `Buyurtma ${label} — uni kuryerga berib bo'lmaydi.`,
        reason: 'FINISHED',
      });
    });

    it('finishedOrderMessage matni', () => {
      expect(finishedOrderMessage('sotilgan')).toBe(
        "Buyurtma sotilgan — uni kuryerga berib bo'lmaydi.",
      );
    });

    it('SOLD + boshqa kuryer → yakunlangan xabar (boshqa kuryerdan ustun)', () => {
      expect(
        assess({
          status: Order_status.SOLD,
          branch_id: '1',
          courier_id: 'other',
        })?.reason,
      ).toBe('FINISHED');
    });
  });

  describe('3. boshqa kuryerda', () => {
    it('RECEIVED, courier_id boshqa → 400 WITH_OTHER_COURIER', () => {
      expect(
        assess({
          status: Order_status.RECEIVED,
          branch_id: '1',
          courier_id: 'other',
        }),
      ).toEqual({
        statusCode: 400,
        message: SCAN_ASSIGN_MESSAGES.WITH_OTHER_COURIER,
        reason: 'WITH_OTHER_COURIER',
      });
    });

    it('courier_id null, holder_courier_id boshqa → WITH_OTHER_COURIER', () => {
      expect(
        assess({
          status: Order_status.RECEIVED,
          branch_id: '1',
          courier_id: null,
          holder_courier_id: 'other',
        })?.reason,
      ).toBe('WITH_OTHER_COURIER');
    });

    it('boshqa kuryer + paket → WITH_OTHER_COURIER (paketdan ustun)', () => {
      expect(
        assess({
          status: Order_status.ON_THE_ROAD,
          branch_id: '1',
          courier_id: 'other',
          current_batch_id: 'b1',
        })?.reason,
      ).toBe('WITH_OTHER_COURIER');
    });
  });

  describe('4. paketda (current_batch_id)', () => {
    it('ON_THE_ROAD, filial 30, paket b1 → 400 IN_TRANSIT', () => {
      expect(
        assess({
          status: Order_status.ON_THE_ROAD,
          branch_id: '30',
          current_batch_id: 'b1',
        }),
      ).toEqual({
        statusCode: 400,
        message: SCAN_ASSIGN_MESSAGES.IN_TRANSIT,
        reason: 'IN_TRANSIT',
      });
    });

    it('HQ da RECEIVED, PENDING paketda → 400 IN_BATCH ("yo‘lda" emas)', () => {
      const result = assess({
        status: Order_status.RECEIVED,
        branch_id: '1',
        current_batch_id: 'b1',
      });
      expect(result).toEqual({
        statusCode: 400,
        message: SCAN_ASSIGN_MESSAGES.IN_BATCH,
        reason: 'IN_BATCH',
      });
      expect(result?.message).not.toContain("yo'lda");
    });

    it('boshqa filialdagi PENDING paket → IN_BATCH (HQ da emas xabaridan ustun)', () => {
      expect(
        assess({
          status: Order_status.RECEIVED,
          branch_id: '20',
          current_batch_id: 'b1',
        })?.reason,
      ).toBe('IN_BATCH');
    });

    it('holatini saqlaydigan RETURN paketidagi WAITING → IN_BATCH', () => {
      expect(
        assess({
          status: Order_status.WAITING,
          branch_id: '20',
          current_batch_id: 'b1',
        })?.reason,
      ).toBe('IN_BATCH');
    });
  });

  describe('5. HQ da emas', () => {
    it('filialga jo‘natilgan (ON_THE_ROAD, filial 20, kuryersiz) → 400 IN_TRANSIT', () => {
      expect(
        assess({
          status: Order_status.ON_THE_ROAD,
          branch_id: '20',
          holder_branch_id: '20',
          courier_id: null,
        }),
      ).toEqual({
        statusCode: 400,
        message: SCAN_ASSIGN_MESSAGES.IN_TRANSIT,
        reason: 'IN_TRANSIT',
      });
    });

    it('RECEIVED, filial 20 → 403 NOT_AT_HQ', () => {
      expect(
        assess({ status: Order_status.RECEIVED, branch_id: '20' }),
      ).toEqual({
        statusCode: 403,
        message: SCAN_ASSIGN_MESSAGES.NOT_AT_HQ,
        reason: 'NOT_AT_HQ',
      });
    });

    it('RECEIVED, filial 1, holder_branch_id 20 → 403 NOT_AT_HQ', () => {
      expect(
        assess({
          status: Order_status.RECEIVED,
          branch_id: '1',
          holder_branch_id: '20',
        })?.statusCode,
      ).toBe(403);
    });

    it('WAITING, filial 20, kuryersiz → 403 NOT_AT_HQ', () => {
      expect(
        assess({
          status: Order_status.WAITING,
          branch_id: '20',
          courier_id: null,
        })?.reason,
      ).toBe('NOT_AT_HQ');
    });
  });

  describe('6. ON_THE_ROAD HQ da', () => {
    it('kuryersiz → 400 IN_TRANSIT', () => {
      expect(
        assess({
          status: Order_status.ON_THE_ROAD,
          branch_id: '1',
          courier_id: null,
        })?.reason,
      ).toBe('IN_TRANSIT');
    });

    it('kuryer o‘zi (c1) → null (idempotent qayta skan)', () => {
      expect(
        assess({
          status: Order_status.ON_THE_ROAD,
          branch_id: '1',
          courier_id: 'c1',
        }),
      ).toBeNull();
    });
  });

  describe('7. buyurtma pochtasi', () => {
    it('RECEIVED, pochta SENT boshqa birovga (courier 0) → 400 IN_TRANSIT', () => {
      expect(
        assess(
          { status: Order_status.RECEIVED, branch_id: '1' },
          { status: Post_status.SENT, courier_id: '0' },
        )?.reason,
      ).toBe('IN_TRANSIT');
    });

    it('RECEIVED, pochta SENT o‘ziga (c1) → null', () => {
      expect(
        assess(
          { status: Order_status.RECEIVED, branch_id: '1' },
          { status: Post_status.SENT, courier_id: 'c1' },
        ),
      ).toBeNull();
    });

    it('RECEIVED, hudud NEW pochtasi (courier 0) → null', () => {
      expect(
        assess(
          { status: Order_status.RECEIVED, branch_id: '1' },
          { status: Post_status.NEW, courier_id: '0' },
        ),
      ).toBeNull();
    });
  });

  describe('8. ruxsat etilgan', () => {
    it('RECEIVED, holder HQ, holder_branch_id null → null', () => {
      expect(
        assess({
          status: Order_status.RECEIVED,
          branch_id: '1',
          holder_branch_id: null,
        }),
      ).toBeNull();
    });

    it('RECEIVED, holder BRANCH, holder_branch_id 1 → null', () => {
      expect(
        assess({
          status: Order_status.RECEIVED,
          branch_id: '1',
          holder_branch_id: '1',
        }),
      ).toBeNull();
    });

    it('RECEIVED, courier_id c1 (qaytgan buyurtma) → null', () => {
      expect(
        assess({
          status: Order_status.RECEIVED,
          branch_id: '1',
          courier_id: 'c1',
        }),
      ).toBeNull();
    });

    it('WAITING_CUSTOMER, courier c1 → null', () => {
      expect(
        assess({
          status: Order_status.WAITING_CUSTOMER,
          branch_id: '1',
          courier_id: 'c1',
          holder_courier_id: 'c1',
          holder_branch_id: '1',
        }),
      ).toBeNull();
    });

    it('id lar raqam bo‘lib kelsa ham solishtiriladi', () => {
      expect(
        assessHqCourierScan({
          order: {
            status: Order_status.RECEIVED,
            branch_id: 1,
            holder_branch_id: 1,
          },
          orderPost: null,
          hqBranchId: '1',
          requesterId: 'c1',
        }),
      ).toBeNull();
    });
  });

  describe('9. noto‘g‘ri holat', () => {
    it('HQ dagi WAITING (kuryer c1) → 400 WRONG_STATUS', () => {
      expect(
        assess({
          status: Order_status.WAITING,
          branch_id: '1',
          courier_id: 'c1',
        }),
      ).toEqual({
        statusCode: 400,
        message: SCAN_ASSIGN_MESSAGES.WRONG_STATUS,
        reason: 'WRONG_STATUS',
      });
    });

    it('CREATED → WRONG_STATUS', () => {
      expect(
        assess({ status: Order_status.CREATED, branch_id: '1' })?.reason,
      ).toBe('WRONG_STATUS');
    });
  });
});
