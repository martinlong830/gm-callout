-- Per-restaurant tip take-home % (gross tip × pct/100 = net tip pay).

alter table public.team_state
  add column if not exists timecard_tip_takehome_pct jsonb not null
  default '{"rp-9":95,"rp-8":80}'::jsonb;

comment on column public.team_state.timecard_tip_takehome_pct is
  'Per-restaurant tip take-home percent (0–100). Keys = restaurant ids (rp-9, rp-8).';
