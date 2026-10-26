import {
  bigserial,
  bigint,
  doublePrecision,
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
import { sql } from 'drizzle-orm';

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

// Phase 3: distribution

/** distribution = streaming, live input and public pages; station = adds the AutoDJ, queues and scheduler (phase 6). */
export const stationEdition = pgEnum('station_edition', ['distribution', 'station']);

/**
 * A radio station. Every station has its own Icecast server on this machine (bound to localhost, port `icecastPort`).
 * Encoders deliver through the ingest gateway; listeners connect through the web server or the station's outputs.
 */
export const stations = pgTable(
  'stations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Globally unique, used in listen URLs (/listen/<slug>/<mount>) and upload logins (<slug>.<user>). */
    slug: text('slug').notNull().unique(),
    edition: stationEdition('edition').notNull().default('distribution'),
    description: text('description').notNull().default(''),
    genre: text('genre').notNull().default(''),
    website: text('website').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    /** Listeners on this server at the same time. The total over a customer's stations stays within its limit. */
    maxListeners: integer('max_listeners').notNull(),
    icecastPort: integer('icecast_port').notNull().unique(),
    /** Public port for legacy Shoutcast v1 encoders (they also use port + 1). Null = off. */
    legacyPort: integer('legacy_port').unique(),
    /** Mount that legacy Shoutcast encoders feed and legacy players hear. */
    legacyMountId: uuid('legacy_mount_id'),
    /** Encrypted. Internal passwords of the Icecast server; encoders never see them. */
    icecastAdminPassword: text('icecast_admin_password').notNull(),
    icecastSourcePassword: text('icecast_source_password').notNull(),
    /** Size of the media folder, refreshed after uploads and every few hours. Counts towards the customer's storage limit. */
    storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull().default(0),
    storageScannedAt: timestamp('storage_scanned_at', { withTimezone: true }),
    /** Public page, widgets, requests, on-demand and recordings (phase 5). Read through publicPageSchema for defaults. */
    publicPage: jsonb('public_page').$type<Record<string, unknown>>().notNull().default({}),
    /** File name of the station logo under DATA_DIR/public/<station id>/. */
    logoFile: text('logo_file'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('stations_tenant_idx').on(t.tenantId)],
);

export const mountKind = pgEnum('mount_kind', ['source', 'transcode']);
export const audioFormat = pgEnum('audio_format', ['mp3', 'aac', 'opus', 'vorbis']);

/**
 * A mount point on the station's Icecast server. `source` mounts are fed by encoders (live DJs, studios, later the
 * AutoDJ); `transcode` mounts are made on this server from another mount in another format or bitrate.
 */
export const stationMounts = pgTable(
  'station_mounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    name: text('name').notNull().default(''),
    kind: mountKind('kind').notNull().default('source'),
    /** For transcode mounts: the mount that is converted. */
    sourceMountId: uuid('source_mount_id'),
    format: audioFormat('format').notNull().default('mp3'),
    /** Highest bitrate an encoder may send (source) or the bitrate that is made (transcode). */
    bitrateKbps: integer('bitrate_kbps').notNull().default(128),
    /** Listeners may connect. A source mount can stay private and only feed transcodes and outputs. */
    isPublic: boolean('is_public').notNull().default(true),
    /** The mount public pages and players use. */
    isDefault: boolean('is_default').notNull().default(false),
    /** Listeners move here when this mount has no source, and come back when it returns. */
    fallbackMountId: uuid('fallback_mount_id'),
    maxListeners: integer('max_listeners'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('station_mounts_path_idx').on(t.stationId, t.path)],
);

/**
 * Where a station can be heard. `local` = listeners connect to this server; `icecast` / `shoutcast1` / `shoutcast2` =
 * an external server, either fed from a local mount (push) or only watched (monitor). Phase 8 adds relay nodes here.
 */
export const outputType = pgEnum('output_type', ['local', 'icecast', 'shoutcast1', 'shoutcast2']);

export interface OutputConfig {
  host?: string;
  port?: number;
  tls?: boolean;
  /** Icecast mount on the external server. */
  mount?: string;
  username?: string;
  /** Encrypted. Source password on the external server. */
  password?: string;
  /** Shoutcast 2 stream id. */
  streamId?: number;
  /** Encrypted. Admin password, for listener counts of Shoutcast servers. */
  adminPassword?: string;
  /** false = encoders deliver to the external server directly and this server only watches it. */
  push?: boolean;
  /** Address listeners use on the external server, for public pages. */
  publicUrl?: string;
}

export interface OutputStatus {
  state: 'idle' | 'connecting' | 'connected' | 'error';
  message?: string;
  listeners?: number | null;
  since?: string;
  checkedAt?: string;
}

export const stationOutputs = pgTable(
  'station_outputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    type: outputType('type').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** The local mount that is pushed to the external server. */
    mountId: uuid('mount_id').references(() => stationMounts.id, { onDelete: 'set null' }),
    config: jsonb('config').$type<OutputConfig>().notNull().default({}),
    status: jsonb('status').$type<OutputStatus>(),
    createdAt: createdAt(),
  },
  (t) => [index('station_outputs_station_idx').on(t.stationId)],
);

