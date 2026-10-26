import { badRequest } from '../../lib/errors.js';

/** Overridable for tests. */
const base = () => process.env.HRS_MOLLIE_API_URL ?? 'https://api.mollie.com/v2';

export interface MolliePayment {
  id: string;
  status: 'open' | 'pending' | 'authorized' | 'paid' | 'canceled' | 'expired' | 'failed';
  method: string | null;
  paidAt?: string;
  metadata?: { invoiceId?: string } | null;
  checkoutUrl: string | null;
}

async function call<T>(apiKey: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'user-agent': 'HostedRadioStation' },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw badRequest(`Mollie: ${(data.detail as string) ?? res.statusText}`);
  return data as T;
}

function toPayment(raw: Record<string, unknown>): MolliePayment {
  const links = raw._links as { checkout?: { href: string } } | undefined;
  return {
    id: raw.id as string,
    status: raw.status as MolliePayment['status'],
    method: (raw.method as string | null) ?? null,
    paidAt: raw.paidAt as string | undefined,
    metadata: raw.metadata as MolliePayment['metadata'],
    checkoutUrl: links?.checkout?.href ?? null,
  };
}

/** Mollie cannot call a webhook on a private address; payments are then checked when the customer comes back. */
export function publicWebhookUrl(publicUrl: string) {
  try {
    const host = new URL(publicUrl).hostname;
    if (host === 'localhost' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || !host.includes('.')) return undefined;
    return `${publicUrl.replace(/\/$/, '')}/api/billing/mollie/webhook`;
  } catch {
    return undefined;
  }
}

export async function createPayment(
  apiKey: string,
  p: { amountCents: number; currency: string; description: string; redirectUrl: string; webhookUrl?: string; invoiceId: string; locale: string },
) {
  const raw = await call<Record<string, unknown>>(apiKey, '/payments', {
    method: 'POST',
    body: {
      amount: { currency: p.currency, value: (p.amountCents / 100).toFixed(2) },
      description: p.description,
      redirectUrl: p.redirectUrl,
      webhookUrl: p.webhookUrl,
      locale: p.locale === 'nl' ? 'nl_NL' : 'en_GB',
      metadata: { invoiceId: p.invoiceId },
    },
  });
  return toPayment(raw);
}

export async function getPayment(apiKey: string, id: string) {
  if (!/^tr_[A-Za-z0-9]+$/.test(id)) throw badRequest('Unknown payment');
  return toPayment(await call<Record<string, unknown>>(apiKey, `/payments/${id}`));
}

/** Checks the key with a harmless call, for the settings page. */
export async function verifyKey(apiKey: string) {
  const raw = await call<{ _embedded?: { methods?: { id: string; description: string }[] } }>(apiKey, '/methods');
  return (raw._embedded?.methods ?? []).map((m) => m.description);
}
