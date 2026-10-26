import {
  type AnyPgColumn,
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
  /** Own nodes the customer may register (phase 8). */
  maxNodes: number;
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
  /** Station node the customer's stations run on (phase 12): new stations start there. Null = this server. */
  stationNodeId: uuid('station_node_id').references((): AnyPgColumn => nodes.id, { onDelete: 'set null' }),
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
    /** full = everything its owner may do; provisioning = only the sign-up API for a website (phase 10). */
    scope: text('scope').notNull().default('full'),
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

/** A mount on air on a station node, as the node reports it (the same figures Icecast gives here). */
export interface StationNodeMount {
  mount: string;
  title: string | null;
  listeners: number;
  bitrateKbps: number | null;
  contentType: string | null;
  listenerPeak?: number;
  streamStart?: string | null;
}

/** Live state of a station that runs on a station node, reported by the node every few seconds. */
export interface StationNodeRuntime {
  updatedAt: string;
  mounts: StationNodeMount[];
  /** The AutoDJ player answered recently / is held for a live DJ. */
  autodj: { connected: boolean; paused: boolean; seenAt: string | null } | null;
  /** Encoders connected to the node for this station. */
  encoders: number;
  /** Pushes to the relay nodes: relay node id → state. */
  relays: Record<string, { state: 'idle' | 'connecting' | 'connected' | 'error'; message?: string }>;
  /** Last package revision the node applied, and the last full mirror sync. */
  revision: string | null;
  syncedAt: string | null;
}

/** Moving a station between this server and a station node, with its media files. */
export interface StationNodeMove {
  /** to_node: from this server to `nodeId`; to_main: back to this server. */
  direction: 'to_node' | 'to_main';
  nodeId: string;
  state: 'copying' | 'failed';
  files: number;
  filesDone: number;
  bytes: number;
  bytesDone: number;
  message?: string;
  startedAt: string;
}

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
    /** AutoDJ settings of the Radio station edition (phase 6). Read through autodjSchema for defaults. */
    autodj: jsonb('autodj').$type<Record<string, unknown>>().notNull().default({}),
    /** Hour clocks and weekly schedule (phase 7). Read through schedulerSchema for defaults. */
    scheduler: jsonb('scheduler').$type<Record<string, unknown>>().notNull().default({}),
    /** Station node that runs this station (phase 12). Null = this server runs it. */
    nodeId: uuid('node_id').references((): AnyPgColumn => nodes.id, { onDelete: 'set null' }),
    /** What the station node reported last about the station: mounts on air, titles, AutoDJ, sync. */
    nodeRuntime: jsonb('node_runtime').$type<StationNodeRuntime>(),
    /** A move between this server and a station node that is under way or failed. */
    nodeMove: jsonb('node_move').$type<StationNodeMove>(),
    /** Which ingest takes the encoders and which relays it feeds (phase 13). Read through routingSchema for defaults. */
    routing: jsonb('routing').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('stations_tenant_idx').on(t.tenantId), index('stations_node_idx').on(t.nodeId)],
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
  /** A relay node a station node pushes to (made by the main server, phase 12); its certificate may be self-signed. */
  relayNodeId?: string;
  insecureTls?: boolean;
  /** Pushes to relay nodes (phase 13), in memory only: the push token itself and the ingest priority (0 = main). */
  token?: string;
  priority?: number;
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
    /** The source node the encoder delivered through, if any. */
    nodeId: uuid('node_id').references((): AnyPgColumn => nodes.id, { onDelete: 'set null' }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    bitrateKbps: integer('bitrate_kbps'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    bytesIn: bigint('bytes_in', { mode: 'number' }).notNull().default(0),
    /** disconnected | kicked | bitrate | restart | error */
    endReason: text('end_reason'),
    /** The encoder is on air on an ingest node (phase 13), which keeps this row up to date; else on this server. */
    onNode: boolean('on_node').notNull().default(false),
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
    /** Source node that takes the encoders of `ingestHost` (phase 8). Null = this server. */
    ingestNodeId: uuid('ingest_node_id').references((): AnyPgColumn => nodes.id, { onDelete: 'set null' }),
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
    /** Set for listeners of a relay node. */
    nodeId: uuid('node_id').references((): AnyPgColumn => nodes.id, { onDelete: 'set null' }),
    /** web = through the web server, legacy = the Shoutcast port, external = an external server, relay = a relay node. */
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
    /** The library track the listener picked (Radio station edition); free-text requests have none. */
    mediaId: uuid('media_id').references((): AnyPgColumn => mediaFiles.id, { onDelete: 'set null' }),
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

// Phase 6: radio station (AutoDJ)

export const mediaSourceType = pgEnum('media_source_type', ['local', 'smb', 'nfs']);

export interface MediaSourceConfig {
  /** local: a folder on this server (administrators only), e.g. a bind mount from the host. */
  path?: string;
  /** smb and nfs: the file server. */
  host?: string;
  /** smb: the share, optionally with a sub folder ("music/hardstyle"). */
  share?: string;
  /** nfs: the exported path ("/export/music"). */
  export?: string;
  username?: string;
  /** Encrypted. */
  password?: string;
  /** smb: Windows domain or workgroup. */
  domain?: string;
  /** smb: protocol version (3.0 when empty); nfs: 3, 4, 4.1 or 4.2. */
  version?: string;
}

export interface MediaSourceStatus {
  state: 'pending' | 'ok' | 'error';
  message?: string;
  checkedAt?: string;
}

/**
 * A music collection outside the station's own storage: a folder on this server, or a Windows/Samba (SMB) or NFS share
 * that the system helper mounts read-only. The files are indexed where they are, nothing is copied.
 */
export const mediaSources = pgTable(
  'media_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: mediaSourceType('type').notNull(),
    config: jsonb('config').$type<MediaSourceConfig>().notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    status: jsonb('status').$type<MediaSourceStatus>(),
    fileCount: integer('file_count').notNull().default(0),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('media_sources_station_idx').on(t.stationId)],
);

/**
 * One audio file in a station's library. `location` is "storage" (the station's own media folder) or the id of a media
 * source; `path` is relative to it. Tags are read when the file is scanned and can be corrected in the panel.
 */
export const mediaFiles = pgTable(
  'media_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => mediaSources.id, { onDelete: 'cascade' }),
    location: text('location').notNull(),
    path: text('path').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    mtimeMs: bigint('mtime_ms', { mode: 'number' }).notNull().default(0),
    title: text('title').notNull(),
    artist: text('artist').notNull().default(''),
    album: text('album').notNull().default(''),
    genre: text('genre').notNull().default(''),
    year: integer('year'),
    durationSeconds: doublePrecision('duration_seconds'),
    bitrateKbps: integer('bitrate_kbps'),
    /** ReplayGain of the track in dB, from the file's tags; evens out loudness between tracks. */
    gainDb: doublePrecision('gain_db'),
    /** Tags changed in the panel are kept when the file is scanned again. */
    edited: boolean('edited').notNull().default(false),
    /** false = the AutoDJ never picks it. */
    enabled: boolean('enabled').notNull().default(true),
    playCount: integer('play_count').notNull().default(0),
    lastPlayedAt: timestamp('last_played_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('media_files_path_idx').on(t.stationId, t.location, t.path),
    index('media_files_artist_idx').on(t.stationId, t.artist),
    index('media_files_played_idx').on(t.stationId, t.lastPlayedAt),
  ],
);

export const autodjQueue = pgEnum('autodj_queue', ['q1', 'q2']);
export const playlistOrder = pgEnum('playlist_order', ['shuffle', 'random', 'sequential']);

export interface PlaylistFolder {
  location: string;
  /** Relative folder; empty = everything in the location. */
  path: string;
}

/**
 * A rotation the AutoDJ picks tracks from. Every playlist feeds one queue (Q1 or Q2); playlists with a higher weight are
 * picked more often. Tracks are the files of its folders (new files join by themselves) plus the files added by hand.
 */
export const playlists = pgTable(
  'playlists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    queue: autodjQueue('queue').notNull().default('q1'),
    weight: integer('weight').notNull().default(5),
    /** shuffle = least recently played first, random = any track, sequential = in folder and file order. */
    order: playlistOrder('order').notNull().default('shuffle'),
    folders: jsonb('folders').$type<PlaylistFolder[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    /** Feeds its queue. Off = only played where an hour clock asks for it (news, commercials, jingles). */
    rotation: boolean('rotation').notNull().default(true),
    /** Sequential playlists: the last path played, as "location:path". */
    cursor: text('cursor'),
    createdAt: createdAt(),
  },
  (t) => [index('playlists_station_idx').on(t.stationId)],
);

export const playlistItems = pgTable(
  'playlist_items',
  {
    playlistId: uuid('playlist_id').notNull().references(() => playlists.id, { onDelete: 'cascade' }),
    mediaId: uuid('media_id').notNull().references(() => mediaFiles.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.playlistId, t.mediaId] }), index('playlist_items_media_idx').on(t.mediaId)],
);

