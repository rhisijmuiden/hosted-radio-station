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
};

export const emailWords: Record<Locale, Record<string, string>> = {
  en: { full: 'full', incremental: 'incremental', succeeded: 'completed', failed: 'failed' },
  nl: { full: 'volledige', incremental: 'incrementele', succeeded: 'voltooid', failed: 'mislukt' },
};

const fill = (text: string, vars: Vars) => text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');

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
