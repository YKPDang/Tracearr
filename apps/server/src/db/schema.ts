/**
 * Drizzle ORM schema definitions for Tracearr
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  real,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Server types enum
export const serverTypeEnum = ['plex', 'jellyfin'] as const;

// Session state enum
export const sessionStateEnum = ['playing', 'paused', 'stopped'] as const;

// Media type enum
export const mediaTypeEnum = ['movie', 'episode', 'track'] as const;

// Rule type enum
export const ruleTypeEnum = [
  'impossible_travel',
  'simultaneous_locations',
  'device_velocity',
  'concurrent_streams',
  'geo_restriction',
] as const;

// Violation severity enum
export const violationSeverityEnum = ['low', 'warning', 'high'] as const;

// Media servers (Plex/Jellyfin instances)
export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).notNull(),
  type: varchar('type', { length: 20 }).notNull().$type<(typeof serverTypeEnum)[number]>(),
  url: text('url').notNull(),
  token: text('token').notNull(), // Encrypted
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Users from connected servers + Tracearr admins
// Two types of users:
// 1. Tracked users: have serverId + externalId, represent streaming users from Plex/Jellyfin
// 2. Owner users: isOwner=true, may have passwordHash and/or plexAccountId for auth
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Nullable for owner accounts created before adding a server
    serverId: uuid('server_id').references(() => servers.id, { onDelete: 'cascade' }),
    // Server-specific user ID (Plex user ID or Jellyfin GUID) - null for local-only owners
    externalId: varchar('external_id', { length: 255 }),
    username: varchar('username', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }),
    thumbUrl: text('thumb_url'),
    // Authentication fields for owner accounts
    passwordHash: text('password_hash'), // bcrypt hash for local login
    plexAccountId: varchar('plex_account_id', { length: 255 }), // Plex.tv global account ID for "Login with Plex"
    isOwner: boolean('is_owner').notNull().default(false),
    allowGuest: boolean('allow_guest').notNull().default(false),
    trustScore: integer('trust_score').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('users_server_id_idx').on(table.serverId),
    index('users_external_id_idx').on(table.serverId, table.externalId),
    index('users_plex_account_id_idx').on(table.plexAccountId),
    index('users_username_idx').on(table.username),
  ]
);

// Session history (will be converted to hypertable)
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionKey: varchar('session_key', { length: 255 }).notNull(),
    state: varchar('state', { length: 20 }).notNull().$type<(typeof sessionStateEnum)[number]>(),
    mediaType: varchar('media_type', { length: 20 })
      .notNull()
      .$type<(typeof mediaTypeEnum)[number]>(),
    mediaTitle: text('media_title').notNull(),
    // Enhanced media metadata for episodes
    grandparentTitle: varchar('grandparent_title', { length: 500 }), // Show name (for episodes)
    seasonNumber: integer('season_number'), // Season number (for episodes)
    episodeNumber: integer('episode_number'), // Episode number (for episodes)
    year: integer('year'), // Release year
    thumbPath: varchar('thumb_path', { length: 500 }), // Poster path (e.g., /library/metadata/123/thumb)
    ratingKey: varchar('rating_key', { length: 255 }), // Plex/Jellyfin media identifier
    externalSessionId: varchar('external_session_id', { length: 255 }), // External reference for deduplication
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    durationMs: integer('duration_ms'), // Actual watch duration (excludes paused time)
    totalDurationMs: integer('total_duration_ms'), // Total media length
    progressMs: integer('progress_ms'), // Current playback position
    // Pause tracking - accumulates total paused time across pause/resume cycles
    lastPausedAt: timestamp('last_paused_at', { withTimezone: true }), // When current pause started
    pausedDurationMs: integer('paused_duration_ms').notNull().default(0), // Accumulated pause time
    // Session grouping for "resume where left off" tracking
    referenceId: uuid('reference_id'), // Links to first session in resume chain
    watched: boolean('watched').notNull().default(false), // True if user watched 80%+
    ipAddress: varchar('ip_address', { length: 45 }).notNull(),
    geoCity: varchar('geo_city', { length: 255 }),
    geoRegion: varchar('geo_region', { length: 255 }), // State/province/subdivision
    geoCountry: varchar('geo_country', { length: 100 }),
    geoLat: real('geo_lat'),
    geoLon: real('geo_lon'),
    playerName: varchar('player_name', { length: 255 }), // Player title/friendly name
    deviceId: varchar('device_id', { length: 255 }), // Machine identifier (unique device UUID)
    product: varchar('product', { length: 255 }), // Product name (e.g., "Plex for iOS")
    device: varchar('device', { length: 255 }), // Device type (e.g., "iPhone", "Android TV")
    platform: varchar('platform', { length: 100 }),
    quality: varchar('quality', { length: 100 }),
    isTranscode: boolean('is_transcode').notNull().default(false),
    bitrate: integer('bitrate'),
  },
  (table) => [
    index('sessions_user_time_idx').on(table.userId, table.startedAt),
    index('sessions_server_time_idx').on(table.serverId, table.startedAt),
    index('sessions_state_idx').on(table.state),
    index('sessions_external_session_idx').on(table.serverId, table.externalSessionId),
    index('sessions_device_idx').on(table.userId, table.deviceId),
    index('sessions_reference_idx').on(table.referenceId), // For session grouping queries
    index('sessions_user_rating_idx').on(table.userId, table.ratingKey), // For resume detection
    // Indexes for stats queries
    index('sessions_geo_idx').on(table.geoLat, table.geoLon), // For /stats/locations
    index('sessions_media_type_idx').on(table.mediaType), // For media type aggregations
    index('sessions_transcode_idx').on(table.isTranscode), // For quality stats
    index('sessions_platform_idx').on(table.platform), // For platform stats
  ]
);

// Sharing detection rules
export const rules = pgTable(
  'rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull(),
    type: varchar('type', { length: 50 }).notNull().$type<(typeof ruleTypeEnum)[number]>(),
    params: jsonb('params').notNull().$type<Record<string, unknown>>(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('rules_active_idx').on(table.isActive),
    index('rules_user_id_idx').on(table.userId),
  ]
);

// Rule violations
export const violations = pgTable(
  'violations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    severity: varchar('severity', { length: 20 })
      .notNull()
      .$type<(typeof violationSeverityEnum)[number]>(),
    data: jsonb('data').notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  },
  (table) => [
    index('violations_user_id_idx').on(table.userId),
    index('violations_rule_id_idx').on(table.ruleId),
    index('violations_created_at_idx').on(table.createdAt),
  ]
);

// Application settings (single row)
export const settings = pgTable('settings', {
  id: integer('id').primaryKey().default(1),
  allowGuestAccess: boolean('allow_guest_access').notNull().default(false),
  discordWebhookUrl: text('discord_webhook_url'),
  customWebhookUrl: text('custom_webhook_url'),
  notifyOnViolation: boolean('notify_on_violation').notNull().default(true),
  notifyOnSessionStart: boolean('notify_on_session_start').notNull().default(false),
  notifyOnSessionStop: boolean('notify_on_session_stop').notNull().default(false),
  notifyOnServerDown: boolean('notify_on_server_down').notNull().default(true),
  // Poller settings
  pollerEnabled: boolean('poller_enabled').notNull().default(true),
  pollerIntervalMs: integer('poller_interval_ms').notNull().default(15000),
  // Tautulli integration
  tautulliUrl: text('tautulli_url'),
  tautulliApiKey: text('tautulli_api_key'), // Encrypted
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Relations
export const serversRelations = relations(servers, ({ many }) => ({
  users: many(users),
  sessions: many(sessions),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  server: one(servers, {
    fields: [users.serverId],
    references: [servers.id],
  }),
  sessions: many(sessions),
  rules: many(rules),
  violations: many(violations),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  server: one(servers, {
    fields: [sessions.serverId],
    references: [servers.id],
  }),
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
  violations: many(violations),
}));

export const rulesRelations = relations(rules, ({ one, many }) => ({
  user: one(users, {
    fields: [rules.userId],
    references: [users.id],
  }),
  violations: many(violations),
}));

export const violationsRelations = relations(violations, ({ one }) => ({
  rule: one(rules, {
    fields: [violations.ruleId],
    references: [rules.id],
  }),
  user: one(users, {
    fields: [violations.userId],
    references: [users.id],
  }),
  session: one(sessions, {
    fields: [violations.sessionId],
    references: [sessions.id],
  }),
}));
