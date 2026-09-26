-- One town clock in the database, shared by every process. Live resumes from the stored
-- hour; it does not recompute time from when a Python process started.
-- loop_leases: only one agent loop may write. The lease expires if that process dies.
-- agents.written_by must change on every update, so an older process that does not set it
-- cannot overwrite a placement.

create table if not exists town_clock (
  town_id uuid primary key references towns (id) on delete cascade,
  mode text not null default 'live' check (mode in ('live', 'fast', 'scrub')),
  anchor_at timestamptz not null,
  anchored_real_at timestamptz not null default now(),
  rate double precision not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists loop_leases (
  name text primary key,
  holder text not null,
  heartbeat timestamptz not null default now()
);

alter table town_clock enable row level security;
alter table loop_leases enable row level security;

alter table agents add column if not exists written_by text;
alter table agent_actions add column if not exists written_by text;

create or replace function public.claim_loop_lease(lease_name text, holder text, ttl_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  insert into public.loop_leases (name, holder, heartbeat)
  values (lease_name, holder, now())
  on conflict (name) do update
    set holder = excluded.holder,
        heartbeat = now()
    where loop_leases.holder = excluded.holder
       or loop_leases.heartbeat < now() - make_interval(secs => ttl_seconds);
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on function public.claim_loop_lease(text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_loop_lease(text, text, integer) to service_role;

-- An update that omits written_by leaves the column unchanged. Require a new value so a
-- process that does not know about this column cannot keep placing people.
create or replace function public.require_fresh_writer()
returns trigger
language plpgsql
as $$
begin
  if NEW.written_by is null or NEW.written_by is not distinct from OLD.written_by then
    raise exception 'agents.written_by must be a new value on every update';
  end if;
  return NEW;
end;
$$;

drop trigger if exists agents_require_writer on agents;
create trigger agents_require_writer
  before update on agents
  for each row execute function public.require_fresh_writer();

create or replace function public.require_action_writer()
returns trigger
language plpgsql
as $$
begin
  if NEW.written_by is null then
    raise exception 'agent_actions.written_by is required';
  end if;
  return NEW;
end;
$$;

drop trigger if exists agent_actions_require_writer on agent_actions;
create trigger agent_actions_require_writer
  before insert on agent_actions
  for each row execute function public.require_action_writer();
