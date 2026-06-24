/**
 * 前端共享 TypeScript 类型：覆盖用户、模块、权限、通知和同步状态。
 */
export type Role = 'admin' | 'editor' | 'viewer';
export type PlatformKey = 'dingtalk' | 'feishu';
export type ModuleCategory = 'project' | 'staff' | 'todo';
export type FieldType = 'text' | 'number' | 'date' | 'status' | 'link' | 'staff' | 'formula' | 'hidden';
export type PermissionSubjectType = 'role' | 'user';

export interface User {
  id: number;
  username: string;
  role: Role;
  displayName: string;
  dataSourceId: number;
  platform: PlatformKey;
  dataSourceName: string;
  provider?: PlatformKey | 'local';
}

export interface ManagedUser {
  id: number;
  username: string;
  loginName?: string;
  displayName: string;
  role: Role;
  enabled: boolean;
  defaultDataSourceId?: number | null;
  defaultDataSourceName?: string;
  hasLocalLogin?: boolean;
  hasEnterpriseLogin?: boolean;
  identityProviders?: PlatformKey[];
  loginMethod?: 'local' | 'enterprise' | 'both' | 'none';
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateManagedUserPayload {
  loginName: string;
  username?: string;
  password: string;
  displayName: string;
  role: Role;
  enabled: boolean;
  defaultDataSourceId?: number | null;
}

export interface UpdateManagedUserPayload {
  id: number;
  loginName?: string;
  displayName: string;
  role: Role;
  enabled: boolean;
  defaultDataSourceId?: number | null;
  newPassword?: string;
  resetPassword?: boolean;
}

export interface DataSourcePlatform {
  key: PlatformKey;
  label: string;
}

export interface DataSourceInstance {
  id?: number;
  name: string;
  platform: PlatformKey;
  config: Record<string, string>;
  ownerUserId?: number | null;
  enabled: boolean;
  sortOrder: number;
  staffTemplateDataSourceId?: number | null;
}

export interface StaffMember {
  key: string;
  userId?: number | null;
  username?: string;
  displayName: string;
  source: 'enterprise' | 'manual';
  product: boolean;
  tester: boolean;
  developer: boolean;
  enabled: boolean;
  sortOrder: number;
}

export interface StaffMembersResponse {
  dataSourceId: number;
  members: StaffMember[];
  options: {
    product: string[];
    tester: string[];
    developer: string[];
  };
  copied?: number;
}

export interface ModuleField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  hidden?: boolean;
  formula?: boolean;
  staffRole?: 'product' | 'tester' | 'developer';
}

export interface ModuleConfig {
  id?: number;
  key: string;
  title: string;
  category: ModuleCategory;
  dataSourceId?: number;
  sheetName: string;
  sheetId?: string;
  headerRow: number;
  dataStartRow: number;
  editable: boolean;
  enabled: boolean;
  sortOrder: number;
  referenceModuleKey?: string;
  fields: ModuleField[];
  canView?: boolean;
  canEdit?: boolean;
  canCreate?: boolean;
  canUpdate?: boolean;
  canDelete?: boolean;
}

export interface ModulePermission {
  moduleKey: string;
  moduleTitle: string;
  category: ModuleCategory;
  explicit?: boolean;
  canView: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export interface SheetRow {
  id: string;
  rowNumber?: number;
  [key: string]: string | number | undefined;
}

export interface NotificationSettings {
  channel: 'dingtalk_robot' | 'feishu_robot';
  enabled: boolean;
  dingtalkEnabled: boolean;
  feishuEnabled: boolean;
  webhookUrl: string;
  secret: string;
  dingtalkWebhookUrl: string;
  dingtalkSecret: string;
  feishuWebhookUrl: string;
  feishuSecret: string;
  keywords: string[];
  scheduledTime: string;
  lastScheduledDate?: string;
}

export interface NotificationUserSettings {
  enabled: boolean;
  scheduledTime: string;
  lastScheduledDate?: string;
}

export interface NotificationLog {
  id: number;
  channel: string;
  action: string;
  actionText?: string;
  status: string;
  user_id?: number;
  user_display_name?: string;
  message?: string;
  payload?: string;
  created_at: string;
  createdAtText?: string;
}

export interface NotificationSendResult {
  channel: 'dingtalk_robot' | 'feishu_robot';
  status: 'success' | 'failed';
  message?: string;
}

export interface ApiUsageSummary {
  todayCalls: number;
  monthCalls: number;
  todayFailures: number;
  monthFailures: number;
  todayTimeouts: number;
  monthTimeouts: number;
  todayCacheHits: number;
  monthCacheHits: number;
  cacheHitRate: number;
  monthlyWarnLimit: number;
  warnLevel: 'ok' | 'warning' | 'danger';
}

export interface SyncOverview {
  rows: {
    total: number;
    pending: number;
    failed: number;
    synced: number;
  };
  jobs: Array<Record<string, string | number | null>>;
  memberLogs: Array<Record<string, string | number | null>>;
}

export interface DingTalkSyncSettings {
  enabled: boolean;
  dingtalkEnabled: boolean;
  feishuEnabled: boolean;
  scheduledTime: string;
  startupSyncEnabled: boolean;
  startupDelayMs: number;
}

export interface RuntimeSettings {
  publicBaseUrl: string;
  frontendBaseUrl: string;
  resolvedPublicBaseUrl: string;
  resolvedFrontendBaseUrl: string;
  oauthRequestTimeout: number;
  oauthRequestRetries: number;
  currentAccessBaseUrl?: string;
}

export interface PlatformConfigs {
  dingtalk: {
    appKey: string;
    appSecret: string;
    corpId: string;
    realmCorpId: string;
    baseUrl: string;
    operatorId: string;
  };
  feishu: {
    appId: string;
    appSecret: string;
    baseUrl: string;
  };
}
