-- Prośby o termin: sprawdzanie konfliktu z planem dnia.
-- Przy pierwszym konflikcie klientka od razu dostaje 3 najbliższe wolne godziny.
-- Gdy wybierze godzinę albo poprosi o inny dzień i znów trafi na zajęty termin,
-- prośba czeka na studio ze znaczkiem „konflikt”. Bez konfliktu prośba czeka na studio jak dotąd.
-- Zajęte godziny: wizyty z planu dnia z godziną (Booksy z maili, potwierdzone prośby, wpisy z panelu z godziną).
-- Wymaga wcześniejszego prosby-o-termin.sql. Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych.

-- ---------- Ustawienia (godziny pracy, czasy rytuałów) ----------
create table if not exists public.booking_settings (
  id          int primary key default 1 check (id = 1),
  -- dzień tygodnia ISO (1 = poniedziałek … 7 = niedziela) → [otwarcie, koniec ostatniego rytuału];
  -- brak dnia = studio nieczynne, null = godzin nie znam (bez sprawdzania)
  hours       jsonb not null,
  break_min   int not null default 30,   -- przerwa po każdym rytuale
  default_min int not null default 60,   -- rytuał spoza listy
  durations   jsonb not null,            -- nazwa rytuału → minuty samego rytuału
  lead_min    int not null default 120   -- najwcześniej za tyle minut od teraz
);
insert into public.booking_settings (id, hours, durations) values (1,
  '{"1": ["09:00", "19:00"], "2": ["09:00", "19:00"], "3": ["09:00", "19:00"], "4": ["09:00", "18:00"], "5": ["09:00", "18:00"]}',
  '{"Kobido UP®": 90, "Master Kobido UP®": 120, "Head SPA Premium": 90, "Access Bars®": 75,
    "Refleksologia Stóp Premium": 45, "Masaż relaksacyjny": 90, "Masaż relaksacyjny 60 min": 60, "Masaż relaksacyjny 90 min": 90,
    "Masaż aromaterapeutyczny": 90, "Masaż aromaterapeutyczny 60 min": 60, "Masaż aromaterapeutyczny 90 min": 90,
    "Masaż gorącą świecą": 60, "Masaż głowy, karku i obręczy barkowej": 45, "Masaż transbukalny": 60, "Ukojenie Dla Żuchwy i Twarzy": 60}')
on conflict (id) do update set hours = excluded.hours, durations = excluded.durations;
alter table public.booking_settings enable row level security;

alter table public.booking_requests add column if not exists attempt       smallint not null default 1;
alter table public.booking_requests add column if not exists conflict_info text;   -- z czym się nakłada (dla studia)
alter table public.booking_requests add column if not exists suggestions   jsonb;  -- wolne godziny zaproponowane klientce
alter table public.booking_requests drop constraint if exists booking_requests_status_check;
alter table public.booking_requests add constraint booking_requests_status_check
  check (status in ('new', 'suggested', 'confirmed', 'declined', 'cancelled'));

-- ---------- Pomocnicze ----------

-- czas rytuału w minutach; bez nazwy („doradź mi”) najdłuższy z listy
create or replace function public.svc_minutes(p_service text) returns int
language sql stable security definer set search_path = public as $$
  select case when nullif(trim(coalesce(p_service, '')), '') is null
    then (select max(v::int) from jsonb_each_text(s.durations) d(k, v))
    else coalesce((s.durations ->> trim(p_service))::int, s.default_min) end
  from public.booking_settings s where s.id = 1
$$;

-- zajęte przedziały dnia (z przerwą po rytuale)
create or replace function public.busy_ranges(p_day date)
returns table (r tstzrange, who text, at_time text, service text)
language sql stable security definer set search_path = public as $$
  select tstzrange(p.start_at, coalesce(b.end_at, p.start_at + make_interval(mins => public.svc_minutes(p.service)))
                   + make_interval(mins => s.break_min)),
         coalesce(c.name, p.guest_name, 'Klientka Booksy'),
         to_char(p.start_at at time zone 'Europe/Warsaw', 'HH24:MI'), p.service
    from public.day_plan p
    left join public.booksy_bookings b on b.id = p.booking_id
    left join public.cards c on c.id = p.card_id
    cross join public.booking_settings s
   where s.id = 1 and p.day = p_day and p.status = 'planned' and p.start_at is not null
