-- Per-user employee Messages UI state (threads + messages). Web + mobile share via user_id.

create table if not exists public.employee_chat_store (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb not null default '{"version":1,"activeThreadId":null,"threads":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists employee_chat_store_set_updated_at on public.employee_chat_store;
create trigger employee_chat_store_set_updated_at
before update on public.employee_chat_store
for each row
execute procedure public.set_updated_at();

alter table public.employee_chat_store enable row level security;

drop policy if exists "employee_chat_store_select" on public.employee_chat_store;
create policy "employee_chat_store_select"
on public.employee_chat_store for select
to authenticated
using (user_id = auth.uid() or public.is_manager(auth.uid()));

drop policy if exists "employee_chat_store_insert" on public.employee_chat_store;
create policy "employee_chat_store_insert"
on public.employee_chat_store for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "employee_chat_store_update" on public.employee_chat_store;
create policy "employee_chat_store_update"
on public.employee_chat_store for update
to authenticated
using (user_id = auth.uid() or public.is_manager(auth.uid()))
with check (user_id = auth.uid() or public.is_manager(auth.uid()));

drop policy if exists "employee_chat_store_delete" on public.employee_chat_store;
create policy "employee_chat_store_delete"
on public.employee_chat_store for delete
to authenticated
using (user_id = auth.uid() or public.is_manager(auth.uid()));
