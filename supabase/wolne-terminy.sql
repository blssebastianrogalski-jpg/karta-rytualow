-- Wolne terminy: uzupełnianie luk w grafiku.
--  1) Po odwołaniu (w aplikacji, w Booksy albo „×”/„Odwołana” w panelu) wolny termin na dziś, jutro lub pojutrze
--     po 10 minutach sam trafia jako oferta do klientek ze zgodą: push + SMS.
--  2) Zwykłe luki: codziennie o 18:00 studio dostaje pytanie „Wysłać ofertę na jutro?” i decyduje w panelu.
--  3) Kto pierwsza stuknie „Biorę”, ta ma termin: wizyta od razu trafia do planu dnia i na kartę klientki.
--     Za wizytę z wolnego terminu klientka dostaje dodatkową pieczątkę (dopisuje się, gdy studio zapisze wizytę).
--  SMS najwyżej 2 na klientkę w tygodniu (ustawienie gap_sms_week), push bez limitu.
--  Wizytę z oferty trzeba dopisać w Booksy (studio dostaje o tym powiadomienie).
-- Wymaga wcześniejszych prosby-konflikty.sql, wizyty-sms-odwolanie.sql, program-polecen.sql i urodziny-przypomnienia-i-zyczenia.sql.
-- Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych.

-- ---------- Ustawienia ----------
alter table public.booking_settings add column if not exists gap_on       boolean not null default true; -- oferty po odwołaniu (automat)
alter table public.booking_settings add column if not exists gap_daily_on boolean not null default true; -- pytanie o zwykłe luki o 18:00
alter table public.booking_settings add column if not exists gap_days     int not null default 2;       -- odwołania na dziś … +2 dni
alter table public.booking_settings add column if not exists gap_min      int not null default 45;      -- najkrótszy rytuał, który zmieści się w luce
alter table public.booking_settings add column if not exists gap_wait_min int not null default 10;      -- ile minut czekać po odwołaniu
alter table public.booking_settings add column if not exists gap_sms_week int not null default 2;       -- najwięcej SMS-ów z ofertą na klientkę w 7 dni

-- ---------- Oferty ----------
create table if not exists public.gap_offers (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('cancel', 'daily')),
  day         date not null,
  start_at    timestamptz not null,          -- początek wolnego okna
  end_at      timestamptz not null,          -- do tej godziny musi skończyć się rytuał
  -- pending = czeka chwilę po odwołaniu, ask = czeka na decyzję studia, open = wysłana,
  -- closed = zajęta albo minęła, skipped = studio nie wysłało albo termin zajął się wcześniej
  status      text not null default 'pending' check (status in ('pending', 'ask', 'open', 'closed', 'skipped')),
  cancel_card uuid references public.cards(id) on delete set null,   -- kto odwołała (nie dostaje oferty)
  info        text,                          -- np. „odwołała Anna Kowalska, Kobido UP®”
  send_after  timestamptz not null default now(),
  sent_at     timestamptz,
  push_n      int,
  sms_n       int,
  created_at  timestamptz not null default now()
);
create index if not exists gap_offers_status_idx on public.gap_offers(status, day);
alter table public.gap_offers enable row level security;

create table if not exists public.gap_notified (
  offer_id bigint not null references public.gap_offers(id) on delete cascade,
  card_id  uuid not null references public.cards(id) on delete cascade,
  push     boolean not null default false,
  sms      boolean not null default false,
  at       timestamptz not null default now(),
  primary key (offer_id, card_id)
);
create index if not exists gap_notified_card_idx on public.gap_notified(card_id, at desc);
alter table public.gap_notified enable row level security;
-- Brak polityk: odczyt i zapis tylko przez funkcje poniżej.

alter table public.day_plan add column if not exists gap_offer_id bigint references public.gap_offers(id) on delete set null;
alter table public.day_plan add column if not exists gap_bonus_at timestamptz;   -- kiedy dopisano dodatkową pieczątkę

-- nowy rodzaj wpisu w historii: dodatkowa pieczątka za wolny termin
do $$
declare r record;
begin
  for r in select conname from pg_constraint
           where conrelid = 'public.visits'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%'
  loop
    execute format('alter table public.visits drop constraint %I', r.conname);
  end loop;
end $$;
alter table public.visits add constraint visits_kind_check
  check (kind in ('stamp', 'package_buy', 'package_visit', 'birthday', 'referral', 'gap'));

-- ---------- Pomocnicze ----------

