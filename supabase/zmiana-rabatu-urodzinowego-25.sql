-- Zmiana rabatu urodzinowego z 50% na 25%.
-- Uruchom w Supabase → SQL Editor (raz). Nie kasuje żadnych danych.

create or replace function public.use_birthday(p_id uuid, p_service text default null, p_plan_id bigint default null)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards; y int := extract(year from public.today_pl());
begin
  perform public.staff_check();
  select * into c from public.cards where id = p_id for update;
  if not public.is_bday_today(c.bday_day, c.bday_month) then raise exception 'Rabat urodzinowy działa tylko w dniu urodzin.'; end if;
  if c.birthday_used_year = y then raise exception 'Rabat urodzinowy został już wykorzystany w tym roku.'; end if;
  update public.cards set birthday_used_year = y where id = p_id returning * into c;
  insert into public.visits (card_id, kind, service, discount) values (p_id, 'birthday', nullif(trim(coalesce(p_service, '')), ''), 25);
  if p_plan_id is not null then update public.day_plan set status = 'birthday' where id = p_plan_id; end if;
  return public.card_json(c, true);
end $$;