/** Log-in for encoders (live DJs, studios) and for uploading files over SFTP/FTP. Scoped to one station. */
export const stationAccounts = pgTable(
  'station_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    displayName: text('display_name').notNull().default(''),
    passwordHash: text('password_hash').notNull(),
    /** The panel user this account belongs to, so a DJ sees their own connection details. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    canBroadcast: boolean('can_broadcast').notNull().default(true),
    canUpload: boolean('can_upload').notNull().default(false),
    /** Source mounts this account may feed. Empty = all source mounts. */
    mountIds: uuid('mount_ids').array().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('station_accounts_username_idx').on(t.stationId, t.username), index('station_accounts_user_idx').on(t.userId)],
);

/** One encoder connection: who broadcast on which mount, from where, and how long. Written by the ingest gateway. */
export const liveSessions = pgTable(
  'live_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    mountId: uuid('mount_id').references(() => stationMounts.id, { onDelete: 'set null' }),
    mountPath: text('mount_path').notNull(),
    accountId: uuid('account_id').references(() => stationAccounts.id, { onDelete: 'set null' }),
    accountName: text('account_name').notNull(),
    /** tls | plain | shoutcast */
    via: text('via').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    bitrateKbps: integer('bitrate_kbps'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    bytesIn: bigint('bytes_in', { mode: 'number' }).notNull().default(0),
    /** disconnected | kicked | bitrate | restart | error */
    endReason: text('end_reason'),
  },
  (t) => [index('live_sessions_station_idx').on(t.stationId, t.startedAt)],
);

export const domainStatus = pgEnum('domain_status', ['pending', 'verified', 'failed']);

export interface DomainCheck {
  host: string;
  ok: boolean;
  /** What the name points to now: CNAME target or addresses. */
  found: string[];
  error?: string;
}

/**
 * A customer's own domain: `panelHost` (stream.example.com) serves the panel, public pages and listener streams;
 * `ingestHost` (src.example.com) takes encoder connections. Certificates are only issued for verified names.
 */
export const tenantDomains = pgTable(
  'tenant_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    panelHost: text('panel_host').notNull().unique(),
    ingestHost: text('ingest_host').notNull().unique(),
    status: domainStatus('status').notNull().default('pending'),
    /** Set by an administrator for DNS setups that cannot be checked from here (split DNS, LAN). */
    verifiedManually: boolean('verified_manually').notNull().default(false),
    checks: jsonb('checks').$type<DomainCheck[]>().notNull().default([]),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('tenant_domains_tenant_idx').on(t.tenantId)],
);

// Phase 4: statistics

/**
 * One listener connection: who listened to which mount, from where, with what and how long. Local listeners are
 * reported by the station's Icecast server (listener hooks), listeners of external servers come from their client
 * lists. `endedAt` is null while the listener is connected.
 */