export const queueState = pgEnum('queue_state', ['queued', 'cued', 'playing']);

/**
 * The two AutoDJ queues. `queued` items wait their turn, the `cued` item has been handed to the player (it loads one
 * track ahead) and the `playing` item is on air. Played items are removed; the play itself is in song_plays.
 */
export const queueItems = pgTable(
  'queue_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    queue: autodjQueue('queue').notNull(),
    mediaId: uuid('media_id').notNull().references(() => mediaFiles.id, { onDelete: 'cascade' }),
    position: doublePrecision('position').notNull(),
    state: queueState('state').notNull().default('queued'),
    /** rotation (picked from a playlist) | request | manual | clock (an item of the hour clock) */
    origin: text('origin').notNull(),
    /** Name of the hour clock item it came from (clock items). */
    label: text('label'),
    playlistId: uuid('playlist_id').references(() => playlists.id, { onDelete: 'set null' }),
    requestId: uuid('request_id').references(() => songRequests.id, { onDelete: 'set null' }),
    addedBy: text('added_by'),
    cuedAt: timestamp('cued_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('queue_items_station_idx').on(t.stationId, t.queue, t.position)],
);

/** Running state of a station's AutoDJ: which queue played last, for the pick rules. */
export const autodjState = pgTable('autodj_state', {
  stationId: uuid('station_id')
    .primaryKey()
    .references(() => stations.id, { onDelete: 'cascade' }),
  lastQueue: autodjQueue('last_queue'),
  /** Tracks played in a row from lastQueue. */
  streak: integer('streak').notNull().default(0),
  /** Last time the player asked for a track or reported one. */
  seenAt: timestamp('seen_at', { withTimezone: true }),
  /** Hour clock in progress: the start of its hour, the clock, the item it is at and the tracks played of that item. */
  clockHour: timestamp('clock_hour', { withTimezone: true }),
  clockId: uuid('clock_id'),
  clockStep: integer('clock_step').notNull().default(0),
  clockDone: integer('clock_done').notNull().default(0),
});

// Phase 7: scheduler

export interface ClockItem {
  /** Stable id within the clock, chosen by the panel. */
  id: string;
  /** rotation = music from the queues, playlist = tracks from one playlist, track = one library track. */
  kind: 'rotation' | 'playlist' | 'track';
  label: string;
  playlistId: string | null;
  mediaId: string | null;
  /** Tracks to play (playlist); 0 = music from the playlist until the next timed item. */
  count: number;
  /** Minute of the hour the item starts at; null = after the item before it. */
  at: number | null;
  /** Timed items: cut the track that is playing at the minute instead of waiting for its end. */
  hard: boolean;
}

/**
 * An hour clock: the order of an hour of radio, such as news on the hour, commercials at a quarter past and music in
 * between. Items with a minute are timed; the others follow the item before them.
 */
export const clocks = pgTable(
  'clocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#FF6B57'),
    items: jsonb('items').$type<ClockItem[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('clocks_station_idx').on(t.stationId)],
);

