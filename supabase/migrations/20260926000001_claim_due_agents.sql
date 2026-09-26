-- Atomic claim for the agent loop. Operates on live table `agents`
-- (the condensed schema's equivalent of the plan's `agent_state`).
create or replace function public.claim_due_agents(p_town_id uuid, p_limit int default 10)
returns setof public.agents
language sql
as $$
  update public.agents
  set next_decision_at = now() + interval '30 seconds',
      updated_at = now()
  where (town_id, user_id) in (
    select town_id, user_id from public.agents
    where town_id = p_town_id and next_decision_at <= now()
    order by next_decision_at
    limit p_limit
    for update skip locked
  )
  returning *;
$$;

revoke all on function public.claim_due_agents(uuid, int) from public, anon, authenticated;
grant execute on function public.claim_due_agents(uuid, int) to service_role;
