-- Cost control: only towns with signals newer than the last brain_run get a Brain call.
create or replace function public.towns_with_unprocessed_signals()
returns table(town_id uuid)
language sql stable
as $$
  select distinct tm.town_id
  from public.town_members tm
  join public.signals s on s.user_id = tm.user_id
  where s.created_at > coalesce(
    (select max(br.created_at) from public.brain_runs br where br.town_id = tm.town_id),
    'epoch'::timestamptz
  );
$$;

revoke all on function public.towns_with_unprocessed_signals() from public, anon, authenticated;
grant execute on function public.towns_with_unprocessed_signals() to service_role;
