export type EmployeeRow = {
  id: string;
  authUserId?: string;
  firstName: string;
  lastName: string;
  displayName: string;
  staffType: string;
  employmentStatus?: 'part-time' | 'full-time';
  phone: string;
  /** Account / profile email (not the sign-in username). */
  email?: string;
  usualRestaurant: string;
  hourlyRate?: number;
  tipPoint?: number;
  /** Delivery/dishwasher tip take-home factor (0–1), e.g. 0.95. */
  deliveryTipRetention?: number;
  clockPin?: string;
  weeklyGrid: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCloudEmployeeId(id: string): boolean {
  return UUID_RE.test(String(id || ''));
}

const ROSTER_LEGACY_DISPLAY_RENAMES: Array<{
  from: string[];
  display: string;
  first: string;
  last: string;
}> = [
  {
    from: ['ANGELYN GELLA', 'ANGEL GELLA'],
    display: 'MAEVE WILLIAMS',
    first: 'MAEVE',
    last: 'WILLIAMS',
  },
  {
    from: ['JONG SARDUA'],
    display: 'JON ARELLANO',
    first: 'JON',
    last: 'ARELLANO',
  },
  {
    from: ['SIED SUMOG - OY', 'SEID SUMOG - OY', 'SIED SUMOG-OY', 'SEID SUMOG-OY'],
    display: 'CHARLES JAKOB ZACANI',
    first: 'CHARLES JAKOB',
    last: 'ZACANI',
  },
];

function normRosterNameKey(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function knownRosterDisplayRename(label: string): {
  display: string;
  first: string;
  last: string;
  from: string[];
} | null {
  const key = normRosterNameKey(label);
  if (!key) return null;
  for (const rule of ROSTER_LEGACY_DISPLAY_RENAMES) {
    if (rule.from.some((f) => normRosterNameKey(f) === key)) {
      return { display: rule.display, first: rule.first, last: rule.last, from: rule.from };
    }
  }
  return null;
}

export function normalizeEmployeeStaffType(raw: unknown): 'Kitchen' | 'Bartender' | 'Server' | null {
  const s = String(raw ?? '').trim();
  if (s === 'Kitchen' || s === 'Bartender' || s === 'Server') return s;
  const lower = s.toLowerCase();
  if (lower === 'kitchen' || lower === 'boh' || lower === 'back of the house' || lower === 'back of house') {
    return 'Kitchen';
  }
  if (lower === 'bartender' || lower === 'foh' || lower === 'front of the house' || lower === 'front of house') {
    return 'Bartender';
  }
  if (lower === 'server' || lower === 'delivery' || lower === 'dishwasher' || lower === 'delivery/dishwasher') {
    return 'Server';
  }
  return null;
}

export function normalizeEmploymentStatus(raw: unknown): 'part-time' | 'full-time' {
  return String(raw ?? '').trim().toLowerCase() === 'part-time' ? 'part-time' : 'full-time';
}

export function mapEmployeeFromDb(row: Record<string, unknown>): EmployeeRow | null {
  if (!row?.id) return null;
  const urRaw = String(row.usual_restaurant ?? '').trim();
  const ur = urRaw || 'rp-9';
  let hourlyRate: number | undefined;
  if (row.hourly_rate != null && !Number.isNaN(Number(row.hourly_rate))) {
    hourlyRate = Math.round(Number(row.hourly_rate) * 100) / 100;
  }
  const metaRaw = (row.meta as Record<string, unknown>) ?? {};
  const meta: Record<string, unknown> = { ...metaRaw };
  let tipPoint: number | undefined;
  const metaTip = meta.tipPoint;
  if (metaTip != null && !Number.isNaN(Number(metaTip))) {
    tipPoint = Number(metaTip);
  }
  let deliveryTipRetention: number | undefined;
  const metaRet = meta.deliveryTipRetention;
  if (metaRet != null && !Number.isNaN(Number(metaRet))) {
    const n = Number(metaRet);
    deliveryTipRetention = n > 1 && n <= 100 ? Math.round((n / 100) * 10000) / 10000 : Math.round(n * 10000) / 10000;
  }
  const clockPin = row.clock_pin != null ? String(row.clock_pin).trim() : undefined;
  const emailFromCol = row.email != null ? String(row.email).trim() : '';
  const emailFromMeta =
    meta.email != null ? String(meta.email).trim() : '';

  let firstName = String(row.first_name ?? '');
  let lastName = String(row.last_name ?? '');
  let displayName = String(row.display_name ?? '').trim() || 'Staff';
  const rename = knownRosterDisplayRename(displayName) || knownRosterDisplayRename(`${firstName} ${lastName}`);
  if (rename) {
    displayName = rename.display;
    firstName = rename.first;
    lastName = rename.last;
    const aliases = Array.isArray(meta.scheduleAliases)
      ? [...(meta.scheduleAliases as string[])]
      : [];
    rename.from.forEach((f) => {
      if (f && !aliases.some((a) => String(a).trim().toLowerCase() === f.toLowerCase())) {
        aliases.push(f);
      }
    });
    meta.scheduleAliases = aliases;
  }

  const staffType = normalizeEmployeeStaffType(row.staff_type) || String(row.staff_type ?? 'Kitchen');

  if (staffType === 'Server' && deliveryTipRetention == null) {
    const draft = {
      staffType,
      usualRestaurant: ur === 'both' ? 'both' : ur,
      firstName,
      lastName,
      displayName,
      meta,
    };
    const def = defaultDeliveryTipRetentionForEmployee(draft);
    if (def != null) {
      deliveryTipRetention = def;
      meta.deliveryTipRetention = def;
    }
  }

  return {
    id: String(row.id),
    authUserId: row.auth_user_id ? String(row.auth_user_id) : undefined,
    firstName,
    lastName,
    displayName,
    staffType,
    employmentStatus: normalizeEmploymentStatus(row.employment_status),
    phone: String(row.phone ?? ''),
    email: emailFromCol || emailFromMeta || undefined,
    usualRestaurant: ur === 'both' ? 'both' : ur,
    hourlyRate,
    tipPoint,
    deliveryTipRetention,
    clockPin: clockPin || undefined,
    weeklyGrid: (row.weekly_grid as Record<string, unknown>) ?? {},
    meta,
  };
}

/** Matches web team card PIN line. */
export function employeeClockPinLine(emp: EmployeeRow): string | null {
  if (emp.clockPin) return emp.clockPin;
  if (isCloudEmployeeId(emp.id)) return 'Not assigned';
  return null;
}

export function employeeBreakPolicyLabel(emp: EmployeeRow): string {
  const bp = emp.meta?.breakPolicy;
  return bp === 'paid' ? 'Paid — break counts as work time' : 'Unpaid — break deducted from paid hours';
}

export function formatHourlyRate(emp: EmployeeRow): string {
  if (emp.hourlyRate == null || Number.isNaN(emp.hourlyRate)) return '—';
  return `$${emp.hourlyRate.toFixed(2)}/hr`;
}

export function formatTipPoint(emp: EmployeeRow): string {
  if (emp.tipPoint == null || Number.isNaN(emp.tipPoint)) return '—';
  return String(emp.tipPoint);
}

/** Accept 0.95 or 95 → store as factor 0–1. */
export function normalizeDeliveryTipRetention(val: unknown): number | null {
  if (val == null || val === '') return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val).trim());
  if (!Number.isFinite(n) || n < 0) return null;
  let factor = n;
  if (factor > 1) {
    if (factor > 100) return null;
    factor = factor / 100;
  }
  return Math.round(factor * 10000) / 10000;
}

