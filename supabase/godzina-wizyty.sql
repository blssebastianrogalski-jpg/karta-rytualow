-- Godzina wizyty dodanej ręcznie do planu dnia (2026-11-05)
-- 1) plan_add przyjmuje godzinę (p_time, opcjonalnie)
-- 2) plan_set_time: ustawienie albo zmiana godziny wizyty dodanej ręcznie (nie z Booksy)
-- 3) poprawka godziny przez właścicielkę nie wysyła automatycznej oferty „po odwołaniu”
-- Bezpieczne przy ponownym uruchomieniu.

-- ---------- 1) Dodanie do planu z godziną ----------
drop function if exists public.plan_add(uuid, text, date);
create or replace function public.plan_add(p_card uuid, p_service text default null, p_day date default null, p_time time default null)
returns void language plpgsql security definer set search_path = public as $$
declare d date := coalesce(p_day, public.today_pl());
begin
  perform public.staff_check();
  if d < public.today_pl() then raise exception 'Ten dzień już minął.'; end if;
  if d > public.today_pl() + 30 then raise exception 'Plan można ułożyć najwyżej 30 dni naprzód.'; end if;
  if exists (select 1 from public.day_plan where card_id = p_card and day = d and status = 'planned') then
    raise exception 'Ta klientka jest już w planie na ten dzień.';
  end if;
  insert into public.day_plan (card_id, service, day, start_at)
  values (p_card, nullif(trim(coalesce(p_service, '')), ''), d,
          case when p_time is null then null else (d + p_time) at time zone 'Europe/Warsaw' end);
end $$;
revoke all on function public.plan_add(uuid, text, date, time) from public, anon;
grant execute on function public.plan_add(uuid, text, date, time) to authenticated;

-- ---------- 2) Ustawienie / zmiana godziny ----------
create or replace function public.plan_set_time(p_plan_id bigint, p_time time)
returns void language plpgsql security definer set search_path = public as $$
declare p public.day_plan;
begin
  perform public.staff_check();
  select * into p from public.day_plan where id = p_plan_id;
  if not found then raise exception 'Nie ma tej wizyty w planie.'; end if;
  if p.booking_id is not null then raise exception 'Godzinę wizyty z Booksy zmień w Booksy, plan zaktualizuje się sam.'; end if;
  if p.status <> 'planned' then raise exception 'Ta wizyta jest już zapisana.'; end if;
  -- poprawka godziny przez właścicielkę: bez automatycznej oferty wolnego terminu
  perform set_config('tctd.bez_oferty', '1', true);
  update public.day_plan
     set start_at = case when p_time is null then null else (p.day + p_time) at time zone 'Europe/Warsaw' end
   where id = p_plan_id;
end $$;
revoke all on function public.plan_set_time(bigint, time) from public, anon;
grant execute on function public.plan_set_time(bigint, time) to authenticated;

-- ---------- 3) Wykrycie odwołania (jak w wolne-terminy.sql + wyjątek na poprawkę godziny) ----------
create or replace function public.day_plan_gap_detect()
returns trigger language plpgsql security definer set search_path = public as $$
declare s public.booking_settings; o public.day_plan := old; nm text;
begin
  if coalesce(current_setting('tctd.bez_oferty', true), '') = '1' then return null; end if;
  if o.status <> 'planned' or o.start_at is null then return null; end if;
  if tg_op = 'UPDATE' and not ((new.status = 'skipped')
       or (new.status = 'planned' and new.start_at is distinct from o.start_at)) then return null; end if;
  select * into s from public.booking_settings where id = 1;
  if not s.gap_on then return null; end if;
  if o.day < public.today_pl() or o.day > public.today_pl() + s.gap_days then return null; end if;
  if o.start_at < now() + make_interval(mins => s.lead_min) then return null; end if;
  if exists (select 1 from public.gap_offers g where g.status in ('pending', 'open')
              and o.start_at >= g.start_at and o.start_at < greatest(g.end_at, g.start_at + interval '1 minute')) then return null; end if;
  select name into nm from public.cards where id = o.card_id;
  insert into public.gap_offers (kind, day, start_at, end_at, status, cancel_card, info, send_after)
  values ('cancel', o.day, o.start_at, o.start_at, 'pending', o.card_id,
          case when tg_op = 'UPDATE' and new.status = 'planned' then 'przeniesiona: ' else 'odwołała: ' end
            || coalesce(nm, o.guest_name, 'klientka') || coalesce(', ' || o.service, ''),
          now() + make_interval(mins => s.gap_wait_min));
  return null;
exception when others then
  return null; -- oferta nigdy nie blokuje odwołania
end $$;
revoke execute on function public.day_plan_gap_detect() from public, anon, authenticated;

notify pgrst, 'reload schema';