/**
 * A block in the station's schedule, weekly on some days or once on a date, in the station's time zone. It runs an
 * hour clock (none = the AutoDJ's queues) and can be a live show: its DJs are shown on the public page and, when the
 * station says so, may only broadcast during their shows. Without a DJ the AutoDJ plays the block's clock.
 */
export const scheduleEntries = pgTable(
  'schedule_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    clockId: uuid('clock_id').references(() => clocks.id, { onDelete: 'set null' }),
    live: boolean('live').notNull().default(false),
    /** Station accounts (DJs) of a live show. */
    accountIds: uuid('account_ids').array().notNull().default([]),
    /** ISO weekdays, 1 = Monday … 7 = Sunday. Ignored when `date` is set. */
    days: integer('days').array().notNull().default([]),
    /** One-off block on this date (YYYY-MM-DD); it wins over the weekly blocks. */
    date: text('date'),
    /** Start as minutes after midnight, and length in minutes (it may run past midnight). */
    startMinute: integer('start_minute').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    /** Listed on the public page. */
    isPublic: boolean('is_public').notNull().default(true),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('schedule_entries_station_idx').on(t.stationId)],
);

// Phase 8: distribution network and orchestration

export const NODE_ROLES = ['relay', 'source', 'station'] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

/** Settings of a node, made in the panel. Read through nodeConfigSchema for defaults. */
export interface NodeConfig {
  /** Host name listeners and encoders use for this node; with a domain the node gets a certificate. */
  publicHost?: string;
  /** Port listeners connect to when the node has no domain (or no web server of its own). */
  listenPort?: number | null;
  /** Relay: the stations it carries, "all" = every station it may carry. */
  relayStations?: 'all' | string[];
  /** Relay: most listeners at the same time on this node. 0 = no limit. */
  maxListeners?: number;
  /** Source: ports for encoders, plain Icecast and TLS. */
  sourcePlainPort?: number | null;
  sourceTlsPort?: number | null;
  /** Check the streams of the stations from this node. */
  probe?: boolean;
  /** Relay: port where station nodes deliver their streams (TLS). */
  pushPort?: number | null;
  /** Station: address of the node on the studio's own network, for RHIS Studio (e.g. 192.168.1.20). */
  lanAddress?: string;
}

