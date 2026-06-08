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
  displayName: string;
  role: Role;
  enabled: boolean;
  defaultDataSourceId?: number | null;
  defaultDataSourceName?: string;
  createdAt?: string;
  updatedAt?: string;
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
  enabled: boolean;
  sortOrder: number;
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
  enabled: boolean;
  webhookUrl: string;
  secret: string;
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
