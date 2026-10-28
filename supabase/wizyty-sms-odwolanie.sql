-- Wizyty umówione przez aplikację (poza Booksy):
--  1) SMS do klientki, gdy studio potwierdzi termin (także przełożony),
--  2) klientka sama odwołuje wizytę na karcie: wizyta znika z planu dnia, studio dostaje powiadomienie,
--  3) klientka prosi o przełożenie: wybiera nowy termin, stara wizyta zostaje, dopóki studio nie potwierdzi nowej.
-- Wizyty z Booksy zmienia się dalej w Booksy (przycisk na karcie).
-- SMS wysyła funkcja kod-sms (akcja „wizyta”, SMSPLANET), zabezpieczona tym samym sekretem co powiadomienia push.
-- Wymaga wcześniejszych prosby-o-termin.sql i prosby-konflikty.sql. Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych.

alter table public.booking_requests add column if not exists move_of bigint references public.day_plan(id) on delete set null;

-- ---------- Karta klientki: najbliższe wizyty z informacją, czy można je zmienić w aplikacji ----------

create or replace function public.get_my_card(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  select * into c from public.cards where token = p_token;
  if not found then return null; end if;
  return (public.card_json(c, true)::jsonb || public.referral_json(c.id) || jsonb_build_object('upcoming', coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'day', p.day, 'start_at', p.start_at, 'service', p.service,
                                        'own', p.booking_id is null,
                                        'moving', exists (select 1 from public.booking_requests r
                                                           where r.move_of = p.id and r.status in ('new', 'suggested')))
                     order by p.day, p.start_at nulls last)
    from (
      select id, day, start_at, service, booking_id from public.day_plan
      where card_id = c.id and status = 'planned' and day >= public.today_pl()
        and (start_at is null or start_at > now() - interval '1 hour')
      order by day, start_at nulls last limit 3
    ) p), '[]'::jsonb)))::json;
end $$;

-- ---------- Klientka odwołuje wizytę ----------

create or replace function public.visit_cancel(p_token text, p_plan_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare p public.day_plan; c public.cards; secret text; what text;
begin
  select * into c from public.cards where token = p_token;
  if not found then raise exception 'Nie znaleziono karty.'; end if;
  select * into p from public.day_plan where id = p_plan_id and card_id = c.id for update;
  if not found or p.status <> 'planned' then raise exception 'Tej wizyty już nie ma w planie. Odśwież kartę.'; end if;
  if p.booking_id is not null then raise exception 'Tę wizytę zmienisz w Booksy.'; end if;
  if coalesce(p.start_at, (p.day + 1)::timestamp at time zone 'Europe/Warsaw') <= now() then
    raise exception 'Ta wizyta już się zaczęła. Zadzwoń do studia.';
  end if;
  -- prośby powiązane z tą wizytą: potwierdzona → odwołana, czekające na przełożenie → anulowane
  update public.booking_requests set status = 'cancelled', reply = 'Odwołana przez klientkę w aplikacji', handled_at = now()
   where plan_id = p.id and status = 'confirmed';
  update public.booking_requests set status = 'cancelled', handled_at = now()
   where move_of = p.id and status in ('new', 'suggested');
  delete from public.day_plan where id = p.id;

  -- powiadomienie dla studia (bez blokowania odwołania, gdy push nie działa)
  begin
    select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
    if secret is not null then
      what := c.name || ' · ' || coalesce(p.service, 'rytuał') || ' · ' || public.pl_day_label(p.day)
              || coalesce(', ' || to_char(p.start_at at time zone 'Europe/Warsaw', 'HH24:MI'), '');
      perform net.http_post(
        url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/send-push',
        body := jsonb_build_object('owner', true, 'title', 'Klientka odwołała wizytę',
                  'body', what || '. Zniknęła z planu dnia. Jeśli była też w Booksy, usuń ją tam.', 'url', 'panel.html'),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret));
    end if;
  exception when others then null;
  end;
end $$;

-- ---------- Prośba o termin / o przełożenie (nowy parametr p_move_of) ----------

drop function if exists public.request_create(text, text, date, text, text, text, text, bigint);
create or replace function public.request_create(p_token text, p_service text, p_day date, p_part text, p_time text,
  p_phone text, p_message text, p_retry_of bigint default null, p_move_of bigint default null)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards; r public.booking_requests; p9 text; att smallint := 1; part text; tm time; svc text;
        conflict text; sug jsonb; st text := 'new'; mv bigint := p_move_of;
