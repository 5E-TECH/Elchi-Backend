import { formatTashkentDateTime } from '@app/common';
import { PDF_COLORS as C, PdfReport, pdfText } from '@app/report-kit/pdf';

/**
 * Umumiy hujjat blanki (tasdiqlangan D3): logotipli lenta, sarlavha va matn.
 * Bo'sh qator — abzas; «- », «• », «1. », «1.1. » — osma chekkali ro'yxat;
 * HAMMASI BOSH HARF qator — kichik sarlavha.
 */

const DEFAULT_TITLE = 'Hujjat';
const FONT_SIZE = 10.5;
const LINE_HEIGHT = 16.4;
const MARGIN_X = 56;
const PAGE_TOP = 62;

const LIST_ITEM = /^([-–—•*]|\d{1,3}(?:\.\d{1,3})*[.)])\s+(.*)$/;

interface Block {
  heading: boolean;
  marker: string | null;
  indent: number;
  /** Oldingi blokdan masofa. */
  gap: number;
  lines: string[];
}

const isHeading = (line: string) =>
  line.length <= 90 && /\p{L}/u.test(line) && line === line.toUpperCase();

function parseBlocks(pdf: PdfReport, content: string): Block[] {
  const blocks: Block[] = [];
  let blank = false;
  for (const line of pdfText(content).split('\n')) {
    if (!line) {
      blank = true;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    const heading = !item && isHeading(line);
    const marker = item ? (/^\d/.test(item[1]) ? item[1] : '•') : null;
    const indent = marker
      ? Math.max(18, pdf.textWidth(marker, 'semibold', FONT_SIZE) + 8)
      : 0;
    const previous = blocks.at(-1);
    let gap = 0;
    if (previous) {
      if (previous.heading) gap = 2;
      else if (heading) gap = 16;
      else if (blank) gap = 9;
      else gap = item ? 4 : 2;
    }
    blocks.push({
      heading,
      marker,
      indent,
      gap,
      lines: pdf.wrap(
        item ? item[2] : line,
        pdf.w - indent,
        heading ? 'bold' : 'medium',
        heading ? 11 : FONT_SIZE,
      ),
    });
    blank = false;
  }
  return blocks;
}

function drawBlocks(pdf: PdfReport, blocks: Block[]): void {
  blocks.forEach((block, i) => {
    const count = block.lines.length;
    const next = blocks[i + 1];
    // Yetim qator yo'q: blok boshida ham, oxirida ham kamida 2 qator.
    const first = block.heading
      ? count * LINE_HEIGHT +
        6 +
        (next ? next.gap + Math.min(2, next.lines.length) * LINE_HEIGHT : 0)
      : (count <= 3 ? count : 2) * LINE_HEIGHT;
    if (i && pdf.y + block.gap + first > pdf.bottom) pdf.newPage(PAGE_TOP);
    else pdf.y += block.gap;
    block.lines.forEach((line, k) => {
      const orphan =
        count - k === 2 && k >= 2 && pdf.y + 2 * LINE_HEIGHT > pdf.bottom;
      if (k && (pdf.y + LINE_HEIGHT > pdf.bottom || orphan)) {
        pdf.newPage(PAGE_TOP);
      }
      const cy = pdf.y + LINE_HEIGHT / 2;
      if (!k && block.marker) {
        pdf.put(block.marker, pdf.x, cy, block.indent, {
          weight: 'semibold',
          size: FONT_SIZE,
          color: C.action,
        });
      }
      pdf.put(line, pdf.x + block.indent, cy, pdf.w - block.indent, {
        weight: block.heading ? 'bold' : 'medium',
        size: block.heading ? 11 : FONT_SIZE,
        color: block.heading ? C.navy : C.text,
      });
      pdf.y += LINE_HEIGHT;
    });
    if (block.heading) pdf.y += 4;
  });
}

export async function buildDocumentPdf(o: {
  title?: string;
  content: string;
  createdAt?: Date;
  /** Test uchun — siqilmagan oqim. */
  compress?: boolean;
}): Promise<Buffer> {
  const title = pdfText(o.title) || DEFAULT_TITLE;
  const oneLine = title.replace(/\s+/g, ' ');
  const created = formatTashkentDateTime(o.createdAt ?? new Date());
  const pdf = new PdfReport({
    title: oneLine,
    footer: oneLine,
    footerWidth: 250,
    head: oneLine,
    createdAt: created,
    marginX: MARGIN_X,
    marginBottom: 58,
    compress: o.compress,
  });

  // Lenta: logotip va sana (hujjatda boshqa rekvizit yo'q).
  pdf.rect(0, 0, pdf.width, 76, C.navy);
  pdf.logo(pdf.x, 24, 85);
  pdf.put('Sana', pdf.x, 30, pdf.w, {
    size: 8.5,
    color: C.navMuted,
    align: 'right',
  });
  pdf.put(created.split(' ')[0], pdf.x, 46, pdf.w, {
    weight: 'bold',
    size: 12,
    color: C.white,
    align: 'right',
  });

  pdf.y = 106;
  for (const line of pdf.wrap(title, pdf.w, 'bold', 19, 4)) {
    pdf.put(line, pdf.x, pdf.y + 10, pdf.w, {
      weight: 'bold',
      size: 19,
      color: C.navy,
    });
    pdf.y += 25;
  }
  pdf.y += 8;
  pdf.rect(pdf.x, pdf.y, 48, 2.4, C.action);
  pdf.y += 26;

  drawBlocks(pdf, parseBlocks(pdf, o.content));
  return await pdf.toBuffer();
}
