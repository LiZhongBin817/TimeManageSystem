import { AuthUser } from '../auth';

type RowLike = Record<string, unknown>;

const developerSeparators = /[、，,\s;；/|]+/;

export function isProjectDataRestricted(user: AuthUser) {
  return user.role !== 'admin';
}

export function developerNameForUser(user: AuthUser) {
  return String(user.displayName || user.username || '').trim();
}

export function splitDeveloperNames(value: unknown) {
  return String(value || '')
    .split(developerSeparators)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isOwnProjectRow(user: AuthUser, row: RowLike | undefined) {
  if (!isProjectDataRestricted(user)) return true;
  if (!row) return false;
  const ownName = developerNameForUser(user);
  if (!ownName) return false;
  return splitDeveloperNames(row.developer).includes(ownName);
}

export function filterProjectRowsForUser<T extends RowLike>(user: AuthUser, rows: T[]) {
  if (!isProjectDataRestricted(user)) return rows;
  return rows.filter((row) => isOwnProjectRow(user, row));
}

export function forceOwnDeveloper<T extends RowLike>(user: AuthUser, payload: T) {
  if (!isProjectDataRestricted(user)) return payload;
  return {
    ...payload,
    developer: developerNameForUser(user)
  };
}

export function assertOwnDeveloperPayload(user: AuthUser, payload: RowLike) {
  if (!isProjectDataRestricted(user)) return;
  if (!isOwnProjectRow(user, payload)) {
    throw new Error('只能维护研发人员为自己的项目数据');
  }
}
