/**
 * Label / receipt rendering for the gateway printer endpoints.
 *
 * Ported from the legacy PCS `printer.service.ts` (pdfkit + qrcode). PCS shipped
 * an unused `escpos` dependency — confirmed dead code, so this is a pure
 * PDF/HTML port with no native printer driver.
 *
 * Two outputs:
 *   - renderThermalPdf()  → 100mm × 60mm landscape label for Gainscha GS-2408D
 *                           (203 DPI). One page per order.
 *   - renderReceiptHtml() → A4 sheet, 2 × 6 = 12 receipts per page, auto-prints
 *                           in the browser.
 *
 * Input is the enriched row returned by order-service `order.print.find`, so
 * there is no DB access here.
 */
import * as fs from 'node:fs';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';

export interface PrintRow {
  id: string;
  order_number: string;
  qr_code_token: string;
  created_at: number;
  where_deliver: string;
  total_price: number;
  comment: string;
  address: string;
  customer_name: string;
  customer_phone: string;
  extra_number: string;
  region_name: string;
  district_name: string;
  market_name: string;
  market_phone: string;
  operator: string;
  products: Array<{ name: string; quantity: number }>;
}

const DEJAVU_CANDIDATES: Array<{ regular: string; bold: string }> = [
  {
    regular: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  },
  {
    regular: '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    bold: '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  },
  {
    regular: '/usr/share/fonts/TTF/DejaVuSans.ttf',
    bold: '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  },
];

/**
 * Register DejaVu (full Latin + Cyrillic coverage) if present on the host,
 * otherwise fall back to pdfkit's built-in Helvetica. Returns the font names to
 * use. Falling back keeps Latin/Uzbek-latin text correct even where the font
 * package is missing, so a PDF is always produced.
 */
function resolveFonts(doc: PDFKit.PDFDocument): {
  regular: string;
  bold: string;
} {
  for (const c of DEJAVU_CANDIDATES) {
    try {
      if (fs.existsSync(c.regular) && fs.existsSync(c.bold)) {
        doc.registerFont('Sans', c.regular);
        doc.registerFont('Sans-Bold', c.bold);
        return { regular: 'Sans', bold: 'Sans-Bold' };
      }
    } catch {
      // probe failed — try the next candidate
    }
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold' };
}

function formatPhoneNumber(phone: string): string {
  const cleaned = (phone ?? '').replace(/\D/g, '');
  if (cleaned.startsWith('998') && cleaned.length === 12) {
    const code = cleaned.slice(3, 5);
    const part1 = cleaned.slice(5, 8);
    const part2 = cleaned.slice(8, 10);
    const part3 = cleaned.slice(10, 12);
    return `+998 (${code}) ${part1}-${part2}-${part3}`;
  }
  return phone ?? '';
}

function formatCurrency(amount: number | string): string {
  const num = Number(amount) || 0;
  return num.toLocaleString('en-US') + " so'm";
}

function formatDateStr(date: number | string): string {
  const createdDate = new Date(Number(date) || Date.now());
  return createdDate.toLocaleDateString('uz-UZ');
}

function formatRegionName(regionName?: string): string {
  if (!regionName) return '';
  if (regionName.trim().startsWith('Qoraqal')) {
    return regionName.split(' ')[0];
  }
  return regionName.trim();
}

function whereDeliverLabel(where: string): string {
  return where === 'address' ? 'UYGACHA' : 'MARKAZGA';
}

function productString(products: PrintRow['products']): string {
  return (products || [])
    .map((p) => `${p.name ?? 'N/A'}-${p.quantity ?? 1}`)
    .join(', ');
}

function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BEEPOST_LOGO_PATHS = [
  {
    d: 'M1.38591 0.141343L6.38352 3.22731C6.65167 3.39289 6.81493 3.68563 6.81493 4.00089V18.0987C6.81493 18.4185 6.64707 18.7147 6.37285 18.8788L1.37524 21.8707C0.94461 22.1285 0.386623 21.9882 0.128938 21.5574C0.0445607 21.4164 0 21.255 0 21.0906V0.914925C0 0.412862 0.40682 0.00585938 0.908658 0.00585938C1.07722 0.00585938 1.24246 0.0527689 1.38591 0.141343Z',
    fill: '#000',
  },
  {
    d: 'M26.7836 0.137942L21.786 3.21357C21.5172 3.379 21.3534 3.67212 21.3534 3.98786V18.0989C21.3534 18.4186 21.5213 18.7148 21.7955 18.879L26.7931 21.8709C27.2237 22.1287 27.7817 21.9884 28.0394 21.5576C28.1238 21.4165 28.1683 21.2552 28.1683 21.0908V0.91224C28.1683 0.410177 27.7615 0.00317383 27.2597 0.00317383C27.0916 0.00317383 26.9268 0.0498263 26.7836 0.137942Z',
    fill: '#000',
  },
  {
    d: 'M1.38349 0.133995L14.0842 7.9218V15.4216L0 7.35155V0.909066C0 0.407003 0.40682 0 0.908657 0C1.07626 0 1.24059 0.0463746 1.38349 0.133995Z',
    fill: '#444',
  },
  {
    d: 'M26.7848 0.133995L14.0841 7.9218V15.4216L28.1683 7.35155V0.909066C28.1683 0.407003 27.7615 0 27.2597 0C27.0921 0 26.9277 0.0463746 26.7848 0.133995Z',
    fill: '#666',
  },
];

/**
 * Gainscha GS-2408D (203 DPI) — 100mm(width) × 60mm(height) landscape label.
 * PDF page size matches the physical label exactly. The printer driver must be
 * set to 100×60mm paper with auto-rotate OFF.
 */
export async function renderThermalPdf(rows: PrintRow[]): Promise<Buffer> {
  const MM = 2.83465; // 1mm in PDF points
  const PAGE_W = 100 * MM; // 283.46pt
  const PAGE_H = 60 * MM; // 170.08pt

  const doc = new PDFDocument({
    size: [PAGE_W, PAGE_H],
    margin: 0,
    autoFirstPage: false,
    bufferPages: true,
  });

  const FONT = resolveFonts(doc);

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  for (let i = 0; i < rows.length; i++) {
    const order = rows[i];
    doc.addPage({ size: [PAGE_W, PAGE_H], margin: 0 });

    const customerName = order.customer_name ?? 'N/A';
    const customerPhone = formatPhoneNumber(order.customer_phone ?? '');
    const extraNumber = order.extra_number
      ? formatPhoneNumber(order.extra_number)
      : '';
    const orderPrice = formatCurrency(order.total_price);
    const region = formatRegionName(order.region_name);
    const district = order.district_name ?? 'N/A';
    const address = order.address ?? '-';
    const comment = order.comment ?? '-';
    const market = order.market_name ?? 'N/A';
    const operator = order.operator || '-';
    const createdTime = formatDateStr(order.created_at);
    const orderNumber = order.order_number ? `#${order.order_number}` : '';
    const whereDeliver = whereDeliverLabel(order.where_deliver);
    const qrCode = order.qr_code_token ?? '';

    // Problem-contact line: PCS used the operator phone; Elchi's order keeps the
    // operator as a name only, so the market phone is the reliable callback.
    const contactDisplay = order.market_phone
      ? formatPhoneNumber(order.market_phone)
      : '-';

    const productStr = productString(order.products);

    // ====== LAYOUT ======
    const M = 2 * MM;
    const FULL_W = PAGE_W - 2 * M;
    const LEFT_W = 28 * MM;
    const RIGHT_X = M + LEFT_W;
    const RIGHT_W = FULL_W - LEFT_W;
    const LABEL_COL = 17 * MM;
    const PAD = 3;
    const TABLE_TOP = M;
    const TABLE_BOT = PAGE_H - M;
    const TABLE_H = TABLE_BOT - TABLE_TOP;

    const MAHSULOT_H = 16;
    const MOLJAL_H = 16;
    const IZOH_H = 13;
    const LOGIST_H = 13;
    const ZONE_B_H = MAHSULOT_H + MOLJAL_H + IZOH_H + LOGIST_H;
    const B_LABEL_COL = 17 * MM;
    const B_VALUE_X = M + B_LABEL_COL;
    const B_VALUE_W = FULL_W - B_LABEL_COL;
    const availBW = B_VALUE_W - 2 * PAD;

    const zoneBTexts = [
      productStr || '-',
      address || '-',
      comment || '-',
      contactDisplay,
    ];
    const zoneBRows = [
      { label: 'Mahsulot:', h: MAHSULOT_H },
      { label: "Mo'ljal:", h: MOLJAL_H },
      { label: 'Izoh:', h: IZOH_H },
      { label: "Muammo bo'lsa:", h: LOGIST_H },
    ];

    const ZONE_A_H = TABLE_H - ZONE_B_H;
    const ZONE_B_Y = TABLE_TOP + ZONE_A_H;

    const zoneARows = [
      { label: 'F.I.O:', h: 16 },
      { label: 'Telefon:', h: 28 },
      { label: 'Manzil:', h: 28 },
      { label: 'Jami:', h: 15 },
      { label: "Jo'natuvchi:", h: 0 },
    ];
    const zoneAFixed = zoneARows.slice(0, -1).reduce((s, r) => s + r.h, 0);
    zoneARows[zoneARows.length - 1].h = ZONE_A_H - zoneAFixed;

    const phoneValue = extraNumber
      ? `${customerPhone}\n${extraNumber}`
      : customerPhone;
    const zoneAValues = [
      customerName,
      phoneValue,
      `${region} ${district}`,
      `${orderPrice}   ${whereDeliver}`,
      `${market} / ${operator}`,
    ];

    // ====== LEFT PANEL (logo + brand + QR + date) ======
    doc.lineWidth(0.5);
    doc.rect(M, TABLE_TOP, LEFT_W, ZONE_A_H).stroke();

    let leftY = TABLE_TOP + 5;
    const logoScale = 0.5;
    const logoW = 29 * logoScale;
    const logoH = 22 * logoScale;
    doc.font(FONT.bold).fontSize(11);
    const brandText = 'BEEPOST';
    const brandW = doc.widthOfString(brandText);
    const totalBrandW = logoW + 3 + brandW;
    const brandStartX = M + (LEFT_W - totalBrandW) / 2;

    doc.save();
    doc.translate(brandStartX, leftY);
    doc.scale(logoScale);
    for (const p of BEEPOST_LOGO_PATHS) {
      doc.path(p.d).fill(p.fill);
    }
    doc.restore();

    doc.font(FONT.bold).fontSize(11);
    doc.text(brandText, brandStartX + logoW + 3, leftY + (logoH - 11) / 2, {
      lineBreak: false,
    });
    leftY += logoH + 5;

    const qrSize = 20 * MM;
    const qrX = M + (LEFT_W - qrSize) / 2 + 2;
    const qrTop = leftY;
    if (qrCode) {
      try {
        const qrBuffer = await QRCode.toBuffer(qrCode, {
          width: 180,
          margin: 0,
          errorCorrectionLevel: 'L',
        });
        doc.image(qrBuffer, qrX, qrTop, { width: qrSize, height: qrSize });
      } catch {
        // QR generation failed — leave the slot empty
      }
    }

    if (orderNumber) {
      doc.save();
      doc.font(FONT.bold).fontSize(9);
      const tw = doc.widthOfString(orderNumber);
      const th = doc.currentLineHeight();
      const cx = M + (qrX - M) / 2;
      const cy = qrTop + qrSize / 2;
      doc.rotate(-90, { origin: [cx, cy] });
      doc.text(orderNumber, cx - tw / 2, cy - th / 2, { lineBreak: false });
      doc.restore();
    }

    leftY += qrSize + 5;

    doc.font(FONT.bold).fontSize(9);
    doc.text(createdTime, M, leftY, {
      width: LEFT_W,
      align: 'center',
      lineBreak: false,
    });

    // ====== RIGHT PANEL — Zone A table ======
    const A_VALUE_X = RIGHT_X + LABEL_COL;
    const A_VALUE_W = RIGHT_W - LABEL_COL;

    doc.rect(RIGHT_X, TABLE_TOP, RIGHT_W, ZONE_A_H).stroke();
    doc
      .moveTo(A_VALUE_X, TABLE_TOP)
      .lineTo(A_VALUE_X, TABLE_TOP + ZONE_A_H)
      .stroke();

    let rowY = TABLE_TOP;
    for (let r = 0; r < zoneARows.length; r++) {
      const row = zoneARows[r];
      const val = zoneAValues[r];

      if (r > 0) {
        doc
          .moveTo(RIGHT_X, rowY)
          .lineTo(RIGHT_X + RIGHT_W, rowY)
          .stroke();
      }

      const isName = r === 0;
      const isPhone = r === 1;
      const isJami = r === 3;
      const isSender = r === 4;

      if (!isSender) {
        doc.font(FONT.bold).fontSize(6.5);
        doc.text(row.label, RIGHT_X + PAD, rowY + PAD, { lineBreak: false });
      }
      const valW = A_VALUE_W - 2 * PAD;

      if (isJami) {
        doc.font(FONT.bold).fontSize(9);
        const priceW = doc.widthOfString(orderPrice);
        doc.text(orderPrice, A_VALUE_X + PAD, rowY + PAD, { lineBreak: false });
        doc.font(FONT.bold).fontSize(7);
        doc.text(
          ' | ' + whereDeliver,
          A_VALUE_X + PAD + priceW,
          rowY + PAD + 2,
          {
            lineBreak: false,
          },
        );
      } else if (isSender) {
        const senderFontSize = 8.5;
        const senderLblY = rowY + (row.h - 6.5) / 2;
        const senderValY = rowY + (row.h - senderFontSize) / 2;
        doc.font(FONT.bold).fontSize(6.5);
        doc.text(row.label, RIGHT_X + PAD, senderLblY, { lineBreak: false });
        doc.save();
        doc.rect(A_VALUE_X, rowY, A_VALUE_W, row.h).clip();
        doc.font(FONT.bold).fontSize(senderFontSize);
        const mktW = doc.widthOfString(market);
        doc.text(market, A_VALUE_X + PAD, senderValY, { lineBreak: false });
        doc.font(FONT.regular).fontSize(7);
        doc.text(' | ' + operator, A_VALUE_X + PAD + mktW, senderValY + 1.5, {
          lineBreak: false,
        });
        doc.restore();
      } else {
        if (isPhone) {
          doc.font(FONT.bold).fontSize(9);
        } else if (isName) {
          doc.font(FONT.bold).fontSize(9.5);
        } else {
          doc.font(FONT.regular).fontSize(8.5);
        }
        doc.text(val, A_VALUE_X + PAD, rowY + PAD, {
          width: valW,
          lineBreak: true,
          height: row.h - 2 * PAD,
          ellipsis: true,
        });
      }

      rowY += row.h;
    }

    // ====== ZONE B — full-width table ======
    const LOGIST_LABEL_COL = 24 * MM;
    const LOGIST_VALUE_X = M + LOGIST_LABEL_COL;
    const LOGIST_VALUE_W = FULL_W - LOGIST_LABEL_COL;
    const availBW_LOGIST = LOGIST_VALUE_W - 2 * PAD;
    const LOGIST_ROW_Y = TABLE_BOT - LOGIST_H;

    doc.rect(M, ZONE_B_Y, FULL_W, TABLE_BOT - ZONE_B_Y).stroke();
    doc.moveTo(B_VALUE_X, ZONE_B_Y).lineTo(B_VALUE_X, LOGIST_ROW_Y).stroke();
    doc
      .moveTo(LOGIST_VALUE_X, LOGIST_ROW_Y)
      .lineTo(LOGIST_VALUE_X, TABLE_BOT)
      .stroke();

    let bRowY = ZONE_B_Y;
    for (let r = 0; r < zoneBRows.length; r++) {
      const row = zoneBRows[r];
      const val = zoneBTexts[r];
      const isLogist = r === zoneBRows.length - 1;

      if (r > 0) {
        doc
          .moveTo(M, bRowY)
          .lineTo(M + FULL_W, bRowY)
          .stroke();
      }

      const labelColWidth = isLogist ? LOGIST_LABEL_COL : B_LABEL_COL;
      const valueX = isLogist ? LOGIST_VALUE_X : B_VALUE_X;
      const valueW = isLogist ? availBW_LOGIST : availBW;

      doc.font(FONT.bold).fontSize(6.5);
      doc.text(row.label, M + PAD, bRowY + PAD, {
        width: labelColWidth - 2 * PAD,
        lineBreak: false,
        ellipsis: false,
      });

      doc.font(FONT.regular).fontSize(8);
      doc.text(val, valueX + PAD, bRowY + PAD, {
        width: valueW,
        lineBreak: true,
        height: row.h - 2 * PAD,
        ellipsis: true,
      });

      bRowY += row.h;
    }
  }

  doc.end();

  return new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

/**
 * A4 sheet of receipts: 2 columns × 6 rows = 12 per page. The returned HTML
 * auto-triggers the browser print dialog on load.
 */
export async function renderReceiptHtml(rows: PrintRow[]): Promise<string> {
  const beepostSvg = `<svg class="logo-svg" viewBox="0 0 28.17 22" xmlns="http://www.w3.org/2000/svg">${BEEPOST_LOGO_PATHS.map(
    (p) => `<path d="${p.d}" fill="${p.fill}"/>`,
  ).join('')}</svg>`;

  const receipts: string[] = [];

  for (const order of rows) {
    const customerName = escapeHtml(order.customer_name ?? 'N/A');
    const customerPhone = formatPhoneNumber(order.customer_phone ?? '');
    const extraNumber = order.extra_number
      ? formatPhoneNumber(order.extra_number)
      : '';
    const orderPrice = formatCurrency(order.total_price);
    const region = formatRegionName(order.region_name);
    const district = order.district_name ?? 'N/A';
    const address = escapeHtml(order.address ?? '-');
    const comment = escapeHtml(order.comment ?? '-');
    const market = escapeHtml(order.market_name ?? 'N/A');
    const operator = escapeHtml(order.operator || '-');
    const createdTime = formatDateStr(order.created_at);
    const orderNumber = order.order_number ? `#${order.order_number}` : '';
    const whereDeliver = whereDeliverLabel(order.where_deliver);
    const qrCode = order.qr_code_token ?? '';

    const contactPhone = order.market_phone
      ? formatPhoneNumber(order.market_phone)
      : '';
    const contactPhonesHtml = contactPhone ? `<b>${contactPhone}</b>` : '-';

    const productStr = escapeHtml(productString(order.products));

    let qrDataUrl = '';
    if (qrCode) {
      try {
        qrDataUrl = await QRCode.toDataURL(qrCode, { width: 140, margin: 0 });
      } catch {
        // QR failed — render without it
      }
    }

    const phoneDisplay = extraNumber
      ? `${customerPhone}<br><span style="font-size:8px;color:#333">${extraNumber}</span>`
      : customerPhone;

    receipts.push(`
      <div class="cell">
        <div class="receipt">
          <div class="zone-a">
            <div class="left-panel">
              <div class="brand-row">
                ${beepostSvg}
                <span class="brand-text">BEEPOST</span>
              </div>
              <div class="qr-row">
                ${orderNumber ? `<span class="order-no-v">${orderNumber}</span>` : ''}
                ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}"/>` : ''}
              </div>
              <div class="date-text">${createdTime}</div>
            </div>
            <div class="right-panel">
              <div class="a-row"><span class="lbl">F.I.O:</span><span class="val val-name">${customerName}</span></div>
              <div class="a-row a-row-phone"><span class="lbl">Telefon:</span><span class="val val-phone">${phoneDisplay}</span></div>
              <div class="a-row a-row-manzil"><span class="lbl">Manzil:</span><span class="val val-manzil">${escapeHtml(region)} ${escapeHtml(district)}</span></div>
              <div class="a-row"><span class="lbl">Jami:</span><span class="val val-price"><b>${orderPrice}</b> <span class="deliver-badge">${whereDeliver}</span></span></div>
              <div class="a-row a-row-last"><span class="lbl">Jo'natuvchi:</span><span class="val val-sender"><b>${market}</b> <span style="font-size:7px;color:#555">/ ${operator}</span></span></div>
            </div>
          </div>
          <div class="zone-b">
            <div class="b-row b-row-compact"><span class="lbl-b">Mahsulot:</span><span class="val-b">${productStr || '-'}</span></div>
            <div class="b-row b-row-compact"><span class="lbl-b">Mo'ljal:</span><span class="val-b">${address || '-'}</span></div>
            <div class="b-row b-row-compact b-row-izoh"><span class="lbl-b">Izoh:</span><span class="val-b">${comment || '-'}</span></div>
            <div class="b-row b-row-last b-row-logist"><table class="logist-tbl"><tr><td class="logist-td-lbl">Muammo bo'lsa:</td><td class="logist-td-val">${contactPhonesHtml}</td></tr></table></div>
          </div>
        </div>
      </div>
    `);
  }

  const COLS = 2;
  const ROWS_PER_PAGE = 6;
  const PER_PAGE = COLS * ROWS_PER_PAGE;

  const pages: string[] = [];
  for (let p = 0; p < receipts.length; p += PER_PAGE) {
    const pageReceipts = receipts.slice(p, p + PER_PAGE);
    const gridRows: string[] = [];
    for (let r = 0; r < ROWS_PER_PAGE; r++) {
      const idx = r * COLS;
      const left = pageReceipts[idx] || '<div class="cell empty"></div>';
      const right = pageReceipts[idx + 1] || '<div class="cell empty"></div>';
      gridRows.push(`<div class="grid-row">${left}${right}</div>`);
    }
    pages.push(`<div class="page">${gridRows.join('\n')}</div>`);
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Beepost - Chek (${rows.length} ta)</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  @page{size:A4;margin:3mm}
  html,body{margin:0;padding:0;background:#eee;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{font-family:'Segoe UI',Arial,sans-serif;font-size:8px;color:#000}
  .page{width:204mm;height:291mm;margin:0 auto;background:#fff;display:flex;flex-direction:column;page-break-after:always;overflow:hidden}
  .page:last-child{page-break-after:auto}
  .grid-row{display:flex;width:100%;flex:1;min-height:0;border-bottom:1px dashed #bbb}
  .grid-row:last-child{border-bottom:none}
  .cell{width:50%;height:100%;padding:2mm 1.5mm;border-right:1px dashed #bbb}
  .cell:last-child{border-right:none}
  .cell.empty{border:none}
  .receipt{width:100%;height:100%;border:0.5px solid #333;display:flex;flex-direction:column;overflow:hidden}
  .zone-a{display:flex;border-bottom:0.5px solid #333}
  .left-panel{width:24mm;flex-shrink:0;border-right:0.5px solid #333;text-align:center;padding:2px 2px;display:flex;flex-direction:column;align-items:center;gap:2px}
  .brand-row{display:flex;align-items:center;justify-content:center;gap:2px}
  .logo-svg{width:12px;height:9px;flex-shrink:0}
  .brand-text{font-size:9px;font-weight:bold;letter-spacing:0.3px}
  .qr{width:17mm;height:17mm;display:block}
  .qr-row{display:flex;align-items:center;justify-content:center;gap:1px}
  .order-no-v{writing-mode:vertical-rl;transform:rotate(180deg);font-size:11px;font-weight:bold;letter-spacing:0.4px;line-height:1;white-space:nowrap}
  .date-text{font-size:9px;font-weight:bold;margin-top:auto}
  .right-panel{flex:1;min-width:0;display:flex;flex-direction:column;position:relative}
  .right-panel::before{content:'';position:absolute;left:14mm;top:0;bottom:0;border-left:0.5px solid #ddd;z-index:1}
  .a-row{display:flex;align-items:stretch;border-bottom:0.5px solid #ccc}
  .a-row-last{border-bottom:none;flex:1}
  .lbl{width:14mm;flex-shrink:0;font-size:8px;font-weight:bold;padding:1px 2px;white-space:nowrap;color:#333;display:flex;align-items:center}
  .val{flex:1;min-width:0;font-size:9.5px;padding:1px 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center}
  .val-name{font-size:10px;font-weight:bold}
  .a-row-phone,.a-row-manzil{flex:none;height:28px;overflow:hidden}
  .val-phone{font-size:9px;font-weight:bold;white-space:normal;line-height:1.3;display:block;overflow:hidden;max-height:100%}
  .val-manzil{font-size:9px;white-space:normal;line-height:1.3;display:block;overflow:hidden;max-height:100%}
  .val-price{font-size:10px}
  .val-sender{font-size:7.5px}
  .deliver-badge{font-size:6.5px;font-weight:bold;background:#000;color:#fff;padding:0.5px 3px;border-radius:2px;margin-left:2px;vertical-align:middle}
  .zone-b{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
  .zone-b::before{content:'';position:absolute;left:14mm;top:0;bottom:0;border-left:0.5px solid #ddd;z-index:1}
  .b-row{flex:1;min-height:0;display:flex;align-items:stretch;border-bottom:0.5px solid #ccc;overflow:hidden}
  .b-row-compact{flex:1}
  .b-row-last{border-bottom:none}
  .lbl-b{width:14mm;flex-shrink:0;font-size:7px;font-weight:bold;padding:1px 2px;white-space:nowrap;color:#333;display:flex;align-items:center}
  .val-b{flex:1;min-width:0;font-size:8px;padding:1px 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center}
  .b-row-izoh .val-b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .b-row-logist{background:#f8f8f8;align-items:center;overflow:hidden;position:relative;z-index:2}
  .logist-tbl{width:100%;border-collapse:collapse;table-layout:fixed;background:#f8f8f8}
  .logist-td-lbl{width:22mm;font-size:7px;font-weight:bold;color:#333;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-right:0.5px solid #ddd;vertical-align:middle}
  .logist-td-val{font-size:8px;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
  @media print{html,body{background:#fff!important;margin:0!important;padding:0!important}.page{margin:0!important;box-shadow:none}.grid-row{border-color:#ccc!important}.cell{border-color:#ccc!important}}
  @media screen{.page{box-shadow:0 2px 8px rgba(0,0,0,0.15);margin:5mm auto}}
</style>
</head>
<body>
${pages.join('\n')}
<script>window.onload=function(){window.print();}</script>
</body>
</html>`;
}
