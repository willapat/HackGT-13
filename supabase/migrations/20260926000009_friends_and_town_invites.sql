-- Account-level friends (separate from `friendships`, the in-town agent path score) and town invites.
-- All writes go through the backend API; the frontend only reads. Idempotent: safe to re-run.

alter table profiles add column if not exists username text unique
  check (username ~ '^[a-z0-9_]{3,20}$');

create table if not exists friend_requests (
  id           uuid primary key default gen_random_uuid(),
  from_user    uuid not null references profiles (id) on delete cascade,
  to_user      uuid not null references profiles (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  check (from_user <> to_user)
);
create unique index if not exists friend_requests_pair
  on friend_requests (least(from_user, to_user), greatest(from_user, to_user));
create index if not exists friend_requests_to on friend_requests (to_user, status);

create table if not exists town_invites (
  id           uuid primary key default gen_random_uuid(),
  town_id      uuid not null references towns (id) on delete cascade,
  from_user    uuid not null references profiles (id) on delete cascade,
  to_user      uuid not null references profiles (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  unique (town_id, to_user)
);
create index if not exists town_invites_to on town_invites (to_user, status);

create or replace function has_friend_request_with(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from friend_requests
    where (from_user = auth.uid() and to_user = other) or (from_user = other and to_user = auth.uid())
  );
$$;

alter table friend_requests enable row level security;
alter table town_invites    enable row level security;

drop policy if exists "own requests" on friend_requests;
create policy "own requests" on friend_requests for select to authenticated
  using (auth.uid() in (from_user, to_user));

drop policy if exists "own invites" on town_invites;
create policy "own invites" on town_invites for select to authenticated
  using (auth.uid() in (from_user, to_user));

drop policy if exists "self and townmates" on profiles;
drop policy if exists "self, townmates, friends" on profiles;
create policy "self, townmates, friends" on profiles for select to authenticated
  using (id = auth.uid() or shares_town_with(id) or has_friend_request_with(id));

drop policy if exists "invited read" on towns;
create policy "invited read" on towns for select to authenticated
  using (exists (select 1 from town_invites i where i.town_id = towns.id and i.to_user = auth.uid()));

do $$ begin
  alter publication supabase_realtime add table friend_requests;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table town_invites;
exception when duplicate_object then null; end $$;
