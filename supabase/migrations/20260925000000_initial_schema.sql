-- Tiny Town schema. Backend (secret key) bypasses RLS; policies below are for the frontend.

-- Safety net: any new table in public gets RLS enabled automatically (replaces Supabase's default ensure_rls).
create or replace function public.rls_auto_enable() returns event_trigger
language plpgsql security definer set search_path = pg_catalog as $$
declare cmd record;
begin
  for cmd in
    select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table') and schema_name = 'public'
  loop
    execute format('alter table if exists %s enable row level security', cmd.object_identity);
  end loop;
end;
$$;

drop event trigger if exists ensure_rls;
create event trigger ensure_rls on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();

create type agent_action as enum ('idle', 'walk_to', 'visit', 'knock', 'chat', 'leave_gift', 'propose_event', 'go_home');

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

create table profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  avatar       jsonb not null default '{}',    -- asset manifest keys
  interests    text[] not null default '{}',
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Towns. tiles is a 2D array of asset manifest keys, indexed tiles[y][x].
-- ---------------------------------------------------------------------------

create table towns (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  tiles       jsonb not null default '[]' check (jsonb_typeof(tiles) = 'array'),
  invite_code text not null unique default substr(md5(random()::text), 1, 6),
  created_by  uuid not null references profiles (id),
  created_at  timestamptz not null default now()
);

-- One row per person per town: their house, plus what the town hall AI currently shows for them.
create table town_members (
  town_id    uuid not null references towns (id) on delete cascade,
  user_id    uuid not null references profiles (id) on delete cascade,
  house_x    int,
  house_y    int,
  mood       text,                            -- 'sunny', 'rainy', 'stormy', ...
  activity   text,
  state      jsonb not null default '{}',     -- extra AI-set props (party lights, etc.)
  joined_at  timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (town_id, user_id)
);
create index town_members_user on town_members (user_id);

-- One row per pair, stored with user_a < user_b.
create table friendships (
  user_a              uuid not null references profiles (id) on delete cascade,
  user_b              uuid not null references profiles (id) on delete cascade,
  path_score          real not null default 0.5,
  last_interaction_at timestamptz,
  primary key (user_a, user_b),
  check (user_a < user_b)
);

-- ---------------------------------------------------------------------------
-- Inputs from users (opted-in signals and manual updates)
-- ---------------------------------------------------------------------------

create table signals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles (id) on delete cascade,
  source     text not null,                   -- 'manual', 'calendar', 'music', ...
  type       text not null,
  value      jsonb not null,
  created_at timestamptz not null default now()
);
create index signals_user_recent on signals (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Town hall AI
-- ---------------------------------------------------------------------------

-- Each run: what it read and what it decided. Agents ground their decisions in the latest output.
create table brain_runs (
  id         uuid primary key default gen_random_uuid(),
  town_id    uuid not null references towns (id) on delete cascade,
  input      jsonb not null,
  output     jsonb,
  error      text,
  created_at timestamptz not null default now()
);
create index brain_runs_town_recent on brain_runs (town_id, created_at desc);

-- Quests, storylines, town events, news.
create table events (
  id         uuid primary key default gen_random_uuid(),
  town_id    uuid not null references towns (id) on delete cascade,
  type       text not null,                   -- 'quest', 'storyline', 'town_event', 'news'
  title      text not null,
  text       text,
  status     text not null default 'suggested',
  created_at timestamptz not null default now()
);
create index events_town on events (town_id, created_at desc);

-- Nothing leaves the town until a participant's status is 'accepted'.
create table event_participants (
  event_id uuid not null references events (id) on delete cascade,
  user_id  uuid not null references profiles (id) on delete cascade,
  status   text not null default 'suggested' check (status in ('suggested', 'accepted', 'declined')),
  primary key (event_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Agents (one character per town member)
-- ---------------------------------------------------------------------------

create table agents (
  town_id          uuid not null,
  user_id          uuid not null,
  x                real not null default 0,
  y                real not null default 0,
  action           agent_action not null default 'idle',
  target           jsonb,                     -- {x, y} or {user_id}
  next_decision_at timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (town_id, user_id),
  foreign key (town_id, user_id) references town_members (town_id, user_id) on delete cascade
);

-- Every decision an agent makes. Chat bubbles live in details.lines.
create table agent_actions (
  id         bigint generated always as identity primary key,
  town_id    uuid not null references towns (id) on delete cascade,
  user_id    uuid not null references profiles (id) on delete cascade,
  action     agent_action not null,
  details    jsonb not null default '{}',     -- target, reasoning, lines: [{speaker_id, text}]
  created_at timestamptz not null default now()
);
create index agent_actions_town_recent on agent_actions (town_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Functions and triggers
-- ---------------------------------------------------------------------------

create function is_town_member(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from town_members where town_id = t and user_id = auth.uid());
$$;

create function shares_town_with(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from town_members a join town_members b on a.town_id = b.town_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1), 'Friend'));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Adding a member also creates their agent.
create function handle_new_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into agents (town_id, user_id, x, y)
  values (new.town_id, new.user_id, coalesce(new.house_x, 0), coalesce(new.house_y, 0));
  return new;
end;
$$;

create trigger on_member_added
  after insert on town_members
  for each row execute function handle_new_member();

create function handle_new_town() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into town_members (town_id, user_id) values (new.id, new.created_by);
  return new;
end;
$$;

create trigger on_town_created
  after insert on towns
  for each row execute function handle_new_town();

-- Frontend calls supabase.rpc('join_town', { code }).
create function join_town(code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  select id into t from towns where invite_code = code;
  if t is null then raise exception 'invalid invite code'; end if;
  insert into town_members (town_id, user_id) values (t, auth.uid()) on conflict do nothing;
  return t;
end;
$$;
revoke execute on function join_town(text) from public, anon;
grant execute on function join_town(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security: town members can see their town; users edit their own stuff.
-- ---------------------------------------------------------------------------

alter table profiles           enable row level security;
alter table towns              enable row level security;
alter table town_members       enable row level security;
alter table friendships        enable row level security;
alter table signals            enable row level security;
alter table brain_runs         enable row level security;
alter table events             enable row level security;
alter table event_participants enable row level security;
alter table agents             enable row level security;
alter table agent_actions      enable row level security;

create policy "self and townmates" on profiles for select to authenticated
  using (id = auth.uid() or shares_town_with(id));
create policy "edit self" on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "members read" on towns for select to authenticated using (is_town_member(id));
create policy "create" on towns for insert to authenticated with check (created_by = auth.uid());

create policy "members read" on town_members for select to authenticated using (is_town_member(town_id));
create policy "leave" on town_members for delete to authenticated using (user_id = auth.uid());

create policy "own pairs" on friendships for select to authenticated using (auth.uid() in (user_a, user_b));

create policy "own read" on signals for select to authenticated using (user_id = auth.uid());
create policy "own add" on signals for insert to authenticated with check (user_id = auth.uid());

create policy "members read" on brain_runs    for select to authenticated using (is_town_member(town_id));
create policy "members read" on events        for select to authenticated using (is_town_member(town_id));
create policy "members read" on agents        for select to authenticated using (is_town_member(town_id));
create policy "members read" on agent_actions for select to authenticated using (is_town_member(town_id));

create policy "members read" on event_participants for select to authenticated
  using (exists (select 1 from events e where e.id = event_id and is_town_member(e.town_id)));
create policy "respond to own" on event_participants for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table town_members, agents, agent_actions, events, event_participants;
