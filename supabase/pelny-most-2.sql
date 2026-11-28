-- Pełny most Karta <-> Wolne Okienko, część 2 (2026-11-28): Karta i Wolne Okienko jako jedna całość.
--
-- Co dochodzi:
--  • wizyty z Booksy można w Karcie przesunąć, zmienić im rytuał albo usunąć z planu (odwołać),
--    zmiana idzie do Wolnego Okienka, a stamtąd automat w Chrome przepisuje ją do Booksy,
--  • zmiany wizyt z Booksy zrobione w Wolnym Okienku wracają do Karty,
--  • długość wizyty zmieniona w Wolnym Okienku (np. 60 → 90 min) jest w Karcie i liczy się przy wolnych godzinach,
--  • wizyta odbyta w Wolnym Okienku: w Karcie przypomnienie „Odbyta w Wolnym Okienku, wbij pieczątkę”.
--    Pieczątki nie wbija automat, bo jej rodzaj (zwykła, pakiet, urodziny) wybiera studio.
--
-- Skrypt Google studia (co 5 minut) korzysta z tych samych funkcji co dotąd (wo_script_karta_visits_v2,
-- wo_script_karta_apply), więc w skrypcie nic nie trzeba zmieniać.
-- Wymaga wcześniejszego pelny-most.sql i skracanie-przerwy.sql. Uruchom w Supabase → SQL Editor (można ponownie).
-- Nie kasuje danych klientek ani wizyt.

-- ---------- Nowe pola ----------
-- długość wizyty inna niż wynika z rytuału (null = z rytuału)
alter table public.day_plan add column if not exists duration_min int
  check (duration_min is null or duration_min between 5 and 600);
-- wizyta oznaczona jako odbyta w Wolnym Okienku (przypomnienie o pieczątce)
alter table public.day_plan add column if not exists wo_done_at timestamptz;
-- powód odwołania wizyty z Booksy w Karcie (client, mistake, noshow) dla Wolnego Okienka
alter table public.booksy_bookings add column if not exists sync_reason text;

-- ---------- Wolne godziny: długość wizyty z planu ----------
create or replace function public.busy_ranges(p_day date)
returns table (r tstzrange, who text, at_time text, service text)
language sql stable security definer set search_path = public as $$
  select tstzrange(p.start_at, coalesce(b.end_at,
                     p.start_at + make_interval(mins => coalesce(p.duration_min, public.svc_minutes(p.service))))
                   + make_interval(mins => coalesce(p.break_min, s.break_min))),
         coalesce(c.name, p.guest_name, 'Klientka Booksy'),
         to_char(p.start_at at time zone 'Europe/Warsaw', 'HH24:MI'), p.service
    from public.day_plan p
    left join public.booksy_bookings b on b.id = p.booking_id
    left join public.cards c on c.id = p.card_id
    cross join public.booking_settings s
   where s.id = 1 and p.day = p_day and p.status = 'planned' and p.start_at is not null
$$;
revoke all on function public.busy_ranges(date) from public, anon, authenticated;

-- wizyta z Booksy (nie z mostu Wolnego Okienka)
create or replace function public.is_booksy_row(p_booking bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.booksy_bookings b where b.id = p_booking
                  and coalesce(b.booksy_id, '') not like 'wo-%')
$$;
revoke all on function public.is_booksy_row(bigint) from public, anon, authenticated;

-- ---------- Znaczniki zmian: także wizyty z Booksy ----------
create or replace function public.day_plan_sync_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('tctd.z_mostu', true), '') = '1' then return new; end if;
  if (old.day, old.start_at, old.service, old.status, old.card_id)
     is distinct from (new.day, new.start_at, new.service, new.status, new.card_id)
     and new.sync_changed_at is not distinct from old.sync_changed_at then
    new.sync_changed_at := now();
    -- wizyta z Wolnego Okienka albo z Booksy odbyta albo „nie przyszła” w Karcie: zmiana idzie do Wolnego Okienka
    if new.booking_id is not null and new.status is distinct from old.status then
      update public.booksy_bookings set sync_changed_at = now() where id = new.booking_id;
    end if;
  end if;
  if new.status <> 'planned' then new.wo_done_at := null; end if;
  return new;
exception when others then
  return new;
end $$;
revoke execute on function public.day_plan_sync_stamp() from public, anon, authenticated;

-- usunięcie z planu: zapis powodu dla Wolnego Okienka; wizyta z Booksy zostaje odwołana (automat odwoła ją w Booksy)
create or replace function public.day_plan_wo_removed()
returns trigger language plpgsql security definer set search_path = public as $$
declare wo uuid;
begin
  if old.status <> 'planned' or coalesce(current_setting('tctd.z_mostu', true), '') = '1' then return old; end if;
  if old.booking_id is not null then
    -- już odwołana (mail Booksy albo zdarzenie z Wolnego Okienka): nic nie wysyłamy z powrotem
    if not exists (select 1 from public.booksy_bookings where id = old.booking_id and status = 'booked') then return old; end if;
    wo := public.wo_booking_of(old.booking_id);
    update public.booksy_bookings set status = 'cancelled', sync_changed_at = now(),
      sync_reason = case when wo is null then coalesce(nullif(current_setting('tctd.powod', true), ''), 'client') end,
      last_event_at = greatest(last_event_at, now()), gcal_state = 'pending', gcal_attempts = 0,
      gcal_error = null, next_try_at = now(), updated_at = now()
     where id = old.booking_id;
    if wo is null then return old; end if;   -- wizyta z Booksy: powód jest w samej rezerwacji
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

