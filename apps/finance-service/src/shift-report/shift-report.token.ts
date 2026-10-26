/**
 * gWI4gYkw — `FinanceServiceService` ga hisobot yuborish ilgagi (aylanma
 * import bo'lmasin: servis faqat shu interfeysni biladi).
 */
export const SHIFT_REPORTS = 'FINANCE_SHIFT_REPORTS';

export interface ShiftReportTrigger {
  /** Yopish commit'idan keyin — fonda yuboradi (javobni kutdirmaydi). */
  deliverSoon(shiftId: string): void;
  /** «Hisobot kimlarga yuborildi» ro'yxati (hisobot sahifasi). */
  listDeliveries(shiftId: string): Promise<Array<Record<string, unknown>>>;
}
