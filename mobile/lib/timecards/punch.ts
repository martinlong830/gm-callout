export function roundDateToNearest5Minutes(d: Date): Date | null {
  if (Number.isNaN(d.getTime())) return null;
  const ms = 5 * 60 * 1000;
  return new Date(Math.round(d.getTime() / ms) * ms);
}

export function scheduledShiftStartAt(isoDate: string, startTime: string): Date | null {
  if (!isoDate || !startTime) return null;
  const parts = String(startTime).split(':');
  const y = parseInt(String(isoDate).slice(0, 4), 10);
  const mo = parseInt(String(isoDate).slice(5, 7), 10) - 1;
  const da = parseInt(String(isoDate).slice(8, 10), 10);
  if (Number.isNaN(y) || Number.isNaN(mo) || Number.isNaN(da)) return null;
  const d = new Date(y, mo, da, parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function normalizePunchTimesForShift(
  clockInIso: string,
  clockOutIso: string,
  shiftIso: string,
  shiftStartTime: string
): { clockInAt: string; clockOutAt: string } {
  const out = { clockInAt: clockInIso, clockOutAt: clockOutIso };
  if (!clockInIso || !clockOutIso) return out;
  const start = scheduledShiftStartAt(shiftIso, shiftStartTime);
  const inD = new Date(clockInIso);
  if (Number.isNaN(inD.getTime())) return out;
  const rin = roundDateToNearest5Minutes(inD);
  if (rin && start && rin.getTime() < start.getTime()) {
    out.clockInAt = start.toISOString();
  } else if (rin) {
    out.clockInAt = rin.toISOString();
  }
  const outD = new Date(clockOutIso);
  if (!Number.isNaN(outD.getTime())) {
    const rout = roundDateToNearest5Minutes(outD);
    if (rout) out.clockOutAt = rout.toISOString();
  }
  return out;
}

export function punchShiftRoundedMinutes(
  clockInAt: string | null | undefined,
  clockOutAt: string | null | undefined,
  shiftStartAtOpt?: Date | string | null
): number {
  const inD = clockInAt ? new Date(clockInAt) : null;
  if (!inD || Number.isNaN(inD.getTime())) return 0;
  let outD = clockOutAt ? new Date(clockOutAt) : new Date();
  if (Number.isNaN(outD.getTime())) outD = new Date();
  let rin = roundDateToNearest5Minutes(inD);
  let shiftStart: Date | null = null;
  if (shiftStartAtOpt instanceof Date) shiftStart = shiftStartAtOpt;
  else if (shiftStartAtOpt) {
    const s = new Date(shiftStartAtOpt);
    shiftStart = Number.isNaN(s.getTime()) ? null : s;
  }
  if (shiftStart && rin && rin.getTime() < shiftStart.getTime()) {
    rin = roundDateToNearest5Minutes(shiftStart);
  }
  const rout = roundDateToNearest5Minutes(outD);
  if (!rin || !rout) return 0;
  return Math.max(0, Math.round((rout.getTime() - rin.getTime()) / 60000));
}

export function formatPunchClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function dateToLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export function localInputToIso(val: string): string | null {
  if (!val.trim()) return null;
  const dt = new Date(val);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

export function parseIsoToDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export function dateToIso(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function formatDateTimePickerLabel(d: Date | null | undefined): string {
  if (!d || Number.isNaN(d.getTime())) return 'Tap to choose';
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Editable text format for manager punch fields (YYYY-MM-DD HH:MM). */
export function formatEditableDateTime(d: Date | null | undefined): string {
  if (!d || Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function parseEditableDateTime(text: string): Date | null {
  const t = String(text || '').trim();
  if (!t) return null;
  const isoLike = t.includes('T') ? t : t.replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T');
  const direct = new Date(isoLike);
  if (!Number.isNaN(direct.getTime())) return direct;
  const slash = t.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?)?$/i
  );
  if (slash) {
    let hour = slash[4] != null ? parseInt(slash[4], 10) : 0;
    const minute = slash[5] != null ? parseInt(slash[5], 10) : 0;
    const ampm = slash[7];
    if (ampm) {
      const upper = ampm.toUpperCase();
      if (upper === 'PM' && hour < 12) hour += 12;
      if (upper === 'AM' && hour === 12) hour = 0;
    }
    const dt = new Date(
      parseInt(slash[3], 10),
      parseInt(slash[1], 10) - 1,
      parseInt(slash[2], 10),
      hour,
      minute,
      0,
      0
    );
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}
