export type EmployeeRow = {
  id: string;
  authUserId?: string;
  firstName: string;
  lastName: string;
  displayName: string;
  staffType: string;
  phone: string;
  /** Account / profile email (not the sign-in username). */
  email?: string;
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

export function mapEmployeeFromDb(row: Record<string, unknown>): EmployeeRow | null {
  if (!row?.id) return null;
  const ur = (row.usual_restaurant as string) || 'rp-9';
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

  return {
    id: String(row.id),
    authUserId: row.auth_user_id ? String(row.auth_user_id) : undefined,
    firstName,
    lastName,
    displayName,
    staffType: String(row.staff_type ?? 'Kitchen'),
    phone: String(row.phone ?? ''),
    email: emailFromCol || emailFromMeta || undefined,
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
