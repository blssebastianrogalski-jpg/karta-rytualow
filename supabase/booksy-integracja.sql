-- ============================================================
--  Integracja Booksy → aplikacja → Kalendarz Google
--  Booksy wysyła maile na konto studia. Skrypt Google (Apps Script) na tym
--  koncie co 5 minut czyta nowe maile od no-reply@booksy.com, wysyła tu
--  odczytane dane (funkcje booksy_script_*), a potem zapisuje wizyty
--  w Kalendarzu Google. Booksy pozostaje źródłem prawdy.
--  Uruchom raz w Supabase → SQL Editor (można uruchomić ponownie).
-- ============================================================

-- ---------- Tabele ----------

-- Ustawienia integracji (zawsze jeden wiersz)
create table if not exists public.booksy_settings (
  id               int primary key default 1 check (id = 1),
  key_hash         text,                 -- skrót SHA-256 klucza skryptu (samego klucza nie przechowujemy)
  connected_at     timestamptz,
  sync_since       timestamptz,          -- maile starsze niż ta chwila czeka import z podglądem
  gcal_mode        text not null default 'delete' check (gcal_mode in ('delete', 'mark')),
  calendar_name    text not null default 'Twoje Ciało Twój Dobrostan | Wizyty',
  script_last_seen timestamptz,
  gmail_ok         boolean,
  calendar_ok      boolean,
  last_ok_at       timestamptz,
  last_error       text,
  last_error_at    timestamptz,
  sync_requested_at timestamptz,
  import_state     text not null default 'none' check (import_state in ('none', 'preview_requested', 'preview_ready', 'apply_requested', 'done')),
  import_preview   jsonb
);
insert into public.booksy_settings (id) values (1) on conflict do nothing;

-- Rezerwacje z Booksy (odwzorowanie; źródłem prawdy jest Booksy)
create table if not exists public.booksy_bookings (
  id             bigint generated always as identity primary key,
  booksy_id      text unique,            -- numer rezerwacji z maila, jeśli jest
  client_name    text,
  client_phone9  text,                   -- ostatnie 9 cyfr telefonu (do dopasowania karty)
  norm_name      text,
  card_id        uuid references public.cards(id) on delete set null,
  match_state    text not null default 'none' check (match_state in ('phone', 'name', 'created', 'manual', 'ambiguous', 'none')),
  service        text,
  start_at       timestamptz not null,
  end_at         timestamptz not null,
  status         text not null default 'booked' check (status in ('booked', 'cancelled')),
  last_event_at  timestamptz not null,   -- data maila z ostatnią zastosowaną zmianą (ochrona przed złą kolejnością)
  conflict       boolean not null default false,   -- nakłada się na inną wizytę z Booksy
  calendar_conflict boolean not null default false, -- nakłada się na ręczny wpis w Kalendarzu Google
  gcal_event_id  text,
  gcal_state     text not null default 'pending' check (gcal_state in ('pending', 'synced', 'error')),
  gcal_error     text,
  gcal_attempts  int not null default 0,
  next_try_at    timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists booksy_bookings_start_idx on public.booksy_bookings(start_at);
create index if not exists booksy_bookings_client_idx on public.booksy_bookings(client_phone9, norm_name);

-- Przetworzone maile: ochrona przed duplikatami i historia zmian każdej wizyty
create table if not exists public.booksy_messages (
  gmail_id     text primary key,
  received_at  timestamptz not null,
  kind         text not null,            -- new | change | cancel | unknown
  booking_id   bigint references public.booksy_bookings(id) on delete set null,
  result       text not null,            -- applied | stale | duplicate | past | ambiguous | unrecognized
  old_start    timestamptz,
  new_start    timestamptz,
  subject      text,                     -- tylko dla nierozpoznanych maili
  processed_at timestamptz not null default now()
);
create index if not exists booksy_messages_booking_idx on public.booksy_messages(booking_id);

-- Dziennik synchronizacji (bez danych klientek)
create table if not exists public.booksy_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  level      text not null default 'info' check (level in ('info', 'warn', 'error')),
  action     text not null,
  booking_id bigint,
  message    text
);

