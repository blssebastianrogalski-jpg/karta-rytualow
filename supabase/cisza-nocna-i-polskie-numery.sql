-- Cisza nocna i SMS tylko na polskie numery (oferty wolnych terminów).
--  1) Oferta po odwołaniu wizyty nie wychodzi między 21:00 a 8:00 (czas polski).
--     Czeka do 8:00, wtedy sprawdzam jeszcze raz, czy termin jest nadal wolny i aktualny, i dopiero wysyłam push + SMS.
--     Godziny można zmienić: update public.booking_settings set gap_quiet_from = 21, gap_quiet_to = 8 where id = 1;
--  2) SMS z ofertą idzie tylko na polskie numery komórkowe (9 cyfr, ewentualnie z +48 / 0048).
--     Numer zagraniczny dostaje tylko push, jeśli ma aplikację.
--  Ręczna wysyłka „Wolne godziny” z panelu działa jak dotąd, o każdej porze (to moja decyzja przy wysyłce).
-- Wymaga wcześniejszego wolne-terminy.sql i wolne-terminy-recznie.sql. Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych.

-- ---------- Ustawienia ciszy nocnej ----------
alter table public.booking_settings add column if not exists gap_quiet_from int not null default 21;  -- od tej godziny oferty czekają
alter table public.booking_settings add column if not exists gap_quiet_to   int not null default 8;   -- o tej godzinie wychodzą

create or replace function public.gap_quiet(p_now timestamptz default now())
returns boolean language sql stable security definer set search_path = public as $$
  select case when s.gap_quiet_from = s.gap_quiet_to then false
              when s.gap_quiet_from > s.gap_quiet_to
                then extract(hour from p_now at time zone 'Europe/Warsaw') >= s.gap_quiet_from
                  or extract(hour from p_now at time zone 'Europe/Warsaw') <  s.gap_quiet_to
              else extract(hour from p_now at time zone 'Europe/Warsaw') >= s.gap_quiet_from
               and extract(hour from p_now at time zone 'Europe/Warsaw') <  s.gap_quiet_to end
    from public.booking_settings s where s.id = 1
$$;
revoke execute on function public.gap_quiet(timestamptz) from public, anon, authenticated;

-- ---------- Polski numer komórkowy ----------
create or replace function public.phone_pl(p_phone text)
returns boolean language sql immutable as $$
  with x as (select trim(coalesce(p_phone, '')) as raw, regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d)
  select case
           when raw like '+%' then d ~ '^48[1-9][0-9]{8}$'
           when d ~ '^0048[1-9][0-9]{8}$' then true
           when d ~ '^48[1-9][0-9]{8}$' then true
           else d ~ '^[1-9][0-9]{8}$'
         end
    from x
$$;
revoke execute on function public.phone_pl(text) from public, anon, authenticated;

-- ---------- Wysyłka: SMS tylko na polskie numery ----------
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
    do_sms := p_sms and c.sms_week < s.gap_sms_week and public.phone_pl(c.phone);
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

-- ---------- Co 5 minut: odwołania (poza ciszą nocną) i zamykanie ofert ----------
create or replace function public.gap_process(p_now timestamptz default now())
returns void language plpgsql security definer set search_path = public as $$
declare s public.booking_settings; o public.gap_offers; e timestamptz; n int;
begin
  select * into s from public.booking_settings where id = 1;

  -- 1) odwołania po czasie oczekiwania: sprawdź jeszcze raz i wyślij (push + SMS)
  --    w ciszy nocnej (21:00–8:00) oferta czeka do rana; rano sprawdzam jeszcze raz, czy termin jest aktualny
  for o in select * from public.gap_offers where status = 'pending' and send_after <= p_now and not public.gap_quiet(p_now)
             order by start_at for update skip locked loop
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
