-- Everything a town needs beyond the tile grid (see backend/town_map.py). Idempotent: safe to re-run.
-- towns.map          {"places": {...}, "landmarks": {...}, "background_homes": {...}, "home_slots": [...]}
-- town_members.home  {"model", "driveway": [x, y], "door": [x, y], "block": [x0, y0, x1, y1]}

alter table towns add column if not exists map jsonb not null default '{}'
  check (jsonb_typeof(map) = 'object');

alter table town_members add column if not exists home jsonb not null default '{}'
  check (jsonb_typeof(home) = 'object');
