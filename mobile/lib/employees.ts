export type EmployeeRow = {
  id: string;
  authUserId?: string;
  firstName: string;
  lastName: string;
  displayName: string;
  staffType: string;
  phone: string;
  usualRestaurant: string;
  weeklyGrid: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

export function mapEmployeeFromDb(row: Record<string, unknown>): EmployeeRow | null {
  if (!row?.id) return null;
  const ur = (row.usual_restaurant as string) || 'rp-9';
  return {
    id: String(row.id),
    authUserId: row.auth_user_id ? String(row.auth_user_id) : undefined,
    firstName: String(row.first_name ?? ''),
    lastName: String(row.last_name ?? ''),
    displayName: String(row.display_name ?? '').trim() || 'Staff',
    staffType: String(row.staff_type ?? 'Kitchen'),
    phone: String(row.phone ?? ''),
    usualRestaurant: ur === 'both' ? 'both' : ur,
    weeklyGrid: (row.weekly_grid as Record<string, unknown>) ?? {},
    meta: (row.meta as Record<string, unknown>) ?? {},
  };
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
};

/** Matches web `employeeLocationLine` for the single-store id. */
export function employeeUsualLocationLine(usualRestaurant: string): string {
  const u = usualRestaurant || 'rp-9';
  if (u === 'both') return LOCATION_NAMES.both;
  return LOCATION_NAMES[u] || u;
}
