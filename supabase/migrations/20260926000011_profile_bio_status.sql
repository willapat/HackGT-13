-- Profile bio, plus a status friends and townmates see as a ring on your avatar:
-- 'free' (green) or 'busy' (red) until status_until, after which it simply lapses. Edited through the API.
alter table profiles add column if not exists bio text not null default '';
alter table profiles drop constraint if exists profiles_bio_length;
alter table profiles add constraint profiles_bio_length check (char_length(bio) <= 160);

alter table profiles add column if not exists status text;
alter table profiles add column if not exists status_until timestamptz;
alter table profiles drop constraint if exists profiles_status_valid;
alter table profiles add constraint profiles_status_valid
  check ((status is null and status_until is null) or (status in ('free', 'busy') and status_until is not null));

-- Profile photos: a public bucket the backend writes with the secret key (see backend/photos.py, which
-- also creates it on first upload). profiles.avatar.photo holds the public URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
