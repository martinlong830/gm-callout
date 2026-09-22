-- Employee photos: allow common camera MIME types. Safe to re-run.

update storage.buckets
set allowed_mime_types = array[
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif'
]
where id = 'employee-photos';

grant execute on function public.is_manager(uuid) to authenticated;
grant execute on function public.is_manager(uuid) to service_role;