function isJuanEspinobarrosEmployee(emp: {
  firstName?: string;
  lastName?: string;
  displayName?: string;
}): boolean {
  const dn = String(emp.displayName || `${emp.firstName || ''} ${emp.lastName || ''}`)
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const ln = String(emp.lastName || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\bESPINOBARROS\b/.test(dn) || /\bESPINOBARROS\b/.test(ln)) return true;
  return /\bJUAN\b/.test(dn) && /\bESPINO/.test(dn);
}

export function defaultDeliveryTipRetentionForEmployee(emp: {
  staffType?: string;
  usualRestaurant?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  meta?: Record<string, unknown>;
}): number | null {
  if (!emp || emp.staffType !== 'Server') return null;
  if (isJuanEspinobarrosEmployee(emp)) return 0.95;
  let loc = emp.usualRestaurant;
  if (loc === 'both') {
    const meta = emp.meta && typeof emp.meta === 'object' ? emp.meta : {};
    loc = String(meta.primaryLocationId || meta.primaryRestaurantId || 'rp-9');
  }
  return loc === 'rp-8' ? 0.8 : 0.95;
}

export function deliveryTipRetentionFactorForEmployee(emp: EmployeeRow | null | undefined): number | null {
  if (!emp || emp.staffType !== 'Server') return null;
  const raw =
    emp.deliveryTipRetention != null
      ? emp.deliveryTipRetention
      : emp.meta?.deliveryTipRetention != null
        ? emp.meta.deliveryTipRetention
        : null;
  const n = normalizeDeliveryTipRetention(raw);
  if (n != null) return n;
  return defaultDeliveryTipRetentionForEmployee(emp);
}