-- koniec wolnego okna od p_start (null = nie zmieści się nawet najkrótszy rytuał)
create or replace function public.gap_window_end(p_start timestamptz) returns timestamptz
language plpgsql stable security definer set search_path = public as $$
declare m int := (select gap_min from public.booking_settings where id = 1);
begin
  if public.slot_check(p_start, m) <> 'ok' then return null; end if;
  while m < 600 and public.slot_check(p_start, m + 15) = 'ok' loop m := m + 15; end loop;
  return p_start + make_interval(mins => m);
end $$;

-- wolne okna dnia (co 30 minut, jak przy prośbach o termin)
create or replace function public.gap_windows(p_day date)
returns table (start_at timestamptz, end_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare s public.booking_settings; h jsonb; t timestamp; st timestamptz; w_start timestamptz; w_end timestamptz; e timestamptz;
begin
  select * into s from public.booking_settings where id = 1;
  h := s.hours -> extract(isodow from p_day)::text;
  if h is null or jsonb_typeof(h) = 'null' then return; end if;
  t := p_day + (h ->> 0)::time;
  while t + make_interval(mins => s.gap_min) <= p_day + (h ->> 1)::time loop
    st := t at time zone 'Europe/Warsaw';
    e := public.gap_window_end(st);
    if e is not null then
      if w_start is null then w_start := st; end if;
      w_end := greatest(coalesce(w_end, e), e);
    elsif w_start is not null then
      start_at := w_start; end_at := w_end; return next;
      w_start := null; w_end := null;
    end if;
    t := t + interval '30 minutes';
  end loop;
  if w_start is not null then start_at := w_start; end_at := w_end; return next; end if;
end $$;

-- godziny rozpoczęcia, które wciąż są wolne w ofercie: [{at, max}] (max = ile minut zmieści się od tej godziny)
create or replace function public.gap_starts(o public.gap_offers) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m int := (select gap_min from public.booking_settings where id = 1); t timestamptz := o.start_at; e timestamptz; res jsonb := '[]';
begin
  while t + make_interval(mins => m) <= o.end_at loop
    e := public.gap_window_end(t);
    if e is not null then
      e := least(e, o.end_at);
      if e >= t + make_interval(mins => m) then
        res := res || jsonb_build_object('at', t, 'max', (extract(epoch from e - t) / 60)::int);
      end if;
    end if;
    t := t + interval '30 minutes';
  end loop;
  return res;
end $$;

-- „jutro 14:00–15:30” / „dziś …” / „pt. 31.10 …” (do SMS, bez polskich znaków po stronie bramki)
create or replace function public.gap_when_short(p_day date) returns text
language sql stable as $$
  select case when p_day = public.today_pl() then 'dziś' when p_day = public.today_pl() + 1 then 'jutro'
    else (array['nd.','pon.','wt.','śr.','czw.','pt.','sob.'])[extract(dow from p_day)::int + 1] || ' ' || to_char(p_day, 'DD.MM') end
$$;
create or replace function public.gap_range(a timestamptz, b timestamptz) returns text
language sql stable as $$
  select to_char(a at time zone 'Europe/Warsaw', 'HH24:MI') || '–' || to_char(b at time zone 'Europe/Warsaw', 'HH24:MI')
$$;

-- ---------- Wykrycie odwołania ----------
-- Wizyta z godziną znika z planu (usunięta, „Odwołana” albo przeniesiona na inną godzinę) → oferta czeka gap_wait_min minut.
-- Po tym czasie termin jest sprawdzany jeszcze raz: jeśli ktoś go zajął, oferta nie wychodzi.
create or replace function public.day_plan_gap_detect()
returns trigger language plpgsql security definer set search_path = public as $$
declare s public.booking_settings; o public.day_plan := old; nm text;
begin
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

drop trigger if exists day_plan_gap_detect on public.day_plan;
create trigger day_plan_gap_detect
  after delete or update of status, start_at on public.day_plan
  for each row execute function public.day_plan_gap_detect();

-- ---------- Wysyłka oferty ----------
-- p_ids: oferty z jednego dnia wysyłane razem (jedna wiadomość). Zwraca liczbę klientek.
create or replace function public.gap_send(p_ids bigint[])
returns int language plpgsql security definer set search_path = public as $$
declare s public.booking_settings; secret text; d date; windows text; n_push int := 0; n_sms int := 0; n int := 0;
        c record; do_sms boolean; has_push boolean; skip uuid[]; msg text; first_id bigint := p_ids[1];
begin
  select * into s from public.booking_settings where id = 1;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  select min(day), string_agg(public.gap_range(start_at, end_at), ', ' order by start_at),
         array_agg(cancel_card) filter (where cancel_card is not null)
    into d, windows, skip from public.gap_offers where id = any(p_ids);
  update public.gap_offers set status = 'open', sent_at = now() where id = any(p_ids);
  if secret is null or d is null then return 0; end if;

  for c in
    select k.id, k.phone,
           exists (select 1 from public.push_subscriptions ps where ps.card_id = k.id) as has_push,
           (select count(*) from public.gap_notified gn where gn.card_id = k.id and gn.sms and gn.at > now() - interval '7 days') as sms_week
      from public.cards k
     where k.sms_ok
       and not (k.id = any(coalesce(skip, '{}'::uuid[])))
       and not exists (select 1 from public.day_plan p where p.card_id = k.id and p.day = d and p.status = 'planned')
  loop
    has_push := c.has_push;
    do_sms := c.sms_week < s.gap_sms_week and length(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')) >= 9;
    if not has_push and not do_sms then continue; end if;
    begin
      if has_push then
        perform net.http_post(
          url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/send-push',
          body := jsonb_build_object('card_id', c.id, 'title', 'Zwolnił się termin: ' || public.gap_when_short(d),
            'body', 'Wolne ' || windows || '. Kto pierwszy, ten lepszy, a za ten termin dostaniesz dodatkową pieczątkę. Stuknij, żeby wybrać godzinę.',
            'url', 'https://karta.twojecialotwojdobrostan.pl/#wolne'),
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret));
        n_push := n_push + 1;
      end if;
      if do_sms then
        -- jeden SMS (do 160 znaków po zamianie polskich liter)
        msg := 'Zwolnil sie termin ' || public.gap_when_short(d) || ': ' || left(replace(windows, '–', '-'), 35)
               || '. Kto pierwszy, ten lepszy + dodatkowa pieczatka! karta.twojecialotwojdobrostan.pl lub 500694094';
        perform public.sms_to(c.phone, msg, secret);
        n_sms := n_sms + 1;
      end if;
      insert into public.gap_notified (offer_id, card_id, push, sms) values (first_id, c.id, has_push, do_sms)
      on conflict (offer_id, card_id) do nothing;
      n := n + 1;
    exception when others then null; -- jedna klientka nie zatrzymuje reszty
    end;
  end loop;
  update public.gap_offers set push_n = n_push, sms_n = n_sms where id = any(p_ids);
  return n;
end $$;
revoke execute on function public.gap_send(bigint[]) from public, anon, authenticated;

create or replace function public.gap_owner_push(p_title text, p_body text, p_url text default 'panel.html#wolne')
returns void language plpgsql security definer set search_path = public as $$
declare secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then return; end if;
  perform net.http_post(
    url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/send-push',
    body := jsonb_build_object('owner', true, 'title', p_title, 'body', p_body, 'url', p_url),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret));
