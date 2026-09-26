-- Tiny Town initial schema.
-- Tables with no RLS policies for `authenticated` are backend-only (service role bypasses RLS).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type interest_source    as enum ('stated', 'inferred');
create type visibility_level   as enum ('hidden', 'vague', 'full');
create type town_role          as enum ('owner', 'member');
create type weather_kind       as enum ('sunny', 'cloudy', 'rainy', 'stormy', 'rainbow');
create type agent_action       as enum ('idle', 'walk_to_building', 'visit', 'knock', 'chat', 'leave_gift', 'propose_event', 'go_home');
create type event_type         as enum ('quest', 'storyline', 'town_event');
create type event_status       as enum ('suggested', 'active', 'scheduled', 'completed', 'expired', 'cancelled');
create type event_creator      as enum ('brain', 'agent', 'user');
create type participant_status as enum ('suggested', 'invited', 'accepted', 'declined');
create type task_status        as enum ('pending', 'running', 'needs_approval', 'done', 'failed');
create type interaction_type   as enum ('knock', 'gift', 'visit', 'chat', 'hangout');
create type interaction_via    as enum ('in_town', 'real_life');

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

create table profiles (
  id                 uuid primary key references auth.users (id) on delete cascade,
  display_name       text not null,
  bio                text,
  timezone           text not null default 'America/New_York',
  birthday           date,
  avatar             jsonb not null default '{}',   -- manifest keys: model, colors, accessories
  notification_prefs jsonb not null default '{}',   -- channels, quiet_hours
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table interests (
  id    uuid primary key default gen_random_uuid(),
  slug  text not null unique,
  label text not null
);

create table user_interests (
  user_id     uuid not null references profiles (id) on delete cascade,
  interest_id uuid not null references interests (id) on delete cascade,
  source      interest_source not null default 'stated',
  created_at  timestamptz not null default now(),
  primary key (user_id, interest_id)
);

-- Which signal sources a person has opted in to. Ingestion must check for an unrevoked row.
create table consents (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles (id) on delete cascade,
  source     text not null,                  -- 'calendar', 'music', 'location', 'manual'
  scope      text,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index consents_one_active on consents (user_id, source) where revoked_at is null;

-- OAuth tokens. Backend-only; values must be encrypted before insert.
create table integrations (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references profiles (id) on delete cascade,
  provider                text not null,
  access_token_encrypted  text,
  refresh_token_encrypted text,
  expires_at              timestamptz,
  created_at              timestamptz not null default now(),
  unique (user_id, provider)
);

-- ---------------------------------------------------------------------------
-- Towns
-- ---------------------------------------------------------------------------

create table towns (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now()
);

create table town_members (
  town_id   uuid not null references towns (id) on delete cascade,
  user_id   uuid not null references profiles (id) on delete cascade,
  role      town_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (town_id, user_id)
);
create index town_members_user on town_members (user_id);

create table town_invites (
  id         uuid primary key default gen_random_uuid(),
  town_id    uuid not null references towns (id) on delete cascade,
  code       text not null unique,
  created_by uuid not null references profiles (id),
  max_uses   int,
  uses       int not null default 0,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

-- Per-town overrides of what a person shares (e.g. mood hidden in one town).
create table visibility_rules (
  user_id uuid not null references profiles (id) on delete cascade,
  town_id uuid not null references towns (id) on delete cascade,
  field   text not null,                     -- 'weather', 'activity', 'location', 'interests'
  level   visibility_level not null,
  primary key (user_id, town_id, field)
);

-- ---------------------------------------------------------------------------
-- Map. Asset files live in the frontend; columns here hold manifest keys only.
-- ---------------------------------------------------------------------------

create table town_layouts (
  town_id      uuid primary key references towns (id) on delete cascade,
  width        int not null,
  height       int not null,
  seed         bigint not null,
  theme        text not null default 'default',
  version      int not null default 1,
  generated_at timestamptz not null default now()
);

create table tiles (
  town_id   uuid not null references towns (id) on delete cascade,
  x         int not null,
  y         int not null,
  tile_type text not null,                   -- manifest key, e.g. 'road_straight'
  rotation  smallint not null default 0 check (rotation in (0, 90, 180, 270)),
  primary key (town_id, x, y)
);

create table buildings (
  id          uuid primary key default gen_random_uuid(),
  town_id     uuid not null references towns (id) on delete cascade,
  type        text not null,                 -- manifest key, e.g. 'cafe'
  level       int not null default 1,
  x           int not null,
  y           int not null,
  rotation    smallint not null default 0 check (rotation in (0, 90, 180, 270)),
  interest_id uuid references interests (id) on delete set null,
  unlocked_at timestamptz not null default now()
);
create index buildings_town on buildings (town_id);

create table houses (
  id          uuid primary key default gen_random_uuid(),
  town_id     uuid not null references towns (id) on delete cascade,
  user_id     uuid not null references profiles (id) on delete cascade,
  style       text not null,                 -- manifest key
  level       int not null default 1,
  x           int not null,
  y           int not null,
  rotation    smallint not null default 0 check (rotation in (0, 90, 180, 270)),
  decorations jsonb not null default '[]',
  unique (town_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Relationships
-- ---------------------------------------------------------------------------

-- One row per pair, stored with user_a < user_b.
create table friendships (
  user_a              uuid not null references profiles (id) on delete cascade,
  user_b              uuid not null references profiles (id) on delete cascade,
  last_interaction_at timestamptz,
  path_score          real not null default 0.5 check (path_score between 0 and 1),
  updated_at          timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);

create table path_score_history (
  id          bigint generated always as identity primary key,
  user_a      uuid not null,
  user_b      uuid not null,
  score       real not null,
  recorded_at timestamptz not null default now(),
  foreign key (user_a, user_b) references friendships (user_a, user_b) on delete cascade
);
create index path_score_history_pair on path_score_history (user_a, user_b, recorded_at);

-- ---------------------------------------------------------------------------
-- Town brain
-- ---------------------------------------------------------------------------

-- Raw opted-in inputs. Short-lived: purged by purge_expired_signals().
create table signals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles (id) on delete cascade,
  source     text not null,
  type       text not null,
  value      jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);
create index signals_user_recent on signals (user_id, created_at desc);

-- Conclusions the brain drew from signals. Character agents may only use facts, never raw signals.
create table facts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references profiles (id) on delete cascade,
  town_id           uuid references towns (id) on delete cascade,   -- null = applies in every town
  category          text not null,           -- 'mood', 'busy', 'interest', 'news', 'plan'
  fact              text not null,
  source_signal_ids uuid[] not null default '{}',
  confidence        real check (confidence between 0 and 1),
  visibility        visibility_level not null default 'full',
  created_at        timestamptz not null default now(),
  expires_at        timestamptz
);
create index facts_user on facts (user_id);

create table brain_runs (
  id             uuid primary key default gen_random_uuid(),
  town_id        uuid not null references towns (id) on delete cascade,
  model          text not null,
  input_snapshot jsonb not null,
  output         jsonb,
  error          text,
  created_at     timestamptz not null default now()
);

-- What the town shows for each person. Written by the brain after applying visibility rules.
create table member_state (
  town_id              uuid not null references towns (id) on delete cascade,
  user_id              uuid not null references profiles (id) on delete cascade,
  weather              weather_kind not null default 'sunny',
  activity             text,
  location_building_id uuid references buildings (id) on delete set null,
  props                jsonb not null default '{}',
  updated_at           timestamptz not null default now(),
  primary key (town_id, user_id)
);

create table news (
  id         uuid primary key default gen_random_uuid(),
  town_id    uuid not null references towns (id) on delete cascade,
  text       text not null,
  event_id   uuid,
  created_at timestamptz not null default now()
);
create index news_town_recent on news (town_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Agents. Positions are saved at decision points only; live movement is client-side.
-- ---------------------------------------------------------------------------

create table agent_state (
  town_id            uuid not null references towns (id) on delete cascade,
  user_id            uuid not null references profiles (id) on delete cascade,
  x                  real not null,
  y                  real not null,
  current_action     agent_action not null default 'idle',
  target_building_id uuid references buildings (id) on delete set null,
  target_user_id     uuid references profiles (id) on delete set null,
  next_decision_at   timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (town_id, user_id)
);
create index agent_state_due on agent_state (next_decision_at);

-- Backend-only decision log (reasoning may reference facts not visible to every viewer).
create table agent_actions (
  id                 bigint generated always as identity primary key,
  town_id            uuid not null references towns (id) on delete cascade,
  user_id            uuid not null references profiles (id) on delete cascade,
  action             agent_action not null,
  target_building_id uuid references buildings (id) on delete set null,
  target_user_id     uuid references profiles (id) on delete set null,
  reasoning          text,
  fact_ids           uuid[] not null default '{}',
  model              text,
  created_at         timestamptz not null default now()
);
create index agent_actions_town_recent on agent_actions (town_id, created_at desc);

-- Chat bubbles between characters. Visible to the whole town, so lines must only use 'full' facts.
create table agent_conversations (
  id                 uuid primary key default gen_random_uuid(),
  town_id            uuid not null references towns (id) on delete cascade,
  participant_ids    uuid[] not null,
  building_id        uuid references buildings (id) on delete set null,
  lines              jsonb not null,         -- [{speaker_id, text}]
  resulting_event_id uuid,
  created_at         timestamptz not null default now()
);

create table inventory (
  user_id   uuid not null references profiles (id) on delete cascade,
  item_type text not null,                   -- manifest key
  qty       int not null default 0 check (qty >= 0),
  primary key (user_id, item_type)
);

-- ---------------------------------------------------------------------------
-- Events, approvals, and real-world actions
-- ---------------------------------------------------------------------------

create table events (
  id                 uuid primary key default gen_random_uuid(),
  town_id            uuid not null references towns (id) on delete cascade,
  type               event_type not null,
  title              text not null,
  text               text not null,
  status             event_status not null default 'suggested',
  created_by_type    event_creator not null,
  created_by_user_id uuid references profiles (id) on delete set null,
  building_id        uuid references buildings (id) on delete set null,
  location           text,
  scheduled_at       timestamptz,
  expires_at         timestamptz,
  created_at         timestamptz not null default now()
);
create index events_town_status on events (town_id, status);

alter table news                add foreign key (event_id)           references events (id) on delete set null;
alter table agent_conversations add foreign key (resulting_event_id) references events (id) on delete set null;

-- Nothing leaves the town until the participant's status is 'accepted'.
create table event_participants (
  event_id     uuid not null references events (id) on delete cascade,
  user_id      uuid not null references profiles (id) on delete cascade,
  status       participant_status not null default 'suggested',
  responded_at timestamptz,
  primary key (event_id, user_id)
);
create index event_participants_user on event_participants (user_id);

-- Multi-step work by the action agent after acceptance (find a time, draft invites).
create table action_tasks (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references events (id) on delete cascade,
  status     task_status not null default 'pending',
  steps      jsonb not null default '[]',
  result     jsonb,
  error      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table interactions (
  id         uuid primary key default gen_random_uuid(),
  town_id    uuid references towns (id) on delete set null,
  from_user  uuid not null references profiles (id) on delete cascade,
  to_user    uuid not null references profiles (id) on delete cascade,
  type       interaction_type not null,
  via        interaction_via not null default 'in_town',
  event_id   uuid references events (id) on delete set null,
  created_at timestamptz not null default now()
);
create index interactions_pair on interactions (from_user, to_user, created_at desc);

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles (id) on delete cascade,
  type       text not null,
  payload    jsonb not null default '{}',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_unread on notifications (user_id, created_at desc) where read_at is null;

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

-- Town creator becomes its owner.
create function handle_new_town() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into town_members (town_id, user_id, role) values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

create trigger on_town_created
  after insert on towns
  for each row execute function handle_new_town();

-- Schedule with pg_cron or a backend job.
create function purge_expired_signals() returns void
language sql security definer set search_path = public as $$
  delete from signals where expires_at < now();
  delete from facts   where expires_at < now();
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table profiles            enable row level security;
alter table interests           enable row level security;
alter table user_interests      enable row level security;
alter table consents            enable row level security;
alter table integrations        enable row level security;
alter table towns               enable row level security;
alter table town_members        enable row level security;
alter table town_invites        enable row level security;
alter table visibility_rules    enable row level security;
alter table town_layouts        enable row level security;
alter table tiles               enable row level security;
alter table buildings           enable row level security;
alter table houses              enable row level security;
alter table friendships         enable row level security;
alter table path_score_history  enable row level security;
alter table signals             enable row level security;
alter table facts               enable row level security;
alter table brain_runs          enable row level security;
alter table member_state        enable row level security;
alter table news                enable row level security;
alter table agent_state         enable row level security;
alter table agent_actions       enable row level security;
alter table agent_conversations enable row level security;
alter table inventory           enable row level security;
alter table events              enable row level security;
alter table event_participants  enable row level security;
alter table action_tasks        enable row level security;
alter table interactions        enable row level security;
alter table notifications       enable row level security;

-- Backend-only (no policies): integrations, brain_runs, agent_actions.

-- Profiles
create policy "read self and townmates" on profiles for select to authenticated
  using (id = auth.uid() or shares_town_with(id));
create policy "update self" on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Interests
create policy "read catalog" on interests for select to authenticated using (true);
create policy "read own and townmates" on user_interests for select to authenticated
  using (user_id = auth.uid() or shares_town_with(user_id));
create policy "manage own stated" on user_interests for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and source = 'stated');

-- Consent and privacy: owner only
create policy "own consents" on consents for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own visibility" on visibility_rules for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and is_town_member(town_id));

-- Towns (joining via invite code goes through the backend)
create policy "members read" on towns for select to authenticated using (is_town_member(id));
create policy "create" on towns for insert to authenticated with check (created_by = auth.uid());
create policy "owner updates" on towns for update to authenticated using (created_by = auth.uid());
create policy "members read" on town_members for select to authenticated using (is_town_member(town_id));
create policy "leave" on town_members for delete to authenticated using (user_id = auth.uid());
create policy "members read" on town_invites for select to authenticated using (is_town_member(town_id));
create policy "members create" on town_invites for insert to authenticated
  with check (is_town_member(town_id) and created_by = auth.uid());

-- Map: members read, backend writes (except decorating your own house)
create policy "members read" on town_layouts for select to authenticated using (is_town_member(town_id));
create policy "members read" on tiles        for select to authenticated using (is_town_member(town_id));
create policy "members read" on buildings    for select to authenticated using (is_town_member(town_id));
create policy "members read" on houses       for select to authenticated using (is_town_member(town_id));
create policy "decorate own" on houses for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Relationships: only the two people in the pair
create policy "own pairs" on friendships for select to authenticated
  using (auth.uid() in (user_a, user_b));
create policy "own pairs" on path_score_history for select to authenticated
  using (auth.uid() in (user_a, user_b));

-- Signals and facts: owner can see, add manual signals, and delete (transparency + correction)
create policy "own read" on signals for select to authenticated using (user_id = auth.uid());
create policy "own manual" on signals for insert to authenticated
  with check (user_id = auth.uid() and source = 'manual');
create policy "own delete" on signals for delete to authenticated using (user_id = auth.uid());
create policy "own read" on facts for select to authenticated using (user_id = auth.uid());
create policy "own delete" on facts for delete to authenticated using (user_id = auth.uid());

-- Shared town view: members read, backend writes
create policy "members read" on member_state        for select to authenticated using (is_town_member(town_id));
create policy "members read" on news                for select to authenticated using (is_town_member(town_id));
create policy "members read" on agent_state         for select to authenticated using (is_town_member(town_id));
create policy "members read" on agent_conversations for select to authenticated using (is_town_member(town_id));
create policy "members read" on events              for select to authenticated using (is_town_member(town_id));

create policy "own read" on inventory for select to authenticated using (user_id = auth.uid());

-- Approvals
create policy "members read" on event_participants for select to authenticated
  using (exists (select 1 from events e where e.id = event_id and is_town_member(e.town_id)));
create policy "respond to own" on event_participants for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and status in ('accepted', 'declined'));
create policy "participants read" on action_tasks for select to authenticated
  using (exists (select 1 from event_participants p where p.event_id = action_tasks.event_id and p.user_id = auth.uid()));

-- Interactions and notifications
create policy "own read" on interactions for select to authenticated
  using (auth.uid() in (from_user, to_user));
create policy "log own" on interactions for insert to authenticated
  with check (from_user = auth.uid() and shares_town_with(to_user));
create policy "own read" on notifications for select to authenticated using (user_id = auth.uid());
create policy "mark read" on notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table
  member_state, agent_state, agent_conversations, events, event_participants, news, notifications;
