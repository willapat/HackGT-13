-- Reactions and comments on posts (signals with value.audience). One reaction per person per post (tap again to
-- change or remove it); comments are plain text written by people, never generated. Backend-only (secret key):
-- the API checks the viewer can see the post, so RLS is on with no policies.
create table if not exists post_reactions (
  signal_id  uuid not null references signals (id) on delete cascade,
  user_id    uuid not null references profiles (id) on delete cascade,
  emoji      text not null check (emoji in ('❤️', '😂', '🎉', '😮', '😢', '👏')),
  created_at timestamptz not null default now(),
  primary key (signal_id, user_id)
);
alter table post_reactions enable row level security;

create table if not exists post_comments (
  id         bigint generated always as identity primary key,
  signal_id  uuid not null references signals (id) on delete cascade,
  user_id    uuid not null references profiles (id) on delete cascade,
  text       text not null check (char_length(btrim(text)) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists post_comments_signal on post_comments (signal_id, created_at);
alter table post_comments enable row level security;