begin
  select * into c from public.cards where token = p_token;
  if not found then raise exception 'Nie znaleziono karty.'; end if;
  p9 := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if length(p9) < 9 then raise exception 'Podaj numer telefonu, żebym mogła oddzwonić.'; end if;
  if p_day is null or p_day < public.today_pl() then raise exception 'Wybierz dzień od dziś.'; end if;
  if p_day > public.today_pl() + 60 then raise exception 'Termin możesz wybrać najwyżej 60 dni naprzód.'; end if;
  -- „inny dzień” po propozycji wolnych godzin = druga próba (poprzednia prośba się zamyka, przełożenie przechodzi dalej)
  if p_retry_of is not null then
    update public.booking_requests set status = 'cancelled', handled_at = now()
     where id = p_retry_of and card_id = c.id and status = 'suggested'
    returning coalesce(mv, move_of) into mv;
    if found then att := 2; end if;
  end if;
  if mv is not null then
    if not exists (select 1 from public.day_plan where id = mv and card_id = c.id and status = 'planned' and booking_id is null) then
      raise exception 'Tej wizyty nie można już przełożyć w aplikacji. Zadzwoń do studia.';
    end if;
    -- jedna prośba o przełożenie na wizytę: nowsza zastępuje starszą
    update public.booking_requests set status = 'cancelled', handled_at = now()
     where move_of = mv and status in ('new', 'suggested');
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
  insert into public.booking_requests (card_id, service, pref_day, pref_part, pref_time, phone, message, status, attempt, conflict_info, suggestions, move_of)
  values (c.id, svc, p_day, part, tm, trim(p_phone), nullif(trim(coalesce(p_message, '')), ''), st, att, conflict, sug, mv)
  returning * into r;
  return public.request_json(r)::json;
end $$;

create or replace function public.request_json(r public.booking_requests) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', r.id, 'card_id', r.card_id, 'service', r.service, 'pref_day', r.pref_day, 'pref_part', r.pref_part,
    'pref_time', to_char(r.pref_time, 'HH24:MI'), 'phone', r.phone, 'message', r.message, 'status', r.status,
    'confirmed_at', r.confirmed_at, 'reply', r.reply, 'handled_at', r.handled_at, 'created_at', r.created_at,
    'attempt', r.attempt, 'conflict', r.conflict_info, 'suggestions', r.suggestions, 'move_of', r.move_of,
    'move_from', (select jsonb_build_object('day', p.day, 'start_at', p.start_at) from public.day_plan p where p.id = r.move_of))
$$;

-- potwierdzenie przełożenia usuwa starą wizytę z planu
create or replace function public.request_confirm(p_id bigint, p_day date, p_time text, p_service text default null)
returns json language plpgsql security definer set search_path = public as $$
declare r public.booking_requests; t time; st timestamptz; pid bigint; svc text; old_id bigint;
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
  old_id := r.move_of;
  select id into pid from public.day_plan
   where card_id = r.card_id and day = p_day and status = 'planned' and booking_id is null
   order by (id = old_id) desc, id limit 1;
  if pid is not null then
    update public.day_plan set start_at = st, service = coalesce(svc, service) where id = pid;
  else
    insert into public.day_plan (card_id, day, service, start_at) values (r.card_id, p_day, svc, st) returning id into pid;
  end if;
  update public.booking_requests
     set status = 'confirmed', confirmed_at = st, plan_id = pid, service = svc, reply = null, suggestions = null, handled_at = now()
   where id = p_id returning * into r;
  if old_id is not null and old_id <> pid then
    update public.booking_requests set status = 'cancelled', reply = 'Przełożona na nowy termin', handled_at = now()
     where plan_id = old_id and status = 'confirmed';
    delete from public.day_plan where id = old_id and status = 'planned' and booking_id is null;
  end if;
  return public.request_json(r)::json;
end $$;

-- ---------- Powiadomienia push (jak w prosby-konflikty.sql + przełożenie) ----------

