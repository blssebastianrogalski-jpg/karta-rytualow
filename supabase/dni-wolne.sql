-- Dni wolne studia (urlop, wolny dzień, wyjście na kilka godzin).
-- W tym czasie: prośby o termin nie przechodzą (klientka wybiera inny dzień), wolne godziny proponowane klientce
-- i oferty wolnych terminów omijają nieobecność, a panel ostrzega przy potwierdzaniu wizyty.
-- Powód nieobecności widzi tylko studio. Klientka widzi tylko „studio nieczynne”.
-- Wymaga wcześniejszych prosby-konflikty.sql i wolne-terminy.sql. Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych.

create table if not exists public.studio_absences (
  id         bigint generated always as identity primary key,
  day_from   date not null,
  day_to     date not null,
  time_from  time,              -- puste = cały dzień
  time_to    time,
  note       text,              -- np. „urlop”, widzi tylko studio
  created_at timestamptz not null default now(),
  check (day_to >= day_from),
  check ((time_from is null) = (time_to is null)),
  check (time_from is null or (day_from = day_to and time_from < time_to))
);
create index if not exists studio_absences_days_idx on public.studio_absences(day_to, day_from);
alter table public.studio_absences enable row level security;
-- Brak polityk: odczyt i zapis tylko przez funkcje poniżej.

-- ---------- Pomocnicze ----------

-- przedział nieobecności w czasie polskim
create or replace function public.absence_range(a public.studio_absences) returns tstzrange
language sql stable as $$
  select tstzrange((a.day_from + coalesce(a.time_from, '00:00'))::timestamp at time zone 'Europe/Warsaw',
                   case when a.time_to is null then (a.day_to + 1)::timestamp else a.day_to + a.time_to end at time zone 'Europe/Warsaw')
$$;

-- cały dzień wolny?
create or replace function public.absence_full_day(p_day date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.studio_absences a
                  where a.time_from is null and p_day between a.day_from and a.day_to)
$$;

-- nieobecność nachodząca na przedział; null = brak (bez notatki: ten tekst trafia też do odpowiedzi dla klientki)
create or replace function public.absence_hit(p_start timestamptz, p_end timestamptz) returns text
language sql stable security definer set search_path = public as $$
  select 'Masz wtedy wolne' || case when a.time_from is not null
           then ' (' || to_char(a.time_from, 'HH24:MI') || '–' || to_char(a.time_to, 'HH24:MI') || ')' else '' end
    from public.studio_absences a
   where public.absence_range(a) && tstzrange(p_start, p_end)
   order by a.day_from limit 1
$$;

-- jak w prosby-konflikty.sql, plus nieobecności studia (sprawdzane przed godzinami pracy)
create or replace function public.slot_check(p_start timestamptz, p_min int) returns text
language plpgsql stable security definer set search_path = public as $$
declare s public.booking_settings; loc timestamp := p_start at time zone 'Europe/Warsaw'; d date := loc::date;
        h jsonb; who text;
begin
  select * into s from public.booking_settings where id = 1;
  if not (s.hours ? extract(isodow from d)::text) then return 'Studio nieczynne tego dnia'; end if;
  who := public.absence_hit(p_start, p_start + make_interval(mins => p_min));
  if who is not null then return who; end if;
  h := s.hours -> extract(isodow from d)::text;
  if jsonb_typeof(h) = 'null' then return 'unknown'; end if;
  if p_start < now() + make_interval(mins => s.lead_min) then return 'Za krótko przed wizytą'; end if;
  if loc::time < (h ->> 0)::time or (loc + make_interval(mins => p_min))::time > (h ->> 1)::time
     or (loc + make_interval(mins => p_min))::date <> d then
    return 'Poza godzinami pracy (' || (h ->> 0) || '–' || (h ->> 1) || ')';
  end if;
  select string_agg(b.who || ' ' || b.at_time || coalesce(' (' || b.service || ')', ''), ', ' order by b.at_time) into who
    from public.busy_ranges(d) b
   where b.r && tstzrange(p_start, p_start + make_interval(mins => p_min + s.break_min));
  if who is not null then return 'Nakłada się na: ' || who; end if;
  return 'ok';
end $$;

-- ---------- Klientka ----------

-- prośba na dzień wolny nie przechodzi (stara wersja aplikacji też dostanie ten komunikat)
create or replace function public.booking_request_absence()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('new', 'suggested') and public.absence_full_day(new.pref_day) then
    raise exception 'W tym dniu studio jest nieczynne. Wybierz proszę inny dzień.';
  end if;
  return new;
