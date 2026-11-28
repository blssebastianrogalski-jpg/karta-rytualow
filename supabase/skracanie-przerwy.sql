-- Skracanie przerwy po wizycie (2026-11-28).
-- W panelu przy wizycie z godziną można ustawić krótszą przerwę po niej (albo bez przerwy).
-- Domyślna przerwa po każdym rytuale zostaje w booking_settings.break_min (30 min).
-- Krótsza przerwa liczy się wszędzie, gdzie aplikacja szuka wolnych godzin: prośby o termin,
-- 3 proponowane godziny, ostrzeżenia o kolizji w panelu i „Wolne godziny”.
-- Klientka nie może jej ustawić: zmienia ją tylko studio (staff_check).
-- Wymaga wcześniejszego prosby-konflikty.sql i booksy-integracja.sql.
-- Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych.

-- null = przerwa domyślna z ustawień
alter table public.day_plan add column if not exists break_min int
  check (break_min is null or break_min between 0 and 240);

-- zajęte przedziały dnia (z przerwą po rytuale: z wizyty, a bez niej domyślna)
create or replace function public.busy_ranges(p_day date)
returns table (r tstzrange, who text, at_time text, service text)
language sql stable security definer set search_path = public as $$
  select tstzrange(p.start_at, coalesce(b.end_at, p.start_at + make_interval(mins => public.svc_minutes(p.service)))
                   + make_interval(mins => coalesce(p.break_min, s.break_min))),
         coalesce(c.name, p.guest_name, 'Klientka Booksy'),
         to_char(p.start_at at time zone 'Europe/Warsaw', 'HH24:MI'), p.service
    from public.day_plan p
    left join public.booksy_bookings b on b.id = p.booking_id
    left join public.cards c on c.id = p.card_id
    cross join public.booking_settings s
   where s.id = 1 and p.day = p_day and p.status = 'planned' and p.start_at is not null
$$;
revoke all on function public.busy_ranges(date) from public, anon, authenticated;

-- panel: przerwa po jednej wizycie; p_min null = wróć do domyślnej
create or replace function public.plan_set_break(p_plan_id bigint, p_min int)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  if p_min is not null and (p_min < 0 or p_min > 240) then raise exception 'Przerwa może mieć od 0 do 240 minut.'; end if;
  update public.day_plan set break_min = p_min where id = p_plan_id and status = 'planned';
  if not found then raise exception 'Nie ma tej wizyty w planie.'; end if;
end $$;
revoke all on function public.plan_set_break(bigint, int) from public, anon;
grant execute on function public.plan_set_break(bigint, int) to authenticated;

-- panel: przerwy po wizytach w planie (osobno, żeby nie zmieniać plan_list / plan_range)
-- {"default": 30, "plan": {"<id planu>": minuty, ...}} tylko dla wizyt z ustawioną przerwą
create or replace function public.plan_breaks(p_from date, p_to date)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_check();
  return json_build_object(
    'default', (select break_min from public.booking_settings where id = 1),
    'plan', coalesce((select json_object_agg(p.id::text, p.break_min) from public.day_plan p
                       where p.day between p_from and least(p_to, p_from + 62) and p.break_min is not null), '{}'::json));
end $$;
revoke all on function public.plan_breaks(date, date) from public, anon;
grant execute on function public.plan_breaks(date, date) to authenticated;
