-- Each person's IANA time zone (e.g. America/Los_Angeles), set quietly by their browser on sign-in.
-- Used for their own "today" and for plan hours. Times themselves stay in UTC (timestamptz). Idempotent.
alter table profiles add column if not exists timezone text;
