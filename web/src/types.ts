export type Role = 'admin' | 'editor' | 'viewer';
export type PlatformKey = 'dingtalk' | 'feishu';
export type ModuleCategory = 'project' | 'staff' | 'todo';
export type FieldType = 'text' | 'number' | 'date' | 'status' | 'link' | 'staff' | 'formula' | 'hidden';

export interface User {
  id: number;
  username: string;
  role: Role;
  displayName: string;
  dataSourceId: number;
  platform: PlatformKey;
  dataSourceName: string;
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
  fields: ModuleField[];
  canEdit?: boolean;
}

export interface SheetRow {
  id: string;
  rowNumber?: number;
  [key: string]: string | number | undefined;
}