/** What a node reported last, kept with the node so every process (API, streams) can read it. */
export interface NodeStatus {
  online: boolean;
  version?: string;
  commit?: string | null;
  hostname?: string;
  /** The node runs its own web server (Caddy), so it can serve HTTPS and get certificates. */
  caddy?: boolean;
  /** Addresses of the node's own network interfaces. */
  addresses?: string[];
  /** Address the node connects from, as seen by the main server. */
  ip?: string | null;
  country?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  cpu?: number;
  memory?: number;
  load?: number;
  cores?: number;
  uptime?: number;
  rxBps?: number;
  txBps?: number;
  /** Round trip over the control channel, last minute. */
  rttMs?: number | null;
  /** Share of pings without an answer over the last 5 minutes, 0..1. */
  loss?: number;
  /** Pings without an answer in the last 24 hours. */
  timeouts24h?: number;
  /** ICMP ping from the node to the main server, when available. */
  icmp?: { rttMs: number | null; loss: number } | null;
  listeners?: number;
  /** Relay: state per carried mount ("<slug>/<mount>"). */
  relays?: { key: string; state: 'connecting' | 'connected' | 'error' | 'idle'; message?: string; bitrateKbps?: number | null; listeners?: number }[];
  /** Source: encoders connected through this node. */
  encoders?: number;
  /** Ingest (phase 13): the station mounts on air on this node, with their title. */
  ingest?: NodeIngestMount[];
  /** Errors applying the configuration on the node (web server, ports). */
  problems?: string[];
  update?: { state: 'idle' | 'running' | 'succeeded' | 'failed'; message?: string; at?: string } | null;
  updatedAt?: string;
}

/** A mount on air on an ingest node. */
export interface NodeIngestMount {
  stationId: string;
  mount: string;
  title: string | null;
  bitrateKbps: number | null;
  contentType: string | null;
  /** Relay nodes the mount is pushed to right now. */
  pushing: string[];
}

/** A listener on a relay node, as the node reported it. */
export interface NodeClient {
  stationId: string;
  mount: string;
  id: string;
  ip: string | null;
  userAgent: string | null;
  referer: string | null;
  connectedSeconds: number;
}

/**
 * A remote node: its own Debian LXC with the node agent, paired with a one-time code and steered from here. Roles say
 * what it does (relay for listeners, source for encoders). A node of a customer (`tenantId`) only serves that customer.
 */
export const nodes = pgTable(
  'nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Free text shown in the panel and topology, e.g. "Amsterdam". */
    location: text('location').notNull().default(''),
    roles: text('roles').array().$type<NodeRole[]>().notNull().default([]),
    config: jsonb('config').$type<NodeConfig>().notNull().default({}),
    /** sha256 of the one-time pairing code, until it is used or expires. */
    pairingCodeHash: text('pairing_code_hash'),
    pairingExpiresAt: timestamp('pairing_expires_at', { withTimezone: true }),
    /** Encrypted. The node's secret, set when it pairs; it signs the encoder connections it forwards. */
    secret: text('secret'),
    pairedAt: timestamp('paired_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    status: jsonb('status').$type<NodeStatus>().notNull().default({ online: false }),
    /** Listeners on the node right now (relay), replaced by every report. */
    clients: jsonb('clients').$type<NodeClient[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('nodes_tenant_idx').on(t.tenantId), uniqueIndex('nodes_pairing_idx').on(t.pairingCodeHash)],
);

/** Health of a node per minute: control channel latency and lost pings, load, traffic and listeners. */
export const nodeMetrics = pgTable(
  'node_metrics',
  {
    nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull(),
    rttAvg: doublePrecision('rtt_avg'),
    rttMax: doublePrecision('rtt_max'),
    pings: integer('pings').notNull().default(0),
    lost: integer('lost').notNull().default(0),
    cpu: doublePrecision('cpu'),
    memory: doublePrecision('memory'),
    rxBps: doublePrecision('rx_bps'),
    txBps: doublePrecision('tx_bps'),
    listeners: integer('listeners'),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.at] }), index('node_metrics_at_idx').on(t.at)],
);

