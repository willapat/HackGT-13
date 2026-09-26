-- Reverts 20260926000000-000003: back to the 10-table core schema.

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1), 'Friend'));
  return new;
end;
$$;

drop function if exists public.claim_due_agents(uuid, int);
drop function if exists public.towns_with_unprocessed_signals();

drop table if exists
  public.facts,
  public.visibility_rules,
  public.consents,
  public.inventory,
  public.news,
  public.agent_conversations,
  public.action_tasks,
  public.notifications,
  public.interactions,
  public.path_score_history;

alter table public.events  drop column if exists details;
alter table public.signals drop column if exists expires_at;