-- ---------- Skrypt Google: Karta → Wolne Okienko ----------
-- Jak w pelny-most.sql, a do tego: długość wizyty z planu i lista wizyt z Booksy (pole booksy).
-- Wizyty z Booksy idą zawsze (Wolne Okienko łączy je po telefonie i godzinie), a changed_at mają tylko,
-- gdy zmieniono je w Karcie.
create or replace function public.wo_script_karta_visits_v2(p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.booksy_auth(p_key);
  delete from public.wo_bridge_removed where removed_at < now() - interval '30 days';
  return jsonb_build_object(
    'version', 3,
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
      '[]'::jsonb));
end $$;

-- ---------- Skrypt Google: Wolne Okienko → Karta ----------
-- Pozycje: plan_id (wizyta z Karty), booksy_row (wizyta z Booksy), wo_booking (wizyta z Wolnego Okienka, tylko „odbyta”).
-- Przyjmujemy tylko zmiany nowsze niż zmiana w Karcie. Bez SMS-ów do klientki i bez oferty wolnego okienka.
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

-- ---------- Panel: wizyty z Booksy też można zmieniać w Karcie ----------

-- przesunięcie wizyty (jak w pelny-most.sql), a do tego wizyty z Booksy: zmiana idzie przez Wolne Okienko do Booksy
create or replace function public.plan_move(p_plan_id bigint, p_day date, p_time time,
  p_service text default null, p_sms boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare p public.day_plan; st timestamptz; svc text; sms boolean := false; bb public.booksy_bookings; mins int;
begin
  perform public.staff_check();
  select * into p from public.day_plan where id = p_plan_id for update;
  if not found then raise exception 'Tej wizyty już nie ma w planie. Odśwież panel.'; end if;
  if p.booking_id is not null and p_time is null then
    raise exception 'Wizyta z Booksy albo z Wolnego Okienka musi mieć godzinę.';
  end if;
  if p.status <> 'planned' then raise exception 'Ta wizyta jest już zapisana.'; end if;
  if p_day is null then raise exception 'Wybierz dzień.'; end if;
  if p_day < public.today_pl() then raise exception 'Ten dzień już minął.'; end if;
  if p_day > public.today_pl() + 30 and p.booking_id is null then
    raise exception 'Plan można ułożyć najwyżej 30 dni naprzód.';
  end if;
  if p_day > public.today_pl() + 120 then raise exception 'Wybierz termin najwyżej 120 dni naprzód.'; end if;
  st := case when p_time is null then null else (p_day + p_time) at time zone 'Europe/Warsaw' end;
  if (p_day <> p.day or st is distinct from p.start_at) and p.card_id is not null and exists (
       select 1 from public.day_plan where card_id = p.card_id and day = p_day and status = 'planned' and id <> p.id
          and (st is null or start_at is null or start_at = st)) then
    raise exception 'Ta klientka ma już wizytę w tym dniu bez godziny albo o tej samej godzinie.';
  end if;
  svc := coalesce(nullif(trim(coalesce(p_service, '')), ''), p.service);

  -- zmiana przez właścicielkę: bez automatycznej oferty wolnego terminu
  perform set_config('tctd.bez_oferty', '1', true);
  if p.booking_id is not null then
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
         duration_min = case when svc is distinct from p.service then null else duration_min end,
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

-- godzina wizyty, także dla wizyty z Booksy i z Wolnego Okienka
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
    if st is null then raise exception 'Wizyta z Booksy albo z Wolnego Okienka musi mieć godzinę.'; end if;
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

-- panel: skąd jest wizyta ({"<id planu>": "wo" | "booksy"})
create or replace function public.plan_sources(p_from date, p_to date)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((select json_object_agg(p.id::text,
                      case when public.wo_booking_of(b.id) is not null then 'wo' else 'booksy' end)
                     from public.day_plan p
                     join public.booksy_bookings b on b.id = p.booking_id
                    where p.day between p_from and least(p_to, p_from + 62)), '{}'::json);
end $$;
revoke all on function public.plan_sources(date, date) from public, anon;
grant execute on function public.plan_sources(date, date) to authenticated;

-- panel: wizyty odbyte w Wolnym Okienku, bez pieczątki w Karcie (ostatnie 7 dni)
create or replace function public.plan_wo_done()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((select json_agg(json_build_object(
      'plan_id', p.id, 'card_id', p.card_id, 'day', p.day, 'start_at', p.start_at, 'service', p.service,
      'name', coalesce(c.name, p.guest_name, 'Klientka'), 'today', p.day = public.today_pl())
      order by p.day, p.start_at)
    from public.day_plan p left join public.cards c on c.id = p.card_id
   where p.wo_done_at is not null and p.status = 'planned'
     and p.day between public.today_pl() - 7 and public.today_pl()), '[]'::json);
end $$;
revoke all on function public.plan_wo_done() from public, anon;
grant execute on function public.plan_wo_done() to authenticated;

-- panel: przypomnienie o pieczątce schowane (np. pieczątka wbita bez planu)
create or replace function public.plan_wo_done_hide(p_plan_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  perform set_config('tctd.z_mostu', '1', true);
  update public.day_plan set wo_done_at = null where id = p_plan_id;
  perform set_config('tctd.z_mostu', '', true);
end $$;
revoke all on function public.plan_wo_done_hide(bigint) from public, anon;
grant execute on function public.plan_wo_done_hide(bigint) to authenticated;
