import nodemailer from 'nodemailer';
import type { AppContext } from '../lib/context.js';
import { badRequest } from '../lib/errors.js';
import { getSetting, type SmtpSettings } from './settings.js';

export function createTransport(smtp: SmtpSettings) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === 'tls',
    requireTLS: smtp.security === 'starttls',
    ignoreTLS: smtp.security === 'none',
    auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
    tls: { rejectUnauthorized: smtp.verifyCertificate, minVersion: 'TLSv1.2' },
    dkim: smtp.dkim.enabled
      ? { domainName: smtp.dkim.domain, keySelector: smtp.dkim.selector, privateKey: smtp.dkim.privateKey }
      : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** E-mail layout in the RHIS house style: night header, cloud background, coral accent. */
export function renderEmail(opts: { title: string; paragraphs: string[]; action?: { label: string; url: string } }) {
  const button = opts.action
    ? `<p style="margin:24px 0"><a href="${escape(opts.action.url)}" style="background:#FF6B57;color:#14213D;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;display:inline-block">${escape(opts.action.label)}</a></p>`
    : '';
  const body = opts.paragraphs.map((p) => `<p style="margin:0 0 12px">${escape(p)}</p>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#F6F7FB;font-family:Archivo,Arial,sans-serif;color:#14213D">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #DCE1EB">
<tr><td style="background:#14213D;padding:20px 28px;color:#FFFFFF;font-weight:800;font-size:18px;letter-spacing:.5px">Hosted Radio Station</td></tr>
<tr><td style="padding:28px"><h1 style="margin:0 0 16px;font-size:22px">${escape(opts.title)}</h1>${body}${button}</td></tr>
<tr><td style="padding:16px 28px;color:#4F5B73;font-size:12px;border-top:1px solid #DCE1EB">Hosted Radio Station &middot; Powered by <a href="https://rhis.nl" style="color:#4F5B73">RHIS</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = [opts.title, '', ...opts.paragraphs, ...(opts.action ? ['', `${opts.action.label}: ${opts.action.url}`] : [])].join('\n');
  return { html, text };
}

export async function sendMail(
  ctx: AppContext,
  msg: {
    to: string;
    subject: string;
    title: string;
    paragraphs: string[];
    action?: { label: string; url: string };
    bcc?: string;
    attachments?: { filename: string; content: Buffer; contentType: string }[];
  },
  smtpOverride?: SmtpSettings,
) {
  const smtp = smtpOverride ?? (await getSetting(ctx, 'smtp'));
  if (!smtpOverride && !smtp.enabled) throw badRequest('Outgoing mail is not configured');
  if (!smtp.host || !smtp.fromAddress) throw badRequest('SMTP host and sender address are required');
  const { html, text } = renderEmail(msg);
  const info = await createTransport(smtp).sendMail({
    from: { name: smtp.fromName, address: smtp.fromAddress },
    replyTo: smtp.replyTo || undefined,
    to: msg.to,
    bcc: msg.bcc || undefined,
    subject: msg.subject,
    html,
    text,
    attachments: msg.attachments,
  });
  return { messageId: info.messageId, response: info.response };
}

/** True when outgoing mail is switched on and complete, so features can offer e-mail (invitations, alerts). */
export async function mailConfigured(ctx: AppContext) {
  const smtp = await getSetting(ctx, 'smtp');
  return smtp.enabled && !!smtp.host && !!smtp.fromAddress;
}
