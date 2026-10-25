import {
  bigserial,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/**
 * Product variant a customer buys. `distribution` = streaming, live input and public pages only;
 * `station` adds the AutoDJ, queues and scheduler. Customers can upgrade from distribution to station.
 */
export const tenantPlan = pgEnum('tenant_plan', ['distribution', 'station']);
export const memberRole = pgEnum('member_role', ['owner', 'manager', 'dj']);

export interface TenantLimits {
  maxStations: number;
  maxListeners: number;
  maxBitrateKbps: number;
  storageQuotaMb: number;
}

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: tenantPlan('plan').notNull().default('station'),
  limits: jsonb('limits').$type<TenantLimits>().notNull(),
  active: boolean('active').notNull().default(true),
  /** Free-form reference to an external system, e.g. the customer id on the RHIS website. */
  externalRef: text('external_ref'),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  isSuperadmin: boolean('is_superadmin').notNull().default(false),
  locale: text('locale').notNull().default('en'),
  active: boolean('active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  'memberships',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tenantId] })],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(), // sha256 of the cookie token
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** When set, the key only works within this tenant. */
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    hash: text('hash').notNull(),
    readOnly: boolean('read_only').notNull().default(false),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_keys_hash_idx').on(t.hash)],
);

/** Instance-wide settings (SMTP, proxy, update channel, ...). Secrets inside are encrypted. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Who did what, when and from where. Written by the API for every change and every sign-in. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Kept when the user is deleted later. */
    actorEmail: text('actor_email'),
    via: text('via').notNull(), // session | api_key | sso | system
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    success: boolean('success').notNull().default(true),
    ip: text('ip'),
    userAgent: text('user_agent'),
    details: jsonb('details').$type<Record<string, unknown>>(),
  },
  (t) => [index('audit_log_at_idx').on(t.at), index('audit_log_tenant_idx').on(t.tenantId, t.at), index('audit_log_actor_idx').on(t.actorUserId, t.at)],
);

export const ssoType = pgEnum('sso_type', ['oidc', 'saml']);

/** Single sign-on for one customer. Secrets inside `config` are encrypted. */
export const ssoProviders = pgTable('sso_providers', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  type: ssoType('type').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  /** Text on the sign-in button, e.g. "Microsoft". */
  displayName: text('display_name').notNull().default(''),
  /** Only addresses in these domains may sign in through this provider. Set by an administrator. */
  emailDomains: text('email_domains').array().notNull().default([]),
  /** false = users of these domains must use SSO; administrators can always use their password. */
  allowPasswordLogin: boolean('allow_password_login').notNull().default(true),
  /** Create an account (with defaultRole) on the first sign-in. */
  autoCreateUsers: boolean('auto_create_users').notNull().default(false),
  defaultRole: memberRole('default_role').notNull().default('dj'),
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Links a user to the subject (OIDC `sub` or SAML NameID) at a customer's identity provider. */
export const userIdentities = pgTable(
  'user_identities',
  {
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.subject] }), index('user_identities_user_idx').on(t.userId)],
);

/** Password reset and invitation links. Only the sha256 of the token is stored. */
export const passwordTokens = pgTable(
  'password_tokens',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(), // reset | invite
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('password_tokens_user_idx').on(t.userId)],
);

export const backupTargetType = pgEnum('backup_target_type', ['ftp', 'ftps', 'sftp', 'onedrive', 'local']);

export interface BackupSchedule {
  incremental: { enabled: boolean; everyHours: number; at: string };
  full: { enabled: boolean; weekday: number; at: string };
}
export interface BackupRetention {
  keepLast: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

/** A remote location that holds a restic repository. Secrets inside `config` and the repository password are encrypted. */
export const backupTargets = pgTable('backup_targets', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  type: backupTargetType('type').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  repoPassword: text('repo_password').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  schedule: jsonb('schedule').$type<BackupSchedule>().notNull(),
  retention: jsonb('retention').$type<BackupRetention>().notNull(),
  /** Last time the scheduler queued a run, so a slot is never queued twice. */
  lastFullSlotAt: timestamp('last_full_slot_at', { withTimezone: true }),
  lastIncrementalSlotAt: timestamp('last_incremental_slot_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const backupRunKind = pgEnum('backup_run_kind', ['full', 'incremental', 'restore']);
export const backupRunState = pgEnum('backup_run_state', ['queued', 'running', 'succeeded', 'failed']);

export const backupRuns = pgTable(
  'backup_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetId: uuid('target_id').references(() => backupTargets.id, { onDelete: 'set null' }),
    targetName: text('target_name').notNull(),
    kind: backupRunKind('kind').notNull(),
    state: backupRunState('state').notNull().default('queued'),
    trigger: text('trigger').notNull(), // manual | schedule | shell
    requestedBy: text('requested_by'),
    /** Restore options: snapshot id and the parts to restore. */
    params: jsonb('params').$type<Record<string, unknown>>(),
    snapshotId: text('snapshot_id'),
    filesNew: integer('files_new'),
    filesChanged: integer('files_changed'),
    bytesAdded: bigint('bytes_added', { mode: 'number' }),
    bytesTotal: bigint('bytes_total', { mode: 'number' }),
    message: text('message'),
    log: text('log').notNull().default(''),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('backup_runs_queued_idx').on(t.queuedAt), index('backup_runs_target_idx').on(t.targetId, t.queuedAt)],
);
