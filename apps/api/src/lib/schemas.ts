import { z } from 'zod';
import type { schema } from '../db/index.js';

export const LOCALES = ['en', 'nl'] as const;

export const idParam = z.object({ id: z.uuid() });
export const errorOut = z.object({ error: z.object({ code: z.string(), message: z.string(), field: z.string().optional() }) });
export const okOut = z.object({ ok: z.literal(true) });

export const tenantLimitsSchema = z.object({
  maxStations: z.number().int().min(0).max(1000).default(1),
  maxListeners: z.number().int().min(0).max(1_000_000).default(100),
  maxBitrateKbps: z.number().int().min(32).max(512).default(192),
  storageQuotaMb: z.number().int().min(0).max(10_000_000).default(10_240),
});

export const roleSchema = z.enum(['owner', 'manager', 'dj']);
export const planSchema = z.enum(['distribution', 'station']);

export const userOut = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  isSuperadmin: z.boolean(),
  locale: z.string(),
  active: z.boolean(),
  lastLoginAt: z.date().nullable(),
  createdAt: z.date(),
});

export const tenantOut = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  plan: planSchema,
  limits: tenantLimitsSchema,
  active: z.boolean(),
  externalRef: z.string().nullable(),
  createdAt: z.date(),
});

export const passwordSchema = z.string().min(10, 'Use at least 10 characters').max(200);
export const emailSchema = z.email().trim().toLowerCase();
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/, 'Use lowercase letters, digits and dashes');

export function toUserOut(u: typeof schema.users.$inferSelect): z.infer<typeof userOut> {
  const { passwordHash: _ignored, ...rest } = u;
  return rest;
}
