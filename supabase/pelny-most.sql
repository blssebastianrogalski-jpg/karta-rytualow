-- Pełny most Karta <-> Wolne Okienko (2026-11-28).
-- Każda zmiana wizyty po jednej stronie trafia na drugą. Wygrywa nowsza zmiana, więc nic się nie odbija.
--
-- Co dochodzi:
--  • zmiana samego rytuału (bez zmiany godziny) w Karcie trafia do Wolnego Okienka,
--  • wizyta odbyta w Karcie (pieczątka, pakiet, urodziny) = odbyta w Wolnym Okienku,
--  • „Nie przyszła” w Karcie = nieobecność w Wolnym Okienku (a nie zwykłe odwołanie),
--  • zmiany zrobione w Wolnym Okienku w wizytach z Karty (inna godzina, dzień, rytuał, odwołanie) wracają do Karty,
--  • wizyty umówione w Wolnym Okienku można w Karcie przesunąć, zmienić im rytuał albo usunąć z planu,
--    a zmiana idzie do Wolnego Okienka (stamtąd automat przepisuje ją do Booksy).
--  Wizyty z Booksy nadal zmienia się w Booksy (Booksy jest dla nich źródłem prawdy).
--
-- Skrypt Google studia (co 5 minut) korzysta z funkcji wo_script_karta_visits_v2 i wo_script_karta_apply.
-- Wymaga wcześniejszych: booksy-integracja.sql, zmiana-wizyty.sql, godzina-wizyty.sql, historia-odwolan.sql,
-- wizyty-sms-odwolanie.sql. Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych klientek ani wizyt.

-- ---------- Znaczniki zmian ----------
alter table public.day_plan add column if not exists sync_changed_at timestamptz;
alter table public.booksy_bookings add column if not exists sync_changed_at timestamptz;

-- wizyty usunięte z planu (z powodem), żeby Wolne Okienko wiedziało, czy to odwołanie, czy nieobecność
create table if not exists public.wo_bridge_removed (
  plan_id    bigint primary key,
  wo_booking uuid,                         -- wizyta umówiona w Wolnym Okienku (null = wizyta z Karty)
  reason     text not null default 'client',
  start_at   timestamptz,
  removed_at timestamptz not null default now()
);
alter table public.wo_bridge_removed enable row level security;   -- tylko przez funkcje poniżej

-- numer wizyty w Wolnym Okienku (rezerwacje z mostu mają numer wo-<uuid>)
create or replace function public.wo_booking_of(p_booking bigint) returns uuid
language sql stable security definer set search_path = public as $$
  select case when b.booksy_id ~ '^wo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then substr(b.booksy_id, 4)::uuid end
    from public.booksy_bookings b where b.id = p_booking
$$;
revoke all on function public.wo_booking_of(bigint) from public, anon, authenticated;

-- każda zmiana dnia, godziny, rytuału, statusu albo klientki w planie dostaje czas zmiany
-- (most wpisuje czas zmiany z Wolnego Okienka sam i wtedy wyzwalacz go nie rusza)
create or replace function public.day_plan_sync_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('tctd.z_mostu', true), '') = '1' then return new; end if;
  if (old.day, old.start_at, old.service, old.status, old.card_id)
     is distinct from (new.day, new.start_at, new.service, new.status, new.card_id)
     and new.sync_changed_at is not distinct from old.sync_changed_at then
    new.sync_changed_at := now();
    -- wizyta z Wolnego Okienka odbyta albo „nie przyszła” w Karcie: zmiana idzie do Wolnego Okienka
    if new.booking_id is not null and new.status is distinct from old.status
       and public.wo_booking_of(new.booking_id) is not null then
      update public.booksy_bookings set sync_changed_at = now() where id = new.booking_id;
    end if;
  end if;
  return new;
exception when others then
  return new;
end $$;
revoke execute on function public.day_plan_sync_stamp() from public, anon, authenticated;
create or replace trigger day_plan_sync_stamp before update on public.day_plan
  for each row execute function public.day_plan_sync_stamp();

