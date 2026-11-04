import { z } from 'zod';
import type { schema } from '../db/index.js';
import { NODE_ROLES, type NodeRole } from '../db/schema.js';
import { forbidden } from './errors.js';

export const LOCALES = ['en', 'nl'] as const;

export const idParam = z.object({ id: z.uuid() });
export const errorOut = z.object({ error: z.object({ code: z.string(), message: z.string(), field: z.string().optional() }) });
export const okOut = z.object({ ok: z.literal(true) });

export const tenantLimitsSchema = z.object({
  maxStations: z.number().int().min(0).max(1000).default(1),
  /**
   * Of those, how many may be a Radio station (AutoDJ). 0 = Distribution only. Left out (older API clients): all of
   * them, or none with the old edition "distribution" (see withRadioLimit).
   */
  maxRadioStations: z.number().int().min(0).max(1000).optional(),
  maxListeners: z.number().int().min(0).max(1_000_000).default(100),
  maxBitrateKbps: z.number().int().min(32).max(512).default(192),
  storageQuotaMb: z.number().int().min(0).max(10_000_000).default(10_240),
  maxNodes: z.number().int().min(0).max(100).default(0),
  /**
   * Roles the customer may give its own nodes (customer navigation). Left out (customers from before this setting):
   * every role, so nothing they run stops working. New customers start with a station node only.
   */
  nodeRoles: z.array(z.enum(NODE_ROLES)).optional(),
  /** What the customer may do itself (customer permissions); left out = allowed. Administrators can always. */
  mayRoute: z.boolean().optional(),
  mayCreateStations: z.boolean().optional(),
  maySwitchEdition: z.boolean().optional(),
});

/** Permission keys kept in the limits; a client that leaves them out keeps what is set. */
export const PERMISSION_KEYS = ['nodeRoles', 'mayRoute', 'mayCreateStations', 'maySwitchEdition'] as const;

/** Throws unless the customer may do this itself (left out = allowed); administrators always may. */
export function assertPermitted(limits: { mayRoute?: boolean; mayCreateStations?: boolean; maySwitchEdition?: boolean }, key: 'mayRoute' | 'mayCreateStations' | 'maySwitchEdition', role: string) {
  if (role === 'superadmin' || limits[key] !== false) return;
  const what = { mayRoute: 'change the routing or placement of stations', mayCreateStations: 'create stations', maySwitchEdition: 'switch a station between Distribution and Radio station' }[key];
  throw forbidden(`Your package does not let you ${what}; ask your provider`);
}

/** The roles a customer may give its own nodes; every role when the limit was never set. */
export function allowedNodeRoles(limits: { nodeRoles?: NodeRole[] | null }): NodeRole[] {
  return limits.nodeRoles ? [...limits.nodeRoles] : [...NODE_ROLES];
}

/** Limits as stored: the number of Radio stations filled in from the old edition when a client left it out. */
export function withRadioLimit(limits: z.infer<typeof tenantLimitsSchema>, edition?: 'distribution' | 'station'): z.infer<typeof tenantLimitsSchema> & { maxRadioStations: number } {
  return { ...limits, maxRadioStations: limits.maxRadioStations ?? (edition === 'distribution' ? 0 : limits.maxStations) };
}

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
  /** Station node where new stations of this customer start (phase 12). */
  stationNodeId: z.uuid().nullable(),
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
