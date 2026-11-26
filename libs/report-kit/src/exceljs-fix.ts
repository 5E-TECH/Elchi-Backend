/**
 * exceljs 4.4.0 xatosi: `<sheetPr>` ichida `pageSetUpPr` ni `outlinePr` dan
 * OLDIN yozadi. Sxema (ISO 29500, CT_SheetPr) tartibi: `tabColor`,
 * `outlinePr`, `pageSetUpPr`. Ikkalasi birga bo'lsa (guruhlangan qatorlar +
 * «bir bet kengligida») Microsoft Excel faylni «Repaired» qilib, o'sha varaqni
 * olib tashlaydi (ega topdi, 2026-11-25). LibreOffice, Quick Look va
 * exceljs'ning o'zi buni sezmaydi.
 *
 * Oddiy va oqimli yozuvchi bitta xform'dan foydalanadi — tartib shu yerda
 * tuzatiladi. `xlsx.ts` import qiladi.
 */
interface XmlStream {
  addRollback(): void;
  openNode(name: string): void;
  closeNode(): void;
  commit(): void;
  rollback(): void;
}
interface ChildXform {
  render(xml: XmlStream, model: unknown): boolean;
}
interface SheetPropertiesXform {
  map: Record<'tabColor' | 'outlinePr' | 'pageSetUpPr', ChildXform>;
  render(xml: XmlStream, model?: Record<string, unknown> | null): void;
}

// Ichki modul — tiplari yo'q.
const Xform =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('exceljs/lib/xlsx/xform/sheet/sheet-properties-xform') as {
    prototype: SheetPropertiesXform;
  };

Xform.prototype.render = function render(
  this: SheetPropertiesXform,
  xml,
  model,
) {
  if (!model) return;
  xml.addRollback();
  xml.openNode('sheetPr');
  // `||` emas — har biri chizilsin.
  const drawn = [
    this.map.tabColor.render(xml, model.tabColor),
    this.map.outlinePr.render(xml, model.outlineProperties),
    this.map.pageSetUpPr.render(xml, model.pageSetup),
  ];
  if (drawn.some(Boolean)) {
    xml.closeNode();
    xml.commit();
  } else {
    xml.rollback();
  }
};
