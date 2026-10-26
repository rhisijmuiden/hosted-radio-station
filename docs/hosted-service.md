# Hosted service: packages, billing and the provisioning API

Phase 10 adds the commercial layer: packages you sell, subscriptions per customer, invoices with VAT, online payment
with Mollie, reminders and automatic suspension, and an API that lets the RHIS website create customers by itself.

Everything is under **Hosted service** in the left menu (Overview, Packages, Invoices). The settings are under
**Administration → Billing** and **Administration → Webhooks**.

## Packages

A package is an edition (**Distribution** or **Radio station**) with limits (stations, listeners, bitrate, storage,
own nodes), a monthly and a yearly price (excl. VAT), an optional setup fee and trial period, and a list of features
for the website. Hidden packages can still be sold through the API, for example a partner deal.

When you change a package you can apply the new limits to every customer on it right away. A customer with custom
limits keeps them.

## Subscriptions

Start a subscription from a customer's page (**Customers → customer → Subscription**), or let the website do it through
the API. A subscription is in one of these states:

| State | Meaning |
| --- | --- |
| Trial | Runs until the trial ends, then the first invoice is made. |
| Active | Renews every month or year, with an invoice at the start of each period. |
| Past due | An invoice is past its due date. A reminder is sent after *Reminder after* days. |
| Suspended | Unpaid for *Off the air after* days: the customer is switched off and its streams stop. Paying the invoice puts it back on the air. |
| Cancelled | Ends at the end of the period, or right away. |

Upgrades take effect immediately, with a prorated invoice for the rest of the period. Downgrades and a switch between
monthly and yearly take effect at the end of the period. You can give a customer a custom price or a discount.

Customers see their package, their invoices and an **Upgrade/Change package** button under **Subscription** in their own
panel.

## Invoices and VAT

Invoices are numbered per year (`<prefix><year>-0001`), come with a PDF in the RHIS house style, and are e-mailed with
a link to a small invoice page where the customer can pay online or download the PDF.

- Dutch customers and consumers in the EU: the VAT rate from the settings (21% by default).
- Business customers elsewhere in the EU with a VAT number: VAT reverse-charged (0%), when enabled in the settings.
- Customers outside the EU: no VAT.

You can also make a manual invoice, mark an invoice as paid (bank transfer), resend it, or cancel it.

## Online payment (Mollie)

Enter a Mollie API key (`live_` or `test_`) under **Administration → Billing** and turn on online payment. Mollie
reports payments to `/api/billing/mollie/webhook` on the public address of the panel. Without a public address the
payment is checked when the customer returns from Mollie.

## Provisioning API

The website talks to `/api/provisioning` with an API key of the scope **Provisioning** (**Administration → API keys**,
superadmins only). Such a key can only reach the provisioning and public endpoints. The full reference is in the API
documentation at `/api/docs`.

```http
POST /api/provisioning/signup
Authorization: Bearer hrs_...
Idempotency-Key: order-10023
Content-Type: application/json

{
  "package": "radio-basic",
  "interval": "month",
  "customer": { "name": "Harder.fm", "externalRef": "order-10023" },
  "owner": { "email": "info@harder.fm", "name": "Jan", "locale": "nl" },
  "billing": { "company": "Harder.fm BV", "address": "Straat 1", "postcode": "1234 AB", "city": "Haarlem", "country": "NL", "vatNumber": "NL123456789B01" },
  "station": { "name": "Harder.fm" }
}
```

The answer has the new customer, subscription, owner and station, and the panel address. The owner gets a welcome
e-mail with an activation link (or set `"sendWelcome": false` and use `activationUrl` from the answer). Sending the
same `Idempotency-Key` again returns the first answer, so a retry never creates a customer twice.

| Endpoint | What it does |
| --- | --- |
| `GET /api/public/packages` | Public packages with prices, for the pricing page (no key needed). |
| `GET /api/provisioning/packages` | All packages, also hidden ones. |
| `POST /api/provisioning/signup` | Create a customer, owner, subscription and optional first station. |
| `GET /api/provisioning/customers?externalRef=…` or `?email=…` | Find a customer. |
| `GET /api/provisioning/customers/:id` | Customer with subscription. |
| `GET /api/provisioning/customers/:id/invoices` | The customer's invoices. |
| `POST /api/provisioning/customers/:id/change` | Change package or interval. |
| `POST /api/provisioning/customers/:id/cancel` | Cancel at the end of the period, or `{"immediate": true}`. |
| `POST /api/provisioning/customers/:id/resume` | Undo a cancellation. |

## Webhooks

Under **Administration → Webhooks** you add endpoints that get a `POST` for events: `customer.created`,
`subscription.created`, `subscription.updated`, `subscription.cancelled`, `subscription.suspended`,
`subscription.resumed`, `invoice.created`, `invoice.paid` and `invoice.overdue`. Failed calls are retried after 1, 5,
30, 120, 360 and 1440 minutes.

The body is `{ "id", "event", "createdAt", "data" }`. Check every call:

```
X-HRS-Event: invoice.paid
X-HRS-Delivery: <delivery id>
X-HRS-Signature: t=1793000000,v1=<hex>
```

`v1` is `HMAC-SHA256(secret, t + "." + raw body)` in hex. Refuse the call when the signature does not match or `t` is
more than five minutes old. Example in Node.js:

```js
const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) && Date.now() / 1000 - Number(t) < 300;
```