exception when others then null;
end $$;
revoke execute on function public.gap_owner_push(text, text, text) from public, anon, authenticated;

-- ---------- Co 5 minut: wysyłka po odwołaniu, zamykanie ofert, pytanie o jutro ----------
create or replace function public.gap_process(p_now timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
declare s public.booking_settings; o public.gap_offers; e timestamptz; n int; loc timestamp := p_now at time zone 'Europe/Warsaw';
        tmr date := (p_now at time zone 'Europe/Warsaw')::date + 1; w record; list text; ids bigint[];
begin
  select * into s from public.booking_settings where id = 1;

  -- 1) odwołania po czasie oczekiwania: sprawdź jeszcze raz i wyślij
  for o in select * from public.gap_offers where status = 'pending' and send_after <= p_now order by start_at for update skip locked loop
    e := public.gap_window_end(o.start_at);
    if e is null or not s.gap_on then
      update public.gap_offers set status = 'skipped', info = coalesce(info, '') || ' · termin już zajęty' where id = o.id;
      continue;
    end if;
    update public.gap_offers set end_at = e where id = o.id;
    n := public.gap_send(array[o.id]);
    perform public.gap_owner_push('Wysłałam ofertę wolnego terminu',
      initcap(public.gap_when_short(o.day)) || ' ' || public.gap_range(o.start_at, e) || ' (' || o.info || '). Oferta poszła do '
      || n || ' ' || case when n = 1 then 'klientki' else 'klientek' end || '.');
  end loop;

  -- 2) oferty, w których nie zostało już miejsca albo czasu
  update public.gap_offers g set status = 'closed'
   where g.status = 'open' and (g.end_at < p_now + make_interval(mins => s.lead_min + s.gap_min)
                                 or jsonb_array_length(public.gap_starts(g)) = 0);
  update public.gap_offers set status = 'skipped' where status = 'ask' and day < public.today_pl();

  -- 3) 18:00: zwykłe luki na jutro → pytanie do studia (raz dziennie)
  if s.gap_daily_on and extract(hour from loc) = 18
     and not exists (select 1 from public.gap_offers where kind = 'daily' and day = tmr) then
    for w in select * from public.gap_windows(tmr) loop
      -- okno już wysłane po odwołaniu nie wraca drugi raz
      if exists (select 1 from public.gap_offers g where g.status in ('pending', 'open') and g.day = tmr
                  and tstzrange(g.start_at, g.end_at) && tstzrange(w.start_at, w.end_at)) then continue; end if;
      insert into public.gap_offers (kind, day, start_at, end_at, status, info)
      values ('daily', tmr, w.start_at, w.end_at, 'ask', 'zwykła luka w grafiku');
    end loop;
    select string_agg(public.gap_range(start_at, end_at), ', ' order by start_at) into list
      from public.gap_offers where kind = 'daily' and day = tmr and status = 'ask';
    if list is not null then
      perform public.gap_owner_push('Wolne terminy na jutro', 'Jutro wolne: ' || list || '. Wysłać ofertę klientkom? Stuknij, żeby zdecydować.');
    end if;
  end if;
