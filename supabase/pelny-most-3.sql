-- Pełny most Karta <-> Wolne Okienko, część 3 (2026-11-28): dane klientek i brakujące wizyty z Booksy.
--
-- Co dochodzi:
--  • imię i nazwisko, telefon, e-mail i urodziny klientki w obie strony (wygrywa nowsza zmiana).
--    Wolne Okienko łączy kartę z klientką tylko po pewnym telefonie (ten sam numer, jedna karta i jedna klientka),
--    karta bez klientki tam = nowa klientka w Wolnym Okienku, a wątpliwe przypadki idą tam na listę do sprawdzenia.
--  • wizyty z Booksy, które są w Wolnym Okienku, a Karta ich nie ma (np. wpisane w Booksy przez studio, bez maila),
--    trafiają do planu jak mail Booksy.
-- Notatek nie przenosimy (w Karcie i w Wolnym Okienku służą czemu innemu).
-- Wymaga wcześniejszego pelny-most-2.sql. Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych.

alter table public.cards add column if not exists sync_changed_at timestamptz;

-- każda zmiana imienia, telefonu, e-maila albo urodzin karty dostaje czas zmiany (most wpisuje swój czas sam)
create or replace function public.cards_sync_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('tctd.z_mostu', true), '') = '1' then return new; end if;
  if (old.name, old.phone, old.email, old.bday_day, old.bday_month)
     is distinct from (new.name, new.phone, new.email, new.bday_day, new.bday_month)
     and new.sync_changed_at is not distinct from old.sync_changed_at then
    new.sync_changed_at := now();
  end if;
  return new;
exception when others then
  return new;
end $$;
revoke execute on function public.cards_sync_stamp() from public, anon, authenticated;
create or replace trigger cards_sync_stamp before update on public.cards
  for each row execute function public.cards_sync_stamp();

