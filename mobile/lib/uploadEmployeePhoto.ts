import type { SupabaseClient } from '@supabase/supabase-js';
import { employeeDisplayName, isCloudEmployeeId, type EmployeeRow } from './employees';

const MAX_BYTES = 5 * 1024 * 1024;

function extFromMime(mime: string | undefined): string {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'jpg';
}

function storageImageContentType(mime: string | undefined, ext: string): string {
  const t = String(mime || '')
    .toLowerCase()
    .trim();
  if (t === 'image/jpg' || t === 'image/pjpeg' || t === 'image/heic' || t === 'image/heif') {
    return 'image/jpeg';
  }
  if (t.startsWith('image/')) return t;
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

async function persistPhotoMeta(
  sb: SupabaseClient,
  empId: string,
  meta: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await sb.from('employees').update({ meta }).eq('id', empId);
  if (error) return { ok: false, message: error.message || 'Could not save photo on the roster.' };
  return { ok: true };
}

export async function uploadEmployeePhotoFromUri(
  sb: SupabaseClient,
  emp: EmployeeRow,
  localUri: string,
  mimeType?: string | null,
  fileSize?: number | null
): Promise<{ ok: true; employee: EmployeeRow; url: string } | { ok: false; message: string }> {
  if (!emp?.id) return { ok: false, message: 'No employee selected.' };
  if (!localUri) return { ok: false, message: 'No image selected.' };
  if (fileSize != null && fileSize > MAX_BYTES) {
    return { ok: false, message: 'Photo must be under 5 MB.' };
  }
  if (!isCloudEmployeeId(emp.id)) {
    return {
      ok: false,
      message: 'Save this employee to the cloud roster before uploading a photo.',
    };
  }

  const updated: EmployeeRow = {
    ...emp,
    meta: { ...(emp.meta ?? {}) },
  };
  updated.meta = updated.meta ?? {};

  let blob: Blob;
  try {
    const res = await fetch(localUri);
    blob = await res.blob();
  } catch {
    return { ok: false, message: 'Could not read the selected image.' };
  }
  if (blob.size > MAX_BYTES) {
    return { ok: false, message: 'Photo must be under 5 MB.' };
  }
  const ext = extFromMime(mimeType ?? blob.type);
  const path = `${emp.id}.${ext}`;
  const contentType = storageImageContentType(mimeType ?? blob.type, ext);
  const up = await sb.storage.from('employee-photos').upload(path, blob, {
    upsert: true,
    contentType,
  });
  if (up.error) {
    return { ok: false, message: up.error.message || 'Upload failed.' };
  }
  const pub = sb.storage.from('employee-photos').getPublicUrl(path);
  updated.meta.photoUrl = `${pub.data.publicUrl}?v=${Date.now()}`;
  updated.meta.photoUseCustom = true;
  delete updated.meta.photoHidden;
  const saved = await persistPhotoMeta(sb, emp.id, updated.meta);
  if (!saved.ok) return saved;
  return { ok: true, employee: updated, url: String(updated.meta.photoUrl || '') };
}

export async function clearEmployeePhoto(
  sb: SupabaseClient,
  emp: EmployeeRow
): Promise<{ ok: true; employee: EmployeeRow } | { ok: false; message: string }> {
  if (!emp?.id) return { ok: false, message: 'No employee selected.' };
  const meta = { ...(emp.meta ?? {}) } as Record<string, unknown>;
  delete meta.photoUrl;
  delete meta.photoUseCustom;
  meta.photoHidden = true;
  const updated: EmployeeRow = { ...emp, meta };
  if (isCloudEmployeeId(emp.id)) {
    const saved = await persistPhotoMeta(sb, emp.id, meta);
    if (!saved.ok) return saved;
  }
  return { ok: true, employee: updated };
}

/** Human-readable label for upload errors (e.g. missing cloud save). */
export function employeePhotoUploadHint(emp: EmployeeRow): string {
  if (!isCloudEmployeeId(emp.id)) {
    return `Save ${employeeDisplayName(emp)} to the cloud roster before uploading a photo.`;
  }
  return 'Choose a photo from your camera roll (max 5 MB).';
}