-- Plan dnia: wiersze z Booksy mają godzinę i powiązanie z rezerwacją.
-- Klientka bez karty w aplikacji (do przypisania) ma tylko guest_name.
alter table public.day_plan alter column card_id drop not null;
alter table public.day_plan add column if not exists booking_id bigint unique references public.booksy_bookings(id) on delete set null;
alter table public.day_plan add column if not exists start_at timestamptz;
alter table public.day_plan add column if not exists guest_name text;

alter table public.booksy_settings enable row level security;
alter table public.booksy_bookings enable row level security;
alter table public.booksy_messages enable row level security;
alter table public.booksy_log enable row level security;
drop policy if exists staff_read on public.booksy_bookings;
create policy staff_read on public.booksy_bookings for select to authenticated using (public.is_staff());
drop policy if exists staff_read on public.booksy_log;
create policy staff_read on public.booksy_log for select to authenticated using (public.is_staff());
-- booksy_settings i booksy_messages: tylko przez funkcje poniżej

-- ---------- Pomocnicze ----------

create or replace function public.booksy_phone9(p text) returns text
language sql immutable as $$
  select case when length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) >= 9
    then right(regexp_replace(p, '\D', '', 'g'), 9) end
$$;

create or replace function public.booksy_norm(p text) returns text
language sql immutable as $$
  select nullif(lower(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g')), '')
$$;

-- '2026-10-25T10:00' (czas polski) → timestamptz; czas letni i zimowy liczy baza
create or replace function public.booksy_local(p text) returns timestamptz
language plpgsql stable as $$
begin
  if p is null or p = '' then return null; end if;
  return (p::timestamp) at time zone 'Europe/Warsaw';
exception when others then return null;
end $$;

-- "Anna Kowalska" → "Anna K." (do Kalendarza Google trafia tylko to)
create or replace function public.booksy_short_name(p text) returns text
language sql immutable as $$
  select case when p is null then null
    when position(' ' in trim(p)) = 0 then trim(p)
    else split_part(trim(p), ' ', 1) || ' ' || left(split_part(trim(p), ' ', 2), 1) || '.' end
$$;

create or replace function public.booksy_log_add(p_level text, p_action text, p_booking bigint, p_message text) returns void
language sql security definer set search_path = public as $$
  insert into public.booksy_log (level, action, booking_id, message) values (p_level, p_action, p_booking, left(p_message, 300));
$$;

-- Sprawdzenie klucza skryptu
create or replace function public.booksy_auth(p_key text) returns public.booksy_settings
language plpgsql security definer set search_path = public as $$
declare s public.booksy_settings;
begin
  select * into s from public.booksy_settings where id = 1;
  if s.key_hash is null or p_key is null or encode(sha256(convert_to(p_key, 'UTF8')), 'hex') <> s.key_hash then
    raise exception 'Nieprawidłowy klucz integracji.';
  end if;
  return s;
end $$;

-- Dopasowanie karty: najpierw telefon, imię i nazwisko tylko pomocniczo.
-- Wynik: card_id + stan (phone | name | created | ambiguous)
create or replace function public.booksy_match_card(p_name text, p_phone9 text, p_create boolean, out card uuid, out state text)
language plpgsql security definer set search_path = public as $$
declare n int; nm text := public.booksy_norm(p_name); other_phone text;
begin
  state := 'ambiguous';
  if p_phone9 is not null then
    select count(*) into n from public.cards where public.booksy_phone9(phone) = p_phone9;
    if n = 1 then
      select id into card from public.cards where public.booksy_phone9(phone) = p_phone9; state := 'phone'; return;
    elsif n > 1 then
      select count(*) into n from public.cards where public.booksy_phone9(phone) = p_phone9 and public.booksy_norm(name) = nm;
      if n = 1 then
        select id into card from public.cards where public.booksy_phone9(phone) = p_phone9 and public.booksy_norm(name) = nm; state := 'phone';
      end if;
      return;
    end if;
  end if;
  if nm is not null then
    select count(*) into n from public.cards where public.booksy_norm(name) = nm;
    if n = 1 then
      select id, public.booksy_phone9(phone) into card, other_phone from public.cards where public.booksy_norm(name) = nm;
      -- ta sama osoba tylko wtedy, gdy telefony nie przeczą sobie
      if other_phone is null or p_phone9 is null then state := 'name'; else card := null; end if;
      return;
    elsif n > 1 then
      return;
    end if;
  end if;
  -- nowa klientka: karta w studiu (bez aplikacji), jak przy imporcie z Booksy
  if p_create and nm is not null then
    insert into public.cards (code, name, phone, source, note)
    values (public.new_code(), left(trim(p_name), 80), case when p_phone9 is not null then substr(p_phone9, 1, 3) || ' ' || substr(p_phone9, 4, 3) || ' ' || substr(p_phone9, 7, 3) end, 'studio', 'Karta założona automatycznie z rezerwacji Booksy.')
    returning id into card;
    state := 'created';
  end if;
end $$;

-- Wpis w planie dnia dla rezerwacji (wykorzystuje istniejący plan, nie drugi kalendarz)
create or replace function public.booksy_sync_plan(p_booking bigint) returns void
language plpgsql security definer set search_path = public as $$
declare b public.booksy_bookings; p public.day_plan; d date;
begin
  select * into b from public.booksy_bookings where id = p_booking;
  d := (b.start_at at time zone 'Europe/Warsaw')::date;
  select * into p from public.day_plan where booking_id = b.id;
  if b.status = 'cancelled' then
    if found and p.status = 'planned' then delete from public.day_plan where id = p.id; end if;
    return;
  end if;
  if not found then
    -- ręcznie dodana ta sama klientka tego dnia: łączymy zamiast dublować
    if b.card_id is not null then
      select * into p from public.day_plan where card_id = b.card_id and day = d and status = 'planned' and booking_id is null order by id limit 1;
    end if;
    if p.id is not null then
      update public.day_plan set booking_id = b.id, start_at = b.start_at, service = coalesce(service, b.service) where id = p.id;
    else
      insert into public.day_plan (card_id, guest_name, day, service, start_at, booking_id)
      values (b.card_id, case when b.card_id is null then b.client_name end, d, b.service, b.start_at, b.id);
    end if;
  elsif p.status = 'planned' then
    update public.day_plan set day = d, start_at = b.start_at, service = b.service,
      card_id = coalesce(p.card_id, b.card_id), guest_name = case when coalesce(p.card_id, b.card_id) is null then b.client_name end
    where id = p.id;
  end if;
end $$;

-- Kolizje terminów między wizytami z Booksy
create or replace function public.booksy_mark_conflicts() returns void
language sql security definer set search_path = public as $$
  update public.booksy_bookings x set conflict = (x.status = 'booked' and exists (
    select 1 from public.booksy_bookings y
    where y.id <> x.id and y.status = 'booked' and y.start_at < x.end_at and x.start_at < y.end_at))
  where x.end_at > now() - interval '1 day';
$$;

-- Zastosowanie jednego odczytanego maila. Zwraca opis wyniku.
create or replace function public.booksy_apply(e jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  k   text := e->>'kind';
  gid text := nullif(e->>'gmail_id', '');
  rcv timestamptz := coalesce((e->>'received_at')::timestamptz, now());
  bk  text := nullif(trim(coalesce(e->>'booksy_id', '')), '');
  nm  text := nullif(trim(coalesce(e->>'client_name', '')), '');
  nn  text := public.booksy_norm(e->>'client_name');
  ph  text := public.booksy_phone9(e->>'client_phone');
  svc text := nullif(trim(regexp_replace(coalesce(e->>'service', ''), '^[^:]{2,40}:\s+', '')), '');  -- bez kategorii Booksy
  st  timestamptz := public.booksy_local(e->>'start_local');
  en  timestamptz := public.booksy_local(e->>'end_local');
  ost timestamptz := public.booksy_local(e->>'old_start_local');
  b   public.booksy_bookings;
  n   int;
  m   record;
  res text;
  old_st timestamptz;
  info jsonb := jsonb_build_object('gmail_id', e->>'gmail_id', 'kind', k, 'name', nm, 'service', svc, 'start', st);
begin
  if gid is null then return info || '{"result":"invalid"}'; end if;
  if exists (select 1 from public.booksy_messages where gmail_id = gid) then
    return info || '{"result":"duplicate"}';
  end if;
  if k not in ('new', 'change', 'cancel') or st is null or (bk is null and ph is null and nn is null) then
    insert into public.booksy_messages (gmail_id, received_at, kind, result, subject)
    values (gid, rcv, coalesce(k, 'unknown'), 'unrecognized', left(e->>'subject', 150));
    perform public.booksy_log_add('warn', 'unrecognized', null, 'Nierozpoznany mail Booksy (' || coalesce(k, 'unknown') || ').');
    return info || '{"result":"unrecognized"}';
  end if;
  if en is null or en <= st then en := st + interval '60 minutes'; end if;

  -- 1) znajdź rezerwację: numer z Booksy, a bez niego ta sama klientka + termin
  if bk is not null then
    select * into b from public.booksy_bookings where booksy_id = bk for update;
  else
    select count(*) into n from public.booksy_bookings
      where (case when ph is not null then client_phone9 = ph else client_phone9 is null and norm_name = nn end)
        and start_at = case when k = 'change' then coalesce(ost, st) else st end;
    if n = 1 then
      select * into b from public.booksy_bookings
        where (case when ph is not null then client_phone9 = ph else client_phone9 is null and norm_name = nn end)
          and start_at = case when k = 'change' then coalesce(ost, st) else st end for update;
    elsif n = 0 and k = 'change' and ost is null then
      -- zmiana bez starego terminu: tylko gdy klientka ma dokładnie jedną przyszłą wizytę
      select count(*) into n from public.booksy_bookings
        where (case when ph is not null then client_phone9 = ph else client_phone9 is null and norm_name = nn end)
          and status = 'booked' and start_at > now();
      if n = 1 then
        select * into b from public.booksy_bookings
          where (case when ph is not null then client_phone9 = ph else client_phone9 is null and norm_name = nn end)
            and status = 'booked' and start_at > now() for update;
      elsif n > 1 then
        insert into public.booksy_messages (gmail_id, received_at, kind, result, new_start) values (gid, rcv, k, 'ambiguous', st);
        perform public.booksy_log_add('warn', 'ambiguous', null, 'Zmiana terminu pasuje do kilku wizyt tej samej klientki. Nic nie zmieniono.');
        return info || '{"result":"ambiguous"}';
      end if;
    elsif n > 1 then
      insert into public.booksy_messages (gmail_id, received_at, kind, result, new_start) values (gid, rcv, k, 'ambiguous', st);
      perform public.booksy_log_add('warn', 'ambiguous', null, 'Mail pasuje do kilku wizyt. Nic nie zmieniono.');
      return info || '{"result":"ambiguous"}';
    end if;
  end if;

  -- 2) zastosuj zmianę
  if b.id is not null then
    if rcv < b.last_event_at then
      res := 'stale';   -- starszy mail niż ostatnio zastosowany: nic nie nadpisujemy
    else
      old_st := b.start_at;
      update public.booksy_bookings set
        status = case when k = 'cancel' then 'cancelled' else 'booked' end,
        start_at = case when k = 'cancel' then start_at else st end,
        end_at = case when k = 'cancel' then end_at else en end,
        service = coalesce(case when k = 'cancel' then null else svc end, service),
        client_name = coalesce(nm, client_name), norm_name = coalesce(nn, norm_name),
        client_phone9 = coalesce(ph, client_phone9),
        last_event_at = rcv, gcal_state = 'pending', gcal_attempts = 0, gcal_error = null,
        next_try_at = now(), updated_at = now()
      where id = b.id returning * into b;
      res := 'applied';
    end if;
  else
    if k <> 'cancel' and st < now() then
      res := 'past';    -- wizyta już minęła: nie importujemy historii
    else
      select * into m from public.booksy_match_card(nm, ph, k <> 'cancel');
      insert into public.booksy_bookings (booksy_id, client_name, client_phone9, norm_name, card_id, match_state,
        service, start_at, end_at, status, last_event_at, gcal_state)
      values (bk, nm, ph, nn, m.card, coalesce(m.state, 'none'), svc,
        st, en,
        case when k = 'cancel' then 'cancelled' else 'booked' end, rcv,
        case when k = 'cancel' then 'synced' else 'pending' end)
      returning * into b;
      res := 'applied';
    end if;
  end if;

  insert into public.booksy_messages (gmail_id, received_at, kind, booking_id, result, old_start, new_start)
  values (gid, rcv, k, b.id, res, old_st, case when k = 'cancel' then null else st end);
  if res = 'applied' then
    perform public.booksy_sync_plan(b.id);
    perform public.booksy_log_add('info', k, b.id,
      case k when 'new' then 'Nowa rezerwacja zapisana.' when 'change' then 'Termin zmieniony.' else 'Wizyta odwołana.' end);
  elsif res = 'stale' then
    perform public.booksy_log_add('info', 'stale', b.id, 'Starszy mail pominięty (nowsza zmiana jest już zapisana).');
  end if;
  return info || jsonb_build_object('result', res, 'booking_id', b.id, 'match', (select match_state from public.booksy_bookings where id = b.id));
end $$;

-- ---------- Funkcje dla skryptu Google (klucz zamiast logowania) ----------

create or replace function public.booksy_script_start(p_key text, p_info jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.booksy_settings := public.booksy_auth(p_key);
begin
  update public.booksy_settings set script_last_seen = now(),
    gmail_ok = coalesce((p_info->>'gmail_ok')::boolean, gmail_ok),
    calendar_ok = coalesce((p_info->>'calendar_ok')::boolean, calendar_ok)
  where id = 1;
  -- RODO: dane starszych wizyt nie są potrzebne
  delete from public.booksy_messages where received_at < now() - interval '180 days';
  delete from public.booksy_bookings where end_at < now() - interval '180 days';
  delete from public.booksy_log where at < now() - interval '90 days';
  return jsonb_build_object('sync_since', s.sync_since, 'gcal_mode', s.gcal_mode, 'calendar_name', s.calendar_name,
    'import_state', s.import_state, 'sync_requested', s.sync_requested_at is not null);
end $$;

-- Odczytane maile. p_dry_run = podgląd importu (nic nie zostaje zapisane).
create or replace function public.booksy_script_ingest(p_key text, p_events jsonb, p_dry_run boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e jsonb; res jsonb := '[]'::jsonb;
begin
  perform public.booksy_auth(p_key);
  begin
    for e in select x from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) x
             order by (x->>'received_at')::timestamptz, x->>'gmail_id' loop
      begin
        res := res || jsonb_build_array(public.booksy_apply(e));
      exception when others then
        -- jeden wadliwy mail nie blokuje pozostałych; skrypt spróbuje go ponownie
        res := res || jsonb_build_array(jsonb_build_object('gmail_id', e->>'gmail_id', 'result', 'error'));
        perform public.booksy_log_add('error', 'ingest', null, 'Błąd przetwarzania maila: ' || sqlerrm);
      end;
    end loop;
    perform public.booksy_mark_conflicts();
    if p_dry_run then raise exception using errcode = 'P0001', message = '__booksy_dry_run__'; end if;
  exception when raise_exception then
    if sqlerrm <> '__booksy_dry_run__' then raise; end if;
  end;
  return jsonb_build_object('results', res, 'dry_run', p_dry_run);
end $$;

-- Wizyty do zapisania w Kalendarzu Google (z ponawianiem po błędach)
create or replace function public.booksy_script_pending(p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.booksy_auth(p_key);
  -- odwołana wizyta, która nigdy nie trafiła do kalendarza: nie ma czego usuwać
  update public.booksy_bookings set gcal_state = 'synced', gcal_error = null
  where status = 'cancelled' and gcal_event_id is null and gcal_state <> 'synced';
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', b.id, 'version', extract(epoch from b.updated_at)::text, 'status', b.status,
      'start', b.start_at, 'end', b.end_at, 'service', b.service,
      'who', public.booksy_short_name(b.client_name), 'event_id', b.gcal_event_id, 'conflict', b.conflict) order by b.start_at)
    from (select * from public.booksy_bookings
          where gcal_state in ('pending', 'error') and gcal_attempts < 20 and next_try_at <= now()
          order by start_at limit 40) b), '[]'::jsonb);
