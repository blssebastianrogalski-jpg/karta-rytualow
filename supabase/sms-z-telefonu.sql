-- SMS o wolnym terminie z mojego telefonu (bez kredytów SMSPLANET).
--  1) Przy wysłanej ofercie w panelu: lista klientek ze zgodą i polskim numerem, przy każdej przycisk „SMS”.
--     Otwiera moją aplikację do wiadomości z gotowym numerem i treścią; wysłane odhaczam (nikt nie dostanie oferty dwa razy).
--     Treść ma aktualne wolne godziny (np. po zablokowaniu czasu w „Moje dni wolne”).
--  2) Ustawienie: po odwołaniu SMS automatycznie przez SMSPLANET (jak dotąd) albo tylko push, a SMS-y wysyłam sama z telefonu.
-- Wymaga wcześniejszego cisza-nocna-i-polskie-numery.sql. Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych.

alter table public.booking_settings add column if not exists gap_sms_auto boolean not null default true; -- false = po odwołaniu tylko push

-- ---------- Co 5 minut: odwołania (poza ciszą nocną, SMS wg ustawienia) i zamykanie ofert ----------
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
    n := public.gap_send(array[o.id], true, s.gap_sms_auto);
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

-- ---------- SMS-y z mojego telefonu ----------
-- Oferta i te, które poszły razem z nią (jedna wiadomość)
create or replace function public.gap_batch(p_offer bigint) returns bigint[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(g.id order by g.start_at), array[p_offer])
    from public.gap_offers o join public.gap_offers g on g.day = o.day and g.sent_at = o.sent_at
   where o.id = p_offer and o.sent_at is not null
$$;
revoke execute on function public.gap_batch(bigint) from public, anon, authenticated;

-- Treść SMS-a (aktualne wolne godziny, np. po zablokowaniu czasu w dniach wolnych) i lista klientek
create or replace function public.gap_sms_recipients(p_offer bigint)
returns json language plpgsql stable security definer set search_path = public as $$
declare ids bigint[]; d date; windows text; freed boolean; skip uuid[]; msg text; r json;
begin
  perform public.staff_check();
  ids := public.gap_batch(p_offer);
  select min(g.day), bool_or(g.kind = 'cancel'), array_agg(g.cancel_card) filter (where g.cancel_card is not null)
    into d, freed, skip from public.gap_offers g where g.id = any(ids);
  if d is null then raise exception 'Nie ma takiej oferty.'; end if;
  select string_agg(public.gap_range(w.a, w.b), ', ' order by w.a) into windows
    from (select min((x->>'at')::timestamptz) as a,
                 max((x->>'at')::timestamptz + make_interval(mins => (x->>'max')::int)) as b
            from public.gap_offers g, jsonb_array_elements(public.gap_starts(g)) x
           where g.id = any(ids) group by g.id) w;
  if windows is not null then
    msg := case when freed then 'Zwolnil sie termin ' else 'Wolny termin ' end || public.gap_when_short(d) || ': ' || left(replace(windows, '–', '-'), 35)
           || '. Kto pierwszy, ten lepszy + dodatkowa pieczatka! karta.twojecialotwojdobrostan.pl lub 500694094';
    msg := translate(msg, 'ąćęłńóśźżĄĆĘŁŃÓŚŹŻ', 'acelnoszzACELNOSZZ'); -- bez polskich liter = jeden zwykły SMS
  end if;
  select json_agg(json_build_object('card_id', k.id, 'name', k.name, 'phone', k.phone,
                                    'tel', '+48' || right(regexp_replace(k.phone, '\D', '', 'g'), 9),
                                    'done', exists (select 1 from public.gap_notified gn where gn.card_id = k.id and gn.offer_id = any(ids) and gn.sms))
                  order by exists (select 1 from public.gap_notified gn where gn.card_id = k.id and gn.offer_id = any(ids) and gn.sms), k.name)
    into r
    from public.cards k
   where k.sms_ok and public.phone_pl(k.phone)
     and not (k.id = any(coalesce(skip, '{}'::uuid[])))
     and not exists (select 1 from public.day_plan p where p.card_id = k.id and p.day = d and p.status = 'planned');
  return json_build_object('msg', msg, 'windows', windows, 'list', coalesce(r, '[]'::json));
end $$;

-- Odhacz: wysłałam tej klientce SMS-a z telefonu
create or replace function public.gap_sms_mark(p_offer bigint, p_card uuid)
returns void language plpgsql security definer set search_path = public as $$
declare ids bigint[];
begin
  perform public.staff_check();
  ids := public.gap_batch(p_offer);
  insert into public.gap_notified (offer_id, card_id, push, sms) values (ids[1], p_card, false, true)
  on conflict (offer_id, card_id) do update set sms = true;
end $$;

-- Po odwołaniu: SMS automatycznie (true) albo tylko push (false)
create or replace function public.gap_sms_auto_get() returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_check();
  return (select gap_sms_auto from public.booking_settings where id = 1);
end $$;
create or replace function public.gap_sms_auto_set(p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.booking_settings set gap_sms_auto = coalesce(p_on, true) where id = 1;
  return coalesce(p_on, true);
end $$;
revoke all on function public.gap_sms_recipients(bigint), public.gap_sms_mark(bigint, uuid), public.gap_sms_auto_get(), public.gap_sms_auto_set(boolean) from public, anon;
grant execute on function public.gap_sms_recipients(bigint), public.gap_sms_mark(bigint, uuid), public.gap_sms_auto_get(), public.gap_sms_auto_set(boolean) to authenticated;
