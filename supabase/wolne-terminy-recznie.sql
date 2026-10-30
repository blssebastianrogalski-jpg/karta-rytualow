-- Wolne terminy na moje polecenie.
--  1) Zwykłe luki w grafiku nie wychodzą już same (koniec z pytaniem o 18:00).
--     W panelu jest „Wolne godziny” na dziś i 5 kolejnych dni: plan dnia, godziny pracy i dni wolne (dni-wolne.sql).
--     Przy każdym dniu: wybieram godziny i sposób wysyłki: push, SMS albo oba.
--  2) Odwołania zostają jak były: po 10 minutach oferta wychodzi sama (push + SMS).
--  SMS nadal najwyżej gap_sms_week (2) na klientkę w tygodniu, tylko klientki ze zgodą (sms_ok).
-- Wymaga wcześniejszego wolne-terminy.sql. Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych.

-- ---------- Koniec automatu o 18:00 ----------
alter table public.booking_settings alter column gap_daily_on set default false;
update public.booking_settings set gap_daily_on = false where id = 1;
-- czekające pytania „Wysłać ofertę na jutro?” nie są już potrzebne
update public.gap_offers set status = 'skipped', info = 'zwykła luka · teraz wysyłam ręcznie' where status = 'ask';

-- ---------- Wysyłka: wybór push / SMS ----------
drop function if exists public.gap_send(bigint[]);
create or replace function public.gap_send(p_ids bigint[], p_push boolean default true, p_sms boolean default true)
returns int language plpgsql security definer set search_path = public as $$
declare s public.booking_settings; secret text; d date; windows text; n_push int := 0; n_sms int := 0; n int := 0;
        c record; do_sms boolean; has_push boolean; skip uuid[]; msg text; first_id bigint := p_ids[1]; freed boolean;
begin
  select * into s from public.booking_settings where id = 1;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  select min(day), string_agg(public.gap_range(start_at, end_at), ', ' order by start_at),
         array_agg(cancel_card) filter (where cancel_card is not null), bool_or(kind = 'cancel')
    into d, windows, skip, freed from public.gap_offers where id = any(p_ids);
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
    has_push := p_push and c.has_push;
    do_sms := p_sms and c.sms_week < s.gap_sms_week and length(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')) >= 9;
    if not has_push and not do_sms then continue; end if;
    begin
      if has_push then
        perform net.http_post(
          url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/send-push',
          body := jsonb_build_object('card_id', c.id,
            'title', case when freed then 'Zwolnił się termin: ' else 'Wolny termin: ' end || public.gap_when_short(d),
            'body', 'Wolne ' || windows || '. Kto pierwszy, ten lepszy, a za ten termin dostaniesz dodatkową pieczątkę. Stuknij, żeby wybrać godzinę.',
            'url', 'https://karta.twojecialotwojdobrostan.pl/#wolne'),
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret));
        n_push := n_push + 1;
      end if;
      if do_sms then
        -- jeden SMS (do 160 znaków po zamianie polskich liter)
        msg := case when freed then 'Zwolnil sie termin ' else 'Wolny termin ' end || public.gap_when_short(d) || ': ' || left(replace(windows, '–', '-'), 35)
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
revoke execute on function public.gap_send(bigint[], boolean, boolean) from public, anon, authenticated;

-- ---------- Co 5 minut: tylko odwołania i zamykanie ofert ----------
create or replace function public.gap_process(p_now timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
declare s public.booking_settings; o public.gap_offers; e timestamptz; n int;
begin
  select * into s from public.booking_settings where id = 1;

  -- 1) odwołania po czasie oczekiwania: sprawdź jeszcze raz i wyślij (push + SMS)
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
  -- zwykłe luki: tylko ręcznie z panelu (gap_send_now)
end $$;
revoke execute on function public.gap_process(timestamptz) from public, anon, authenticated;