$$;

-- czy rytuał o długości p_min może zacząć się o p_start: 'ok', 'unknown' (dzień bez znanych godzin) albo powód
create or replace function public.slot_check(p_start timestamptz, p_min int) returns text
language plpgsql stable security definer set search_path = public as $$
declare s public.booking_settings; loc timestamp := p_start at time zone 'Europe/Warsaw'; d date := loc::date;
        h jsonb; who text;
begin
  select * into s from public.booking_settings where id = 1;
  if not (s.hours ? extract(isodow from d)::text) then return 'Studio nieczynne tego dnia'; end if;
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

-- wolne godziny najbliższe godzinie p_target (szuka od początku jej dnia do 21 dni naprzód, co 30 min)
drop function if exists public.free_slots(timestamptz, int, int);
create or replace function public.free_slots(p_target timestamptz, p_min int, p_n int default 3)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.booking_settings; d date; h jsonb; t timestamp; st timestamptz; found_ts timestamptz[] := '{}';
begin
  select * into s from public.booking_settings where id = 1;
  d := (greatest(p_target, now()) at time zone 'Europe/Warsaw')::date;
  for i in 0..21 loop
    h := s.hours -> extract(isodow from d + i)::text;
    if h is not null and jsonb_typeof(h) <> 'null' then
      t := (d + i) + (h ->> 0)::time;
      while t + make_interval(mins => p_min) <= (d + i) + (h ->> 1)::time loop
        st := t at time zone 'Europe/Warsaw';
        if public.slot_check(st, p_min) = 'ok' then found_ts := found_ts || st; end if;
        t := t + interval '30 minutes';
      end loop;
    end if;
    exit when array_length(found_ts, 1) >= p_n * 4;
  end loop;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x) from (
    select x from unnest(found_ts) x order by abs(extract(epoch from x - p_target)) limit p_n) q), '[]'::jsonb);
end $$;

-- sprawdzenie prośby: null = wolne albo nie da się sprawdzić, tekst = opis konfliktu
create or replace function public.request_conflict(p_day date, p_part text, p_time time, p_service text)
returns text language plpgsql stable security definer set search_path = public as $$
declare m int := public.svc_minutes(p_service); res text; t time; t_from time; t_to time; h jsonb;
begin
  if p_time is not null then
    res := public.slot_check((p_day + p_time) at time zone 'Europe/Warsaw', m);
    return case when res in ('ok', 'unknown') then null else res end;
  end if;
  h := (select hours from public.booking_settings where id = 1) -> extract(isodow from p_day)::text;
  if h is null then return 'Studio nieczynne tego dnia'; end if;
  if jsonb_typeof(h) = 'null' then return null; end if;
  t_from := case p_part when 'midday' then '12:00' when 'evening' then '16:00' else (h ->> 0)::time end;
  t_to   := case p_part when 'morning' then '11:59' when 'midday' then '15:59' else (h ->> 1)::time end;
  t := greatest(t_from, (h ->> 0)::time);
  while t <= t_to and t + make_interval(mins => m) <= (h ->> 1)::time loop
    if public.slot_check((p_day + t) at time zone 'Europe/Warsaw', m) = 'ok' then return null; end if;
    t := t + interval '30 minutes';
  end loop;
  return 'Brak wolnej godziny ' || public.request_part_label(p_part) || ' tego dnia';
end $$;

-- ---------- Klientka ----------

drop function if exists public.request_create(text, text, date, text, text, text, text);
create or replace function public.request_create(p_token text, p_service text, p_day date, p_part text, p_time text,
  p_phone text, p_message text, p_retry_of bigint default null)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards; r public.booking_requests; p9 text; att smallint := 1; part text; tm time; svc text;
        conflict text; sug jsonb; st text := 'new';
