-- Public employee profile photos (manager upload, team read).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'employee-photos',
  'employee-photos',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "employee_photos_public_read" on storage.objects;
create policy "employee_photos_public_read"
on storage.objects for select
to authenticated, anon
using (bucket_id = 'employee-photos');

drop policy if exists "employee_photos_manager_insert" on storage.objects;
create policy "employee_photos_manager_insert"
on storage.objects for insert
to authenticated
with check (bucket_id = 'employee-photos' and public.is_manager(auth.uid()));

drop policy if exists "employee_photos_manager_update" on storage.objects;
create policy "employee_photos_manager_update"
on storage.objects for update
to authenticated
using (bucket_id = 'employee-photos' and public.is_manager(auth.uid()))
with check (bucket_id = 'employee-photos' and public.is_manager(auth.uid()));

drop policy if exists "employee_photos_manager_delete" on storage.objects;
create policy "employee_photos_manager_delete"
on storage.objects for delete
to authenticated
using (bucket_id = 'employee-photos' and public.is_manager(auth.uid()));
