-- Inbox notices for things that happened to you, e.g. a town you were in was deleted by its creator.
-- The backend writes them (secret key); you can read your own through RLS, and dismiss them through the API.
create table if not exists notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references profiles (id) on delete cascade,
  kind       text not null,                      -- 'town_deleted', ...
  payload    jsonb not null default '{}',         -- e.g. {town_name, by_name}
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_recent on notifications (user_id, created_at desc);
alter table notifications enable row level security;
drop policy if exists "read own" on notifications;
create policy "read own" on notifications for select to authenticated using (user_id = auth.uid());
