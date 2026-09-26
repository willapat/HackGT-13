-- Play advances the town clock at one game minute per real second. Idempotent.

alter table town_clock drop constraint if exists town_clock_mode_check;
alter table town_clock add constraint town_clock_mode_check
  check (mode in ('live', 'play', 'fast', 'scrub'));
