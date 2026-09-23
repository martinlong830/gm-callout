-- History panel only needs metadata. Covering index avoids heap fetches of
-- huge schedule_assignments / draft_schedule jsonb when listing save points.

create index if not exists team_state_schedule_revisions_list_meta_idx
  on public.team_state_schedule_revisions (team_state_id, created_at desc)
  include (source, label, content_hash);