export const listenerSessions = pgTable(
  'listener_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    mountPath: text('mount_path').notNull(),
    /** Set for listeners of an external server. */
    outputId: uuid('output_id').references(() => stationOutputs.id, { onDelete: 'set null' }),
    /** web = through the web server, legacy = the Shoutcast port, external = an external server. */
    via: text('via').notNull(),
    /** Client id on the server that reported it, to match the disconnect. */
    clientKey: text('client_key'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    /** Full or shortened address, depending on the privacy setting. Null when unknown. */
    ip: text('ip'),
    /** Keyed hash of address and player, to count unique listeners without keeping the address. */
    listenerHash: text('listener_hash'),
    country: text('country'),
    region: text('region'),
    city: text('city'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    asn: integer('asn'),
    network: text('network'),
    userAgent: text('user_agent'),
    /** desktop | mobile | tablet | speaker | tv | car | bot | other */
    device: text('device'),
    player: text('player'),
    os: text('os'),
    referrer: text('referrer'),
  },
  (t) => [
    index('listener_sessions_station_start_idx').on(t.stationId, t.startedAt),
    index('listener_sessions_station_end_idx').on(t.stationId, t.endedAt),
    index('listener_sessions_tenant_start_idx').on(t.tenantId, t.startedAt),
    index('listener_sessions_start_idx').on(t.startedAt),
    index('listener_sessions_open_idx').on(t.stationId, t.clientKey).where(sql`ended_at is null`),
  ],
);

/**
 * Listeners per minute, per station and target: `*` = the station in total, `mount:/live` = a local mount,
 * `output:<id>` = an external server. Kept for a while, then only the hourly rollup remains.
 */
export const listenerSamples = pgTable(
  'listener_samples',
  {
    at: timestamp('at', { withTimezone: true }).notNull(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    target: text('target').notNull(),
    avg: doublePrecision('avg').notNull(),
    peak: integer('peak').notNull(),
  },
  (t) => [primaryKey({ columns: [t.stationId, t.target, t.at] }), index('listener_samples_at_idx').on(t.at)],
);

/** Listeners per hour, made from the minute samples. */
export const listenerHourly = pgTable(
  'listener_hourly',
  {
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    target: text('target').notNull(),
    avg: doublePrecision('avg').notNull(),
    peak: integer('peak').notNull(),
    minutes: integer('minutes').notNull(),
  },
  (t) => [primaryKey({ columns: [t.stationId, t.target, t.hour] }), index('listener_hourly_hour_idx').on(t.hour)],
);

/** Every title change on a source mount, with the station's listeners at the start, peak and end. */
export const songPlays = pgTable(
  'song_plays',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    mountPath: text('mount_path').notNull(),
    title: text('title').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    listenersStart: integer('listeners_start').notNull().default(0),
    listenersPeak: integer('listeners_peak').notNull().default(0),
    listenersEnd: integer('listeners_end'),
  },
  (t) => [index('song_plays_station_idx').on(t.stationId, t.startedAt)],
);

// Phase 5: public pages

export const requestStatus = pgEnum('request_status', ['pending', 'accepted', 'played', 'rejected']);

/** A song request from a listener on the public page. In the Distribution edition the DJ handles them by hand. */
export const songRequests = pgTable(
  'song_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    artist: text('artist').notNull(),
    title: text('title').notNull(),
    message: text('message').notNull().default(''),
    requesterName: text('requester_name').notNull().default(''),
    /** Keyed hash of the listener's address, to limit requests per listener without keeping the address. */
    requesterHash: text('requester_hash').notNull(),
    status: requestStatus('status').notNull().default('pending'),
    handledBy: text('handled_by'),
    handledAt: timestamp('handled_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('song_requests_station_idx').on(t.stationId, t.createdAt), index('song_requests_hash_idx').on(t.stationId, t.requesterHash, t.createdAt)],
);

/**
 * An on-demand item: a recorded live broadcast or a file put in the station's `ondemand` folder. Only published items
 * are on the public page. `file` is relative to the station's media folder.
 */
export const onDemandItems = pgTable(
  'ondemand_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    /** recording | upload */
    source: text('source').notNull(),
    file: text('file').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /** DJ of a recording. */
    host: text('host').notNull().default(''),
    liveSessionId: uuid('live_session_id').references(() => liveSessions.id, { onDelete: 'set null' }),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    durationSeconds: integer('duration_seconds'),
    /** Null = still recording. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    plays: integer('plays').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ondemand_items_file_idx').on(t.stationId, t.file), index('ondemand_items_station_idx').on(t.stationId, t.createdAt)],
);

/** Album art found for a title, cached under DATA_DIR/cache/artwork. `file` null = nothing found (tried again later). */
export const artworkCache = pgTable('artwork_cache', {
  key: text('key').primaryKey(),
  file: text('file'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});
