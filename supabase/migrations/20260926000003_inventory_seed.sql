-- Starting gifts so leave_gift can be validated on day one.
insert into public.inventory (user_id, item_type, qty)
select id, 'gift', 3 from public.profiles
on conflict (user_id, item_type) do nothing;

-- New signups get the same starting inventory. Original handle_new_user body preserved.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1), 'Friend'));
  insert into public.inventory (user_id, item_type, qty)
  values (new.id, 'gift', 3)
  on conflict (user_id, item_type) do nothing;
  return new;
end;
$$;
