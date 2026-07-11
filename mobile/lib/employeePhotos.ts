import type { ImageSourcePropType } from 'react-native';
import { BUNDLED_EMPLOYEE_PHOTOS } from './employeePhotoBundled';
import type { EmployeeRow } from './employees';
import { employeeDisplayName } from './employees';

function normNameKey(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** File slug for bundled photos (e.g. mark_ong.jpg) — matches web `employeePhotoSlug`. */
export function employeePhotoSlug(emp: EmployeeRow): string {
  if (emp.displayName) {
    return normNameKey(emp.displayName).replace(/\s+/g, '_');
  }
  return normNameKey(employeeDisplayName(emp)).replace(/\s+/g, '_');
}

/** Alternate slugs (display name vs first+last) so bundled files still match. */
export function employeePhotoSlugVariants(emp: EmployeeRow): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const slug = normNameKey(raw).replace(/\s+/g, '_');
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    out.push(slug);
  };
  if (emp.displayName) add(String(emp.displayName));
  add(employeeDisplayName(emp));
  const fn = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
  if (fn) add(fn);
  return out;
}

/** Web app origin for bundled assets/employee-photos (fallback when app bundle has no file). */
export function webAppAssetBase(): string {
  const raw = process.env.EXPO_PUBLIC_GM_WEB_URL ?? '';
  const trimmed = String(raw).trim().replace(/\/$/, '');
  if (trimmed) return trimmed;
  return 'https://gm-callout.onrender.com';
}

export type EmployeePhotoSource =
  | { kind: 'bundled'; source: ImageSourcePropType }
  | { kind: 'uri'; uri: string };

export function employeePhotoSources(emp: EmployeeRow): EmployeePhotoSource[] {
  if (!emp) return [];
  const out: EmployeePhotoSource[] = [];
  const seenUri = new Set<string>();
  const meta = emp.meta ?? {};
  const hideBundled = !!meta.photoHidden;

  const custom =
    meta.photoUrl && meta.photoUseCustom ? String(meta.photoUrl).trim() : '';
  if (custom && (custom.startsWith('data:') || /^https?:\/\//i.test(custom))) {
    out.push({ kind: 'uri', uri: custom });
    seenUri.add(custom);
  }

  // Prefer bundled assets (zero network). Only one remote candidate to avoid
  // roster N×slug×jpg/png speculative downloads that burn Storage/CDN egress.
  const slug = employeePhotoSlug(emp);
  const bundled = BUNDLED_EMPLOYEE_PHOTOS[slug];
  if (bundled) {
    out.push({ kind: 'bundled', source: bundled });
  } else if (!hideBundled && slug) {
    // Try alternate bundled keys without adding remote URLs for each variant.
    for (const alt of employeePhotoSlugVariants(emp)) {
      const altBundled = BUNDLED_EMPLOYEE_PHOTOS[alt];
      if (altBundled) {
        out.push({ kind: 'bundled', source: altBundled });
        break;
      }
    }
    if (!out.some((s) => s.kind === 'bundled')) {
      const jpg = `${webAppAssetBase()}/assets/employee-photos/${slug}.jpg`;
      if (!seenUri.has(jpg)) {
        out.push({ kind: 'uri', uri: jpg });
        seenUri.add(jpg);
      }
    }
  }

  return out;
}

/** @deprecated Use employeePhotoSources — kept for any external callers. */
export function employeePhotoUrlCandidates(emp: EmployeeRow): string[] {
  return employeePhotoSources(emp)
    .filter((s): s is { kind: 'uri'; uri: string } => s.kind === 'uri')
    .map((s) => s.uri);
}

export function employeePhotoInitials(emp: EmployeeRow): string {
  const f = (emp.firstName || '').trim();
  const l = (emp.lastName || '').trim();
  if (f && l) return (f.charAt(0) + l.charAt(0)).toUpperCase();
  const parts = employeeDisplayName(emp).split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }
  return employeeDisplayName(emp).slice(0, 2).toUpperCase() || '?';
}
