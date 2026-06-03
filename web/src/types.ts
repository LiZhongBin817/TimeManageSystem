export type Role = 'admin' | 'editor' | 'viewer';

export interface User {
  id: number;
  username: string;
  role: Role;
  displayName: string;
}

export interface ModuleField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'status' | 'link' | 'staff';
  required?: boolean;
  staffRole?: 'product' | 'tester' | 'developer';
}

export interface ModuleConfig {
  key: string;
  title: string;
  sheetName: string;
  editable: boolean;
  fields: ModuleField[];
  canEdit?: boolean;
}

export interface SheetRow {
  id: string;
  rowNumber?: number;
  [key: string]: string | number | undefined;
}
