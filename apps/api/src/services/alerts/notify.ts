import type { AppContext } from '../../lib/context.js';
import { badRequest } from '../../lib/errors.js';
import { emitEvent } from '../billing/webhooks.js';
import { sendMail } from '../mail.js';
import { getSetting, type AlertKind, type AlertSettings } from '../settings.js';

/** An alert as it goes out: in a message, by e-mail, Telegram and the alert.* webhooks. */
export interface AlertNotice {
  id: string;
  kind: AlertKind;
  severity: 'critical' | 'warning';
  params: Record<string, string>;
  message: string | null;
  openedAt: Date;
  resolvedAt: Date | null;
  nodeId: string | null;
  stationId: string | null;
}

type Lang = AlertSettings['language'];

const TITLES: Record<Lang, Record<AlertKind, string>> = {
  en: {
    node_offline: 'Node {node} is offline',
    node_problem: 'Node {node} reports a problem',
    station_off_air: '{station} is off air',
    station_silent: '{station} plays silence',
    stream_quality: '{station} {mount} does not sound as set',
    stream_down: '{station} does not play through {where}',
    feed_lost: '{node} lost the feed of {station}',
    updates_paused: 'Node updates are paused',
    dns_error: 'Cloudflare DNS fails',
  },
  nl: {
    node_offline: 'Node {node} is offline',
    node_problem: 'Node {node} meldt een probleem',
    station_off_air: '{station} is uit de lucht',
    station_silent: '{station} speelt stilte',
    stream_quality: '{station} {mount} klinkt niet zoals ingesteld',
    stream_down: '{station} speelt niet via {where}',
    feed_lost: '{node} heeft de feed van {station} verloren',
    updates_paused: 'Node-updates staan op pauze',
    dns_error: 'Cloudflare DNS geeft een fout',
  },
};

const WORDS = {
  en: { resolved: 'Solved', after: 'after {d}', since: 'since {t}', problems: '{n} problems', solvedN: '{n} problems solved', open: 'Open Monitoring', test: 'Test message from Hosted Radio Station', testBody: 'Alerts reach you here.' },
  nl: { resolved: 'Opgelost', after: 'na {d}', since: 'sinds {t}', problems: '{n} problemen', solvedN: '{n} problemen opgelost', open: 'Open Monitoring', test: 'Testbericht van Hosted Radio Station', testBody: 'Meldingen komen hier binnen.' },
} as const;

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? '');

export function alertTitle(a: Pick<AlertNotice, 'kind' | 'params'>, lang: Lang) {
  return fill(TITLES[lang][a.kind] ?? a.kind, a.params);
}

/** "4 min", "1 h 12 min", "2 d 3 h". */
export function duration(ms: number) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
}

/** The lines of one message: new problems first, then the solved ones. */
export function noticeLines(opened: AlertNotice[], resolved: AlertNotice[], lang: Lang, timeZone: string) {
  const w = WORDS[lang];
  const time = (d: Date) => d.toLocaleTimeString(lang === 'nl' ? 'nl-NL' : 'en-GB', { timeZone, hour: '2-digit', minute: '2-digit' });
  const lines: { icon: string; title: string; detail: string }[] = [];
  for (const a of opened) {
    lines.push({ icon: a.severity === 'critical' ? '🔴' : '🟠', title: alertTitle(a, lang), detail: [a.message, fill(w.since, { t: time(a.openedAt) })].filter(Boolean).join(' · ') });
  }
  for (const a of resolved) {
    lines.push({ icon: '✅', title: `${w.resolved}: ${alertTitle(a, lang)}`, detail: fill(w.after, { d: duration((a.resolvedAt ?? new Date()).getTime() - a.openedAt.getTime()) }) });
  }
  const subject =
    lines.length === 1 ? `${lines[0]!.icon} ${lines[0]!.title}` : opened.length ? `🔴 ${fill(w.problems, { n: String(opened.length) })}` : `✅ ${fill(w.solvedN, { n: String(resolved.length) })}`;
  return { subject, lines };
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

export async function sendTelegram(token: string, chatId: string, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!res.ok || !body?.ok) throw new Error(body?.description ?? `Telegram answered HTTP ${res.status}`);
}