end $$;

-- Wynik zapisu w kalendarzu: [{id, version, ok, event_id, error, calendar_conflict}]
create or replace function public.booksy_script_result(p_key text, p_results jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r jsonb; b public.booksy_bookings;
begin
  perform public.booksy_auth(p_key);
  for r in select x from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) x loop
    select * into b from public.booksy_bookings where id = (r->>'id')::bigint for update;
    if not found then continue; end if;
    if coalesce((r->>'ok')::boolean, false) then
      update public.booksy_bookings set gcal_event_id = nullif(r->>'event_id', ''),
        calendar_conflict = coalesce((r->>'calendar_conflict')::boolean, false),
        -- w międzyczasie przyszła nowa zmiana: zostaje do ponownego zapisu
        gcal_state = case when extract(epoch from updated_at)::text = r->>'version' then 'synced' else 'pending' end,
        gcal_error = null, gcal_attempts = 0
      where id = b.id;
    else
      update public.booksy_bookings set gcal_state = 'error', gcal_attempts = gcal_attempts + 1,
        gcal_error = left(coalesce(r->>'error', 'Nieznany błąd'), 200),
        next_try_at = now() + least(interval '6 hours', interval '1 minute' * power(2, gcal_attempts + 1))
      where id = b.id;
      perform public.booksy_log_add('error', 'calendar', b.id, 'Kalendarz Google: ' || coalesce(r->>'error', 'błąd'));
    end if;
  end loop;