-- ---------- Skrypt Google: Karta → Wolne Okienko (jak w pelny-most-2.sql, a do tego karty) ----------
create or replace function public.wo_script_karta_visits_v2(p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.booksy_auth(p_key);
  delete from public.wo_bridge_removed where removed_at < now() - interval '30 days';
  return jsonb_build_object(
    'version', 4,
    'generated_at', now(),
    'from_day', public.today_pl() - 3,
    'to_day', public.today_pl() + 120,
    'visits', coalesce((select jsonb_agg(q.x order by q.x->>'start') from (
      select jsonb_build_object(
        'plan_id', p.id,
        'start', p.start_at,
        'minutes', coalesce(p.duration_min, public.svc_minutes(p.service), 90),
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
      from public.wo_bridge_removed r), '[]'::jsonb),
    'booksy', coalesce((select jsonb_agg(jsonb_build_object(
        'booksy_row', b.id,
        'plan_id', p.id,
        'start', b.start_at,
        'minutes', greatest(5, (extract(epoch from b.end_at - b.start_at) / 60)::int),
        'service', coalesce(p.service, b.service),
        'name', coalesce(c.name, b.client_name),
        'phone', coalesce(nullif(right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 9), ''), b.client_phone9),
        'status', case when b.status = 'cancelled' then
                         case when b.sync_reason = 'noshow' then 'noshow' else 'cancelled' end
                       else coalesce(p.status, 'planned') end,
        'changed_at', b.sync_changed_at) order by b.start_at)
      from public.booksy_bookings b
      left join public.day_plan p on p.booking_id = b.id
      left join public.cards c on c.id = coalesce(p.card_id, b.card_id)
      where coalesce(b.booksy_id, '') not like 'wo-%'
        and (b.status = 'booked' or b.sync_changed_at is not null)
        and (b.start_at at time zone 'Europe/Warsaw')::date between public.today_pl() - 3 and public.today_pl() + 120),
      '[]'::jsonb),
    'cards', coalesce((select jsonb_agg(jsonb_build_object(
        'card_id', c.id, 'name', c.name, 'phone', c.phone, 'email', c.email,
        'bday_day', c.bday_day, 'bday_month', c.bday_month, 'changed_at', c.sync_changed_at))
      from public.cards c), '[]'::jsonb));
end $$;


-- ---------- Skrypt Google: Wolne Okienko → Karta (jak w pelny-most-2.sql, a do tego klientki i brakujące wizyty) ----------
create or replace function public.wo_script_karta_apply(p_key text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; p public.day_plan; b public.booksy_bookings; v_at timestamptz; st timestamptz; d date; svc text;
  why text; mins int; dur int; n int := 0;
begin
  perform public.booksy_auth(p_key);
  if p_items is null or jsonb_typeof(p_items) <> 'array' then return jsonb_build_object('applied', 0); end if;
  perform set_config('tctd.z_mostu', '1', true);
  perform set_config('tctd.bez_oferty', '1', true);
  for v in select x from jsonb_array_elements(p_items) x loop
    begin
      v_at := (v ->> 'changed_at')::timestamptz;
      if v_at is null then continue; end if;

      -- dane klientki zmienione w Wolnym Okienku
      if v ? 'card_id' then
        update public.cards set
          name = case when char_length(trim(coalesce(v ->> 'name', ''))) between 2 and 80 then trim(v ->> 'name') else name end,
          phone = coalesce(nullif(trim(coalesce(v ->> 'phone', '')), ''), phone),
          email = nullif(trim(coalesce(v ->> 'email', '')), ''),
          bday_day = (v ->> 'bday_day')::smallint, bday_month = (v ->> 'bday_month')::smallint,
          sync_changed_at = v_at
         where id = (v ->> 'card_id')::uuid and coalesce(sync_changed_at, created_at) < v_at;
        if found then n := n + 1; end if;
        continue;
      end if;

      -- wizyta z Booksy, której Karta nie miała (wpisana w Booksy bez maila): jak mail Booksy
      if v ? 'booksy_new' then
        if (public.booksy_apply(jsonb_build_object('kind', 'new', 'gmail_id', 'wo-booksy-' || (v ->> 'wo_booking'),
              'booksy_id', v ->> 'booksy_id', 'client_name', v ->> 'client_name', 'client_phone', v ->> 'client_phone',
              'service', v ->> 'service', 'start_local', v ->> 'start_local', 'end_local', v ->> 'end_local',
              'received_at', v ->> 'received_at', 'subject', 'Wizyta z Booksy z Wolnego Okienka')) ->> 'result') = 'applied' then
          n := n + 1;
        end if;
        continue;
      end if;

      -- wizyta z Wolnego Okienka odbyta tam: przypomnienie o pieczątce
      if v ? 'wo_booking' and not (v ? 'plan_id') then
        if v ->> 'status' = 'completed' then
          update public.day_plan pp set wo_done_at = v_at
            from public.booksy_bookings bb
           where bb.id = pp.booking_id and bb.booksy_id = 'wo-' || (v ->> 'wo_booking')
             and pp.status = 'planned' and pp.wo_done_at is null;
          if found then n := n + 1; end if;
        end if;
        continue;
      end if;

      -- wizyta z Booksy zmieniona w Wolnym Okienku
      if v ? 'booksy_row' then
        select * into b from public.booksy_bookings where id = (v ->> 'booksy_row')::bigint
          and coalesce(booksy_id, '') not like 'wo-%' for update;
        if not found then continue; end if;
        if coalesce(b.sync_changed_at, b.last_event_at) >= v_at then continue; end if;   -- w Karcie albo w Booksy nowsza
        if v ->> 'status' = 'completed' then
          update public.day_plan set wo_done_at = v_at where booking_id = b.id and status = 'planned' and wo_done_at is null;
          update public.booksy_bookings set sync_changed_at = v_at where id = b.id;
          n := n + 1;
        elsif v ->> 'status' in ('cancelled', 'no_show') then
          if b.status = 'booked' then
            why := case when v ->> 'status' = 'no_show' then 'noshow'
                        when v ->> 'cancelled_by' = 'client' then 'client' else 'mistake' end;
            update public.booksy_bookings set status = 'cancelled', sync_changed_at = v_at, sync_reason = why,
              gcal_state = 'pending', gcal_attempts = 0, gcal_error = null, next_try_at = now(), updated_at = now()
             where id = b.id;
            update public.booking_requests set status = 'cancelled', reply = 'Odwołana przez studio', handled_at = now()
             where plan_id = (select id from public.day_plan where booking_id = b.id) and status = 'confirmed';
            perform set_config('tctd.powod', why, true);
            perform public.booksy_sync_plan(b.id);
            perform set_config('tctd.powod', '', true);
            n := n + 1;
          end if;
        elsif v ->> 'status' in ('pending', 'confirmed') then
          st := (v ->> 'start')::timestamptz;
          if st is null then continue; end if;
          mins := coalesce((v ->> 'minutes')::int, greatest(5, (extract(epoch from b.end_at - b.start_at) / 60)::int));
          svc := coalesce(nullif(trim(coalesce(v ->> 'service', '')), ''), b.service);
          if b.status = 'booked' and b.start_at = st and b.end_at = st + make_interval(mins => mins)
             and b.service is not distinct from svc then
            update public.booksy_bookings set sync_changed_at = v_at where id = b.id;
            continue;
          end if;
          update public.booksy_bookings set status = 'booked', start_at = st, end_at = st + make_interval(mins => mins),
            service = svc, sync_changed_at = v_at, sync_reason = null,
            gcal_state = 'pending', gcal_attempts = 0, gcal_error = null, next_try_at = now(), updated_at = now()
           where id = b.id;
          perform public.booksy_sync_plan(b.id);
          update public.day_plan set reminded_at = null where booking_id = b.id and status = 'planned'
            and (day, start_at) is distinct from ((st at time zone 'Europe/Warsaw')::date, st);
          perform public.booksy_mark_conflicts();
          n := n + 1;
        end if;
        continue;
      end if;

      -- wizyta z Karty
      select * into p from public.day_plan where id = (v ->> 'plan_id')::bigint and booking_id is null for update;
      if not found or p.status <> 'planned' then continue; end if;
      if coalesce(p.sync_changed_at, p.created_at) >= v_at then continue; end if;   -- w Karcie zmiana jest nowsza
      if v ->> 'status' = 'completed' then
        if p.wo_done_at is null then
          -- termin jak w Wolnym Okienku (mogła być przełożona tuż przed zapisaniem jako odbyta)
          st := coalesce((v ->> 'start')::timestamptz, p.start_at);
          update public.day_plan set wo_done_at = v_at, sync_changed_at = v_at,
            day = coalesce((st at time zone 'Europe/Warsaw')::date, day), start_at = st where id = p.id;
          n := n + 1;
        end if;
      elsif v ->> 'status' in ('cancelled', 'no_show') then
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
        mins := (v ->> 'minutes')::int;
        -- długość taka jak z rytuału = bez osobnej długości
        dur := case when mins is null then case when svc is distinct from p.service then null else p.duration_min end
                    when mins = public.svc_minutes(svc) then null else mins end;
        if p.day = d and p.start_at = st and p.service is not distinct from svc and p.duration_min is not distinct from dur then
          update public.day_plan set sync_changed_at = v_at where id = p.id;
          continue;
        end if;
        update public.day_plan set day = d, start_at = st, service = svc, duration_min = dur, sync_changed_at = v_at,
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
