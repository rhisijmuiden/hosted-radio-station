/**
 * Texts of the e-mails the platform sends, in English and Dutch. The layout (RHIS house style) lives in mail.ts.
 * Each template returns the subject, a title, paragraphs and an optional button.
 */
type Locale = 'en' | 'nl';
type Vars = Record<string, string>;

interface Template {
  subject: string;
  title: string;
  paragraphs: string[];
  action?: string;
}

const templates: Record<string, Record<Locale, Template>> = {
  reset: {
    en: {
      subject: 'Reset your password',
      title: 'Reset your password',
      paragraphs: [
        'Hello {{name}},',
        'Someone asked to reset the password of your Hosted Radio Station account. Use the button below to choose a new one. The link works for one hour.',
        'Did you not ask for this? Then you can ignore this e-mail; your password stays the same.',
      ],
      action: 'Choose a new password',
    },
    nl: {
      subject: 'Stel je wachtwoord opnieuw in',
      title: 'Stel je wachtwoord opnieuw in',
      paragraphs: [
        'Hallo {{name}},',
        'Er is gevraagd om het wachtwoord van je Hosted Radio Station-account opnieuw in te stellen. Kies met de knop hieronder een nieuw wachtwoord. De link werkt een uur.',
        'Heb je dit niet zelf gevraagd? Dan kun je deze e-mail negeren; je wachtwoord blijft hetzelfde.',
      ],
      action: 'Kies een nieuw wachtwoord',
    },
  },
  invite: {
    en: {
      subject: 'You have been invited to Hosted Radio Station',
      title: 'Welcome, {{name}}',
      paragraphs: [
        '{{inviter}} gave you access to {{where}}.',
        'Choose a password to activate your account. The link works for three days.',
        'Your sign-in address is {{email}}.',
      ],
      action: 'Activate your account',
    },
    nl: {
      subject: 'Je bent uitgenodigd voor Hosted Radio Station',
      title: 'Welkom, {{name}}',
      paragraphs: [
        '{{inviter}} heeft je toegang gegeven tot {{where}}.',
        'Kies een wachtwoord om je account te activeren. De link werkt drie dagen.',
        'Je logt in met {{email}}.',
      ],
      action: 'Activeer je account',
    },
  },
  backupFailed: {
    en: {
      subject: 'Backup failed: {{target}}',
      title: 'A backup failed',
      paragraphs: ['The {{kind}} backup to "{{target}}" failed at {{time}}.', 'Reason: {{message}}', 'Open the backups page for the full log.'],
      action: 'Open backups',
    },
    nl: {
      subject: 'Back-up mislukt: {{target}}',
      title: 'Een back-up is mislukt',
      paragraphs: ['De {{kind}} back-up naar "{{target}}" is mislukt om {{time}}.', 'Reden: {{message}}', 'Open de back-uppagina voor het volledige logboek.'],
      action: 'Open back-ups',
    },
  },
  backupSucceeded: {
    en: {
      subject: 'Backup completed: {{target}}',
      title: 'Backup completed',
      paragraphs: ['The {{kind}} backup to "{{target}}" finished at {{time}}.', '{{stats}}'],
      action: 'Open backups',
    },
    nl: {
      subject: 'Back-up voltooid: {{target}}',
      title: 'Back-up voltooid',
      paragraphs: ['De {{kind}} back-up naar "{{target}}" is klaar om {{time}}.', '{{stats}}'],
      action: 'Open back-ups',
    },
  },
  restoreFinished: {
    en: {
      subject: 'Restore {{state}}: {{target}}',
      title: 'Restore {{state}}',
      paragraphs: ['Restoring snapshot {{snapshot}} from "{{target}}" {{state}} at {{time}}.', '{{message}}'],
      action: 'Open the admin panel',
    },
    nl: {
      subject: 'Herstel {{state}}: {{target}}',
      title: 'Herstel {{state}}',
      paragraphs: ['Het terugzetten van snapshot {{snapshot}} vanaf "{{target}}" is {{state}} om {{time}}.', '{{message}}'],
      action: 'Open het beheerpaneel',
    },
  },
  welcome: {
    en: {
      subject: 'Welcome to {{product}}',
      title: 'Welcome, {{name}}',
      paragraphs: [
        'Your account for {{customer}} is ready, with the {{package}} package.',
        '{{trial}}',
        'Choose a password to sign in. The link works for three days; your sign-in address is {{email}}.',
        'In the panel you create your stations, connect your encoder and find your public page and player.',
      ],
      action: 'Choose your password',
    },
    nl: {
      subject: 'Welkom bij {{product}}',
      title: 'Welkom, {{name}}',
      paragraphs: [
        'Je account voor {{customer}} staat klaar, met het pakket {{package}}.',
        '{{trial}}',
        'Kies een wachtwoord om in te loggen. De link werkt drie dagen; je logt in met {{email}}.',
        'In het paneel maak je je stations aan, koppel je je encoder en vind je je publieke pagina en speler.',
      ],
      action: 'Kies je wachtwoord',
    },
  },
  invoice: {
    en: {
      subject: 'Invoice {{number}} from {{seller}}',
      title: 'Invoice {{number}}',
      paragraphs: [
        'Hello {{name}},',
        'Here is invoice {{number}} for {{customer}}, for {{amount}}. Please pay it before {{due}}. The invoice is attached as a PDF.',
        '{{payment}}',
      ],
      action: 'View and pay the invoice',
    },
    nl: {
      subject: 'Factuur {{number}} van {{seller}}',
      title: 'Factuur {{number}}',
      paragraphs: [
        'Hallo {{name}},',
        'Hierbij factuur {{number}} voor {{customer}}, voor {{amount}}. Graag betalen voor {{due}}. De factuur zit als PDF in de bijlage.',
        '{{payment}}',
      ],
      action: 'Bekijk en betaal de factuur',
    },
  },
  invoiceReminder: {
    en: {
      subject: 'Reminder: invoice {{number}} is overdue',
      title: 'Payment reminder',
      paragraphs: [
        'Hello {{name}},',
        'We have not yet received payment of invoice {{number}} ({{amount}}), which was due on {{due}}.',
        '{{suspend}}',
        'Already paid? Then you can ignore this e-mail.',
      ],
      action: 'Pay the invoice',
    },
    nl: {
      subject: 'Herinnering: factuur {{number}} is verlopen',
      title: 'Betalingsherinnering',
      paragraphs: [
        'Hallo {{name}},',
        'We hebben de betaling van factuur {{number}} ({{amount}}) nog niet ontvangen. De vervaldatum was {{due}}.',
        '{{suspend}}',
        'Al betaald? Dan kun je deze e-mail negeren.',
      ],
      action: 'Betaal de factuur',
    },
  },
  suspended: {
    en: {
      subject: 'Your stations are off the air',
      title: 'Account suspended',
      paragraphs: [
        'Hello {{name}},',
        'Because invoice {{number}} ({{amount}}) is still unpaid, the stations of {{customer}} have been taken off the air.',
        'As soon as the invoice is paid, everything comes back on by itself.',
      ],
      action: 'Pay the invoice',
    },
    nl: {
      subject: 'Je stations zijn uit de lucht',
      title: 'Account geblokkeerd',
      paragraphs: [
        'Hallo {{name}},',
        'Omdat factuur {{number}} ({{amount}}) nog niet betaald is, zijn de stations van {{customer}} uit de lucht gehaald.',
        'Zodra de factuur betaald is, gaat alles vanzelf weer aan.',
      ],
      action: 'Betaal de factuur',
    },
  },
  paymentReceived: {
    en: {
      subject: 'Payment received for invoice {{number}}',
      title: 'Thank you for your payment',
      paragraphs: ['Hello {{name}},', 'We received {{amount}} for invoice {{number}}.', '{{resumed}}'],
      action: 'Open the panel',
    },
    nl: {
      subject: 'Betaling ontvangen voor factuur {{number}}',
      title: 'Bedankt voor je betaling',
      paragraphs: ['Hallo {{name}},', 'We hebben {{amount}} ontvangen voor factuur {{number}}.', '{{resumed}}'],
      action: 'Open het paneel',
    },
  },
};

