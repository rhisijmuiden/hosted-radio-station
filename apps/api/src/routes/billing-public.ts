import { and, asc, eq } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '../db/index.js';
import { checkInvoiceToken, invoicePayUrl, invoiceToken, startPayment, syncMolliePayment, type Invoice } from '../services/billing/engine.js';
import { formatDate, formatMoney } from '../services/billing/money.js';
import { renderInvoicePdf } from '../services/billing/pdf.js';
import { getSetting } from '../services/settings.js';

const localized = z.object({ en: z.string(), nl: z.string() });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const pageWords = {
  en: { invoice: 'Invoice', open: 'Open', overdue: 'Overdue', paid: 'Paid', void: 'Cancelled', due: 'Due', total: 'Total incl. VAT', subtotal: 'Subtotal', vat: 'VAT', reverse: 'VAT reverse-charged', export: 'Outside the EU, no VAT', pdf: 'Download PDF', pay: 'Pay online', thanks: 'Thank you, your payment has been received.', pending: 'Your payment is not complete yet. You can try again.', issued: 'Issued' },
  nl: { invoice: 'Factuur', open: 'Openstaand', overdue: 'Verlopen', paid: 'Betaald', void: 'Geannuleerd', due: 'Vervalt', total: 'Totaal incl. btw', subtotal: 'Subtotaal', vat: 'Btw', reverse: 'Btw verlegd', export: 'Buiten de EU, geen btw', pdf: 'Download PDF', pay: 'Online betalen', thanks: 'Bedankt, je betaling is ontvangen.', pending: 'Je betaling is nog niet afgerond. Je kunt het opnieuw proberen.', issued: 'Datum' },
};

/** A small page in the RHIS house style for an invoice link from an e-mail: status, amount, PDF and pay button. */
function invoicePage(inv: Invoice, pdfUrl: string, payUrl: string | null, notice: 'paid' | 'pending' | null) {
  const w = pageWords[inv.locale === 'nl' ? 'nl' : 'en'];
  const money = (c: number) => formatMoney(c, inv.currency, inv.locale);
  const overdue = inv.status === 'open' && inv.dueAt < new Date();
  const [label, tone] =
    inv.status === 'paid' ? [w.paid, '#1C8A57'] : inv.status === 'void' ? [w.void, '#4F5B73'] : overdue ? [w.overdue, '#C23434'] : [w.open, '#A86B00'];
  const rows = inv.lines
    .map((l) => `<tr><td>${esc(l.description)}</td><td class="r">${esc(money(l.amountCents))}</td></tr>`)
    .join('');
  const banner = notice ? `<p class="notice ${notice}">${notice === 'paid' ? w.thanks : w.pending}</p>` : '';
  return `<!doctype html><html lang="${inv.locale === 'nl' ? 'nl' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(`${w.invoice} ${inv.number}`)}</title><link rel="icon" href="/brand/favicon.svg">
<style>
@font-face{font-family:Archivo;src:url(/brand/archivo-latin.woff2) format("woff2");font-weight:100 900;font-stretch:62% 125%}
:root{--bg:#F6F7FB;--card:#fff;--ink:#14213D;--muted:#4F5B73;--line:#DCE1EB}
@media (prefers-color-scheme:dark){:root{--bg:#0E1626;--card:#16213A;--ink:#EEF1F7;--muted:#A3AEC4;--line:#26324D}.logo-l{display:none}.logo-d{display:block!important}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 Archivo,system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:40px 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.top{height:6px;background:#FF6B57}.body{padding:24px}h1{font-stretch:125%;font-weight:800;font-size:24px;margin:16px 0 4px}
.badge{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:700;color:#fff;background:${tone}}
.muted{color:var(--muted);font-size:13px}table{width:100%;border-collapse:collapse;margin:20px 0}td{padding:8px 0;border-bottom:1px solid var(--line);vertical-align:top}
.r{text-align:right;white-space:nowrap;padding-left:12px}.sub td{color:var(--muted);font-size:14px;padding:4px 0;border:0}.total td{border:0;font-weight:800;font-size:18px;padding-top:12px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}a.btn{display:inline-flex;align-items:center;height:42px;padding:0 18px;border-radius:10px;font-weight:700;text-decoration:none}
.primary{background:#FF6B57;color:#14213D}.secondary{border:1px solid var(--line);color:var(--ink)}
.notice{border-radius:10px;padding:10px 14px;margin:0 0 16px;font-weight:600}.notice.paid{background:#1C8A5722;color:#1C8A57}.notice.pending{background:#A86B0022;color:#A86B00}
footer{margin-top:20px;text-align:center;font-size:12px;color:var(--muted)}footer a{color:inherit}
</style></head><body><main>${banner}<div class="card"><div class="top"></div><div class="body">
<img class="logo-l" src="/brand/rhis-logo.svg" alt="RHIS" height="26"><img class="logo-d" src="/brand/rhis-logo-wit.svg" alt="RHIS" height="26" style="display:none">
<h1>${esc(w.invoice)} ${esc(inv.number)}</h1>
<p><span class="badge">${esc(label)}</span> <span class="muted">${esc(inv.seller.company)} · ${esc(w.issued)} ${esc(formatDate(inv.issuedAt, inv.locale))} · ${esc(w.due)} ${esc(formatDate(inv.dueAt, inv.locale))}</span></p>
<table>${rows}<tr class="sub"><td>${esc(w.subtotal)}</td><td class="r">${esc(money(inv.subtotalCents))}</td></tr><tr class="sub"><td>${esc(inv.vatScheme === 'reverse_charge' ? w.reverse : inv.vatScheme === 'export' ? w.export : `${w.vat} ${inv.vatRate}%`)}</td><td class="r">${esc(money(inv.vatCents))}</td></tr><tr class="total"><td>${esc(w.total)}</td><td class="r">${esc(money(inv.totalCents))}</td></tr></table>
<div class="actions">${payUrl ? `<a class="btn primary" href="${esc(payUrl)}">${esc(w.pay)}</a>` : ''}<a class="btn secondary" href="${esc(pdfUrl)}">${esc(w.pdf)}</a></div>
</div></div><footer>Powered by <a href="https://rhis.nl">RHIS</a></footer></main></body></html>`;
}

