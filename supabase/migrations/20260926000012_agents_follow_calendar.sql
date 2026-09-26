-- Postgres refuses an agents row that does not match the calendar at the town clock.
-- A process with the secret key can still send any update, so the check has to live here, not in Python.
-- Mirrors backend/calendar_drive.py (destination_for, estimate_travel_minutes, current_trip,
-- plan_clock_placement). Change both together.
-- Idempotent: safe to run more than once.

create or replace function public.calendar_destination(p_user uuid, p_building text, p_text text, p_kind text)
returns text
language sql
immutable
as $$
  select coalesce(
    nullif(btrim(p_building), ''),
    case
      when lower(btrim(coalesce(p_text, ''))) = 'home' then 'house:' || p_user::text
      when lower(btrim(coalesce(p_text, ''))) = 'campus' or p_kind = 'class' then 'library'
      else 'downtown'
    end
  )
$$;

create or replace function public.estimate_travel_minutes(p_building text, p_text text default null)
returns integer
language sql
immutable
as $$
  select case
    when lower(btrim(coalesce(p_text, ''))) = 'home' or p_building like 'house:%' then 6
    when p_building = 'cafe' then 8
    when p_building in ('market', 'park') then 10
    when p_building in ('gym', 'library') then 12
    when p_building = 'downtown' then 15
    when lower(btrim(coalesce(p_text, ''))) = 'campus' then 18
    else 12
  end
$$;

create or replace function public.calendar_blocks(p_town uuid, p_user uuid)
returns table (start_at timestamptz, end_at timestamptz, leave_at timestamptz, dest text, travel integer)
language sql
stable
set search_path = public
as $$
  select e.start_at,
         e.end_at,
         e.start_at - make_interval(mins => t.travel),
         d.dest,
         t.travel
  from events e
  join event_participants p on p.event_id = e.id and p.user_id = p_user
  cross join lateral (
    select public.calendar_destination(p_user, e.building_id, e.text, e.kind) as dest
  ) d
  cross join lateral (
    select coalesce(nullif(e.travel_minutes, 0), public.estimate_travel_minutes(d.dest, e.text)) as travel
  ) t
  where e.town_id = p_town
    and e.type = 'personal'
    and e.start_at is not null
    and e.end_at is not null
  order by e.start_at
$$;

-- Where someone belongs at p_at. from_building is the door a walk leaves from.
create or replace function public.calendar_placement(p_town uuid, p_user uuid, p_at timestamptz)
returns table (phase text, action text, building_id text, from_building text)
language plpgsql
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  home text := 'house:' || p_user::text;
  b record;
  last_b record;
  next_leave timestamptz;
  arrive timestamptz;
begin
  for b in select * from public.calendar_blocks(p_town, p_user) loop
    if b.leave_at <= p_at and p_at < b.end_at then
      if p_at < b.start_at then
        return query select 'walking'::text, 'walk_to'::text, b.dest, home;
      else
        return query select 'there'::text, 'idle'::text, b.dest, b.dest;
      end if;
      return;
    end if;
  end loop;

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

-- Same as backend/town_map.buildings: a place's map door, or a member's home door.
create or replace function public.building_door(p_town uuid, p_building text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select case
    when p_building like 'house:%' then (
      select nullif(m.home -> 'door', 'null'::jsonb)
      from town_members m
      where m.town_id = p_town and m.user_id::text = substr(p_building, 7)
    )
    else (
      select nullif(t.map -> 'places' -> p_building -> 'door', 'null'::jsonb)
      from towns t
      where t.id = p_town
    )
  end
$$;

create or replace function public.near_door(p_x real, p_y real, p_door jsonb)
returns boolean
language sql
immutable
as $$
  select p_x is not null and p_y is not null
     and abs(p_x - (p_door ->> 0)::real) < 0.2
     and abs(p_y - (p_door ->> 1)::real) < 0.2
$$;

create or replace function public.town_time_at(p_town uuid, p_real timestamptz)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select c.anchor_at + make_interval(secs => extract(epoch from (p_real - c.anchored_real_at)) * c.rate)
  from town_clock c
  where c.town_id = p_town
$$;

create or replace function public.agents_follow_calendar()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  bid text := NEW.target ->> 'building_id';
  door jsonb;
  from_door jsonb;
  clock record;
  town_now timestamptz;
  planned timestamptz;
  skew interval;
  expected record;
begin
  -- Claims and next-look bumps do not move anyone.
  if NEW.action is not distinct from OLD.action
     and NEW.target is not distinct from OLD.target
     and NEW.x is not distinct from OLD.x
     and NEW.y is not distinct from OLD.y then
    return NEW;
  end if;

  -- A person walking their own character (POST /towns/{id}/members/me/move).
  if coalesce(NEW.target ->> 'by', '') = 'user' then
    return NEW;
  end if;

  if bid is null then
    raise exception 'placement rejected: target.building_id is required';
  end if;
  door := public.building_door(NEW.town_id, bid);

  -- Idle is drawn on target.building_id. x/y on another door is the teleport.
  if NEW.action = 'idle' then
    if NEW.target ? 'depart_at' then
      raise exception 'placement rejected: idle at % must not carry depart_at', bid;
    end if;
    if door is not null and not public.near_door(NEW.x, NEW.y, door) then
      raise exception 'placement rejected: idle at % must stand on its door %, not (%, %)', bid, door, NEW.x, NEW.y;
    end if;
  end if;
  if door is not null and NEW.target ? 'door' and NEW.target -> 'door' <> door then
    raise exception 'placement rejected: % door is %, row says %', bid, door, NEW.target -> 'door';
  end if;

  select * into clock from town_clock where town_id = NEW.town_id;
  if not found then
    return NEW;
  end if;

  if not (NEW.target ? 'clock_at') then
    raise exception 'placement rejected: target.clock_at (the town time this was planned for) is required';
  end if;
  planned := (NEW.target ->> 'clock_at')::timestamptz;
  town_now := public.town_time_at(NEW.town_id, now());
  -- Fast day moves twelve game minutes a real second; allow for the time between planning and writing.
  skew := greatest(interval '2 minutes', make_interval(secs => clock.rate * 15));
  if greatest(planned - town_now, town_now - planned) > skew then
    raise exception 'placement rejected: planned for %, town clock is %', planned, town_now;
  end if;

  select * into expected from public.calendar_placement(NEW.town_id, NEW.user_id, planned);
  if expected.action <> NEW.action::text or expected.building_id <> bid then
    raise exception 'placement rejected: calendar says % at % (%), row says % at %',
      expected.action, expected.building_id, expected.phase, NEW.action, bid;
  end if;

  if NEW.action = 'walk_to' then
    if not (NEW.target ? 'depart_at') then
      raise exception 'placement rejected: walk to % needs depart_at', bid;
    end if;
    from_door := public.building_door(NEW.town_id, expected.from_building);
    if from_door is not null and not public.near_door(NEW.x, NEW.y, from_door) then
      raise exception 'placement rejected: walk to % leaves from % %, not (%, %)',
        bid, expected.from_building, from_door, NEW.x, NEW.y;
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists agents_follow_calendar on agents;
create trigger agents_follow_calendar
  before update on agents
  for each row execute function public.agents_follow_calendar();

revoke all on function public.calendar_placement(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.calendar_placement(uuid, uuid, timestamptz) to service_role;
