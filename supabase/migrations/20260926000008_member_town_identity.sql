-- Per-town identity: each member picks the name and color they go by in that town, when they join or
-- create it, and can change them later. No two members of a town share a name (ignoring case and
-- spacing); colors must also differ, which the API checks (a "too similar" rule can't be a constraint).
-- Idempotent: safe to run more than once.

alter table town_members add column if not exists name text;
alter table town_members add column if not exists color text;

alter table town_members drop constraint if exists town_members_name_len;
alter table town_members add constraint town_members_name_len
  check (name is null or char_length(btrim(name)) between 1 and 30);
alter table town_members drop constraint if exists town_members_color_hex;
alter table town_members add constraint town_members_color_hex
  check (color is null or color ~ '^#[0-9a-fA-F]{6}$');

-- Backfill existing members from their profile. A repeated name in the same town gets a number.
with ranked as (
  select m.town_id, m.user_id, left(btrim(p.display_name), 27) as base,
         row_number() over (
           partition by m.town_id, lower(regexp_replace(btrim(p.display_name), '\s+', ' ', 'g'))
           order by m.joined_at
         ) as rn
  from town_members m
  join profiles p on p.id = m.user_id
  where m.name is null
)
update town_members t
set name = case when r.rn = 1 then r.base else r.base || ' ' || r.rn end
from ranked r
where t.town_id = r.town_id and t.user_id = r.user_id;

update town_members t
set color = p.avatar ->> 'color'
from profiles p
where p.id = t.user_id and t.color is null and (p.avatar ->> 'color') ~ '^#[0-9a-fA-F]{6}$';

create unique index if not exists town_members_unique_name
  on town_members (town_id, lower(regexp_replace(btrim(name), '\s+', ' ', 'g')))
  where name is not null;
