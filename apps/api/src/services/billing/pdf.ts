import PDFDocument from 'pdfkit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { schema } from '../../db/index.js';
import type { AppContext } from '../../lib/context.js';
import { formatDate, formatMoney } from './money.js';

type Invoice = typeof schema.invoices.$inferSelect;

const NACHT = '#14213D';
const KORAAL = '#FF6B57';
const MUTED = '#4F5B73';
const LINE = '#DCE1EB';
const WOLK = '#F6F7FB';

const words = {
  en: {
    invoice: 'Invoice',
    number: 'Invoice number',
    date: 'Invoice date',
    due: 'Due date',
    period: 'Period',
    reference: 'Your reference',
    customerVat: 'Your VAT number',
    billTo: 'Bill to',
    description: 'Description',
    qty: 'Qty',
    price: 'Price',
    amount: 'Amount',
    subtotal: 'Subtotal',
    vat: 'VAT',
    total: 'Total',
    reverse: 'VAT reverse charged (article 196 VAT Directive)',
    export: 'VAT not applicable: service supplied outside the EU',
    payBy: (amount: string, date: string, iban: string, number: string) =>
      `Please pay ${amount} before ${date}${iban ? ` to ${iban}` : ''}, stating invoice number ${number}.`,
    payOnline: 'Or pay online:',
    paid: (date: string) => `Paid on ${date}. Thank you!`,
    void: 'This invoice has been cancelled.',
    coc: 'CoC',
    vatNo: 'VAT',
  },
  nl: {
    invoice: 'Factuur',
    number: 'Factuurnummer',
    date: 'Factuurdatum',
    due: 'Vervaldatum',
    period: 'Periode',
    reference: 'Uw referentie',
    customerVat: 'Uw btw-nummer',
    billTo: 'Factuur aan',
    description: 'Omschrijving',
    qty: 'Aantal',
    price: 'Prijs',
    amount: 'Bedrag',
    subtotal: 'Subtotaal',
    vat: 'Btw',
    total: 'Totaal',
    reverse: 'Btw verlegd (artikel 196 Btw-richtlijn)',
    export: 'Btw niet van toepassing: dienst buiten de EU',
    payBy: (amount: string, date: string, iban: string, number: string) =>
      `Graag ${amount} voor ${date} overmaken${iban ? ` naar ${iban}` : ''} onder vermelding van factuurnummer ${number}.`,
    payOnline: 'Of betaal online:',
    paid: (date: string) => `Betaald op ${date}. Dank je wel!`,
    void: 'Deze factuur is geannuleerd.',
    coc: 'KvK',
    vatNo: 'Btw',
  },
};

let logo: { body: string; rect: { x: number; y: number; w: number; h: number; r: number } | null; arcs: string | null } | null | undefined;

function loadLogo(ctx: AppContext) {
  if (logo !== undefined) return logo;
  const file = join(ctx.config.INSTALL_DIR, 'brand/logo/rhis-logo.svg');
  logo = null;
  if (existsSync(file)) {
    const svg = readFileSync(file, 'utf8');
    const body = svg.match(/<path fill="#14213D" d="([^"]+)"/)?.[1];
    const r = svg.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"/);
    const arcs = svg.match(/<path d="([^"]+)" fill="none"/)?.[1] ?? null;
    if (body) logo = { body, rect: r ? { x: +r[1]!, y: +r[2]!, w: +r[3]!, h: +r[4]!, r: +r[5]! } : null, arcs };
  }
  return logo;
}

function drawLogo(doc: PDFKit.PDFDocument, ctx: AppContext, x: number, y: number, height: number) {
  const l = loadLogo(ctx);
  if (!l) {
    doc.font('bold').fontSize(height * 0.8).fillColor(NACHT).text('RHIS', x, y);
    return;
  }
  const scale = height / 1092;
  doc.save().translate(x, y).scale(scale);
  doc.path(l.body).fill(NACHT);
  if (l.rect) doc.roundedRect(l.rect.x, l.rect.y, l.rect.w, l.rect.h, l.rect.r).fill(KORAAL);
  if (l.arcs) doc.path(l.arcs).lineWidth(75).lineCap('round').stroke(KORAAL);
  doc.restore();
}

