-- Google Calendar connections, one per person. Holds the Google refresh token, so only the backend
-- (secret key, bypasses RLS) may read it: RLS is on and there are deliberately no policies.
create table if not exists calendar_connections (
  user_id        uuid primary key references profiles (id) on delete cascade,
  provider       text not null default 'google',
  refresh_token  text not null,
  scopes         text,
  connected_at   timestamptz not null default now(),
  last_synced_at timestamptz,
  last_error     text
);
alter table calendar_connections enable row level security;

comment on table calendar_connections is 'External calendar access per user. Backend-only (no RLS policies).';

-- Personal events copied from someone's external calendar, so each sync can replace that person's copies.
alter table events
  add column if not exists imported_from text,
  add column if not exists imported_for uuid references profiles (id) on delete cascade;
create index if not exists events_imported_for on events (imported_for) where imported_for is not null;

comment on column events.imported_from is 'External calendar the row was copied from (e.g. google). Null for events made in Luma.';
comment on column events.imported_for is 'Whose calendar the row was copied from. Synced rows are replaced on every sync.';