end $$;
revoke execute on function public.booking_request_absence() from public, anon, authenticated;
drop trigger if exists booking_request_absence on public.booking_requests;
create trigger booking_request_absence
  before insert on public.booking_requests
  for each row execute function public.booking_request_absence();

-- dni, których nie da się wybrać w formularzu: stałe dni bez pracy (1 = pon. … 7 = niedz.) i całe dni wolne na 60 dni
create or replace function public.closed_days(p_token text)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.cards where token = p_token) then return null; end if;
  return json_build_object(
    'weekdays', (select coalesce(json_agg(i order by i), '[]'::json) from generate_series(1, 7) i
                  where not ((select hours from public.booking_settings where id = 1) ? i::text)),
    'days', (select coalesce(json_agg(d::date order by d), '[]'::json)
               from generate_series(public.today_pl(), public.today_pl() + 60, interval '1 day') d
              where public.absence_full_day(d::date)));
end $$;

-- ---------- Studio ----------

-- wizyty z planu, które wypadają w czasie nieobecności
create or replace function public.absence_clashes(a public.studio_absences) returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('day', p.day, 'start_at', p.start_at, 'service', p.service,
                                             'name', coalesce(c.name, p.guest_name, 'Klientka'), 'booksy', p.booking_id is not null)
                           order by p.day, p.start_at nulls first), '[]'::json)
    from public.day_plan p left join public.cards c on c.id = p.card_id
   where p.status = 'planned' and p.day between a.day_from and a.day_to
     and (a.time_from is null or p.start_at is null or public.absence_range(a) && tstzrange(p.start_at, p.start_at + interval '1 minute'))
$$;

create or replace function public.absence_list()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((
    select json_agg(json_build_object('id', a.id, 'day_from', a.day_from, 'day_to', a.day_to,
                                      'time_from', to_char(a.time_from, 'HH24:MI'), 'time_to', to_char(a.time_to, 'HH24:MI'),
                                      'note', a.note, 'clashes', public.absence_clashes(a)) order by a.day_from, a.time_from)
    from public.studio_absences a where a.day_to >= public.today_pl()
  ), '[]'::json);
end $$;

create or replace function public.absence_add(p_from date, p_to date, p_time_from text default null, p_time_to text default null, p_note text default null)
returns json language plpgsql security definer set search_path = public as $$
declare a public.studio_absences; tf time := nullif(trim(coalesce(p_time_from, '')), '')::time; tt time := nullif(trim(coalesce(p_time_to, '')), '')::time;
begin
  perform public.staff_check();
  if p_from is null then raise exception 'Wybierz dzień.'; end if;
  p_to := coalesce(p_to, p_from);
  if p_from < public.today_pl() then raise exception 'Wybierz dzień od dziś.'; end if;
  if p_to < p_from then raise exception 'Dzień „do” jest przed dniem „od”.'; end if;
  if p_to > p_from + 366 then raise exception 'Najwyżej rok naraz.'; end if;
  if (tf is null) <> (tt is null) then raise exception 'Podaj obie godziny albo żadnej (cały dzień).'; end if;
  if tf is not null and p_to <> p_from then raise exception 'Godziny można podać tylko dla jednego dnia.'; end if;
  if tf is not null and tf >= tt then raise exception 'Godzina „do” musi być po godzinie „od”.'; end if;
  insert into public.studio_absences (day_from, day_to, time_from, time_to, note)
  values (p_from, p_to, tf, tt, nullif(trim(coalesce(p_note, '')), '')) returning * into a;
  -- oferty wolnych terminów w tym czasie przestają obowiązywać
  update public.gap_offers g set status = case when g.status = 'open' then 'closed' else 'skipped' end,
         info = coalesce(g.info || ' · ', '') || 'dzień wolny'
   where g.status in ('pending', 'ask', 'open') and tstzrange(g.start_at, greatest(g.end_at, g.start_at + interval '1 minute')) && public.absence_range(a);
  return json_build_object('id', a.id, 'clashes', public.absence_clashes(a));
end $$;

create or replace function public.absence_delete(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  delete from public.studio_absences where id = p_id;
  if not found then raise exception 'Ten dzień wolny jest już usunięty.'; end if;
end $$;

-- ---------- Uprawnienia ----------
revoke all on function public.absence_range(public.studio_absences), public.absence_full_day(date),
  public.absence_hit(timestamptz, timestamptz), public.absence_clashes(public.studio_absences) from public, anon, authenticated;
revoke all on function public.closed_days(text), public.absence_list(), public.absence_add(date, date, text, text, text),
  public.absence_delete(bigint) from public;
grant execute on function public.closed_days(text) to anon, authenticated;
grant execute on function public.absence_list(), public.absence_add(date, date, text, text, text), public.absence_delete(bigint) to authenticated;