-- usunięcie z planu: zapis powodu dla Wolnego Okienka (wizyty z Booksy pomijamy, zmienia się je w Booksy)
create or replace function public.day_plan_wo_removed()
returns trigger language plpgsql security definer set search_path = public as $$
declare wo uuid;
begin
  if old.status <> 'planned' or coalesce(current_setting('tctd.z_mostu', true), '') = '1' then return old; end if;
  if old.booking_id is not null then
    wo := public.wo_booking_of(old.booking_id);
    if wo is null then return old; end if;
    -- już odwołana (zdarzenie z Wolnego Okienka): nic nie wysyłamy z powrotem
    if not exists (select 1 from public.booksy_bookings where id = old.booking_id and status = 'booked') then return old; end if;
    update public.booksy_bookings set status = 'cancelled', sync_changed_at = now(),
      last_event_at = greatest(last_event_at, now()), gcal_state = 'pending', gcal_attempts = 0,
      gcal_error = null, next_try_at = now(), updated_at = now()
     where id = old.booking_id;
  elsif old.start_at is null then
    return old;   -- wizyta bez godziny nie była w Wolnym Okienku
  end if;
  insert into public.wo_bridge_removed (plan_id, wo_booking, reason, start_at)
  values (old.id, wo, coalesce(nullif(current_setting('tctd.powod', true), ''), 'client'), old.start_at)
  on conflict (plan_id) do update set wo_booking = excluded.wo_booking, reason = excluded.reason,
    start_at = excluded.start_at, removed_at = now();
  return old;
exception when others then
  return old;   -- most nigdy nie blokuje usunięcia z planu
end $$;
revoke execute on function public.day_plan_wo_removed() from public, anon, authenticated;
create or replace trigger day_plan_wo_removed before delete on public.day_plan
  for each row execute function public.day_plan_wo_removed();

