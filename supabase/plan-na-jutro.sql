-- Plan dnia na dziś i na jutro: plan_add przyjmuje dzień wizyty.
-- Uruchom raz w Supabase → SQL Editor.

drop function if exists public.plan_add(uuid, text);

create or replace function public.plan_add(p_card uuid, p_service text default null, p_day date default null)
returns void language plpgsql security definer set search_path = public as $$
declare d date := coalesce(p_day, public.today_pl());
begin
  perform public.staff_check();
  if d < public.today_pl() or d > public.today_pl() + 1 then raise exception 'Plan można ułożyć na dziś albo na jutro.'; end if;
  if exists (select 1 from public.day_plan where card_id = p_card and day = d and status = 'planned') then
    raise exception 'Ta klientka jest już w planie na ten dzień.';
  end if;
  insert into public.day_plan (card_id, service, day) values (p_card, nullif(trim(coalesce(p_service, '')), ''), d);
end $$;

revoke all on function public.plan_add(uuid, text, date) from public, anon;
grant execute on function public.plan_add(uuid, text, date) to authenticated;