begin
  select * into c from public.cards where token = p_token;
  if not found then raise exception 'Nie znaleziono karty.'; end if;
  p9 := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if length(p9) < 9 then raise exception 'Podaj numer telefonu, żebym mogła oddzwonić.'; end if;
  if p_day is null or p_day < public.today_pl() then raise exception 'Wybierz dzień od dziś.'; end if;
  if p_day > public.today_pl() + 60 then raise exception 'Termin możesz wybrać najwyżej 60 dni naprzód.'; end if;
  -- „inny dzień” po propozycji wolnych godzin = druga próba (poprzednia prośba się zamyka)
  if p_retry_of is not null then
    update public.booking_requests set status = 'cancelled', handled_at = now()
     where id = p_retry_of and card_id = c.id and status = 'suggested';
    if found then att := 2; end if;
  end if;
  if (select count(*) from public.booking_requests where card_id = c.id and status in ('new', 'suggested')) >= 3 then
    raise exception 'Masz już 3 prośby czekające na odpowiedź. Odezwę się wkrótce.';
  end if;
  part := case when p_part in ('morning', 'midday', 'evening') then p_part else 'any' end;
  tm := nullif(trim(coalesce(p_time, '')), '')::time;
  svc := nullif(trim(coalesce(p_service, '')), '');
  conflict := public.request_conflict(p_day, part, tm, svc);
  if conflict is not null and att = 1 then
    sug := public.free_slots((p_day + coalesce(tm, case part when 'morning' then '09:00' when 'midday' then '12:00' when 'evening' then '16:00' else '12:00' end::time))
                             at time zone 'Europe/Warsaw', public.svc_minutes(svc));
    if jsonb_array_length(sug) > 0 then st := 'suggested'; else sug := null; end if;
  end if;
  insert into public.booking_requests (card_id, service, pref_day, pref_part, pref_time, phone, message, status, attempt, conflict_info, suggestions)
  values (c.id, svc, p_day, part, tm, trim(p_phone), nullif(trim(coalesce(p_message, '')), ''), st, att, conflict, sug)
  returning * into r;
  return public.request_json(r)::json;
end $$;

-- klientka wybiera jedną z zaproponowanych godzin
create or replace function public.request_pick(p_token text, p_id bigint, p_start timestamptz)
returns json language plpgsql security definer set search_path = public as $$
declare r public.booking_requests; res text;
begin
  select r2.* into r from public.booking_requests r2 join public.cards c on c.id = r2.card_id
   where r2.id = p_id and c.token = p_token and r2.status = 'suggested' for update of r2;
  if not found then raise exception 'Ta propozycja jest już nieaktualna. Poproś o termin jeszcze raz.'; end if;
  if not (r.suggestions @> jsonb_build_array(to_jsonb(p_start))) then raise exception 'Wybierz jedną z proponowanych godzin.'; end if;
  res := public.slot_check(p_start, public.svc_minutes(r.service));
  update public.booking_requests
     set pref_day = (p_start at time zone 'Europe/Warsaw')::date, pref_time = (p_start at time zone 'Europe/Warsaw')::time,
         pref_part = 'any', status = 'new', attempt = 2, suggestions = null,
         conflict_info = case when res in ('ok', 'unknown') then null else 'Wybrana godzina zajęła się w międzyczasie. ' || res end
   where id = p_id returning * into r;
  return public.request_json(r)::json;
end $$;

-- ---------- Widoki (z nowymi polami) ----------

create or replace function public.request_json(r public.booking_requests) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', r.id, 'card_id', r.card_id, 'service', r.service, 'pref_day', r.pref_day, 'pref_part', r.pref_part,
    'pref_time', to_char(r.pref_time, 'HH24:MI'), 'phone', r.phone, 'message', r.message, 'status', r.status,
    'confirmed_at', r.confirmed_at, 'reply', r.reply, 'handled_at', r.handled_at, 'created_at', r.created_at,
    'attempt', r.attempt, 'conflict', r.conflict_info, 'suggestions', r.suggestions)
$$;

