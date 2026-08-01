/**
 * Map in-app / push notification type + data → destination screen.
 * Keep in sync with web notifications-center.js resolveNotificationRoute.
 */

export type NotificationSubsection = 'timeoff' | 'swap' | 'callout' | 'availability' | 'schedule';

export type NotificationRoute = {
  screen: 'actions' | 'availability' | 'schedule';
  subsection?: NotificationSubsection;
  requestId?: string | null;
  weekMondayIso?: string | null;
};

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

/** Map staff_requests.type (and aliases) → Actions chip / subsection. */
export function subsectionFromRequestType(requestType: string | null | undefined): NotificationSubsection | null {
  const t = String(requestType || '')
    .trim()
    .toLowerCase();
  if (t === 'callout' || t === 'callout_request') return 'callout';
  if (t === 'timeoff' || t === 'vacation' || t === 'sick' || t === 'pto') return 'timeoff';
  if (t === 'swap' || t === 'shift_swap') return 'swap';
  if (t === 'availability') return 'availability';
  return null;
}

export function resolveNotificationRoute(
  type: string | null | undefined,
  data: unknown
): NotificationRoute | null {
  const d = asRecord(data);
  const notifType = String(type || d.type || '')
    .trim()
    .toLowerCase();
  const requestType = str(d.requestType || d.request_type);
  const requestId = str(d.requestId || d.request_id || d.staffRequestId || d.staff_request_id) || null;
  const weekMondayIso = str(d.weekMondayIso || d.week_monday_iso).slice(0, 10) || null;
  const explicit = str(d.subsection || d.screen).toLowerCase();

  let subsection: NotificationSubsection | null =
    explicit === 'timeoff' ||
    explicit === 'swap' ||
    explicit === 'callout' ||
    explicit === 'availability' ||
    explicit === 'schedule'
      ? (explicit as NotificationSubsection)
      : subsectionFromRequestType(requestType);

  if (!subsection) {
    if (notifType === 'availability_submitted') subsection = 'availability';
    else if (notifType === 'schedule_published') subsection = 'schedule';
    else if (notifType === 'swap_offer_targeted' || notifType.indexOf('swap') >= 0) subsection = 'swap';
    else if (notifType.indexOf('callout') >= 0) subsection = 'callout';
    else if (notifType.indexOf('timeoff') >= 0 || notifType.indexOf('vacation') >= 0 || notifType.indexOf('sick') >= 0) {
      subsection = 'timeoff';
    }
  }

  if (!subsection) return null;

  if (subsection === 'availability') {
    return { screen: 'availability', subsection, requestId };
  }
  if (subsection === 'schedule') {
    return {
      screen: 'schedule',
      subsection,
      requestId,
      weekMondayIso: weekMondayIso && /^\d{4}-\d{2}-\d{2}$/.test(weekMondayIso) ? weekMondayIso : null,
    };
  }
  return {
    screen: 'actions',
    subsection,
    requestId,
  };
}

/** Expo Router href for manager / employee tabs. */
export function hrefForNotificationRoute(
  role: 'manager' | 'admin' | 'employee' | null | undefined,
  route: NotificationRoute
): string {
  const managerLike = role === 'manager' || role === 'admin';
  if (route.screen === 'availability') {
    return managerLike ? '/manager/availability' : '/employee/availability';
  }
  if (route.screen === 'schedule') {
    const base = managerLike ? '/manager/schedule' : '/employee/schedule';
    if (route.weekMondayIso) return `${base}?weekMondayIso=${encodeURIComponent(route.weekMondayIso)}`;
    return base;
  }
  const sub = route.subsection || 'timeoff';
  const base = managerLike ? '/manager/requests' : '/employee/actions';
  const q = new URLSearchParams();
  q.set('subsection', sub);
  if (route.requestId) q.set('requestId', route.requestId);
  return `${base}?${q.toString()}`;
}
