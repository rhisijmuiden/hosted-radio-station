import { z } from 'zod';
import type { Station } from '../streaming/state.js';

const urlOrEmpty = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === '' || /^https?:\/\/\S+$/.test(v), 'Use a full address starting with http:// or https://');

export const LINK_KINDS = ['instagram', 'facebook', 'x', 'tiktok', 'youtube', 'soundcloud', 'mixcloud', 'whatsapp'] as const;

/** What listeners see of a station: the public page, widgets, song requests, on-demand and recordings. */
export const publicPageSchema = z.object({
  /** Public page, widgets and the public API of this station. The listen URLs keep working when off. */
  enabled: z.boolean().default(true),
  showListeners: z.boolean().default(true),
  showHistory: z.boolean().default(true),
  historyCount: z.number().int().min(1).max(50).default(15),
  /** Look up album art for titles (iTunes Search); found images are cached on this server. */
  artwork: z.boolean().default(true),
  accentColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #FF6B57')
    .default('#FF6B57'),
  theme: z.enum(['auto', 'light', 'dark']).default('auto'),
  links: z
    .object({
      instagram: urlOrEmpty.default(''),
      facebook: urlOrEmpty.default(''),
      x: urlOrEmpty.default(''),
      tiktok: urlOrEmpty.default(''),
      youtube: urlOrEmpty.default(''),
      soundcloud: urlOrEmpty.default(''),
      mixcloud: urlOrEmpty.default(''),
      whatsapp: urlOrEmpty.default(''),
    })
    .default({ instagram: '', facebook: '', x: '', tiktok: '', youtube: '', soundcloud: '', mixcloud: '', whatsapp: '' }),
  requests: z
    .object({
      enabled: z.boolean().default(false),
      /** Only take requests while a DJ is on air. */
      onlyWhenLive: z.boolean().default(true),
      /** Requests one listener may send per hour. */
      perHour: z.number().int().min(1).max(30).default(3),
      /** Shown above the request form. */
      message: z.string().trim().max(300).default(''),
    })
    .default({ enabled: false, onlyWhenLive: true, perHour: 3, message: '' }),
  onDemand: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  recording: z
    .object({
      /** Record every live broadcast into the media folder (counts towards the storage limit). */
      enabled: z.boolean().default(false),
      /** Put recordings on the public page right away instead of as a draft. */
      autoPublish: z.boolean().default(false),
      /** Remove recordings that are not published after this many days. 0 = keep. */
      keepDays: z.number().int().min(0).max(3650).default(30),
      /** Recordings shorter than this are thrown away (a DJ testing the connection). */
      minMinutes: z.number().int().min(0).max(120).default(5),
    })
    .default({ enabled: false, autoPublish: false, keepDays: 30, minMinutes: 5 }),
});
export type PublicPageSettings = z.infer<typeof publicPageSchema>;

/** The station's public settings with defaults for everything that was never set. */
export function publicSettings(station: Pick<Station, 'publicPage'>): PublicPageSettings {
  const parsed = publicPageSchema.safeParse(station.publicPage ?? {});
  return parsed.success ? parsed.data : publicPageSchema.parse({});
}
