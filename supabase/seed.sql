insert into interests (slug, label) values
  ('climbing',    'Climbing'),
  ('coffee',      'Coffee'),
  ('board_games', 'Board games'),
  ('running',     'Running'),
  ('gym',         'Gym'),
  ('cooking',     'Cooking'),
  ('music',       'Live music'),
  ('movies',      'Movies'),
  ('reading',     'Reading'),
  ('hiking',      'Hiking'),
  ('gaming',      'Video games'),
  ('art',         'Art')
on conflict (slug) do nothing;