export const emailWords: Record<Locale, Record<string, string>> = {
  en: {
    full: 'full',
    incremental: 'incremental',
    succeeded: 'completed',
    failed: 'failed',
    trial: 'You can try everything free of charge until {{date}}.',
    payOnline: 'You can pay online with the button below, or by bank transfer to {{iban}} stating {{number}}.',
    payTransfer: 'Please transfer the amount to {{iban}} stating {{number}}.',
    suspendWarning: 'If the invoice stays unpaid, your stations will go off the air on {{date}}.',
    resumed: 'Your stations are back on the air.',
  },
  nl: {
    full: 'volledige',
    incremental: 'incrementele',
    succeeded: 'voltooid',
    failed: 'mislukt',
    trial: 'Je kunt alles gratis proberen tot {{date}}.',
    payOnline: 'Je kunt online betalen met de knop hieronder, of overmaken naar {{iban}} onder vermelding van {{number}}.',
    payTransfer: 'Maak het bedrag over naar {{iban}} onder vermelding van {{number}}.',
    suspendWarning: 'Blijft de factuur onbetaald, dan gaan je stations op {{date}} uit de lucht.',
    resumed: 'Je stations zijn weer in de lucht.',
  },
};

export const fill = (text: string, vars: Vars) => text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');

export function emailLocale(locale: string | null | undefined): Locale {
  return locale === 'nl' ? 'nl' : 'en';
}

export function renderTemplate(name: keyof typeof templates, locale: string | null | undefined, vars: Vars, url?: string) {
  const t = templates[name]![emailLocale(locale)];
  return {
    subject: fill(t.subject, vars),
    title: fill(t.title, vars),
    paragraphs: t.paragraphs.map((p) => fill(p, vars)).filter((p) => p.trim() !== ''),
    action: t.action && url ? { label: fill(t.action, vars), url } : undefined,
  };
}
