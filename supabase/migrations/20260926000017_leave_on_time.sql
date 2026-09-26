-- Leave for the next event when its travel window starts, from the door they are
-- actually standing at. Mirrors backend/calendar_drive.py (_stand, current_trip).
-- Idempotent: safe to run more than once.

create or replace function public.calendar_stand(p_town uuid, p_user uuid, p_at timestamptz)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  home text := 'house:' || p_user::text;
  hit record;
  last_b record;
begin
  select * into hit
  from public.calendar_blocks(p_town, p_user) x
  where x.start_at <= p_at and p_at < x.end_at
  order by x.start_at desc
  limit 1;
  if found then
    return hit.dest;
  end if;

  select * into last_b
  from public.calendar_blocks(p_town, p_user) x
  where x.end_at <= p_at
  order by x.start_at desc
  limit 1;
  if not found then
    return home;
  end if;
  if last_b.dest <> home
     and p_at < last_b.end_at + make_interval(mins => last_b.travel) then
    return last_b.dest;
  end if;
  return home;
end;
$$;

create or replace function public.calendar_placement(p_town uuid, p_user uuid, p_at timestamptz)
returns table (phase text, action text, building_id text, from_building text)
language plpgsql
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  home text := 'house:' || p_user::text;
  hit record;
  last_b record;
  next_leave timestamptz;
  arrive timestamptz;
begin
  -- Latest event whose travel window has started. An earlier event does not keep them
  -- past the time they need to leave for the next one.
  select * into hit
  from public.calendar_blocks(p_town, p_user) x
  where x.leave_at <= p_at and p_at < x.end_at
  order by x.start_at desc
  limit 1;
  if found then
    if p_at < hit.start_at then
      return query select 'walking'::text, 'walk_to'::text, hit.dest,
        public.calendar_stand(p_town, p_user, hit.leave_at - interval '1 second');
    else
      return query select 'there'::text, 'idle'::text, hit.dest, hit.dest;
    end if;
    return;
  end if;

  select * into last_b
  from public.calendar_blocks(p_town, p_user) x
  where x.end_at <= p_at
  order by x.start_at desc
  limit 1;
  if not found then
    return query select 'none'::text, 'idle'::text, home, home;
    return;
  end if;

  select x.leave_at into next_leave
  from public.calendar_blocks(p_town, p_user) x
  where x.leave_at > p_at
  order by x.start_at
  limit 1;

  arrive := last_b.end_at + case when last_b.dest <> home then make_interval(mins => last_b.travel) else interval '0' end;
  if last_b.dest <> home and p_at < arrive and (next_leave is null or p_at < next_leave) then
    return query select 'going_home'::text, 'walk_to'::text, home, last_b.dest;
    return;
  end if;
  return query select 'home'::text, 'idle'::text, home, home;
end;
$$;

revoke all on function public.calendar_stand(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.calendar_stand(uuid, uuid, timestamptz) to service_role;