/** The chats that wrote to the bot lately, so nobody has to look up a chat id by hand. */
export async function telegramChats(token: string) {
  const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates?allowed_updates=${encodeURIComponent('["message","channel_post","my_chat_member"]')}`, { signal: AbortSignal.timeout(10_000) });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string; result?: Record<string, any>[] } | null;
  if (!res.ok || !body?.ok) throw badRequest(body?.description ?? `Telegram answered HTTP ${res.status}`);
  const chats = new Map<string, { id: string; name: string; type: string }>();
  for (const u of body.result ?? []) {
    const chat = (u.message ?? u.channel_post ?? u.my_chat_member)?.chat;
    if (!chat?.id) continue;
    const name = chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id));
    chats.set(String(chat.id), { id: String(chat.id), name: String(name).slice(0, 100), type: String(chat.type ?? '') });
  }
  return [...chats.values()];
}

export interface DeliveryResult {
  channel: 'email' | 'telegram';
  ok: boolean;
  error: string | null;
}

/** Sends one message about these alerts to every channel that is on. Webhooks get one event per alert. */
export async function deliver(ctx: AppContext, settings: AlertSettings, opened: AlertNotice[], resolved: AlertNotice[], opts: { test?: boolean } = {}): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  const { timezone } = (await getSetting(ctx, 'nodes')).updates;
  const lang = settings.language;
  const url = `${ctx.config.PUBLIC_URL.replace(/\/$/, '')}/monitoring`;
  const w = WORDS[lang];
  const { subject, lines } = opts.test ? { subject: w.test, lines: [{ icon: '✅', title: w.test, detail: w.testBody }] } : noticeLines(opened, resolved, lang, timezone);
  if (!lines.length) return results;

  if (settings.telegram.enabled && settings.telegram.botToken && settings.telegram.chatId) {
    const text = [...lines.map((l) => `${l.icon} <b>${esc(l.title)}</b>${l.detail ? `\n${esc(l.detail)}` : ''}`), '', `<a href="${esc(url)}">${esc(w.open)}</a>`].join('\n');
    try {
      await sendTelegram(settings.telegram.botToken, settings.telegram.chatId, text.slice(0, 4000));
      results.push({ channel: 'telegram', ok: true, error: null });
    } catch (err) {
      results.push({ channel: 'telegram', ok: false, error: (err as Error).message.slice(0, 300) });
    }
  }
  if (settings.email.enabled && settings.email.to.length) {
    const paragraphs = lines.map((l) => `${l.icon} ${l.title}${l.detail ? ` (${l.detail})` : ''}`);
    try {
      for (const to of settings.email.to) await sendMail(ctx, { to, subject, title: opts.test ? w.test : subject.replace(/^\S+\s/, ''), paragraphs, action: { label: w.open, url } });
      results.push({ channel: 'email', ok: true, error: null });
    } catch (err) {
      results.push({ channel: 'email', ok: false, error: (err as Error).message.slice(0, 300) });
    }
  }
  if (!opts.test) {
    const ref = (a: AlertNotice) => ({ id: a.id, kind: a.kind, severity: a.severity, title: alertTitle(a, 'en'), message: a.message, nodeId: a.nodeId, stationId: a.stationId, params: a.params, openedAt: a.openedAt.toISOString(), resolvedAt: a.resolvedAt?.toISOString() ?? null });
    for (const a of opened) await emitEvent(ctx, 'alert.opened', { alert: ref(a) }).catch(() => undefined);
    for (const a of resolved) await emitEvent(ctx, 'alert.resolved', { alert: ref(a) }).catch(() => undefined);
  }
  return results;
}
