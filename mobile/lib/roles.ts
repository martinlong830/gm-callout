export type AppRole = 'admin' | 'manager' | 'employee';

export function isManagerLikeRole(role: string | null | undefined): boolean {
  return role === 'manager' || role === 'admin';
}

export function isAdminRole(role: string | null | undefined): boolean {
  return role === 'admin';
}

export function isAppRole(r: string | undefined | null): r is AppRole {
  return r === 'manager' || r === 'employee' || r === 'admin';
}
