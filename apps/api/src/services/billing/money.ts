import type { schema } from '../../db/index.js';
import type { BillingSettings } from '../settings.js';

type Package = typeof schema.packages.$inferSelect;
type Subscription = typeof schema.subscriptions.$inferSelect;
export type Interval = 'month' | 'year';

const EU = new Set('AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK'.split(' '));
export const isEu = (country: string) => EU.has(country.toUpperCase());

/** Adds whole months in UTC; the 31st becomes the last day of a shorter month. */
export function addMonths(date: Date, months: number) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export const addInterval = (date: Date, interval: Interval) => addMonths(date, interval === 'year' ? 12 : 1);
export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86400_000);

/** Package price for one interval without VAT. A package without a yearly price costs twelve months a year. */
export function packagePrice(pkg: Package, interval: Interval) {
  return interval === 'year' ? (pkg.priceYearCents ?? pkg.priceMonthCents * 12) : pkg.priceMonthCents;
}

/** What the customer pays per interval before discount: the agreed price, or the package price. */
export function basePrice(sub: Pick<Subscription, 'customPriceCents'>, pkg: Package, interval: Interval) {
  return sub.customPriceCents ?? packagePrice(pkg, interval);
}

/** Price per month, used to compare packages (upgrade or downgrade) and for the monthly recurring revenue. */
export function monthlyValue(sub: Pick<Subscription, 'customPriceCents' | 'discountPercent' | 'interval'>, pkg: Package) {
  const price = basePrice(sub, pkg, sub.interval);
  const net = Math.round(price * (1 - sub.discountPercent / 100));
  return sub.interval === 'year' ? Math.round(net / 12) : net;
}

export interface VatResult {
  rate: number;
  scheme: 'standard' | 'reverse_charge' | 'export';
}

/**
 * VAT for a buyer. Same country as the seller, or an EU consumer: the standard rate. An EU business with a VAT number in
 * another country: reverse charged (0%). Outside the EU: no Dutch VAT on services (0%).
 */
export function vatFor(settings: BillingSettings, buyer: { country: string; vatNumber: string }): VatResult {
  const seller = settings.company.country.toUpperCase();
  const country = (buyer.country || seller).toUpperCase();
  if (country === seller) return { rate: settings.vatRate, scheme: 'standard' };
  if (isEu(country)) {
    if (settings.reverseCharge && buyer.vatNumber.trim()) return { rate: 0, scheme: 'reverse_charge' };
    return { rate: settings.vatRate, scheme: 'standard' };
  }
  return { rate: 0, scheme: 'export' };
}

export function totals(lines: { amountCents: number }[], vatRate: number) {
  const subtotalCents = lines.reduce((n, l) => n + l.amountCents, 0);
  const vatCents = Math.round((subtotalCents * vatRate) / 100);
  return { subtotalCents, vatCents, totalCents: subtotalCents + vatCents };
}

export function formatMoney(cents: number, currency: string, locale: string) {
  return new Intl.NumberFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', { style: 'currency', currency }).format(cents / 100);
}

export function formatDate(date: Date, locale: string) {
  return new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' }).format(date);
}