end $$;

-- Koniec przebiegu skryptu
create or replace function public.booksy_script_finish(p_key text, p_ok boolean, p_error text default null,
  p_stats jsonb default '{}', p_import_preview jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare s public.booksy_settings := public.booksy_auth(p_key);
begin
  if p_ok then
    update public.booksy_settings set last_ok_at = now(), sync_requested_at = null,
      import_state = case
        when p_import_preview is not null and import_state = 'preview_requested' then 'preview_ready'
        when import_state = 'apply_requested' and coalesce((p_stats->>'import_applied')::boolean, false) then 'done'
        else import_state end,
      import_preview = coalesce(p_import_preview, import_preview)
    where id = 1;
    if coalesce((p_stats->>'messages')::int, 0) > 0 or coalesce((p_stats->>'calendar')::int, 0) > 0 then
      perform public.booksy_log_add('info', 'run', null, 'Przebieg: maile ' || coalesce(p_stats->>'messages', '0') || ', kalendarz ' || coalesce(p_stats->>'calendar', '0') || '.');
    end if;
  else
    update public.booksy_settings set last_error = left(coalesce(p_error, 'Błąd skryptu'), 300), last_error_at = now() where id = 1;
    perform public.booksy_log_add('error', 'run', null, coalesce(p_error, 'Błąd skryptu'));
  end if;
end $$;

-- ---------- Funkcje dla panelu (właścicielka) ----------

create or replace function public.booksy_status()
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.booksy_settings;
begin
  perform public.staff_check();
  select * into s from public.booksy_settings where id = 1;
  return jsonb_build_object(
    'connected', s.key_hash is not null, 'connected_at', s.connected_at, 'sync_since', s.sync_since,
    'script_last_seen', s.script_last_seen, 'gmail_ok', s.gmail_ok, 'calendar_ok', s.calendar_ok,
    'last_ok_at', s.last_ok_at, 'last_error', s.last_error, 'last_error_at', s.last_error_at,
    'sync_requested_at', s.sync_requested_at, 'gcal_mode', s.gcal_mode, 'calendar_name', s.calendar_name,
    'import_state', s.import_state, 'import_preview', s.import_preview,
    'processed', (select count(*) from public.booksy_messages where result = 'applied'),
    'bookings', (select count(*) from public.booksy_bookings),
    'errors', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'service', service, 'start', start_at, 'error', gcal_error, 'attempts', gcal_attempts) order by start_at)
       from public.booksy_bookings where gcal_state = 'error'), '[]'::jsonb),
    'unrecognized', coalesce((select jsonb_agg(jsonb_build_object('at', received_at, 'kind', kind, 'subject', subject, 'result', result) order by received_at desc)
       from (select * from public.booksy_messages where result in ('unrecognized', 'ambiguous') order by received_at desc limit 10) m), '[]'::jsonb),
    'unassigned', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.client_name, 'service', b.service, 'start', b.start_at,
         'candidates', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone)) from public.cards c
            where public.booksy_norm(c.name) = b.norm_name or (b.client_phone9 is not null and public.booksy_phone9(c.phone) = b.client_phone9)), '[]'::jsonb)) order by b.start_at)
       from public.booksy_bookings b where b.card_id is null and b.status = 'booked' and b.end_at > now()), '[]'::jsonb),
    'upcoming', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', coalesce(c.name, b.client_name), 'service', b.service,
         'start', b.start_at, 'end', b.end_at, 'gcal', b.gcal_state, 'conflict', b.conflict or b.calendar_conflict, 'card', b.card_id is not null) order by b.start_at)
       from public.booksy_bookings b left join public.cards c on c.id = b.card_id
       where b.status = 'booked' and b.end_at > now() and b.start_at < now() + interval '14 days'), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('at', at, 'level', level, 'message', message) order by at desc)
       from (select * from public.booksy_log order by at desc limit 15) l), '[]'::jsonb)
  );