end $$;
revoke execute on function public.gap_process(timestamptz) from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname = 'gap-offers';
select cron.schedule('gap-offers', '*/5 * * * *', $$select public.gap_process()$$);
-- Wyłączenie w razie potrzeby:  select cron.unschedule('gap-offers');
-- albo tylko automat po odwołaniu: update public.booking_settings set gap_on = false where id = 1;

-- ---------- Klientka ----------

create or replace function public.my_gap_offers(p_token text)
returns json language plpgsql stable security definer set search_path = public as $$
declare c public.cards; s public.booking_settings;
begin
  select * into c from public.cards where token = p_token;
  if not found then return '[]'::json; end if;
  select * into s from public.booking_settings where id = 1;
  return coalesce((
    select json_agg(x order by x.start_at) from (
      select g.id, g.kind, g.day, g.start_at, g.end_at, public.gap_starts(g) as starts, s.durations, s.default_min
        from public.gap_offers g
       where g.status = 'open' and g.day >= public.today_pl()
         and g.cancel_card is distinct from c.id
    ) x where jsonb_array_length(x.starts) > 0
  ), '[]'::json);
end $$;

create or replace function public.gap_take(p_token text, p_offer bigint, p_start timestamptz, p_service text)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards; o public.gap_offers; m int; svc text := nullif(trim(coalesce(p_service, '')), ''); pid bigint;
        loc timestamp := p_start at time zone 'Europe/Warsaw';
begin
  perform pg_advisory_xact_lock(hashtext('gap_take')); -- dwie klientki naraz: pierwsza wygrywa
  select * into c from public.cards where token = p_token;
  if not found then raise exception 'Nie znaleziono karty.'; end if;
  select * into o from public.gap_offers where id = p_offer;
  if not found or o.status <> 'open' then raise exception 'Ten termin jest już zajęty. Dziękuję, że chciałaś!'; end if;
  if svc is null then raise exception 'Wybierz rytuał.'; end if;
  m := public.svc_minutes(svc);
  if p_start < o.start_at or p_start + make_interval(mins => m) > o.end_at then
    raise exception 'Ten rytuał nie zmieści się w wolnym terminie. Wybierz krótszy albo inną godzinę.';
  end if;
  if public.slot_check(p_start, m) <> 'ok' then raise exception 'Ktoś właśnie zajął tę godzinę. Wybierz inną, jeśli jest.'; end if;
  if exists (select 1 from public.day_plan where gap_offer_id = o.id and card_id = c.id and status = 'planned') then
    raise exception 'Masz już wizytę z tej oferty.';
  end if;

  insert into public.day_plan (card_id, day, service, start_at, gap_offer_id)
  values (c.id, o.day, svc, p_start, o.id) returning id into pid;
  -- jak potwierdzona prośba o termin: przypomnienie dzień przed, „Przełóż” i „Odwołaj” na karcie
  insert into public.booking_requests (card_id, service, pref_day, pref_part, pref_time, phone, status, confirmed_at, plan_id, reply, handled_at)
  values (c.id, svc, o.day, 'any', loc::time, left(coalesce(c.phone, ''), 30), 'confirmed', p_start, pid, 'Wolny termin z oferty', now());
  if jsonb_array_length(public.gap_starts(o)) = 0 then update public.gap_offers set status = 'closed' where id = o.id; end if;

  perform public.gap_owner_push('Wolny termin zajęty',
    c.name || ' · ' || public.pl_day_label(o.day) || ', ' || to_char(loc, 'HH24:MI') || ' · ' || svc
    || '. Jest już w planie dnia. Wpisz wizytę w Booksy.', 'panel.html');
  return json_build_object('plan_id', pid, 'day', o.day, 'start_at', p_start, 'service', svc);
