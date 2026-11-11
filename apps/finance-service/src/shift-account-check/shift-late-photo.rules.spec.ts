import {
  PUBLIC_ERROR_CODES,
  SHIFT_ACCOUNT_PHOTO_STATUSES,
  SHIFT_LATE_PHOTO_ERROR_CODES,
  SHIFT_LATE_PHOTO_MESSAGES,
} from '@app/common';
import {
  SHIFT_LATE_PHOTO_WINDOW_MS,
  canUploadLate,
  isAutoClosedMainShift,
  isLateUploaded,
  latePhotoBlock,
  latePhotoFields,
  lateUploadDeadline,
  shiftAccountPhotoStatus,
} from './shift-account-check.rules';

/**
 * BE-B (ega 2026-11-10: «24 soat ichida keyin yuklash») — avto-yopilgan
 * ASOSIY kassa smenasiga karta rasmini keyin yuklash qoidalari (sof
 * funksiyalar): oyna, rad etish tartibi, `photo_status`, hisobot maydonlari.
 */
describe('BE-B — smenaga rasmni keyin yuklash qoidalari', () => {
  const closedAt = new Date('2026-11-10T13:00:00.000Z');
  const deadlineIso = '2026-11-11T13:00:00.000Z';
  const autoMain = {
    status: 'closed',
    cashbox_user_id: '0',
    close_reason: 'auto',
    closed_at: closedAt,
  };
  const at = (ms: number) => new Date(closedAt.getTime() + ms);
  const H = 3600_000;

  it('oyna — 24 soat (aniq ms)', () => {
    expect(SHIFT_LATE_PHOTO_WINDOW_MS).toBe(86_400_000);
  });

  it('avto-yopilgan MAIN smena: muddat closed_at + 24 soat; chegarada ham ruxsat, keyin — expired', () => {
    expect(isAutoClosedMainShift(autoMain)).toBe(true);
    expect(lateUploadDeadline(autoMain)?.toISOString()).toBe(deadlineIso);
    expect(latePhotoBlock(autoMain, at(H))).toBeNull();
    expect(latePhotoBlock(autoMain, at(SHIFT_LATE_PHOTO_WINDOW_MS))).toBeNull();
    expect(latePhotoBlock(autoMain, at(SHIFT_LATE_PHOTO_WINDOW_MS + 1))).toBe(
      'expired',
    );
    expect(canUploadLate(autoMain, at(H).getTime())).toBe(true);
    expect(canUploadLate(autoMain, at(25 * H))).toBe(false);
    // `closed_at` ISO satr ko'rinishida ham (JSON / raw query).
    expect(
      lateUploadDeadline({
        ...autoMain,
        closed_at: closedAt.toISOString(),
      })?.toISOString(),
    ).toBe(deadlineIso);
    // cashbox_user_id NULL — eski MAIN smena.
    expect(isAutoClosedMainShift({ ...autoMain, cashbox_user_id: null })).toBe(
      true,
    );
  });

  it('rad etish tartibi: MAIN emas → main_only (avto-yopilgan bo‘lsa ham); ochiq / qo‘lda → not_auto_closed', () => {
    expect(latePhotoBlock({ ...autoMain, cashbox_user_id: '13' }, at(H))).toBe(
      'main_only',
    );
    expect(
      latePhotoBlock(
        { status: 'open', cashbox_user_id: '13', closed_at: null },
        at(H),
      ),
    ).toBe('main_only');
    expect(
      latePhotoBlock(
        { status: 'open', cashbox_user_id: '0', close_reason: null },
        at(H),
      ),
    ).toBe('not_auto_closed');
    expect(latePhotoBlock({ ...autoMain, close_reason: 'manual' }, at(H))).toBe(
      'not_auto_closed',
    );
    // Eski (167 dan oldingi) yopilgan smena — close_reason NULL → qo'lda.
    expect(latePhotoBlock({ ...autoMain, close_reason: null }, at(H))).toBe(
      'not_auto_closed',
    );
    // Muddati o'tgan qo'lda yopilgan smena ham — not_auto_closed (expired emas).
    expect(
      latePhotoBlock({ ...autoMain, close_reason: 'manual' }, at(48 * H)),
    ).toBe('not_auto_closed');
    expect(lateUploadDeadline({ ...autoMain, close_reason: 'manual' })).toBe(
      null,
    );
    expect(lateUploadDeadline({ ...autoMain, closed_at: null })).toBeNull();
  });

  it('photo_status: uploaded → not_required → pending (ochiq / oyna ichida) → missing', () => {
    const required = { photo_file_key: null, photo_required_snap: true };
    expect(
      shiftAccountPhotoStatus(
        { photo_file_key: 'k.jpg', photo_required_snap: true },
        autoMain,
        at(30 * H),
      ),
    ).toBe('uploaded');
    // Rasm talab qilinmagan bo'lsa ham yuklangan — uploaded.
    expect(
      shiftAccountPhotoStatus(
        { photo_file_key: 'k.jpg', photo_required_snap: false },
        { status: 'open' },
        at(H),
      ),
    ).toBe('uploaded');
    expect(
      shiftAccountPhotoStatus(
        { photo_file_key: null, photo_required_snap: false },
        autoMain,
        at(H),
      ),
    ).toBe('not_required');
    expect(shiftAccountPhotoStatus(required, autoMain, at(H))).toBe('pending');
    expect(shiftAccountPhotoStatus(required, autoMain, at(25 * H))).toBe(
      'missing',
    );
    // Ochiq smena qoralamasi — pending.
    expect(
      shiftAccountPhotoStatus(
        required,
        { status: 'open', cashbox_user_id: '0' },
        at(H),
      ),
    ).toBe('pending');
    // Qo'lda yopilgan / filial avto-yopilgan — oyna yo'q → missing.
    expect(
      shiftAccountPhotoStatus(
        required,
        { ...autoMain, close_reason: 'manual' },
        at(H),
      ),
    ).toBe('missing');
    expect(
      shiftAccountPhotoStatus(
        required,
        { ...autoMain, cashbox_user_id: '13' },
        at(H),
      ),
    ).toBe('missing');
    expect([...SHIFT_ACCOUNT_PHOTO_STATUSES]).toEqual([
      'not_required',
      'uploaded',
      'pending',
      'missing',
    ]);
  });

  it('late_uploaded: rasm closed_at dan KEYIN yuklangan', () => {
    expect(isLateUploaded({ photo_uploaded_at: at(1) }, autoMain)).toBe(true);
    expect(isLateUploaded({ photo_uploaded_at: at(-H) }, autoMain)).toBe(false);
    expect(isLateUploaded({ photo_uploaded_at: closedAt }, autoMain)).toBe(
      false,
    );
    expect(isLateUploaded({ photo_uploaded_at: null }, autoMain)).toBe(false);
    expect(
      isLateUploaded({ photo_uploaded_at: at(H) }, { closed_at: null }),
    ).toBe(false);
  });

  it('hisobot maydonlari (latePhotoFields)', () => {
    const row = {
      photo_file_key: null,
      photo_required_snap: true,
      photo_uploaded_at: null,
    };
    expect(latePhotoFields(row, autoMain, at(H))).toEqual({
      photo_status: 'pending',
      late_upload_deadline: deadlineIso,
      late_uploaded: false,
      can_upload_late: true,
    });
    expect(
      latePhotoFields(
        { ...row, photo_file_key: 'k.jpg', photo_uploaded_at: at(2 * H) },
        autoMain,
        at(3 * H),
      ),
    ).toEqual({
      photo_status: 'uploaded',
      late_upload_deadline: deadlineIso,
      late_uploaded: true,
      can_upload_late: true,
    });
    expect(latePhotoFields(row, autoMain, at(25 * H))).toEqual({
      photo_status: 'missing',
      late_upload_deadline: deadlineIso,
      late_uploaded: false,
      can_upload_late: false,
    });
    expect(
      latePhotoFields(row, { ...autoMain, close_reason: 'manual' }, at(H)),
    ).toEqual({
      photo_status: 'missing',
      late_upload_deadline: null,
      late_uploaded: false,
      can_upload_late: false,
    });
    expect(
      latePhotoFields(row, { status: 'open', cashbox_user_id: '0' }, at(H)),
    ).toEqual({
      photo_status: 'pending',
      late_upload_deadline: null,
      late_uploaded: false,
      can_upload_late: false,
    });
  });

  it('xato kodlari libs/common da va PUBLIC_ERROR_CODES ga qo‘shilgan (EXPIRED — `deadline` bilan)', () => {
    expect(SHIFT_LATE_PHOTO_ERROR_CODES).toEqual({
      MAIN_ONLY: 'SHIFT_LATE_PHOTO_MAIN_ONLY',
      NOT_AUTO_CLOSED: 'SHIFT_LATE_PHOTO_NOT_AUTO_CLOSED',
      EXPIRED: 'SHIFT_LATE_PHOTO_EXPIRED',
      CARD_NOT_IN_SHIFT: 'SHIFT_LATE_PHOTO_CARD_NOT_IN_SHIFT',
    });
    for (const code of Object.values(SHIFT_LATE_PHOTO_ERROR_CODES)) {
      expect(PUBLIC_ERROR_CODES[code]).toBeDefined();
      expect(SHIFT_LATE_PHOTO_MESSAGES[code]).toEqual(expect.any(String));
    }
    expect(PUBLIC_ERROR_CODES.SHIFT_LATE_PHOTO_EXPIRED).toEqual(['deadline']);
  });
});