/** The invoice as an A4 PDF in the RHIS house style, in the invoice's language. */
export function renderInvoicePdf(ctx: AppContext, inv: Invoice): Promise<Buffer> {
  const w = words[inv.locale === 'nl' ? 'nl' : 'en'];
  const money = (c: number) => formatMoney(c, inv.currency, inv.locale);
  const date = (d: Date) => formatDate(d, inv.locale);
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: { Title: `${w.invoice} ${inv.number}`, Author: inv.seller.company || 'Hosted Radio Station' } });
  // Archivo (RHIS house style) in static cuts: PDF viewers cannot draw the variable web font.
  const fonts = join(ctx.config.INSTALL_DIR, 'apps/api/assets/fonts');
  try {
    if (!existsSync(join(fonts, 'archivo-latin-400-normal.woff'))) throw new Error('no font');
    doc.registerFont('regular', join(fonts, 'archivo-latin-400-normal.woff'));
    doc.registerFont('bold', join(fonts, 'archivo-latin-700-normal.woff'));
  } catch {
    doc.registerFont('regular', 'Helvetica');
    doc.registerFont('bold', 'Helvetica-Bold');
  }
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = 50;
  const right = 545;
  // Header band
  doc.rect(0, 0, 595, 8).fill(KORAAL);
  drawLogo(doc, ctx, left, 40, 34);
  doc.font('bold').fontSize(24).fillColor(NACHT).text(w.invoice.toUpperCase(), 300, 40, { width: right - 300, align: 'right', characterSpacing: 1 });
  doc.font('regular').fontSize(10).fillColor(MUTED).text(inv.number, 300, 70, { width: right - 300, align: 'right' });

  // Seller (right) and buyer (left)
  const s = inv.seller;
  const sellerLines = [s.company, s.address, [s.postcode, s.city].filter(Boolean).join(' '), s.country, s.email, s.phone, s.website].filter(Boolean);
  doc.font('regular').fontSize(9).fillColor(MUTED).text(sellerLines.join('\n'), 330, 110, { width: right - 330, align: 'right', lineGap: 1.5 });

  const b = inv.buyer;
  doc.font('bold').fontSize(8).fillColor(MUTED).text(w.billTo.toUpperCase(), left, 110, { characterSpacing: 0.8 });
  const attn = b.company && b.name ? `${inv.locale === 'nl' ? 't.a.v.' : 'Attn.'} ${b.name}` : '';
  const buyerLines = [attn, b.address, [b.postcode, b.city].filter(Boolean).join(' '), b.country, b.email].filter(Boolean);
  doc.font('bold').fontSize(11).fillColor(NACHT).text(b.company || b.name, left, 124, { width: 260 });
  doc.font('regular').fontSize(9.5).fillColor(NACHT).text(buyerLines.join('\n'), left, doc.y + 2, { width: 260, lineGap: 1.5 });

  // Facts
  let y = Math.max(doc.y, 200) + 24;
  const facts: [string, string][] = [
    [w.number, inv.number],
    [w.date, date(inv.issuedAt)],
    [w.due, date(inv.dueAt)],
  ];
  if (inv.periodStart && inv.periodEnd) facts.push([w.period, `${date(inv.periodStart)} – ${date(new Date(inv.periodEnd.getTime() - 86400_000))}`]);
  if (b.reference) facts.push([w.reference, b.reference]);
  if (b.vatNumber) facts.push([w.customerVat, b.vatNumber]);
  doc.roundedRect(left, y, right - left, 18 + Math.ceil(facts.length / 3) * 34, 8).fill(WOLK);
  facts.forEach(([label, value], i) => {
    const fx = left + 14 + (i % 3) * 165;
    const fy = y + 12 + Math.floor(i / 3) * 34;
    doc.font('bold').fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), fx, fy, { width: 155, characterSpacing: 0.6 });
    doc.font('bold').fontSize(10).fillColor(NACHT).text(value, fx, fy + 11, { width: 155 });
  });
  y += 18 + Math.ceil(facts.length / 3) * 34 + 26;

  // Lines
  const cols = { desc: left, qty: 330, price: 390, amount: 470 };
  const header = (yy: number) => {
    doc.font('bold').fontSize(8).fillColor(MUTED);
    doc.text(w.description.toUpperCase(), cols.desc, yy, { characterSpacing: 0.6 });
    doc.text(w.qty.toUpperCase(), cols.qty, yy, { width: 50, align: 'right', characterSpacing: 0.6 });
    doc.text(w.price.toUpperCase(), cols.price, yy, { width: 70, align: 'right', characterSpacing: 0.6 });
    doc.text(w.amount.toUpperCase(), cols.amount, yy, { width: right - cols.amount, align: 'right', characterSpacing: 0.6 });
    doc.moveTo(left, yy + 14).lineTo(right, yy + 14).lineWidth(1).stroke(NACHT);
    return yy + 22;
  };
  y = header(y);
  for (const line of inv.lines) {
    const h = doc.font('regular').fontSize(10).heightOfString(line.description, { width: 270 });
    if (y + h > 700) {
      doc.addPage();
      y = header(60);
    }
    doc.fillColor(NACHT).text(line.description, cols.desc, y, { width: 270 });
    doc.text(String(line.quantity), cols.qty, y, { width: 50, align: 'right' });
    doc.text(money(line.unitCents), cols.price, y, { width: 70, align: 'right' });
    doc.text(money(line.amountCents), cols.amount, y, { width: right - cols.amount, align: 'right' });
    y += h + 8;
    doc.moveTo(left, y - 3).lineTo(right, y - 3).lineWidth(0.5).stroke(LINE);
  }

  // Totals
  y += 8;
  const row = (label: string, value: string, bold = false) => {
    doc.font(bold ? 'bold' : 'regular').fontSize(bold ? 12 : 10).fillColor(NACHT);
    doc.text(label, 330, y, { width: 130 });
    doc.text(value, 460, y, { width: right - 460, align: 'right' });
    y += bold ? 22 : 17;
  };
  row(w.subtotal, money(inv.subtotalCents));
  row(`${w.vat} ${inv.vatRate.toLocaleString(inv.locale === 'nl' ? 'nl-NL' : 'en-GB')}%`, money(inv.vatCents));
  doc.rect(330, y + 2, right - 330, 2).fill(KORAAL);
  y += 10;
  row(w.total, money(inv.totalCents), true);
  if (inv.vatScheme !== 'standard') {
    doc.font('regular').fontSize(8.5).fillColor(MUTED).text(inv.vatScheme === 'reverse_charge' ? w.reverse : w.export, 330, y, { width: right - 330 });
    y = doc.y + 6;
  }

  // Payment
  y = Math.max(y + 18, doc.y + 18);
  doc.font('regular').fontSize(10).fillColor(NACHT);
  if (inv.status === 'void') doc.font('bold').fillColor('#C23434').text(w.void, left, y, { width: right - left });
  else if (inv.status === 'paid' && inv.paidAt) doc.font('bold').fillColor('#1C8A57').text(w.paid(date(inv.paidAt)), left, y, { width: right - left });
  else {
    doc.text(w.payBy(money(inv.totalCents), date(inv.dueAt), [s.iban, s.bic ? `(BIC ${s.bic})` : ''].filter(Boolean).join(' '), inv.number), left, y, { width: right - left });
    if (inv.paymentUrl) {
      doc.moveDown(0.4).fillColor(MUTED).text(w.payOnline, { continued: true }).fillColor(KORAAL).text(` ${inv.paymentUrl}`, { link: inv.paymentUrl });
    }
  }
  if (inv.notes) doc.moveDown(0.8).font('regular').fontSize(9.5).fillColor(MUTED).text(inv.notes, left, doc.y, { width: right - left });

  // Footer
  const footer = [s.company, s.cocNumber ? `${w.coc} ${s.cocNumber}` : '', s.vatNumber ? `${w.vatNo} ${s.vatNumber}` : '', s.iban ? `IBAN ${s.iban}` : '']
    .filter(Boolean)
    .join('  ·  ');
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing below the bottom margin would start a new page.
    doc.page.margins.bottom = 0;
    doc.moveTo(left, 770).lineTo(right, 770).lineWidth(0.5).stroke(LINE);
    doc.font('regular').fontSize(8).fillColor(MUTED).text(footer, left, 778, { width: right - left, align: 'center', lineBreak: false });
    if (s.footer) doc.text(s.footer, left, 790, { width: right - left, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}