create or replace function public.my_requests(p_token text)
returns json language plpgsql stable security definer set search_path = public as $$
declare cid uuid;
begin
  select id into cid from public.cards where token = p_token;
  if cid is null then return '[]'::json; end if;
  return coalesce((
    select json_agg(public.request_json(r) - 'conflict' order by r.created_at desc)
    from (select * from public.booking_requests
           where card_id = cid and (status in ('new', 'suggested')
              or (status = 'confirmed' and confirmed_at > now() - interval '1 hour')
              or (status = 'declined' and handled_at > now() - interval '7 days'))
           order by created_at desc limit 5) r
  ), '[]'::json);
end $$;

create or replace function public.request_cancel(p_token text, p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.booking_requests r set status = 'cancelled', handled_at = now()
    from public.cards c
   where r.id = p_id and r.card_id = c.id and c.token = p_token and r.status in ('new', 'suggested');
  if not found then raise exception 'Tej prośby nie można już anulować. Zadzwoń do studia.'; end if;
end $$;

-- ---------- Studio ----------

create or replace function public.requests_list()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((
    select json_agg(public.request_json(r) || jsonb_build_object('name', c.name, 'stamps', c.stamps, 'card_phone', c.phone)
                    order by (r.status in ('new', 'suggested')) desc, r.status = 'suggested',
                             case when r.status in ('new', 'suggested') then r.created_at end, r.handled_at desc nulls last)
    from public.booking_requests r join public.cards c on c.id = r.card_id
    where r.status in ('new', 'suggested') or r.handled_at > now() - interval '14 days'
  ), '[]'::json);
end $$;

-- studio może potwierdzić także prośbę czekającą na wybór klientki
create or replace function public.request_confirm(p_id bigint, p_day date, p_time text, p_service text default null)
returns json language plpgsql security definer set search_path = public as $$
declare r public.booking_requests; t time; st timestamptz; pid bigint; svc text;
begin
  perform public.staff_check();
  select * into r from public.booking_requests where id = p_id for update;
  if not found then raise exception 'Nie znaleziono prośby.'; end if;
  if r.status not in ('new', 'suggested', 'declined') then raise exception 'Ta prośba jest już załatwiona.'; end if;
  if p_day is null or p_day < public.today_pl() then raise exception 'Wybierz dzień od dziś.'; end if;
  if p_day > public.today_pl() + 60 then raise exception 'Termin najwyżej 60 dni naprzód.'; end if;
  t := nullif(trim(coalesce(p_time, '')), '')::time;
  if t is null then raise exception 'Podaj godzinę wizyty.'; end if;
  st := (p_day + t) at time zone 'Europe/Warsaw';
  svc := coalesce(nullif(trim(coalesce(p_service, '')), ''), r.service);
  select id into pid from public.day_plan
   where card_id = r.card_id and day = p_day and status = 'planned' and booking_id is null order by id limit 1;
  if pid is not null then
    update public.day_plan set start_at = st, service = coalesce(svc, service) where id = pid;
  else
    insert into public.day_plan (card_id, day, service, start_at) values (r.card_id, p_day, svc, st) returning id into pid;
  end if;
  update public.booking_requests
     set status = 'confirmed', confirmed_at = st, plan_id = pid, service = svc, reply = null, suggestions = null, handled_at = now()
   where id = p_id returning * into r;
  return public.request_json(r)::json;
end $$;

create or replace function public.request_decline(p_id bigint, p_reply text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.booking_requests set status = 'declined', reply = nullif(trim(coalesce(p_reply, '')), ''), suggestions = null, handled_at = now()
   where id = p_id and status in ('new', 'suggested');
  if not found then raise exception 'Ta prośba jest już załatwiona.'; end if;
end $$;

-- panel: sprawdzenie, czy godzina potwierdzenia nie koliduje (ostrzeżenie, nie blokada)
create or replace function public.slot_conflict(p_day date, p_time text, p_service text)
returns text language plpgsql stable security definer set search_path = public as $$
declare res text;
begin
  perform public.staff_check();
  res := public.slot_check((p_day + p_time::time) at time zone 'Europe/Warsaw', public.svc_minutes(p_service));
  return case when res in ('ok', 'unknown', 'Za krótko przed wizytą') then null else res end;
end $$;

-- ---------- Powiadomienia ----------

create or replace function public.booking_request_push()
returns trigger language plpgsql security definer set search_path = public as $$
declare secret text; nm text; what text; payloads jsonb[] := '{}';
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then return new; end if;
  select name into nm from public.cards where id = new.card_id;
  what := coalesce(nm, 'Klientka') || ' · ' || coalesce(new.service, 'rytuał') || ' · ' || public.pl_day_label(new.pref_day)
          || ', ' || coalesce(to_char(new.pref_time, 'HH24:MI'), public.request_part_label(new.pref_part));
  if tg_op = 'INSERT' and new.status = 'suggested' then
    payloads := payloads || jsonb_build_object('owner', true, 'title', 'Prośba o termin · konflikt',
      'body', what || '. Zaproponowałam klientce 3 wolne godziny.', 'url', 'panel.html#prosby');
    payloads := payloads || jsonb_build_object('card_id', new.card_id, 'title', 'Ten termin jest zajęty',
      'body', 'Wybierz jedną z wolnych godzin na swojej karcie.', 'url', './');
  elsif tg_op = 'INSERT' and new.status = 'new' then
    payloads := payloads || jsonb_build_object('owner', true,
      'title', case when new.conflict_info is not null then 'Prośba o termin · KONFLIKT' else 'Prośba o termin' end,
      'body', what || coalesce('. ' || new.conflict_info, ''), 'url', 'panel.html#prosby');
  elsif tg_op = 'UPDATE' and new.status = 'new' and old.status = 'suggested' then
    payloads := payloads || jsonb_build_object('owner', true,
      'title', case when new.conflict_info is not null then 'Klientka wybrała godzinę · KONFLIKT' else 'Klientka wybrała godzinę' end,
      'body', what || coalesce('. ' || new.conflict_info, '. Czeka na Twoje potwierdzenie.'), 'url', 'panel.html#prosby');
  elsif tg_op = 'UPDATE' and new.status = 'confirmed' and old.status is distinct from 'confirmed' then
    payloads := payloads || jsonb_build_object('card_id', new.card_id, 'title', 'Termin potwierdzony',
      'body', (select upper(left(l, 1)) || substr(l, 2) from public.pl_day_label((new.confirmed_at at time zone 'Europe/Warsaw')::date) l) || ', '
              || to_char(new.confirmed_at at time zone 'Europe/Warsaw', 'HH24:MI') || '. Do zobaczenia!', 'url', './');
  elsif tg_op = 'UPDATE' and new.status = 'declined' and old.status is distinct from 'declined' then
    payloads := payloads || jsonb_build_object('card_id', new.card_id, 'title', 'Odpowiedź na prośbę o termin',
      'body', coalesce(new.reply, 'Ten termin jest niestety zajęty. Zajrzyj do karty.'), 'url', './');
  end if;
  for i in 1..coalesce(array_length(payloads, 1), 0) loop
    perform net.http_post(
      url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/send-push',
      body := payloads[i],
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret));
  end loop;
  return new;
exception when others then
  return new; -- brak powiadomienia nie może blokować prośby
end $$;
revoke execute on function public.booking_request_push() from public, anon, authenticated;

-- ---------- Uprawnienia ----------
revoke all on function public.svc_minutes(text), public.busy_ranges(date), public.slot_check(timestamptz, int),
  public.free_slots(timestamptz, int, int), public.request_conflict(date, text, time, text) from public, anon, authenticated;
revoke all on function public.request_create(text, text, date, text, text, text, text, bigint), public.request_pick(text, bigint, timestamptz),
  public.slot_conflict(date, text, text) from public;
grant execute on function public.request_create(text, text, date, text, text, text, text, bigint), public.request_pick(text, bigint, timestamptz)
  to anon, authenticated;
grant execute on function public.slot_conflict(date, text, text) to authenticated;