/** What happened to a node: paired, online/offline, roles, updates, warnings. `kind` + `details` are shown translated. */
export const nodeEvents = pgTable(
  'node_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    /** info | warning | error */
    level: text('level').notNull().default('info'),
    kind: text('kind').notNull(),
    details: jsonb('details').$type<Record<string, string | number | null>>().notNull().default({}),
  },
  (t) => [index('node_events_node_idx').on(t.nodeId, t.at)],
);

/** Latest result of a stream check from a node (remote probe), per station stream it watches. */
export const nodeProbes = pgTable(
  'node_probes',
  {
    nodeId: uuid('node_id').notNull().references(() => nodes.id, { onDelete: 'cascade' }),
    /** "<station slug>/<mount>@<where>", where = main or the id of a relay node. */
    target: text('target').notNull(),
    stationId: uuid('station_id').notNull().references(() => stations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    ok: boolean('ok').notNull(),
    httpStatus: integer('http_status'),
    /** Time to the first audio bytes. */
    ttfbMs: integer('ttfb_ms'),
    message: text('message'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    /** Checks and failures over the last 24 hours, kept as per-hour buckets [hour, checks, failures]. */
    buckets: jsonb('buckets').$type<[number, number, number][]>().notNull().default([]),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.target] }), index('node_probes_station_idx').on(t.stationId)],
);

/**
 * A studio client (Windows) asking to be linked to an account. The client shows `userCode`, the user approves it in the
 * panel, and the client's next poll (with its device secret) receives a personal API key once.
 */
export const studioLinks = pgTable(
  'studio_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Short code the user compares in the panel, e.g. "KQ7M-3XTR" (stored without the dash). */
    userCode: text('user_code').notNull(),
    /** sha256 of the secret only the client knows; it polls with it. */
    deviceSecretHash: text('device_secret_hash').notNull(),
    deviceName: text('device_name').notNull(),
    clientVersion: text('client_version'),
    ip: text('ip'),
    /** pending | approved | denied | used */
    state: text('state').notNull().default('pending'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('studio_links_code_idx').on(t.userCode), uniqueIndex('studio_links_secret_idx').on(t.deviceSecretHash)],
);

/**
 * Short-lived encoder passwords the studio client gets for a DJ account, so DJs never type their encoder password.
 * The ingest gateway accepts one as the account's password until it expires.
 */
export const studioLiveTokens = pgTable(
  'studio_live_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => stationAccounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    hash: text('hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('studio_live_tokens_hash_idx').on(t.hash), index('studio_live_tokens_account_idx').on(t.accountId)],
);

// Phase 10: hosted service (packages, subscriptions, invoices, webhooks)

/**
 * A package that is sold: an edition with its limits and prices. The RHIS website reads the public ones and signs
 * customers up with a package code. Changing a package does not change running subscriptions until they are renewed
 * or moved to it.
 */
