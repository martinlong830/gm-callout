export type EmployeeRow = {
  id: string;
  authUserId?: string;
  firstName: string;
  lastName: string;
  displayName: string;
  staffType: string;
  phone: string;
  usualRestaurant: string;
  hourlyRate?: number;
  tipPoint?: number;
  clockPin?: string;
  weeklyGrid: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCloudEmployeeId(id: string): boolean {
  return UUID_RE.test(String(id || ''));
}

export function mapEmployeeFromDb(row: Record<string, unknown>): EmployeeRow | null {
  if (!row?.id) return null;
  const ur = (row.usual_restaurant as string) || 'rp-9';
  let hourlyRate: number | undefined;
  if (row.hourly_rate != null && !Number.isNaN(Number(row.hourly_rate))) {
    hourlyRate = Math.round(Number(row.hourly_rate) * 100) / 100;
  }
  const meta = (row.meta as Record<string, unknown>) ?? {};
  let tipPoint: number | undefined;
  const metaTip = meta.tipPoint;
  if (metaTip != null && !Number.isNaN(Number(metaTip))) {
    tipPoint = Number(metaTip);
  }
  const clockPin = row.clock_pin != null ? String(row.clock_pin).trim() : undefined;
  return {
    id: String(row.id),
    authUserId: row.auth_user_id ? String(row.auth_user_id) : undefined,
    firstName: String(row.first_name ?? ''),
    lastName: String(row.last_name ?? ''),
    displayName: String(row.display_name ?? '').trim() || 'Staff',
    staffType: String(row.staff_type ?? 'Kitchen'),
    phone: String(row.phone ?? ''),
    usualRestaurant: ur === 'both' ? 'both' : ur,
    hourlyRate,
    tipPoint,
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

export function employeeDisplayName(e: EmployeeRow): string {
  return e.displayName || `${e.firstName} ${e.lastName}`.trim();
}

const STAFF_LABELS: Record<string, string> = {
  Kitchen: 'Back of the House',
  Bartender: 'Front of the House',
  Server: 'Delivery/Dishwasher',
};

export function staffTypeLabel(code: string): string {
  return STAFF_LABELS[code] || code || 'Staff';
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
