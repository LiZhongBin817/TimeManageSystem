export type {
  Role,
  ModuleField,
  ModuleConfig,
  DataSourceInstance,
  ModuleCategory
} from './configStore';

export {
  canConfigure,
  canEdit,
  canRead,
  findModule,
  getDataSource,
  listDataSources,
  listModules,
  replaceModuleFields,
  rolePermissions,
  saveDataSource,
  saveModule,
  updateModuleSheetId
} from './configStore';

export type ModuleKey = string;
