-- The weekly town paper, saved once a week is over (backend/paper.py) so past weeks never call the model again.
-- `paper` is the validated JSON GET /towns/{id}/paper returns. Written only by the backend (secret key).
create table if not exists town_papers (
  town_id uuid not null references towns(id) on delete cascade,
  week_start date not null,
  paper jsonb not null,
  created_at timestamptz not null default now(),
  primary key (town_id, week_start)
);

alter table town_papers enable row level security;
drop policy if exists "members read" on town_papers;
create policy "members read" on town_papers for select to authenticated using (is_town_member(town_id));
