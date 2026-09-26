-- How long it takes to walk to this event from home, in minutes. Characters leave start_at - travel_minutes.
alter table events
  add column if not exists travel_minutes int not null default 12
  check (travel_minutes >= 1 and travel_minutes <= 120);

comment on column events.travel_minutes is 'Walk time to the event place. Leave at start_at minus this.';
