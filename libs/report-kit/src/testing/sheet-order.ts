import { inflateRawSync } from 'node:zlib';

/**
 * FAQAT TEST: varaq XML'idagi elementlar sxema (ISO 29500) tartibidami.
 * Buzilsa Microsoft Excel faylni «Repaired» qilib varaqni olib tashlaydi,
 * `exceljs` esa xatosiz o'qiydi — shuning uchun qiymat testlari yetarli emas.
 */
const WORKSHEET =
  'sheetPr dimension sheetViews sheetFormatPr cols sheetData sheetCalcPr sheetProtection protectedRanges scenarios autoFilter sortState dataConsolidate customSheetViews mergeCells phoneticPr conditionalFormatting dataValidations hyperlinks printOptions pageMargins pageSetup headerFooter rowBreaks colBreaks customProperties cellWatches ignoredErrors smartTags drawing legacyDrawing legacyDrawingHF picture oleObjects controls webPublishItems tableParts extLst';
const SHEET_PR = 'tabColor outlinePr pageSetUpPr';

const outOfOrder = (tags: string[], order: string) => {
  const at = tags.map((tag) => order.split(' ').indexOf(tag));
  return at.some((value, i) => value < 0 || (i > 0 && value < at[i - 1]));
};

/** Bevosita bolalar nomi. */
function children(xml: string): string[] {
  const tags: string[] = [];
  let depth = 0;
  for (const [, close, name, self] of xml.matchAll(
    /<(\/?)([\w:]+)(?:"[^"]*"|[^>"])*?(\/?)>/g,
  )) {
    if (close) depth -= 1;
    else {
      if (depth === 1) tags.push(name);
      if (!self) depth += 1;
    }
  }
  return tags;
}

/** Zip markaziy katalogidagi fayllar (`.xlsx`). */
function unzip(zip: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  let at = zip.readUInt32LE(end + 16);
  for (let left = zip.readUInt16LE(end + 10); left > 0; left -= 1) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const skip = zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const from =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(from, from + size);
    files.set(name, (method ? inflateRawSync(data) : data).toString('utf8'));
    at += 46 + nameLength + skip;
  }
  return files;
}

/** Bo'sh — hammasi joyida; aks holda «varaq: elementlar» ro'yxati. */
export function sheetOrderProblems(xlsx: Buffer): string[] {
  const problems: string[] = [];
  let sheets = 0;
  for (const [name, xml] of unzip(xlsx)) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    sheets += 1;
    const body = xml.slice(xml.indexOf('<worksheet'));
    const tags = children(body);
    if (outOfOrder(tags, WORKSHEET))
      problems.push(`${name}: ${tags.join(' ')}`);
    const sheetPr = /<sheetPr(?:\s[^>]*)?>.*?<\/sheetPr>/s.exec(body)?.[0];
    const inner = sheetPr ? children(sheetPr) : [];
    if (outOfOrder(inner, SHEET_PR)) {
      problems.push(`${name} sheetPr: ${inner.join(' ')}`);
    }
  }
  return sheets ? problems : ['varaq topilmadi'];
}