-- ---------- Skrypt Google: Karta → Wolne Okienko ----------
-- Jak wo_script_karta_visits, a do tego: czas zmiany każdej wizyty, wizyty z Wolnego Okienka zmienione w Karcie
-- (wo_booking) i lista usuniętych z planu z powodem. Ostatnie 3 dni też, żeby „odbyta” doszła po fakcie.
create or replace function public.wo_script_karta_visits_v2(p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.booksy_auth(p_key);
  delete from public.wo_bridge_removed where removed_at < now() - interval '30 days';
  return jsonb_build_object(
    'version', 2,
    'generated_at', now(),
    'from_day', public.today_pl() - 3,
    'to_day', public.today_pl() + 120,
    'visits', coalesce((select jsonb_agg(q.x order by q.x->>'start') from (
      select jsonb_build_object(
        'plan_id', p.id,
        'start', p.start_at,
        'minutes', coalesce(public.svc_minutes(p.service), 90),
        'service', p.service,
        'name', coalesce(nullif(trim(p.guest_name), ''), c.name),
        'phone', coalesce(
          (select nullif(trim(r.phone), '') from public.booking_requests r
            where r.plan_id = p.id and r.status = 'confirmed' order by r.id desc limit 1),
          c.phone),
        'status', p.status,
        'created_at', p.created_at,
        'changed_at', coalesce(p.sync_changed_at, p.created_at)) as x
      from public.day_plan p
      left join public.cards c on c.id = p.card_id
      where p.booking_id is null
        and p.start_at is not null
        and p.day between public.today_pl() - 3 and public.today_pl() + 120
      union all
      select jsonb_build_object(
        'plan_id', p.id,
        'wo_booking', public.wo_booking_of(b.id),
        'start', p.start_at,
        'minutes', greatest(5, (extract(epoch from b.end_at - b.start_at) / 60)::int),
        'service', p.service,
        'status', p.status,
        'changed_at', b.sync_changed_at)
      from public.day_plan p
      join public.booksy_bookings b on b.id = p.booking_id
      where b.sync_changed_at is not null
        and public.wo_booking_of(b.id) is not null
        and p.start_at is not null
        and p.day between public.today_pl() - 3 and public.today_pl() + 120) q), '[]'::jsonb),
    'removed', coalesce((select jsonb_agg(jsonb_build_object(
        'plan_id', r.plan_id, 'wo_booking', r.wo_booking, 'reason', r.reason, 'start', r.start_at,
        'removed_at', r.removed_at) order by r.removed_at)
      from public.wo_bridge_removed r), '[]'::jsonb));
end $$;

-- ---------- Skrypt Google: Wolne Okienko → Karta ----------
-- Zmiany zrobione w Wolnym Okienku w wizytach z Karty. Przyjmujemy tylko nowsze niż zmiana w Karcie.
-- Bez SMS-ów do klientki i bez oferty wolnego okienka (Wolne Okienko ma własną listę rezerwową).
create or replace function public.wo_script_karta_apply(p_key text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; p public.day_plan; v_at timestamptz; st timestamptz; d date; svc text; why text; n int := 0;
begin
  perform public.booksy_auth(p_key);
  if p_items is null or jsonb_typeof(p_items) <> 'array' then return jsonb_build_object('applied', 0); end if;
  perform set_config('tctd.z_mostu', '1', true);
  perform set_config('tctd.bez_oferty', '1', true);
  for v in select x from jsonb_array_elements(p_items) x loop
    begin
      v_at := (v ->> 'changed_at')::timestamptz;
      select * into p from public.day_plan where id = (v ->> 'plan_id')::bigint and booking_id is null for update;
      if not found or v_at is null or p.status <> 'planned' then continue; end if;
      if coalesce(p.sync_changed_at, p.created_at) >= v_at then continue; end if;   -- w Karcie zmiana jest nowsza
      if v ->> 'status' in ('cancelled', 'no_show') then
        why := case when v ->> 'status' = 'no_show' then 'noshow'
                    when v ->> 'cancelled_by' = 'client' then 'client' else 'mistake' end;
        perform set_config('tctd.powod', why, true);
        update public.booking_requests set status = 'cancelled', reply = 'Odwołana przez studio', handled_at = now()
         where plan_id = p.id and status = 'confirmed';
        update public.booking_requests set status = 'cancelled', handled_at = now()
         where move_of = p.id and status in ('new', 'suggested');
        delete from public.day_plan where id = p.id;
        perform set_config('tctd.powod', '', true);
        n := n + 1;
      elsif v ->> 'status' in ('pending', 'confirmed') then
        st := (v ->> 'start')::timestamptz;
        if st is null then continue; end if;
        d := (st at time zone 'Europe/Warsaw')::date;
        svc := coalesce(nullif(trim(coalesce(v ->> 'service', '')), ''), p.service);
        if p.day = d and p.start_at = st and p.service is not distinct from svc then
          update public.day_plan set sync_changed_at = v_at where id = p.id;
          continue;
        end if;
        update public.day_plan set day = d, start_at = st, service = svc, sync_changed_at = v_at,
          reminded_at = case when d <> p.day or st is distinct from p.start_at then null else reminded_at end
         where id = p.id;
        update public.booking_requests set confirmed_at = st, service = svc where plan_id = p.id and status = 'confirmed';
        n := n + 1;
      end if;
    exception when others then
      perform public.booksy_log_add('error', 'wo_most', null, 'Zmiana z Wolnego Okienka: ' || sqlerrm);
    end;
  end loop;
  perform set_config('tctd.z_mostu', '', true);
  perform set_config('tctd.bez_oferty', '', true);
  if n > 0 then
    perform public.booksy_log_add('info', 'wo_most', null, 'Zmiany z Wolnego Okienka w planie: ' || n || '.');
  end if;
  return jsonb_build_object('applied', n);
end $$;

revoke all on function public.wo_script_karta_visits_v2(text), public.wo_script_karta_apply(text, jsonb) from public;
grant execute on function public.wo_script_karta_visits_v2(text), public.wo_script_karta_apply(text, jsonb) to anon, authenticated;

-- ---------- Panel: wizyty z Wolnego Okienka można zmieniać w Karcie ----------

-- przesunięcie wizyty (jak w zmiana-wizyty.sql), a do tego:
--  • wizyta z Wolnego Okienka: można ją przesunąć i zmienić rytuał (musi mieć godzinę),
--  • ta sama klientka może mieć dwa zabiegi tego dnia o różnych godzinach (jak dwa-zabiegi-po-sobie.sql).
create or replace function public.plan_move(p_plan_id bigint, p_day date, p_time time,
  p_service text default null, p_sms boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare p public.day_plan; st timestamptz; svc text; sms boolean := false; wo uuid; bb public.booksy_bookings; mins int;
begin
  perform public.staff_check();
  select * into p from public.day_plan where id = p_plan_id for update;
  if not found then raise exception 'Tej wizyty już nie ma w planie. Odśwież panel.'; end if;
  if p.booking_id is not null then
    wo := public.wo_booking_of(p.booking_id);
    if wo is null then raise exception 'Wizytę z Booksy przesuń w Booksy, plan zaktualizuje się sam.'; end if;
    if p_time is null then raise exception 'Wizyta z Wolnego Okienka musi mieć godzinę.'; end if;
  end if;
  if p.status <> 'planned' then raise exception 'Ta wizyta jest już zapisana.'; end if;
  if p_day is null then raise exception 'Wybierz dzień.'; end if;
  if p_day < public.today_pl() then raise exception 'Ten dzień już minął.'; end if;
  if p_day > public.today_pl() + 30 then raise exception 'Plan można ułożyć najwyżej 30 dni naprzód.'; end if;
  st := case when p_time is null then null else (p_day + p_time) at time zone 'Europe/Warsaw' end;
  if (p_day <> p.day or st is distinct from p.start_at) and p.card_id is not null and exists (
       select 1 from public.day_plan where card_id = p.card_id and day = p_day and status = 'planned' and id <> p.id
          and (st is null or start_at is null or start_at = st)) then
    raise exception 'Ta klientka ma już wizytę w tym dniu bez godziny albo o tej samej godzinie.';
  end if;
  svc := coalesce(nullif(trim(coalesce(p_service, '')), ''), p.service);

  -- zmiana przez właścicielkę: bez automatycznej oferty wolnego terminu
  perform set_config('tctd.bez_oferty', '1', true);
  if wo is not null then
    select * into bb from public.booksy_bookings where id = p.booking_id for update;
    mins := case when svc is distinct from p.service then coalesce(public.svc_minutes(svc), 60)
                 else greatest(5, (extract(epoch from bb.end_at - bb.start_at) / 60)::int) end;
    update public.booksy_bookings set start_at = st, end_at = st + make_interval(mins => mins), service = svc,
      sync_changed_at = now(), last_event_at = greatest(last_event_at, now()), gcal_state = 'pending',
      gcal_attempts = 0, gcal_error = null, next_try_at = now(), updated_at = now()
     where id = bb.id;
    perform public.booksy_mark_conflicts();
  end if;
  update public.day_plan
     set day = p_day, start_at = st, service = svc,
         reminded_at = case when p_day <> p.day or st is distinct from p.start_at then null else reminded_at end
   where id = p.id;
  -- potwierdzona prośba z aplikacji pokazuje klientce nowy termin
  if st is not null then
    update public.booking_requests set confirmed_at = st, service = svc where plan_id = p.id and status = 'confirmed';
  end if;

  if coalesce(p_sms, false) and p.card_id is not null then
    sms := public.visit_notify_client(p.card_id, 'Zmiana terminu wizyty',
      'Nowy termin: ' || public.pl_day_label(p_day) || coalesce(', ' || to_char(st at time zone 'Europe/Warsaw', 'HH24:MI'), '')
        || coalesce(' (' || svc || ')', '') || '. Do zobaczenia!',
      'Wizyta przełożona: ' || public.visit_when_short(p_day, st)
        || coalesce(', ' || left(trim(regexp_replace(svc, '[®™©]', '', 'g')), 38), '')
        || '. Zmiana/odwołanie: karta.twojecialotwojdobrostan.pl Twoje Ciało Twój Dobrostan');
  end if;
  return json_build_object('day', p_day, 'start_at', st, 'sms', sms);
end $$;
revoke all on function public.plan_move(bigint, date, time, text, boolean) from public, anon;
grant execute on function public.plan_move(bigint, date, time, text, boolean) to authenticated;

-- godzina wizyty (jak w godzina-wizyty.sql), także dla wizyty z Wolnego Okienka
create or replace function public.plan_set_time(p_plan_id bigint, p_time time)
returns void language plpgsql security definer set search_path = public as $$
declare p public.day_plan; st timestamptz; bb public.booksy_bookings;
begin
  perform public.staff_check();
  select * into p from public.day_plan where id = p_plan_id for update;
  if not found then raise exception 'Nie ma tej wizyty w planie.'; end if;
  if p.status <> 'planned' then raise exception 'Ta wizyta jest już zapisana.'; end if;
  st := case when p_time is null then null else (p.day + p_time) at time zone 'Europe/Warsaw' end;
  if p.booking_id is not null then
    if public.wo_booking_of(p.booking_id) is null then
      raise exception 'Godzinę wizyty z Booksy zmień w Booksy, plan zaktualizuje się sam.';
    end if;
    if st is null then raise exception 'Wizyta z Wolnego Okienka musi mieć godzinę.'; end if;
    select * into bb from public.booksy_bookings where id = p.booking_id for update;
    update public.booksy_bookings set start_at = st, end_at = st + (bb.end_at - bb.start_at),
      sync_changed_at = now(), last_event_at = greatest(last_event_at, now()), gcal_state = 'pending',
      gcal_attempts = 0, gcal_error = null, next_try_at = now(), updated_at = now()
     where id = bb.id;
    perform public.booksy_mark_conflicts();
  end if;
  -- poprawka godziny przez właścicielkę: bez automatycznej oferty wolnego terminu
  perform set_config('tctd.bez_oferty', '1', true);
  update public.day_plan set start_at = st where id = p_plan_id;
end $$;
revoke all on function public.plan_set_time(bigint, time) from public, anon;
grant execute on function public.plan_set_time(bigint, time) to authenticated;

-- panel: które wizyty w planie są z Wolnego Okienka ({"<id planu>": "wo"}), osobno, żeby nie zmieniać plan_list
create or replace function public.plan_sources(p_from date, p_to date)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((select json_object_agg(p.id::text, 'wo') from public.day_plan p
                    join public.booksy_bookings b on b.id = p.booking_id
                   where p.day between p_from and least(p_to, p_from + 62)
                     and public.wo_booking_of(b.id) is not null), '{}'::json);
end $$;
revoke all on function public.plan_sources(date, date) from public, anon;
grant execute on function public.plan_sources(date, date) to authenticated;
