-- Events are things people put on their calendar (class, work, gym, dinner), not town-generated news/quests.
alter table events
  add column if not exists start_at timestamptz,
  add column if not exists end_at timestamptz,
  add column if not exists building_id text,
  add column if not exists kind text;

comment on table events is 'User-shared calendar items (class, work, gym, dinner). Participants are the people going.';
create index if not exists events_town_start on events (town_id, start_at);