/** Public: the package list for the website's pricing page, and invoice links that work without signing in. */
export const billingPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  const { ctx } = app;

  app.get(
    '/packages',
    {
      schema: {
        tags: ['Public'],
        summary: 'Packages for a pricing page: limits and prices without VAT (and the VAT rate to add)',
        response: {
          200: z.object({
            vatRate: z.number(),
            packages: z.array(
              z.object({
                code: z.string(),
                name: z.string(),
                edition: z.enum(['distribution', 'station']),
                description: localized,
                features: z.array(localized),
                limits: z.object({ maxStations: z.number(), maxRadioStations: z.number(), maxListeners: z.number(), maxBitrateKbps: z.number(), storageQuotaMb: z.number(), maxNodes: z.number() }),
                currency: z.string(),
                priceMonthCents: z.number().int(),
                priceYearCents: z.number().int().nullable(),
                setupFeeCents: z.number().int(),
                trialDays: z.number().int(),
              }),
            ),
          }),
        },
      },
    },
    async (_req, reply) => {
      const rows = await ctx.db
        .select()
        .from(schema.packages)
        .where(and(eq(schema.packages.public, true), eq(schema.packages.active, true)))
        .orderBy(asc(schema.packages.sortOrder), asc(schema.packages.priceMonthCents));
      const s = await getSetting(ctx, 'billing');
      reply.header('cache-control', 'public, max-age=300').header('access-control-allow-origin', '*');
      return { vatRate: s.vatRate, packages: rows };
    },
  );

  const params = z.object({ id: z.uuid() });
  const query = z.object({ t: z.string().max(64).optional(), status: z.enum(['paid', 'pending']).optional() });

  async function load(id: string, t: string | undefined) {
    if (!checkInvoiceToken(ctx, id, t)) return null;
    const [inv] = await ctx.db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
    return inv ?? null;
  }
  const notFoundPage = (reply: FastifyReply) => reply.status(404).type('text/plain; charset=utf-8').send('Invoice not found');

  app.get('/invoices/:id', { schema: { hide: true, params, querystring: query } }, async (req, reply) => {
    const inv = await load(req.params.id, req.query.t);
    if (!inv) return notFoundPage(reply);
    const t = invoiceToken(ctx, inv.id);
    const s = await getSetting(ctx, 'billing');
    const pay = inv.status === 'open' && s.mollie.enabled && !!s.mollie.apiKey ? invoicePayUrl(ctx, inv.id) : null;
    return reply
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .type('text/html; charset=utf-8')
      .send(invoicePage(inv, `/api/public/invoices/${inv.id}/pdf?t=${t}`, pay, req.query.status ?? null));
  });

  app.get('/invoices/:id/pdf', { schema: { hide: true, params, querystring: query } }, async (req, reply) => {
    const inv = await load(req.params.id, req.query.t);
    if (!inv) return notFoundPage(reply);
    const pdf = await renderInvoicePdf(ctx, inv);
    return reply.header('cache-control', 'no-store').header('content-disposition', `inline; filename="${inv.number}.pdf"`).type('application/pdf').send(pdf);
  });

  app.get('/invoices/:id/pay', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { hide: true, params, querystring: query } }, async (req, reply) => {
    const inv = await load(req.params.id, req.query.t);
    if (!inv) return notFoundPage(reply);
    const page = `/api/public/invoices/${inv.id}?t=${invoiceToken(ctx, inv.id)}`;
    if (inv.status !== 'open') return reply.redirect(page);
    try {
      return reply.redirect(await startPayment(ctx, inv));
    } catch (err) {
      req.log.warn({ err }, 'starting a payment failed');
      return reply.redirect(`${page}&status=pending`);
    }
  });

  // Mollie sends the customer back here; the payment is checked right away, so it also works without the webhook.
  app.get('/invoices/:id/return', { schema: { hide: true, params, querystring: query } }, async (req, reply) => {
    let inv = await load(req.params.id, req.query.t);
    if (!inv) return notFoundPage(reply);
    if (inv.status === 'open' && inv.molliePaymentId) inv = (await syncMolliePayment(ctx, inv.molliePaymentId).catch(() => null)) ?? inv;
    return reply.redirect(`/api/public/invoices/${inv.id}?t=${invoiceToken(ctx, inv.id)}&status=${inv.status === 'paid' ? 'paid' : 'pending'}`);
  });
};
