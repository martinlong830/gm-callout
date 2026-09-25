-- Auto clock-out was using America/Los_Angeles, so a 12:00 AM setting
-- closed punches at 3:00 AM Eastern (Red Poke stores are in New York).

create or replace function public.timeclock_auto_clockout_boundary(clock_in_at timestamptz, as_of timestamptz)
returns timestamptz
language plpgsql
stable
as $$
declare
  settings jsonb;
  auto_t time;
  tz text := 'America/New_York';
  local_as_of timestamp;
  local_in timestamp;
  d date;
  candidate timestamptz;
  best timestamptz := null;
begin
  settings := public.timeclock_settings_effective();
  auto_t := public.parse_time_hhmm(settings->>'auto_clock_out_time');
  local_as_of := timezone(tz, as_of);
  local_in := timezone(tz, clock_in_at);
  d := date_trunc('day', local_in)::date;
  while d <= date_trunc('day', local_as_of)::date loop
    candidate := (d + auto_t) at time zone tz;
    if candidate <= as_of and clock_in_at < candidate then
      best := candidate;
    end if;
    d := d + 1;
  end loop;
  return best;
end;
$$;