end $$;

-- Nowy klucz dla skryptu (pokazywany raz). Stary klucz przestaje działać.
create or replace function public.booksy_new_key()
returns text language plpgsql security definer set search_path = public as $$
declare k text := 'tctd_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  perform public.staff_check();
  update public.booksy_settings set key_hash = encode(sha256(convert_to(k, 'UTF8')), 'hex'),
    connected_at = now(), sync_since = coalesce(sync_since, now()), last_error = null where id = 1;
  perform public.booksy_log_add('info', 'connect', null, 'Utworzono klucz skryptu.');
  return k;
end $$;

create or replace function public.booksy_disconnect()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.booksy_settings set key_hash = null, connected_at = null, gmail_ok = null, calendar_ok = null where id = 1;
  perform public.booksy_log_add('info', 'disconnect', null, 'Integracja rozłączona. Rezerwacje i plan zostają bez zmian.');
end $$;

create or replace function public.booksy_request_sync()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.booksy_settings set sync_requested_at = now() where id = 1;
end $$;

-- Ponowienie zapisu w kalendarzu: jednej wizyty albo wszystkich z błędem
create or replace function public.booksy_retry(p_id bigint default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.booksy_bookings set gcal_state = 'pending', gcal_attempts = 0, next_try_at = now()
  where gcal_state = 'error' and (p_id is null or id = p_id);
  update public.booksy_settings set sync_requested_at = now() where id = 1;
end $$;

create or replace function public.booksy_set_mode(p_mode text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.booksy_settings set gcal_mode = p_mode where id = 1;
end $$;

-- Import przyszłych wizyt z wcześniejszych maili: preview → apply (albo cancel)
create or replace function public.booksy_import(p_action text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.booksy_settings set
    import_state = case p_action when 'preview' then 'preview_requested' when 'apply' then 'apply_requested' else 'none' end,
    import_preview = case when p_action = 'cancel' then null else import_preview end,
    sync_requested_at = case when p_action in ('preview', 'apply') then now() else sync_requested_at end
  where id = 1;
end $$;

-- Przypisanie rezerwacji do karty (p_card = null: nowa karta z danych rezerwacji)
create or replace function public.booksy_assign(p_booking bigint, p_card uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare b public.booksy_bookings; c uuid := p_card;
begin
  perform public.staff_check();
  select * into b from public.booksy_bookings where id = p_booking for update;
  if not found then raise exception 'Nie znaleziono rezerwacji.'; end if;
  if c is null then
    insert into public.cards (code, name, phone, source, note)
    values (public.new_code(), left(coalesce(b.client_name, 'Klientka Booksy'), 80),
      case when b.client_phone9 is not null then substr(b.client_phone9, 1, 3) || ' ' || substr(b.client_phone9, 4, 3) || ' ' || substr(b.client_phone9, 7, 3) end,
      'studio', 'Karta założona z rezerwacji Booksy.')
    returning id into c;
  end if;
  update public.booksy_bookings set card_id = c, match_state = 'manual', updated_at = now() where id = b.id;
  update public.day_plan set card_id = c, guest_name = null where booking_id = b.id;
end $$;

-- Plan dnia z godzinami i wpisami z Booksy
create or replace function public.plan_list(p_day date default null)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((
    select json_agg(json_build_object(
      'id', p.id, 'card_id', p.card_id, 'service', p.service, 'status', p.status,
      'name', coalesce(c.name, p.guest_name, 'Klientka Booksy'), 'stamps', coalesce(c.stamps, 0), 'source', c.source, 'phone', c.phone,
      'bday_today', coalesce(public.is_bday_today(c.bday_day, c.bday_month), false),
      'birthday_used_year', c.birthday_used_year,
      'start_at', p.start_at, 'booking_id', p.booking_id,
      'conflict', coalesce(b.conflict or b.calendar_conflict, false)
    ) order by p.start_at nulls last, p.created_at)
    from public.day_plan p
    left join public.cards c on c.id = p.card_id
    left join public.booksy_bookings b on b.id = p.booking_id
    where p.day = coalesce(p_day, public.today_pl())
  ), '[]'::json);
end $$;

-- ---------- Uprawnienia ----------

revoke all on function public.booksy_auth(text), public.booksy_apply(jsonb), public.booksy_sync_plan(bigint),
  public.booksy_mark_conflicts(), public.booksy_match_card(text, text, boolean), public.booksy_log_add(text, text, bigint, text)
  from public, anon, authenticated;
revoke all on function public.booksy_script_start(text, jsonb), public.booksy_script_ingest(text, jsonb, boolean),
  public.booksy_script_pending(text), public.booksy_script_result(text, jsonb),
  public.booksy_script_finish(text, boolean, text, jsonb, jsonb) from public;
grant execute on function public.booksy_script_start(text, jsonb), public.booksy_script_ingest(text, jsonb, boolean),
  public.booksy_script_pending(text), public.booksy_script_result(text, jsonb),
  public.booksy_script_finish(text, boolean, text, jsonb, jsonb) to anon, authenticated;
revoke all on function public.booksy_status(), public.booksy_new_key(), public.booksy_disconnect(), public.booksy_request_sync(),
  public.booksy_retry(bigint), public.booksy_set_mode(text), public.booksy_import(text), public.booksy_assign(bigint, uuid)
  from public, anon;
grant execute on function public.booksy_status(), public.booksy_new_key(), public.booksy_disconnect(), public.booksy_request_sync(),
  public.booksy_retry(bigint), public.booksy_set_mode(text), public.booksy_import(text), public.booksy_assign(bigint, uuid)
  to authenticated;

-- ---------- Porządki (bezpieczne przy ponownym uruchomieniu) ----------
-- nazwy usług bez kategorii Booksy, np. „Vouchery i Pakiety: Pakiety Kobido UP®” → „Pakiety Kobido UP®”
update public.day_plan p set service = regexp_replace(p.service, '^[^:]{2,40}:\s+', '')
  where p.booking_id is not null and p.service ~ '^[^:]{2,40}:\s+';
update public.booksy_bookings set service = regexp_replace(service, '^[^:]{2,40}:\s+', ''),
  gcal_state = 'pending', gcal_attempts = 0, next_try_at = now(), updated_at = now()
  where service ~ '^[^:]{2,40}:\s+';
