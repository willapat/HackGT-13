-- AI building choice per synced calendar event, so each 5-minute sync doesn't ask the model again.
-- Keyed by a hash of the event's title/location; the text itself is never stored. Backend-only:
-- RLS is on and there are deliberately no policies.
create table if not exists calendar_place_guesses (
  user_id     uuid not null references profiles (id) on delete cascade,
  town_id     uuid not null references towns (id) on delete cascade,
  event_key   text not null,
  choice      text not null,
  source      text not null check (source in ('model', 'fallback')),
  decided_at  timestamptz not null default now(),
  primary key (user_id, town_id, event_key)
);
alter table calendar_place_guesses enable row level security;

comment on table calendar_place_guesses is
  'AI building choice per synced calendar event (hash only, never the title). Backend-only (no RLS policies).';
comment on column calendar_place_guesses.choice is 'A place id in that town, or misc.';
