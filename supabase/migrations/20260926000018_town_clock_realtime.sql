-- The 3D town follows changes live over Supabase Realtime instead of polling the API every 2 seconds.
-- agents, agent_actions, town_members and events already publish; the town clock joins them, readable by
-- the town's members (Realtime only delivers rows the subscriber may select). Idempotent.

drop policy if exists "members read" on town_clock;
create policy "members read" on town_clock for select to authenticated using (is_town_member(town_id));

do $$ begin
  alter publication supabase_realtime add table town_clock;
exception when duplicate_object then null; end $$;
