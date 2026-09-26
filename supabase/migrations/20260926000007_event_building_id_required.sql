-- Characters walk to events.building_id. Infer leftover nulls, then require a place.

update events
set building_id = 'library'
where building_id is null
  and (lower(coalesce(text, '')) = 'campus' or kind = 'class');

update events e
set building_id = 'house:' || ep.user_id
from (
  select distinct on (event_id) event_id, user_id
  from event_participants
  order by event_id, user_id
) ep
where e.id = ep.event_id
  and e.building_id is null
  and lower(coalesce(e.text, '')) = 'home';

update events
set building_id = 'downtown'
where building_id is null;

alter table events
  alter column building_id set default 'downtown',
  alter column building_id set not null;

comment on column events.building_id is 'Place the character walks to (cafe, gym, house:<user_id>, ...). Always set.';