/** Percent (e.g. 95) for dishwasher tip net math / labels. */
export function tipTakehomePctForDishwasherEmployee(
  emp: EmployeeRow | null | undefined,
  restaurantId?: string | null,
  storePctFallback?: number
): number {
  const factor = deliveryTipRetentionFactorForEmployee(emp ?? null);
  if (factor != null) return Math.round(factor * 10000) / 100;
  if (storePctFallback != null && Number.isFinite(storePctFallback)) return storePctFallback;
  return restaurantId === 'rp-8' ? 80 : 95;
}

export function employeeDisplayName(e: EmployeeRow): string {
  return e.displayName || `${e.firstName} ${e.lastName}`.trim();
}

const STAFF_LABELS: Record<string, string> = {
  Kitchen: 'Back of the House',
  Bartender: 'Front of the House',
  Server: 'Delivery/Dishwasher',
};

export function staffTypeLabel(code: string): string {
  if (!code) return 'Unassigned';
  return STAFF_LABELS[code] || code || 'Unassigned';
}

const LOCATION_NAMES: Record<string, string> = {
  both: 'Both locations',
  'rp-9': 'Red Poke 598 9th Ave',
  'rp-8': 'Red Poke 885 8th Ave',
};

/** Matches web `employeeLocationLine` for the single-store id. */
export function employeeUsualLocationLine(usualRestaurant: string): string {
  const u = usualRestaurant || 'rp-9';
  if (u === 'both') return LOCATION_NAMES.both;
  return LOCATION_NAMES[u] || u;
}

export function employeeIsMultiLocation(usualRestaurant: string): boolean {
  return String(usualRestaurant || '') === 'both';
}

/**
 * Team location eligibility for schedule views (matches manager assignment pools).
 * `usualRestaurant === 'both'` → all stores; otherwise only that restaurant id.
 */
export function employeeMatchesUsualLocation(
  usualRestaurant: string | null | undefined,
  restaurantId: string
): boolean {
  const u = usualRestaurant || 'both';
  if (u === 'both') return true;
  return u === restaurantId;
}

/** Restaurants an employee may open in schedule views (Team `usualRestaurant`). */
export function filterRestaurantsForUsualLocation<T extends { id: string }>(
  restaurants: T[],
  usualRestaurant: string | null | undefined
): T[] {
  const allowed = restaurants.filter((r) => employeeMatchesUsualLocation(usualRestaurant, r.id));
  return allowed.length ? allowed : restaurants;
}

/**
 * Employee schedule switcher: home/both stores plus the pay-week borrow store
 * (web `employeeMatchesScheduleRestaurant` includes week-borrow).
 */
