-- Dwa zabiegi tej samej klientki jeden po drugim (2026-11-28).
-- 1) plan_add: ta sama klientka może być w planie kilka razy tego samego dnia, jeśli każda wizyta
--    ma inną godzinę. Blokada zostaje dla duplikatu (ta sama godzina) i dla wizyt bez godziny.
-- 2) slot_conflict_card: ostrzeżenie o kolizji w panelu nie liczy przerwy między wizytami tej samej
--    klientki (drugi zabieg może zacząć się zaraz po pierwszym). Prawdziwe nakładanie się nadal ostrzega.
-- Wymaga wcześniejszego godzina-wizyty.sql, prosby-konflikty.sql i skracanie-przerwy.sql.
-- Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych.

create or replace function public.plan_add(p_card uuid, p_service text default null, p_day date default null, p_time time default null)
returns void language plpgsql security definer set search_path = public as $$
declare d date := coalesce(p_day, public.today_pl());
        st timestamptz := case when p_time is null then null else (coalesce(p_day, public.today_pl()) + p_time) at time zone 'Europe/Warsaw' end;
begin
  perform public.staff_check();
  if d < public.today_pl() then raise exception 'Ten dzień już minął.'; end if;
  if d > public.today_pl() + 30 then raise exception 'Plan można ułożyć najwyżej 30 dni naprzód.'; end if;
  if exists (select 1 from public.day_plan where card_id = p_card and day = d and status = 'planned'
               and (st is null or start_at is null or start_at = st)) then
    raise exception '%', case when st is null
      then 'Ta klientka jest już w planie na ten dzień. Podaj godzinę, żeby dodać drugi zabieg.'
      else 'Ta klientka jest już w planie na ten dzień bez godziny albo o tej samej godzinie. Najpierw ustaw godzinę tamtej wizyty.' end;
  end if;
  insert into public.day_plan (card_id, service, day, start_at)
  values (p_card, nullif(trim(coalesce(p_service, '')), ''), d, st);
end $$;
revoke all on function public.plan_add(uuid, text, date, time) from public, anon;
grant execute on function public.plan_add(uuid, text, date, time) to authenticated;

-- panel: jak slot_conflict, ale bez przerwy między wizytami tej samej klientki (p_card)
create or replace function public.slot_conflict_card(p_day date, p_time text, p_service text, p_card uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare s public.booking_settings; st timestamptz := (p_day + p_time::time) at time zone 'Europe/Warsaw';
        m int := public.svc_minutes(p_service); res text; who text;
begin
  perform public.staff_check();
  res := public.slot_check(st, m);
  if res in ('ok', 'unknown', 'Za krótko przed wizytą') then return null; end if;
  if res not like 'Nakłada się na:%' then return res; end if;
  select * into s from public.booking_settings where id = 1;
  select string_agg(coalesce(c.name, p.guest_name, 'Klientka Booksy') || ' ' || to_char(p.start_at at time zone 'Europe/Warsaw', 'HH24:MI')
                    || coalesce(' (' || p.service || ')', ''), ', ' order by p.start_at) into who
    from public.day_plan p
    left join public.booksy_bookings b on b.id = p.booking_id
    left join public.cards c on c.id = p.card_id
   where p.day = p_day and p.status = 'planned' and p.start_at is not null
     and tstzrange(p.start_at, coalesce(b.end_at, p.start_at + make_interval(mins => public.svc_minutes(p.service)))
                   + make_interval(mins => case when p_card is not null and p.card_id = p_card then 0 else coalesce(p.break_min, s.break_min) end))
      && tstzrange(st, st + make_interval(mins => m + case when p_card is not null and p.card_id = p_card then 0 else s.break_min end));
  return case when who is null then null else 'Nakłada się na: ' || who end;
end $$;
revoke all on function public.slot_conflict_card(date, text, text, uuid) from public, anon;
grant execute on function public.slot_conflict_card(date, text, text, uuid) to authenticated;
