-- Things people put on their own spot in a town. Written by people, never generated, and never read by the town brain.
-- `town_members.bubble` = {text, until}: a short message or emoji shown above your character until it expires.
-- (A house mood lives in `town_members.home.mood` = {kind, until}; no column needed.)
alter table town_members add column if not exists bubble jsonb;

-- Each member's mailbox: notes other townmates leave by clicking it. Backend-only (secret key): the API checks both
-- people live in the town, so RLS is on with no policies.
create table if not exists mailbox_messages (
  id         bigint generated always as identity primary key,
  town_id    uuid not null references towns (id) on delete cascade,
  to_user    uuid not null references profiles (id) on delete cascade,
  from_user  uuid not null references profiles (id) on delete cascade,
  text       text not null check (char_length(btrim(text)) between 1 and 500),
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists mailbox_messages_inbox on mailbox_messages (town_id, to_user, created_at desc);
alter table mailbox_messages enable row level security;