export function filterRestaurantsForEmployeeSchedule<T extends { id: string }>(
  restaurants: T[],
  usualRestaurant: string | null | undefined,
  borrowedRestaurantId?: string | null
): T[] {
  const usual = filterRestaurantsForUsualLocation(restaurants, usualRestaurant);
  const extraId =
    borrowedRestaurantId === 'rp-8' || borrowedRestaurantId === 'rp-9'
      ? borrowedRestaurantId
      : null;
  if (!extraId || usual.some((r) => r.id === extraId)) return usual;
  const extra = restaurants.find((r) => r.id === extraId);
  return extra ? [...usual, extra] : usual;
}

/** Canonical primary store id for multi-location staff (`meta.primaryLocationId`). */
export function employeePrimaryLocationId(emp: EmployeeRow | null | undefined): string | null {
  if (!emp || !employeeIsMultiLocation(emp.usualRestaurant)) return null;
  const meta = emp.meta && typeof emp.meta === 'object' ? emp.meta : {};
  const raw = meta.primaryLocationId ?? meta.primaryRestaurantId;
  const id = raw != null ? String(raw).trim() : '';
  if (id === 'rp-8' || id === 'rp-9') return id;
  return null;
}

/**
 * Preferred "main" store for schedule restaurant pills (leftmost).
 * Single-store usualRestaurant → that store; both → primary when set; else null
 * (keep default list order: rp-9 then rp-8). Applies to managers and admins alike —
 * unlike managerManagedRestaurantId, admins still get their primary for display order.
 */
export function managerScheduleMainRestaurantId(
  emp: EmployeeRow | null | undefined
): string | null {
  if (!emp) return null;
  const home = emp.usualRestaurant || 'both';
  if (home === 'rp-8' || home === 'rp-9') return home;
  if (home === 'both') return employeePrimaryLocationId(emp);
  return null;
}

/**
 * Schedule store switcher order: preferred main first; remaining keep input order.
 * Does not follow the currently selected store — switching tabs must not reshuffle.
 */
export function orderRestaurantsMainFirst<T extends { id: string }>(
  restaurants: T[],
  mainId: string | null | undefined
): T[] {
  if (!mainId || restaurants.length < 2) return restaurants.slice();
  const ix = restaurants.findIndex((r) => r.id === mainId);
  if (ix <= 0) return restaurants.slice();
  const next = restaurants.slice();
  const [main] = next.splice(ix, 1);
  next.unshift(main);
  return next;
}

/**
 * Store a manager may manage (`rp-8` / `rp-9`), or `null` for company-wide (both editable).
 * Admins are always company-wide. Single-store usualRestaurant → that store; multi-store →
 * primaryLocationId when set; both without primary / no linked roster → unrestricted.
 */
export function managerManagedRestaurantId(
  emp: EmployeeRow | null | undefined,
  role?: string | null
): string | null {
  if (role === 'admin') return null;
  if (!emp) return null;
  const home = emp.usualRestaurant || 'both';
  if (home === 'rp-8' || home === 'rp-9') return home;
  if (home === 'both') return employeePrimaryLocationId(emp);
  return null;
}

/**
 * Roster visibility for a store-scoped manager (mirrors timecards single-store membership).
 * Unrestricted managers (`scopeRid` null) see everyone.
 */
export function employeeVisibleInManagerStoreScope(
  emp: EmployeeRow | null | undefined,
  scopeRid: string | null | undefined
): boolean {
  if (!scopeRid) return true;
  if (!emp) return false;
  const home = emp.usualRestaurant || 'rp-9';
  if (home === scopeRid) return true;
  if (home === 'both') return employeePrimaryLocationId(emp) === scopeRid;
  return false;
}

/** True when the manager may edit the given restaurant's schedule (view always allowed). */
export function managerCanEditRestaurant(
  emp: EmployeeRow | null | undefined,
  restaurantId: string,
  role?: string | null
): boolean {
  const scope = managerManagedRestaurantId(emp, role);
  if (!scope) return true;
  return scope === restaurantId;
}
