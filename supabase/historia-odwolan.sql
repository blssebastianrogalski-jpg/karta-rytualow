-- Historia odwołań i ostrzeżenie o nowej rezerwacji (Regulamin wizyt, pkt 3 i 5).
-- Uruchom w Supabase → SQL Editor (raz). Nie kasuje żadnych danych i nic nie wysyła klientkom.
--
-- • visit_incidents: każde odwołanie i nieprzyjście:
--     cancel = odwołanie co najmniej 24 h przed wizytą,
--     late   = odwołanie później niż 24 h przed wizytą,
--     noshow = nie przyszła (zaznaczone w panelu).
--   Skąd: mail Booksy o odwołaniu, „Odwołaj” na karcie w aplikacji, „Usuń z planu” w panelu
--   (powód „Klientka odwołała” albo „Nie przyszła”) i ręczny wpis w karcie klientki (starsza historia).
--   Przełożenie wizyty i „Pomyłka w planie” się nie liczą.
-- • Zasady z regulaminu:
--     year = co najmniej 2 nieodbyte wizyty (late/noshow) w tym roku kalendarzowym,
--     row  = dwie ostatnie rezerwacje zakończone odwołaniem (dowolnym), bez wizyty pomiędzy.
-- • risk_alerts: gdy osoba spełniająca którąś zasadę zarezerwuje wizytę (Booksy, prośba o termin
--   w aplikacji, wpis w planie), w panelu pojawia się ostrzeżenie, a właścicielka dostaje push.
--   SMS do klientki wychodzi WYŁĄCZNIE po kliknięciu „Wyślij SMS” w panelu (risk_alert_sms).

-- ---------- Tabele ----------

create table if not exists public.visit_incidents (
  id          bigint generated always as identity primary key,
  card_id     uuid,                       -- bez klucza obcego: usunięcie karty nie może się wywrócić
  phone9      text,                       -- ostatnie 9 cyfr telefonu (dopasowanie do Booksy)
  name        text,
  kind        text not null check (kind in ('cancel', 'late', 'noshow')),
  visit_at    timestamptz not null,       -- termin wizyty, której dotyczy
  reported_at timestamptz not null default now(),  -- kiedy odwołała
  source      text not null check (source in ('booksy', 'app', 'panel', 'manual')),
  booking_id  bigint unique,              -- rezerwacja Booksy (jedna wizyta = jeden wpis)
  plan_id     bigint,
  service     text,
  note        text check (note is null or char_length(note) <= 200),
  created_at  timestamptz not null default now()
);
create index if not exists visit_incidents_card_idx on public.visit_incidents(card_id);
create index if not exists visit_incidents_phone_idx on public.visit_incidents(phone9);
alter table public.visit_incidents enable row level security;

create table if not exists public.risk_alerts (
  id          bigint generated always as identity primary key,
  card_id     uuid,
  phone9      text,
  name        text,
  phone       text,                       -- numer do SMS
  day         date not null,
  visit_at    timestamptz,                -- null = prośba o termin bez konkretnej godziny
  service     text,
  source      text not null check (source in ('booksy', 'app', 'plan')),
  booking_id  bigint unique,
  request_id  bigint unique,
  plan_id     bigint,
  reasons     jsonb not null,
  status      text not null default 'new' check (status in ('new', 'sent', 'dismissed')),
  sms_text    text,
  handled_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists risk_alerts_status_idx on public.risk_alerts(status, created_at desc);
alter table public.risk_alerts enable row level security;
-- Brak polityk: zapis i odczyt tylko przez funkcje poniżej.

-- ---------- Ocena według regulaminu ----------

create or replace function public.risk_phone9(p text) returns text
language sql immutable as $$
  select case when length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) >= 9
    then right(regexp_replace(p, '\D', '', 'g'), 9) end
$$;