export const packages = pgTable('packages', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Stable code the website uses, e.g. "radio-basic". */
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: jsonb('description').$type<{ en: string; nl: string }>().notNull().default({ en: '', nl: '' }),
  /** Selling points for pricing tables, one line each. */
  features: jsonb('features').$type<{ en: string; nl: string }[]>().notNull().default([]),
  edition: tenantPlan('edition').notNull(),
  limits: jsonb('limits').$type<TenantLimits>().notNull(),
  currency: text('currency').notNull().default('EUR'),
  /** Prices without VAT, in cents. A null yearly price means the package is only sold per month. */
  priceMonthCents: integer('price_month_cents').notNull(),
  priceYearCents: integer('price_year_cents'),
  setupFeeCents: integer('setup_fee_cents').notNull().default(0),
  trialDays: integer('trial_days').notNull().default(0),
  /** Shown in the public package list (website, customer panel). */
  public: boolean('public').notNull().default(true),
  /** New customers can be signed up with it. Retired packages keep their subscriptions. */
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const billingInterval = pgEnum('billing_interval', ['month', 'year']);
export const subscriptionStatus = pgEnum('subscription_status', ['trialing', 'active', 'past_due', 'suspended', 'cancelled']);

export interface BillingContact {
  company: string;
  name: string;
  email: string;
  address: string;
  postcode: string;
  city: string;
  /** ISO 3166-1 alpha-2, e.g. "NL". */
  country: string;
  vatNumber: string;
  /** Purchase order or reference printed on invoices. */
  reference: string;
}

/** The package a customer pays for. One per customer; customers without one (own stations) are never billed. */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    packageId: uuid('package_id').notNull().references(() => packages.id, { onDelete: 'restrict' }),
    interval: billingInterval('interval').notNull().default('month'),
    status: subscriptionStatus('status').notNull(),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    /** A downgrade waits for the end of the period. */
    pendingPackageId: uuid('pending_package_id').references(() => packages.id, { onDelete: 'set null' }),
    pendingInterval: billingInterval('pending_interval'),
    /** Agreed price per interval instead of the package price, in cents without VAT. */
    customPriceCents: integer('custom_price_cents'),
    discountPercent: integer('discount_percent').notNull().default(0),
    /** The limits were changed by hand; package changes then leave them alone. */
    customLimits: boolean('custom_limits').notNull().default(false),
    billing: jsonb('billing').$type<BillingContact>().notNull(),
    /** Language of invoices and billing e-mails. */
    locale: text('locale').notNull().default('en'),
    notes: text('notes').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('subscriptions_tenant_idx').on(t.tenantId), index('subscriptions_period_idx').on(t.currentPeriodEnd)],
);

export const invoiceStatus = pgEnum('invoice_status', ['open', 'paid', 'void']);

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitCents: number;
  /** quantity × unitCents, rounded. */
  amountCents: number;
}

export interface InvoiceParty {
  company: string;
  name: string;
  email: string;
  address: string;
  postcode: string;
  city: string;
  country: string;
  vatNumber: string;
  cocNumber?: string;
  iban?: string;
  bic?: string;
  website?: string;
  phone?: string;
  /** Free text at the bottom of the invoice (seller only). */
  footer?: string;
}

/** An invoice, numbered when it is created. Seller and buyer are copied in, so later changes never alter it. */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: text('number').notNull().unique(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, { onDelete: 'set null' }),
    /** Kept when the customer is deleted later. */
    tenantName: text('tenant_name').notNull(),
    status: invoiceStatus('status').notNull().default('open'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),
    currency: text('currency').notNull().default('EUR'),
    lines: jsonb('lines').$type<InvoiceLine[]>().notNull(),
    subtotalCents: integer('subtotal_cents').notNull(),
    vatRate: doublePrecision('vat_rate').notNull(),
    /** standard | reverse_charge (EU business customer) | export (outside the EU) */
    vatScheme: text('vat_scheme').notNull().default('standard'),
    vatCents: integer('vat_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
    seller: jsonb('seller').$type<InvoiceParty>().notNull(),
    buyer: jsonb('buyer').$type<InvoiceParty & { reference: string }>().notNull(),
    locale: text('locale').notNull().default('en'),
    notes: text('notes').notNull().default(''),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** How it was paid: mollie, bank transfer, ... and the reference. */
    paymentMethod: text('payment_method'),
    paymentRef: text('payment_ref'),
    /** Online payment (Mollie) and its checkout link. */
    molliePaymentId: text('mollie_payment_id'),
    paymentUrl: text('payment_url'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('invoices_tenant_idx').on(t.tenantId, t.issuedAt), index('invoices_status_idx').on(t.status, t.dueAt), index('invoices_mollie_idx').on(t.molliePaymentId)],
);

/** Outgoing webhooks: the RHIS website (or anything else) hears about sign-ups, invoices and suspensions. */
export const webhooks = pgTable('webhooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  /** Encrypted signing secret. */
  secret: text('secret').notNull(),
  /** Event names, or "*" for all. */
  events: jsonb('events').$type<string[]>().notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    webhookId: uuid('webhook_id').notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** pending | delivered | failed (gave up) */
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    responseStatus: integer('response_status'),
    error: text('error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('webhook_deliveries_due_idx').on(t.state, t.nextAttemptAt), index('webhook_deliveries_hook_idx').on(t.webhookId, t.createdAt)],
);

/** Answers to provisioning calls with an Idempotency-Key, so a website retry never creates a customer twice. */
export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  /** sha256 of the request body; the same key with another body is refused. */
  requestHash: text('request_hash').notNull(),
  statusCode: integer('status_code').notNull(),
  response: jsonb('response').notNull(),
  createdAt: createdAt(),
});
