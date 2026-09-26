-- Tables the condensed initial schema omitted that the Brain/Agent loops write to.
-- Live names: member_state → town_members; agent_state → agents.
-- Do not put business writes in route handlers except signals/events/action_tasks as specified.

create table if not exists public.facts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  town_id            uuid references public.towns (id) on delete cascade,
  category           text not null check (category in ('mood', 'busy', 'interest', 'news', 'plan')),
  fact               text not null,
  source_signal_ids  uuid[] not null default '{}',
  confidence         real not null default 1.0 check (confidence >= 0 and confidence <= 1),
  visibility         text not null default 'full' check (visibility in ('hidden', 'vague', 'full')),
  created_at         timestamptz not null default now()
);
create index if not exists facts_town_user on public.facts (town_id, user_id, created_at desc);

create table if not exists public.visibility_rules (
  user_id  uuid not null references public.profiles (id) on delete cascade,
  town_id  uuid not null references public.towns (id) on delete cascade,
  field    text not null,
  level    text not null default 'full' check (level in ('hidden', 'vague', 'full')),
  primary key (user_id, town_id, field)
);

create table if not exists public.consents (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  source     text not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, source)
);

create table if not exists public.inventory (
  user_id   uuid not null references public.profiles (id) on delete cascade,
  item_type text not null,
  qty       int not null default 0 check (qty >= 0),
  primary key (user_id, item_type)
);

create table if not exists public.news (
  id         uuid primary key default gen_random_uuid(),
  town_id    uuid not null references public.towns (id) on delete cascade,
  text       text not null,
  event_id   uuid references public.events (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists news_town on public.news (town_id, created_at desc);

create table if not exists public.agent_conversations (
  id           uuid primary key default gen_random_uuid(),
  town_id      uuid not null references public.towns (id) on delete cascade,
  building_id  text,
  speaker_ids  uuid[] not null default '{}',
  lines        jsonb not null default '[]',
  fact_ids     uuid[] not null default '{}',
  created_at   timestamptz not null default now()
);

create table if not exists public.action_tasks (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id) on delete cascade,
  status     text not null default 'pending',
  result     jsonb,
  error      text,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  town_id    uuid references public.towns (id) on delete cascade,
  text       text not null,
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.interactions (
  id         uuid primary key default gen_random_uuid(),
  town_id    uuid references public.towns (id) on delete cascade,
  user_a     uuid not null references public.profiles (id) on delete cascade,
  user_b     uuid not null references public.profiles (id) on delete cascade,
  type       text not null,
  via        text not null default 'in_town',
  created_at timestamptz not null default now()
);

create table if not exists public.path_score_history (
  id         bigint generated always as identity primary key,
  user_a     uuid not null,
  user_b     uuid not null,
  delta      real not null,
  reason     text,
  created_at timestamptz not null default now()
);

alter table public.events add column if not exists details jsonb not null default '{}';
alter table public.signals add column if not exists expires_at timestamptz;

alter table public.facts enable row level security;
alter table public.visibility_rules enable row level security;
alter table public.consents enable row level security;
alter table public.inventory enable row level security;
alter table public.news enable row level security;
alter table public.agent_conversations enable row level security;
alter table public.action_tasks enable row level security;
alter table public.notifications enable row level security;
alter table public.interactions enable row level security;
alter table public.path_score_history enable row level security;

create policy "own read" on public.facts for select to authenticated
  using (user_id = auth.uid());
create policy "own rules" on public.visibility_rules for select to authenticated
  using (user_id = auth.uid());
create policy "own consents" on public.consents for select to authenticated
  using (user_id = auth.uid());
create policy "own inventory" on public.inventory for select to authenticated
  using (user_id = auth.uid());
create policy "members read" on public.news for select to authenticated
  using (is_town_member(town_id));
create policy "members read" on public.agent_conversations for select to authenticated
  using (is_town_member(town_id));
create policy "members via event" on public.action_tasks for select to authenticated
  using (exists (select 1 from public.events e where e.id = event_id and is_town_member(e.town_id)));
create policy "own notifications" on public.notifications for select to authenticated
  using (user_id = auth.uid());
create policy "own pairs" on public.interactions for select to authenticated
  using (auth.uid() in (user_a, user_b));
create policy "own pairs" on public.path_score_history for select to authenticated
  using (auth.uid() in (user_a, user_b));

do $$
begin
  alter publication supabase_realtime add table public.news;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.agent_conversations;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null;
end $$;
