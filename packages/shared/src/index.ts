/**
 * @tracearr/shared - Shared types, schemas, and constants
 */

// Type exports
export type {
  // Server
  ServerType,
  Server,
  // User
  User,
  UserRole,
  AuthUser,
  UserLocation,
  UserDevice,
  // Session
  SessionState,
  MediaType,
  Session,
  SessionWithDetails,
  ActiveSession,
  // Rule
  RuleType,
  ImpossibleTravelParams,
  SimultaneousLocationsParams,
  DeviceVelocityParams,
  ConcurrentStreamsParams,
  GeoRestrictionParams,
  RuleParams,
  Rule,
  // Violation
  ViolationSeverity,
  Violation,
  ViolationWithDetails,
  // Stats
  DashboardStats,
  PlayStats,
  UserStats,
  LocationStats,
  LocationStatsSummary,
  LocationStatsResponse,
  LibraryStats,
  DayOfWeekStats,
  HourOfDayStats,
  QualityStats,
  TopUserStats,
  TopContentStats,
  PlatformStats,
  // Settings
  Settings,
  // Tautulli import
  TautulliImportProgress,
  TautulliImportResult,
  // WebSocket
  ServerToClientEvents,
  ClientToServerEvents,
  // API
  PaginatedResponse,
  ApiError,
} from './types.js';

// Schema exports
export {
  // Common
  uuidSchema,
  paginationSchema,
  // Auth
  loginSchema,
  callbackSchema,
  // Server
  createServerSchema,
  serverIdParamSchema,
  // User
  updateUserSchema,
  userIdParamSchema,
  // Session
  sessionQuerySchema,
  sessionIdParamSchema,
  // Rule
  impossibleTravelParamsSchema,
  simultaneousLocationsParamsSchema,
  deviceVelocityParamsSchema,
  concurrentStreamsParamsSchema,
  geoRestrictionParamsSchema,
  ruleParamsSchema,
  createRuleSchema,
  updateRuleSchema,
  ruleIdParamSchema,
  // Violation
  violationQuerySchema,
  violationIdParamSchema,
  // Stats
  statsQuerySchema,
  locationStatsQuerySchema,
  // Settings
  updateSettingsSchema,
  // Tautulli import
  tautulliImportSchema,
} from './schemas.js';

// Schema input type exports
export type {
  LoginInput,
  CallbackInput,
  CreateServerInput,
  UpdateUserInput,
  SessionQueryInput,
  CreateRuleInput,
  UpdateRuleInput,
  ViolationQueryInput,
  StatsQueryInput,
  LocationStatsQueryInput,
  UpdateSettingsInput,
  TautulliImportInput,
} from './schemas.js';

// Constant exports
export {
  RULE_DEFAULTS,
  RULE_DISPLAY_NAMES,
  SEVERITY_LEVELS,
  WS_EVENTS,
  REDIS_KEYS,
  CACHE_TTL,
  NOTIFICATION_EVENTS,
  API_VERSION,
  API_BASE_PATH,
  JWT_CONFIG,
  POLLING_INTERVALS,
  PAGINATION,
  GEOIP_CONFIG,
} from './constants.js';