create or replace function public.booking_request_push()
returns trigger language plpgsql security definer set search_path = public as $$
declare secret text; nm text; what text; payloads jsonb[] := '{}'; mv text := '';
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then return new; end if;
  select name into nm from public.cards where id = new.card_id;
  what := coalesce(nm, 'Klientka') || ' · ' || coalesce(new.service, 'rytuał') || ' · ' || public.pl_day_label(new.pref_day)
          || ', ' || coalesce(to_char(new.pref_time, 'HH24:MI'), public.request_part_label(new.pref_part));
  if new.move_of is not null then
    select '. Teraz: ' || public.pl_day_label(p.day) || coalesce(', ' || to_char(p.start_at at time zone 'Europe/Warsaw', 'HH24:MI'), '')
      into mv from public.day_plan p where p.id = new.move_of;
    mv := coalesce(mv, '');
  end if;
  if tg_op = 'INSERT' and new.status = 'suggested' then
    payloads := payloads || jsonb_build_object('owner', true,
      'title', case when new.move_of is not null then 'Prośba o przełożenie · konflikt' else 'Prośba o termin · konflikt' end,
      'body', what || mv || '. Zaproponowałam klientce 3 wolne godziny.', 'url', 'panel.html#prosby');
    payloads := payloads || jsonb_build_object('card_id', new.card_id, 'title', 'Ten termin jest zajęty',
      'body', 'Wybierz jedną z wolnych godzin na swojej karcie.', 'url', './');
  elsif tg_op = 'INSERT' and new.status = 'new' then
    payloads := payloads || jsonb_build_object('owner', true,
      'title', case when new.move_of is not null then 'Prośba o przełożenie' else 'Prośba o termin' end
               || case when new.conflict_info is not null then ' · KONFLIKT' else '' end,
      'body', what || mv || coalesce('. ' || new.conflict_info, ''), 'url', 'panel.html#prosby');
  elsif tg_op = 'UPDATE' and new.status = 'new' and old.status = 'suggested' then
    payloads := payloads || jsonb_build_object('owner', true,
      'title', case when new.conflict_info is not null then 'Klientka wybrała godzinę · KONFLIKT' else 'Klientka wybrała godzinę' end,
      'body', what || mv || coalesce('. ' || new.conflict_info, '. Czeka na Twoje potwierdzenie.'), 'url', 'panel.html#prosby');
  elsif tg_op = 'UPDATE' and new.status = 'confirmed' and old.status is distinct from 'confirmed' then
    payloads := payloads || jsonb_build_object('card_id', new.card_id,
      'title', case when new.move_of is not null then 'Wizyta przełożona' else 'Termin potwierdzony' end,
      'body', (select upper(left(l, 1)) || substr(l, 2) from public.pl_day_label((new.confirmed_at at time zone 'Europe/Warsaw')::date) l) || ', '
              || to_char(new.confirmed_at at time zone 'Europe/Warsaw', 'HH24:MI') || '. Do zobaczenia!', 'url', './');
  elsif tg_op = 'UPDATE' and new.status = 'declined' and old.status is distinct from 'declined' then
    payloads := payloads || jsonb_build_object('card_id', new.card_id, 'title',
      case when new.move_of is not null then 'Odpowiedź na prośbę o przełożenie' else 'Odpowiedź na prośbę o termin' end,
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

-- ---------- SMS z potwierdzeniem wizyty ----------
-- Wcześniej klientka dostawała tylko powiadomienie push (a bez włączonych powiadomień nic).
-- Teraz przy potwierdzeniu idzie też SMS na numer z prośby (albo z karty).

create or replace function public.booking_request_sms()
returns trigger language plpgsql security definer set search_path = public as $$
declare secret text; phone text; msg text; loc timestamp;
begin
  if not (new.status = 'confirmed' and old.status is distinct from 'confirmed' and new.confirmed_at is not null) then return new; end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then return new; end if;
  select coalesce(nullif(new.phone, ''), c.phone) into phone from public.cards c where c.id = new.card_id;
  if phone is null then return new; end if;
  loc := new.confirmed_at at time zone 'Europe/Warsaw';
  -- jeden SMS (do 160 znaków po zamianie polskich liter)
  msg := case when new.move_of is not null then 'Wizyta przełożona: ' else 'Wizyta potwierdzona: ' end
         || (array['nd.','pon.','wt.','śr.','czw.','pt.','sob.'])[extract(dow from loc)::int + 1] || ' ' || to_char(loc, 'DD.MM, HH24:MI')
         || coalesce(', ' || left(trim(regexp_replace(new.service, '[®™©]', '', 'g')), 38), '')
         || '. Zmiana/odwołanie: karta.twojecialotwojdobrostan.pl Twoje Ciało Twój Dobrostan';
  perform net.http_post(
    url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/kod-sms',
    body := jsonb_build_object('action', 'wizyta', 'phone', phone, 'msg', msg),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret));
  return new;
exception when others then
  return new; -- brak SMS nie może blokować potwierdzenia
end $$;
revoke execute on function public.booking_request_sms() from public, anon, authenticated;

drop trigger if exists booking_requests_sms on public.booking_requests;
create trigger booking_requests_sms
  after update of status on public.booking_requests
  for each row execute function public.booking_request_sms();

-- ---------- Uprawnienia ----------
revoke all on function public.visit_cancel(text, bigint),
  public.request_create(text, text, date, text, text, text, text, bigint, bigint) from public;
grant execute on function public.visit_cancel(text, bigint),
  public.request_create(text, text, date, text, text, text, text, bigint, bigint), public.get_my_card(text) to anon, authenticated;
