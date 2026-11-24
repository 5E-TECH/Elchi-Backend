import type { SiteImportRepairRow } from './site-import-repair';

/**
 * 2026-11-24 kechqurun «Tashqi saytlar» skanidan noto'g'ri tumanga tushgan 58
 * ta buyurtma va saytdagi HAQIQIY tuman SOATO kodi.
 *
 * Manba: 2026-11-25 da har buyurtmaning QR kodi bo'yicha saytdan qayta
 * so'ralgan (`search-by-qr`, hech narsa yaratmaydi). Saytning `region` i 58
 * tasida ham buyurtmadagi (xato yozilgan) `region_id` bilan bir xil chiqqan.
 * Shaxsiy ma'lumot yo'q: buyurtma id, sayt, saytdagi id, tuman kodi.
 */
const ROWS: ReadonlyArray<readonly [string, string, string, string]> = [
  ['4016', 'alion', '42762', '1703227'],
  ['4017', 'alion', '42746', '1714237'],
  ['4018', 'alion', '42736', '1703232'],
  ['4019', 'alion', '42702', '1730209'],
  ['4020', 'alion', '42714', '1733204'],
  ['4021', 'alion', '42730', '1718238'],
  ['4022', 'alion', '42758', '1703206'],
  ['4029', 'inhayat', '6b05a72aae09f11e70cc7bf3', '1730227'],
  ['4030', 'inhayat', '6b04a4d8ae09f11e70cc7be9', '1730230'],
  ['4034', 'lidershop', '56613', '1726266'],
  ['4035', 'lidershop', '56540', '1727212'],
  ['4036', 'lidershop', '56117', '1726280'],
  ['4037', 'lidershop', '56726', '1727228'],
  ['4038', 'lidershop', '56657', '1706258'],
  ['4039', 'lidershop', '56698', '1718236'],
  ['4040', 'lidershop', '56642', '1726292'],
  ['4041', 'lidershop', '56538', '1722201'],
  ['4042', 'lidershop', '56677', '1710220'],
  ['4043', 'lidershop', '56688', '1703203'],
  ['4044', 'lidershop', '56668', '1708209'],
  ['4045', 'lidershop', '56553', '1726269'],
  ['4046', 'lidershop', '56520', '1718401'],
  ['4047', 'lidershop', '56510', '1726294'],
  ['4048', 'lidershop', '56488', '1726264'],
  ['4049', 'lidershop', '56534', '1714401'],
  ['4050', 'lidershop', '56651', '1722210'],
  ['4051', 'lidershop', '56523', '1714212'],
  ['4052', 'lidershop', '56731', '1730401'],
  ['4053', 'lidershop', '56615', '1727253'],
  ['4054', 'lidershop', '56696', '1727239'],
  ['4055', 'lidershop', '56691', '1726277'],
  ['4056', 'lidershop', '56515', '1726264'],
  ['4057', 'lidershop', '56687', '1706246'],
  ['4058', 'lidershop', '56679', '1718401'],
  ['4059', 'lidershop', '56689', '1706258'],
  ['4060', 'lidershop', '56627', '1726277'],
  ['4061', 'lidershop', '56592', '1703227'],
  ['4062', 'lidershop', '56392', '1708401'],
  ['4063', 'lidershop', '56450', '1733212'],
  ['4064', 'lidershop', '56671', '1710235'],
  ['4065', 'lidershop', '56480', '1722201'],
  ['4066', 'lidershop', '56607', '1706401'],
  ['4067', 'lidershop', '56555', '1718227'],
  ['4068', 'lidershop', '56568', '1722215'],
  ['4069', 'lidershop', '56578', '1703401'],
  ['4070', 'lidershop', '56666', '1712401'],
  ['4071', 'lidershop', '56721', '1718212'],
  ['4072', 'lidershop', '56526', '1727404'],
  ['4073', 'lidershop', '56653', '1727237'],
  ['4074', 'lidershop', '56505', '1712401'],
  ['4075', 'lidershop', '56614', '1712234'],
  ['4076', 'lidershop', '56518', '1718401'],
  ['4077', 'lidershop', '56482', '1708401'],
  ['4078', 'lidershop', '56567', '1718224'],
  ['4079', 'lidershop', '56495', '1706401'],
  ['4080', 'lidershop', '56493', '1730221'],
  ['4081', 'lidershop', '56507', '1727419'],
  ['4082', 'lidershop', '56556', '1703211'],
];

export const SITE_IMPORT_2026_11_24: readonly SiteImportRepairRow[] = ROWS.map(
  ([order_id, site, external_id, sato]) => ({
    order_id,
    site,
    external_id,
    sato,
  }),
);
