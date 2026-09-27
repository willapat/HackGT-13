-- Optional Instagram and Facebook usernames on a profile. Friends and townmates see them as links.
-- Stored as just the username (or a numeric Facebook id), never a full URL. Idempotent.
alter table profiles add column if not exists instagram text;
alter table profiles add column if not exists facebook text;
