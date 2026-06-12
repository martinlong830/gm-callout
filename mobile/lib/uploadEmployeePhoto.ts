import type { SupabaseClient } from '@supabase/supabase-js';
import { employeeDisplayName, isCloudEmployeeId, type EmployeeRow } from './employees';
import { saveEmployeeRow } from './employeeSave';

const MAX_BYTES = 5 * 1024 * 1024;

function extFromMime(mime: string | undefined): string {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('heic') || m.includes('heif')) return 'jpg';
  return 'jpg';
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

  const updated: EmployeeRow = {
    ...emp,
    meta: { ...(emp.meta ?? {}) },
  };
  updated.meta = updated.meta ?? {};

  if (isCloudEmployeeId(emp.id)) {
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
    const contentType = mimeType || blob.type || 'image/jpeg';
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
  } else {
    return {
      ok: false,
      message: 'Save this employee to the cloud roster before uploading a photo.',
    };
  }

  const saved = await saveEmployeeRow(sb, updated);
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
  const saved = await saveEmployeeRow(sb, updated);
  if (!saved.ok) return saved;
  return { ok: true, employee: updated };
}

/** Human-readable label for upload errors (e.g. missing cloud save). */
export function employeePhotoUploadHint(emp: EmployeeRow): string {
  if (!isCloudEmployeeId(emp.id)) {
    return `Save ${employeeDisplayName(emp)} to the cloud roster before uploading a photo.`;
  }
  return 'Choose a photo from your camera roll (max 5 MB).';
}
