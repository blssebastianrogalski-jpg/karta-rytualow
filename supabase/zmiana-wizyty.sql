-- Zmiana wizyty w panelu: przesunięcie na inny dzień i godzinę oraz usunięcie z planu.
-- Uruchom w Supabase → SQL Editor (raz). Nie kasuje żadnych danych.
--
-- • plan_move: inny dzień (do 30 dni naprzód), godzina i rytuał wizyty dodanej w aplikacji.
--   Wizyty z Booksy zmienia się w Booksy (plan zaktualizuje się sam z maila).
--   Przesunięcie nie wysyła innym klientkom oferty wolnego terminu (tak jak poprawka godziny).
-- • plan_cancel: usunięcie z planu z wyborem powodu:
--     'client'  = klientka odwołała → zwolnione okienko idzie do automatu „Wolne terminy” (jak dotąd),
--     'mistake' = pomyłka w planie → bez oferty dla innych klientek.
-- • SMS i powiadomienie do klientki tylko wtedy, gdy właścicielka zaznaczy to w panelu (p_sms = true).

-- jeden SMS (do 160 znaków po zamianie polskich liter): „pon. 10.11, 14:00”
create or replace function public.visit_when_short(p_day date, p_start timestamptz)
returns text language sql stable as $$
  select (array['nd.','pon.','wt.','śr.','czw.','pt.','sob.'])[extract(dow from p_day)::int + 1] || ' ' || to_char(p_day, 'DD.MM')
         || coalesce(', ' || to_char(p_start at time zone 'Europe/Warsaw', 'HH24:MI'), '')
$$;

-- SMS + push do klientki (nigdy nie blokuje zmiany w planie)
create or replace function public.visit_notify_client(p_card uuid, p_title text, p_push text, p_sms text)
returns boolean language plpgsql security definer set search_path = public as $$
declare secret text; phone text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then return false; end if;
  perform net.http_post(
    url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/send-push',
    body := jsonb_build_object('card_id', p_card, 'title', p_title, 'body', p_push, 'url', './'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret));
  select c.phone into phone from public.cards c where c.id = p_card;
  if nullif(trim(coalesce(phone, '')), '') is null then return false; end if;
  perform net.http_post(
    url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/sms-wyslij',
    body := jsonb_build_object('phone', phone, 'msg', p_sms),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret));
  return true;
exception when others then
  return false;
end $$;
revoke execute on function public.visit_when_short(date, timestamptz) from public, anon;
revoke execute on function public.visit_notify_client(uuid, text, text, text) from public, anon, authenticated;

-- ---------- Przesunięcie wizyty ----------
create or replace function public.plan_move(p_plan_id bigint, p_day date, p_time time,
  p_service text default null, p_sms boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare p public.day_plan; st timestamptz; svc text; sms boolean := false;
begin
  perform public.staff_check();
  select * into p from public.day_plan where id = p_plan_id for update;
  if not found then raise exception 'Tej wizyty już nie ma w planie. Odśwież panel.'; end if;
  if p.booking_id is not null then raise exception 'Wizytę z Booksy przesuń w Booksy, plan zaktualizuje się sam.'; end if;
  if p.status <> 'planned' then raise exception 'Ta wizyta jest już zapisana.'; end if;
  if p_day is null then raise exception 'Wybierz dzień.'; end if;
  if p_day < public.today_pl() then raise exception 'Ten dzień już minął.'; end if;
  if p_day > public.today_pl() + 30 then raise exception 'Plan można ułożyć najwyżej 30 dni naprzód.'; end if;
  if p_day <> p.day and p.card_id is not null and exists (
       select 1 from public.day_plan where card_id = p.card_id and day = p_day and status = 'planned' and id <> p.id) then
    raise exception 'Ta klientka ma już wizytę w tym dniu.';
  end if;
  st := case when p_time is null then null else (p_day + p_time) at time zone 'Europe/Warsaw' end;
  svc := coalesce(nullif(trim(coalesce(p_service, '')), ''), p.service);

  -- zmiana przez właścicielkę: bez automatycznej oferty wolnego terminu
  perform set_config('tctd.bez_oferty', '1', true);
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

-- ---------- Usunięcie z planu ----------
create or replace function public.plan_cancel(p_plan_id bigint, p_reason text default 'client', p_sms boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare p public.day_plan; sms boolean := false;
begin
  perform public.staff_check();
  select * into p from public.day_plan where id = p_plan_id for update;
  if not found then return json_build_object('sms', false); end if;  -- już usunięta
  if p.status <> 'planned' then raise exception 'Ta wizyta jest już zapisana, więc nie można jej usunąć z planu.'; end if;
  update public.booking_requests set status = 'cancelled', reply = 'Odwołana przez studio', handled_at = now()
   where plan_id = p.id and status = 'confirmed';
  update public.booking_requests set status = 'cancelled', handled_at = now()
   where move_of = p.id and status in ('new', 'suggested');
  -- pomyłka w planie: okienko nie idzie do automatu „Wolne terminy”
  if p_reason = 'mistake' then perform set_config('tctd.bez_oferty', '1', true); end if;
  delete from public.day_plan where id = p.id;

  if coalesce(p_sms, false) and p.card_id is not null
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

revoke all on function public.plan_move(bigint, date, time, text, boolean), public.plan_cancel(bigint, text, boolean) from public, anon;
grant execute on function public.plan_move(bigint, date, time, text, boolean), public.plan_cancel(bigint, text, boolean) to authenticated;
