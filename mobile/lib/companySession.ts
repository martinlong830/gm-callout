import AsyncStorage from '@react-native-async-storage/async-storage';

const COMPANY_ID_KEY = 'gm-callout-company-id';
const TEAM_STATE_ID_KEY = 'gm-callout-team-state-id';
const ACCESS_CODE_KEY = 'gm-callout-access-code';
const COMPANY_NAME_KEY = 'gm-callout-company-name';
const COMPANY_RESTAURANTS_KEY = 'gm-callout-company-restaurants';

export const RED_POKE_COMPANY_ID = 'a0000000-0000-4000-8000-000000000001';

export type CompanySessionPayload = {
  companyId?: string;
  teamStateId?: string;
  accessCode?: string;
  companyName?: string;
  restaurantsConfig?: unknown[];
};

export async function storeCompanySession(payload: CompanySessionPayload): Promise<void> {
  const ops: Promise<void>[] = [];
  if (payload.companyId) ops.push(AsyncStorage.setItem(COMPANY_ID_KEY, payload.companyId));
  if (payload.teamStateId) ops.push(AsyncStorage.setItem(TEAM_STATE_ID_KEY, payload.teamStateId));
  if (payload.accessCode) ops.push(AsyncStorage.setItem(ACCESS_CODE_KEY, payload.accessCode));
  if (payload.companyName) ops.push(AsyncStorage.setItem(COMPANY_NAME_KEY, payload.companyName));
  if (payload.restaurantsConfig && payload.restaurantsConfig.length) {
    ops.push(AsyncStorage.setItem(COMPANY_RESTAURANTS_KEY, JSON.stringify(payload.restaurantsConfig)));
  }
  await Promise.all(ops);
}

export async function readStoredCompanyId(): Promise<string> {
  return (await AsyncStorage.getItem(COMPANY_ID_KEY)) || '';
}

/** Resolved team_state row id (company UUID or legacy `main`). */
export async function readStoredTeamStateId(): Promise<string> {
  const stored = (await AsyncStorage.getItem(TEAM_STATE_ID_KEY)) || '';
  return stored.trim() || 'main';
}

export async function readStoredAccessCode(): Promise<string> {
  return (await AsyncStorage.getItem(ACCESS_CODE_KEY)) || '';
}

export async function readStoredCompanyName(): Promise<string> {
  return (await AsyncStorage.getItem(COMPANY_NAME_KEY)) || '';
}

export async function clearCompanySession(): Promise<void> {
  await AsyncStorage.multiRemove([
    COMPANY_ID_KEY,
    TEAM_STATE_ID_KEY,
    ACCESS_CODE_KEY,
    COMPANY_NAME_KEY,
    COMPANY_RESTAURANTS_KEY,
  ]);
}

export function isRedPokeAccessCode(code: string): boolean {
  return (
    String(code || '')
      .trim()
      .toLowerCase() === 'redpoke'
  );
}

export async function isRedPokeCompanySession(): Promise<boolean> {
  const code = await readStoredAccessCode();
  if (isRedPokeAccessCode(code)) return true;
  const cid = await readStoredCompanyId();
  if (cid === RED_POKE_COMPANY_ID) return true;
  const teamStateId = await readStoredTeamStateId();
  return teamStateId === 'main';
}

/** Company UUID for roster scoping (Red Poke fallback on legacy main). */
export async function resolveCompanyIdForEmployees(): Promise<string> {
  const cid = (await readStoredCompanyId()).trim();
  if (cid) return cid;
  if (await isRedPokeCompanySession()) return RED_POKE_COMPANY_ID;
  return '';
}