end $$;

-- ---------- Dodatkowa pieczątka po wizycie z wolnego terminu ----------
-- Dopisuje się, gdy studio zapisze wizytę z planu dnia (pieczątka, pakiet, urodziny).
-- Nie wypełnia 5. ani 10. kratki (tam jest rabat za wizytę): wtedy czeka jak pieczątka za polecenie.
create or replace function public.day_plan_gap_bonus()
returns trigger language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  if new.gap_offer_id is null or new.gap_bonus_at is not null or new.card_id is null
     or old.status <> 'planned' or new.status not in ('stamp', 'package_buy', 'package_visit', 'birthday') then
    return new;
  end if;
  new.gap_bonus_at := now();
  select * into c from public.cards where id = new.card_id for update;
  if c.stamps < 10 and c.stamps not in (4, 9) then
    update public.cards set stamps = stamps + 1 where id = c.id;
    insert into public.visits (card_id, kind) values (c.id, 'gap');
  else
    update public.cards set bonus_stamps = bonus_stamps + 1 where id = c.id;
  end if;
  return new;
end $$;
revoke execute on function public.day_plan_gap_bonus() from public, anon, authenticated;

drop trigger if exists day_plan_gap_bonus on public.day_plan;
create trigger day_plan_gap_bonus
  before update of status on public.day_plan
  for each row execute function public.day_plan_gap_bonus();

-- ---------- Studio ----------

create or replace function public.gap_list()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((
    select json_agg(json_build_object(
      'id', g.id, 'kind', g.kind, 'day', g.day, 'start_at', g.start_at, 'end_at', g.end_at, 'status', g.status,
      'info', g.info, 'sent_at', g.sent_at, 'push_n', g.push_n, 'sms_n', g.sms_n, 'created_at', g.created_at,
      'taken', coalesce((select json_agg(json_build_object('card_id', p.card_id, 'name', k.name, 'start_at', p.start_at,
                                                         'service', p.service, 'status', p.status, 'bonus', p.gap_bonus_at is not null)
                                       order by p.start_at)
                           from public.day_plan p join public.cards k on k.id = p.card_id where p.gap_offer_id = g.id), '[]'::json)
    ) order by (g.status = 'ask') desc, g.day desc, g.start_at)
    from public.gap_offers g
    where g.status in ('ask', 'pending') or g.created_at > now() - interval '7 days'
  ), '[]'::json);
end $$;

-- p_send = true: wyślij ofertę na zwykłe luki tego dnia; false: nie wysyłaj
create or replace function public.gap_decide(p_day date, p_send boolean)
returns json language plpgsql security definer set search_path = public as $$
declare ids bigint[]; keep bigint[] := '{}'; i bigint; n int := 0; o public.gap_offers; e timestamptz;
begin
  perform public.staff_check();
  select array_agg(id order by start_at) into ids from public.gap_offers where day = p_day and status = 'ask';
  if ids is null then raise exception 'Te terminy są już załatwione.'; end if;
  if not p_send then
    update public.gap_offers set status = 'skipped' where id = any(ids);
    return json_build_object('sent', 0);
  end if;
  -- od pytania mogło się coś zmienić: zostają tylko okna wciąż wolne
  foreach i in array ids loop
    select * into o from public.gap_offers where id = i;
    if jsonb_array_length(public.gap_starts(o)) > 0 then keep := keep || i;
    else update public.gap_offers set status = 'skipped', info = 'zajęte przed wysyłką' where id = i; end if;
  end loop;
  if array_length(keep, 1) is null then raise exception 'Te terminy są już zajęte.'; end if;
  n := public.gap_send(keep);
  return json_build_object('sent', n);
end $$;

-- ---------- Uprawnienia ----------
revoke all on function public.gap_window_end(timestamptz), public.gap_windows(date), public.gap_starts(public.gap_offers)
  from public, anon, authenticated;
revoke all on function public.my_gap_offers(text), public.gap_take(text, bigint, timestamptz, text),
  public.gap_list(), public.gap_decide(date, boolean) from public;
grant execute on function public.my_gap_offers(text), public.gap_take(text, bigint, timestamptz, text) to anon, authenticated;
grant execute on function public.gap_list(), public.gap_decide(date, boolean) to authenticated;