-- ---------- Studio: wolne godziny na dziś i kolejne dni ----------
-- [{day, state: open|closed|off|unknown, hours, visits, windows: [{start_at, end_at, sent}], push_n, sms_n, any_n}]
-- push_n / sms_n / any_n: ile klientek ze zgodą dostałoby ofertę na ten dzień (SMS z limitem tygodniowym)
create or replace function public.gap_forecast(p_days int default 5)
returns json language plpgsql stable security definer set search_path = public as $$
declare s public.booking_settings; d date; h jsonb; off boolean; wins jsonb; aud record; res jsonb := '[]'; i int;
begin
  perform public.staff_check();
  select * into s from public.booking_settings where id = 1;
  for i in 0 .. least(greatest(coalesce(p_days, 5), 1), 14) loop
    d := public.today_pl() + i;
    h := s.hours -> extract(isodow from d)::text;
    off := false;
    if to_regprocedure('public.absence_full_day(date)') is not null then -- po dni-wolne.sql
      execute 'select public.absence_full_day($1)' into off using d;
    end if;
    wins := '[]';
    if not off and h is not null and jsonb_typeof(h) <> 'null' then
      select coalesce(jsonb_agg(jsonb_build_object('start_at', w.start_at, 'end_at', w.end_at,
               'sent', exists (select 1 from public.gap_offers g where g.status in ('pending', 'open') and g.day = d
                                 and tstzrange(g.start_at, greatest(g.end_at, g.start_at + interval '1 minute')) && tstzrange(w.start_at, w.end_at)))
             order by w.start_at), '[]') into wins
        from public.gap_windows(d) w;
    end if;
    select count(*) filter (where x.has_push) as push_n, count(*) filter (where x.sms_left) as sms_n,
           count(*) filter (where x.has_push or x.sms_left) as any_n into aud
      from (select exists (select 1 from public.push_subscriptions ps where ps.card_id = k.id) as has_push,
                   length(regexp_replace(coalesce(k.phone, ''), '\D', '', 'g')) >= 9
                   and (select count(*) from public.gap_notified gn where gn.card_id = k.id and gn.sms and gn.at > now() - interval '7 days') < s.gap_sms_week as sms_left
              from public.cards k
             where k.sms_ok
               and not exists (select 1 from public.day_plan p where p.card_id = k.id and p.day = d and p.status = 'planned')) x;
    res := res || jsonb_build_object(
      'day', d,
      'state', case when h is null then 'closed' when off then 'off' when jsonb_typeof(h) = 'null' then 'unknown' else 'open' end,
      'hours', h,
      'visits', (select count(*) from public.day_plan p where p.day = d and p.status = 'planned'),
      'windows', wins, 'push_n', aud.push_n, 'sms_n', aud.sms_n, 'any_n', aud.any_n);
  end loop;
  return res::json;
end $$;

-- p_windows: wybrane okna [{start_at, end_at}] (null = wszystkie wolne tego dnia); p_channel: 'push' | 'sms' | 'both'
-- Okna liczone są od nowa w chwili wysyłki, więc godzina zajęta w międzyczasie nie wyjdzie.
create or replace function public.gap_send_now(p_day date, p_windows jsonb, p_channel text)
returns json language plpgsql security definer set search_path = public as $$
declare w record; ids bigint[] := '{}'; oid bigint; n int; do_push boolean := p_channel in ('push', 'both'); do_sms boolean := p_channel in ('sms', 'both');
begin
  perform public.staff_check();
  if not (do_push or do_sms) then raise exception 'Wybierz: push, SMS albo oba.'; end if;
  if p_day is null or p_day < public.today_pl() or p_day > public.today_pl() + 14 then raise exception 'Wybierz dzień od dziś do 14 dni naprzód.'; end if;
  perform pg_advisory_xact_lock(hashtext('gap_send_now'));
  for w in select * from public.gap_windows(p_day) loop
    if p_windows is not null and jsonb_typeof(p_windows) = 'array' and not exists (
         select 1 from jsonb_array_elements(p_windows) x
          where tstzrange((x ->> 'start_at')::timestamptz, (x ->> 'end_at')::timestamptz) && tstzrange(w.start_at, w.end_at)) then
      continue;
    end if;
    -- okno, na które oferta już wyszła, nie idzie drugi raz
    if exists (select 1 from public.gap_offers g where g.status in ('pending', 'open') and g.day = p_day
                and tstzrange(g.start_at, greatest(g.end_at, g.start_at + interval '1 minute')) && tstzrange(w.start_at, w.end_at)) then
      continue;
    end if;
    insert into public.gap_offers (kind, day, start_at, end_at, status, info)
    values ('daily', p_day, w.start_at, w.end_at, 'ask',
            'wysłane ręcznie: ' || case p_channel when 'push' then 'push' when 'sms' then 'SMS' else 'push i SMS' end)
    returning id into oid;
    ids := ids || oid;
  end loop;
  if array_length(ids, 1) is null then raise exception 'Te godziny są już zajęte albo oferta na nie już wyszła. Odśwież listę.'; end if;
  n := public.gap_send(ids, do_push, do_sms);
  return (select json_build_object('sent', n, 'push', coalesce(max(push_n), 0), 'sms', coalesce(max(sms_n), 0))
            from public.gap_offers where id = any(ids));
end $$;

-- ---------- Uprawnienia ----------
revoke all on function public.gap_forecast(int), public.gap_send_now(date, jsonb, text) from public, anon;
grant execute on function public.gap_forecast(int), public.gap_send_now(date, jsonb, text) to authenticated;