-- null = wszystko w porządku; inaczej { reasons: [...], history: [...] }
create or replace function public.risk_eval(p_card uuid, p_phone9 text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  y int := extract(year from now() at time zone 'Europe/Warsaw')::int;
  reasons jsonb := '[]'::jsonb;
  n int; lst jsonb; last2 boolean[]; hist jsonb;
begin
  if p_card is null and p_phone9 is null then return null; end if;

  -- zasada 1: co najmniej 2 nieodbyte wizyty w tym roku
  select count(*), jsonb_agg(jsonb_build_object('at', visit_at, 'kind', kind) order by visit_at)
    into n, lst
    from public.visit_incidents i
   where ((p_card is not null and i.card_id = p_card) or (p_phone9 is not null and i.phone9 = p_phone9))
     and i.kind in ('late', 'noshow')
     and extract(year from i.visit_at at time zone 'Europe/Warsaw')::int = y;
  if n >= 2 then reasons := reasons || jsonb_build_array(jsonb_build_object('rule', 'year', 'n', n, 'list', lst)); end if;

  -- zasada 2: dwie ostatnie rezerwacje odwołane (bez wizyty pomiędzy)
  select array_agg(c order by at desc) into last2 from (
    select at, c from (
      select i.visit_at as at, true as c from public.visit_incidents i
       where (p_card is not null and i.card_id = p_card) or (p_phone9 is not null and i.phone9 = p_phone9)
      union all
      select v.created_at, false from public.visits v
       where p_card is not null and v.card_id = p_card
      union all
      select b.start_at, false from public.booksy_bookings b
       where b.status = 'booked' and b.start_at < now()
         and ((p_card is not null and b.card_id = p_card) or (p_phone9 is not null and b.client_phone9 = p_phone9))
         and not exists (select 1 from public.visit_incidents i where i.booking_id = b.id)
    ) e order by at desc limit 2
  ) t;
  if coalesce(array_length(last2, 1), 0) = 2 and last2[1] and last2[2] then
    select jsonb_agg(jsonb_build_object('at', at, 'kind', kind) order by at) into lst from (
      select i.visit_at as at, i.kind from public.visit_incidents i
       where (p_card is not null and i.card_id = p_card) or (p_phone9 is not null and i.phone9 = p_phone9)
       order by i.visit_at desc limit 2) z;
    reasons := reasons || jsonb_build_array(jsonb_build_object('rule', 'row', 'list', lst));
  end if;

  if jsonb_array_length(reasons) = 0 then return null; end if;
  select jsonb_agg(jsonb_build_object('id', id, 'at', visit_at, 'kind', kind, 'source', source, 'service', service, 'note', note) order by visit_at desc)
    into hist from (
      select * from public.visit_incidents i
       where (p_card is not null and i.card_id = p_card) or (p_phone9 is not null and i.phone9 = p_phone9)
       order by visit_at desc limit 12) h;
  return jsonb_build_object('reasons', reasons, 'history', coalesce(hist, '[]'::jsonb));
end $$;
revoke execute on function public.risk_eval(uuid, text) from public, anon, authenticated;

-- ---------- Zapis odwołania ----------

create or replace function public.incident_record(p_card uuid, p_phone9 text, p_name text, p_visit_at timestamptz,
  p_reported timestamptz, p_noshow boolean, p_source text, p_booking bigint, p_plan bigint, p_service text)
returns void language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if p_visit_at is null or (p_card is null and p_phone9 is null) then return; end if;
  k := case when p_noshow then 'noshow'
            when p_reported > p_visit_at - interval '24 hours' then 'late'
            else 'cancel' end;
  if p_booking is not null then
    insert into public.visit_incidents (card_id, phone9, name, kind, visit_at, reported_at, source, booking_id, plan_id, service)
    values (p_card, p_phone9, p_name, k, p_visit_at, p_reported, p_source, p_booking, p_plan, p_service)
    on conflict (booking_id) do update
      set kind = case when excluded.source = 'panel' then excluded.kind else visit_incidents.kind end,
          card_id = coalesce(visit_incidents.card_id, excluded.card_id);
  else
    insert into public.visit_incidents (card_id, phone9, name, kind, visit_at, reported_at, source, plan_id, service)
    values (p_card, p_phone9, p_name, k, p_visit_at, p_reported, p_source, p_plan, p_service);
  end if;
end $$;
revoke execute on function public.incident_record(uuid, text, text, timestamptz, timestamptz, boolean, text, bigint, bigint, text) from public, anon, authenticated;

-- mail Booksy „odwołał(a) wizytę”: liczy się godzina maila
create or replace function public.booksy_message_incident()
returns trigger language plpgsql security definer set search_path = public as $$
declare b public.booksy_bookings;
begin
  if new.kind <> 'cancel' or new.result <> 'applied' or new.booking_id is null then return null; end if;
  select * into b from public.booksy_bookings where id = new.booking_id;
  if not found then return null; end if;
  perform public.incident_record(b.card_id, b.client_phone9, b.client_name, b.start_at, new.received_at, false,
    'booksy', b.id, null, b.service);
  return null;
exception when others then
  return null; -- historia nigdy nie blokuje integracji
end $$;
revoke execute on function public.booksy_message_incident() from public, anon, authenticated;
drop trigger if exists booksy_message_incident on public.booksy_messages;
create trigger booksy_message_incident after insert on public.booksy_messages
  for each row execute function public.booksy_message_incident();

-- wizyta znika z planu: „Odwołaj” w aplikacji albo „Usuń z planu” w panelu
-- tctd.powod ustawia plan_cancel (client / noshow); pomyłka w planie i przełożenie się nie liczą
-- BEFORE: przy przełożeniu booking_requests.move_of jeszcze wskazuje ten wiersz (klucz obcy potem go zeruje)
create or replace function public.day_plan_incident()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  o public.day_plan := old;
  why text := nullif(current_setting('tctd.powod', true), '');
  b public.booksy_bookings; c public.cards;
  st timestamptz;
begin
  if o.status <> 'planned' then return old; end if;
  if why = 'mistake' or (why is null and current_setting('tctd.bez_oferty', true) = '1') then return old; end if;
  -- przełożenie przez prośbę z aplikacji (stary termin znika po potwierdzeniu nowego)
  if exists (select 1 from public.booking_requests r where r.move_of = o.id and r.status = 'confirmed') then return old; end if;
  st := coalesce(o.start_at, (o.day + time '09:00') at time zone 'Europe/Warsaw');
  if o.booking_id is not null then
    -- Booksy usuwa wizytę z planu samo (po mailu); tu tylko decyzja właścicielki w panelu
    if why is null then return old; end if;
    select * into b from public.booksy_bookings where id = o.booking_id;
    perform public.incident_record(coalesce(o.card_id, b.card_id), b.client_phone9, coalesce(b.client_name, o.guest_name),
      coalesce(b.start_at, st), now(), why = 'noshow', 'panel', o.booking_id, o.id, coalesce(o.service, b.service));
    return old;
  end if;
  if o.card_id is null then return old; end if;
  select * into c from public.cards where id = o.card_id;
  if not found then return old; end if; -- usuwanie karty
  perform public.incident_record(c.id, public.risk_phone9(c.phone), c.name, st, now(), why = 'noshow',
    case when why is null then 'app' else 'panel' end, null, o.id, o.service);
  return old;
exception when others then
  return old; -- historia nigdy nie blokuje odwołania
end $$;
revoke execute on function public.day_plan_incident() from public, anon, authenticated;
drop trigger if exists day_plan_incident on public.day_plan;
create trigger day_plan_incident before delete on public.day_plan
  for each row execute function public.day_plan_incident();

-- usunięcie karty usuwa też jej historię odwołań
create or replace function public.cards_incident_cleanup()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.visit_incidents where card_id = old.id;
  delete from public.risk_alerts where card_id = old.id;
  return null;
exception when others then
  return null;
end $$;
revoke execute on function public.cards_incident_cleanup() from public, anon, authenticated;
drop trigger if exists cards_incident_cleanup on public.cards;
create trigger cards_incident_cleanup after delete on public.cards
  for each row execute function public.cards_incident_cleanup();

-- ---------- Usunięcie z planu: nowy powód „Nie przyszła” ----------
-- (jak w zmiana-wizyty.sql, plus p_reason 'noshow' i zapis w historii odwołań)
create or replace function public.plan_cancel(p_plan_id bigint, p_reason text default 'client', p_sms boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare p public.day_plan; sms boolean := false;
begin
  perform public.staff_check();
  if coalesce(p_reason, 'client') not in ('client', 'mistake', 'noshow') then raise exception 'Nieznany powód.'; end if;
  select * into p from public.day_plan where id = p_plan_id for update;
  if not found then return json_build_object('sms', false); end if;  -- już usunięta
  if p.status <> 'planned' then raise exception 'Ta wizyta jest już zapisana, więc nie można jej usunąć z planu.'; end if;
  update public.booking_requests set status = 'cancelled', reply = 'Odwołana przez studio', handled_at = now()
   where plan_id = p.id and status = 'confirmed';
  update public.booking_requests set status = 'cancelled', handled_at = now()
   where move_of = p.id and status in ('new', 'suggested');
  perform set_config('tctd.powod', coalesce(p_reason, 'client'), true);
  -- pomyłka w planie albo nieprzyjście: okienko nie idzie do automatu „Wolne terminy”
  if p_reason in ('mistake', 'noshow') then perform set_config('tctd.bez_oferty', '1', true); end if;
  delete from public.day_plan where id = p.id;
  perform set_config('tctd.powod', '', true);

  if coalesce(p_sms, false) and p_reason <> 'noshow' and p.card_id is not null
     and coalesce(p.start_at, (p.day + 1)::timestamp at time zone 'Europe/Warsaw') > now() then
    sms := public.visit_notify_client(p.card_id, 'Wizyta odwołana',
      'Wizyta ' || public.pl_day_label(p.day) || coalesce(', ' || to_char(p.start_at at time zone 'Europe/Warsaw', 'HH24:MI'), '')
        || ' jest odwołana. Nowy termin wybierzesz na karcie.',
      'Wizyta odwołana: ' || public.visit_when_short(p.day, p.start_at)
        || coalesce(', ' || left(trim(regexp_replace(p.service, '[®™©]', '', 'g')), 38), '')
        || '. Nowy termin: karta.twojecialotwojdobrostan.pl Twoje Ciało Twój Dobrostan');
  end if;
  return json_build_object('sms', sms);
end $$;
revoke all on function public.plan_cancel(bigint, text, boolean) from public, anon;
grant execute on function public.plan_cancel(bigint, text, boolean) to authenticated;

-- ---------- Ostrzeżenie przy nowej rezerwacji ----------

create or replace function public.risk_alert_make(p_card uuid, p_phone9 text, p_name text, p_phone text,
  p_day date, p_visit_at timestamptz, p_service text, p_source text, p_booking bigint, p_request bigint, p_plan bigint)
returns void language plpgsql security definer set search_path = public as $$
declare r jsonb; ph9 text := p_phone9; when_txt text; why text;
begin
  if p_card is not null and ph9 is null then select public.risk_phone9(phone) into ph9 from public.cards where id = p_card; end if;
  r := public.risk_eval(p_card, ph9);
  if r is null then return; end if;
  -- jedna rezerwacja = jedno ostrzeżenie (prośba z aplikacji i jej potwierdzenie w planie to ta sama wizyta)
  if exists (select 1 from public.risk_alerts a
              where ((p_card is not null and a.card_id = p_card) or (ph9 is not null and a.phone9 = ph9))
                and (a.day = p_day or a.created_at > now() - interval '3 days')) then return; end if;
  insert into public.risk_alerts (card_id, phone9, name, phone, day, visit_at, service, source, booking_id, request_id, plan_id, reasons)
  values (p_card, ph9, p_name, coalesce(nullif(trim(coalesce(p_phone, '')), ''), ph9), p_day, p_visit_at, p_service, p_source,
          p_booking, p_request, p_plan, r);
  when_txt := public.visit_when_short(p_day, p_visit_at);
  why := case when exists (select 1 from jsonb_array_elements(r->'reasons') x where x->>'rule' = 'year')
              then 'nieodbyte wizyty w tym roku' else 'dwa odwołania pod rząd' end;
  perform public.gap_owner_push('Rezerwacja osoby z historią odwołań',
    coalesce(p_name, 'Klientka') || ' · ' || when_txt || ' · ' || why || '. Zdecyduj w panelu, czy wysłać SMS o zadatku.',
    'panel.html#ostrzezenia');
exception when others then
  return; -- ostrzeżenie nigdy nie blokuje rezerwacji
end $$;
revoke execute on function public.risk_alert_make(uuid, text, text, text, date, timestamptz, text, text, bigint, bigint, bigint) from public, anon, authenticated;

create or replace function public.booksy_booking_risk()
returns trigger language plpgsql security definer set search_path = public as $$
declare ph text;
begin
  if new.status <> 'booked' or new.start_at <= now() then return null; end if;
  if new.card_id is not null then select phone into ph from public.cards where id = new.card_id; end if;
  perform public.risk_alert_make(new.card_id, new.client_phone9, new.client_name, coalesce(ph, new.client_phone9),
    (new.start_at at time zone 'Europe/Warsaw')::date, new.start_at, new.service, 'booksy', new.id, null, null);
  return null;
exception when others then return null;
end $$;
revoke execute on function public.booksy_booking_risk() from public, anon, authenticated;
drop trigger if exists booksy_booking_risk on public.booksy_bookings;
create trigger booksy_booking_risk after insert on public.booksy_bookings
  for each row execute function public.booksy_booking_risk();

create or replace function public.booking_request_risk()
returns trigger language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  if new.status <> 'new' or new.move_of is not null then return null; end if;
  select * into c from public.cards where id = new.card_id;
  perform public.risk_alert_make(new.card_id, coalesce(public.risk_phone9(c.phone), public.risk_phone9(new.phone)), c.name,
    coalesce(nullif(new.phone, ''), c.phone), new.pref_day,
    case when new.pref_time is not null then (new.pref_day + new.pref_time) at time zone 'Europe/Warsaw' end,
    new.service, 'app', null, new.id, null);
  return null;
exception when others then return null;
end $$;
revoke execute on function public.booking_request_risk() from public, anon, authenticated;
drop trigger if exists booking_request_risk on public.booking_requests;
create trigger booking_request_risk after insert on public.booking_requests
  for each row execute function public.booking_request_risk();

create or replace function public.day_plan_risk()
returns trigger language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  if new.booking_id is not null or new.card_id is null or new.status <> 'planned' or new.day < public.today_pl() then return null; end if;
  select * into c from public.cards where id = new.card_id;
  perform public.risk_alert_make(c.id, public.risk_phone9(c.phone), c.name, c.phone, new.day, new.start_at, new.service,
    'plan', null, null, new.id);
  return null;
exception when others then return null;
end $$;
revoke execute on function public.day_plan_risk() from public, anon, authenticated;
drop trigger if exists day_plan_risk on public.day_plan;
create trigger day_plan_risk after insert on public.day_plan
  for each row execute function public.day_plan_risk();

-- ---------- Panel ----------

-- ostrzeżenia: nowe + załatwione w ostatnich 14 dniach
create or replace function public.risk_alerts_list()
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((select json_agg(json_build_object(
      'id', a.id, 'card_id', a.card_id, 'name', coalesce(c.name, a.name, 'Klientka'), 'phone', a.phone,
      'day', a.day, 'visit_at', a.visit_at, 'service', a.service, 'source', a.source,
      'reasons', a.reasons->'reasons', 'history', a.reasons->'history',
      'status', a.status, 'sms_text', a.sms_text, 'handled_at', a.handled_at, 'created_at', a.created_at)
      order by (a.status = 'new') desc, a.created_at desc)
    from public.risk_alerts a left join public.cards c on c.id = a.card_id
    where a.status = 'new' or a.handled_at > now() - interval '14 days'), '[]'::json);
end $$;

-- SMS do klientki: tylko na wyraźne kliknięcie właścicielki, z treścią z panelu
create or replace function public.risk_alert_sms(p_id bigint, p_text text)
returns json language plpgsql security definer set search_path = public as $$
declare a public.risk_alerts; secret text; msg text := trim(coalesce(p_text, ''));
begin
  perform public.staff_check();
  select * into a from public.risk_alerts where id = p_id for update;
  if not found then raise exception 'Nie ma już tego ostrzeżenia. Odśwież panel.'; end if;
  if a.status = 'sent' then raise exception 'SMS do tej osoby już wyszedł.'; end if;
  if char_length(msg) < 10 then raise exception 'Wpisz treść SMS-a.'; end if;
  if char_length(msg) > 459 then raise exception 'SMS jest za długi (najwyżej 459 znaków, czyli 3 części).'; end if;
  if public.risk_phone9(a.phone) is null then raise exception 'Brak numeru telefonu tej osoby.'; end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then raise exception 'Brak sekretu push_secret w bazie, SMS nie wyszedł.'; end if;
  perform net.http_post(
    url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/sms-wyslij',
    body := jsonb_build_object('phone', a.phone, 'msg', msg),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret));
  update public.risk_alerts set status = 'sent', sms_text = msg, handled_at = now() where id = a.id;
  return json_build_object('phone', a.phone);
end $$;

create or replace function public.risk_alert_dismiss(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.risk_alerts set status = 'dismissed', handled_at = now() where id = p_id and status = 'new';
end $$;

-- historia odwołań w karcie klientki
create or replace function public.incidents_card(p_card uuid)
returns json language plpgsql security definer set search_path = public as $$
declare ph9 text;
begin
  perform public.staff_check();
  select public.risk_phone9(phone) into ph9 from public.cards where id = p_card;
  return json_build_object(
    'list', coalesce((select json_agg(json_build_object('id', i.id, 'at', i.visit_at, 'kind', i.kind, 'source', i.source,
                        'service', i.service, 'note', i.note) order by i.visit_at desc)
                      from public.visit_incidents i where i.card_id = p_card or (ph9 is not null and i.phone9 = ph9)), '[]'::json),
    'risk', public.risk_eval(p_card, ph9)->'reasons');
end $$;

-- ręczny wpis (np. starsza historia sprzed aplikacji)
create or replace function public.incident_add(p_card uuid, p_day date, p_kind text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  perform public.staff_check();
  select * into c from public.cards where id = p_card;
  if not found then raise exception 'Nie znaleziono karty.'; end if;
  if p_kind not in ('cancel', 'late', 'noshow') then raise exception 'Wybierz, co się stało.'; end if;
  if p_day is null or p_day > public.today_pl() + 60 or p_day < date '2025-01-01' then raise exception 'Sprawdź datę wizyty.'; end if;
  insert into public.visit_incidents (card_id, phone9, name, kind, visit_at, reported_at, source, note)
  values (c.id, public.risk_phone9(c.phone), c.name, p_kind, (p_day + time '12:00') at time zone 'Europe/Warsaw', now(), 'manual',
          nullif(left(trim(coalesce(p_note, '')), 200), ''));
end $$;

create or replace function public.incident_delete(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  delete from public.visit_incidents where id = p_id;
end $$;

revoke all on function public.risk_alerts_list(), public.risk_alert_sms(bigint, text), public.risk_alert_dismiss(bigint),
  public.incidents_card(uuid), public.incident_add(uuid, date, text, text), public.incident_delete(bigint) from public, anon;
grant execute on function public.risk_alerts_list(), public.risk_alert_sms(bigint, text), public.risk_alert_dismiss(bigint),
  public.incidents_card(uuid), public.incident_add(uuid, date, text, text), public.incident_delete(bigint) to authenticated;

-- ---------- Odwołania z Booksy, które już są w bazie (od 24.10.2026) ----------
insert into public.visit_incidents (card_id, phone9, name, kind, visit_at, reported_at, source, booking_id, service)
select distinct on (b.id) b.card_id, b.client_phone9, b.client_name,
       case when m.received_at > b.start_at - interval '24 hours' then 'late' else 'cancel' end,
       b.start_at, m.received_at, 'booksy', b.id, b.service
  from public.booksy_messages m join public.booksy_bookings b on b.id = m.booking_id
 where m.kind = 'cancel' and m.result = 'applied'
 order by b.id, m.received_at
on conflict (booking_id) do nothing;

-- Podsumowanie po uruchomieniu
select (select count(*) from public.visit_incidents) as odwolania_w_historii,
       (select count(*) from public.visit_incidents where kind = 'late') as pozne_odwolania;
