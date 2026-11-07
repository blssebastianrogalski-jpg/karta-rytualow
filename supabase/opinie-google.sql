-- Prośba o opinię w Google zamiast przypomnienia z Booksy.
--  1) W dniu wizyty o 20:30 (czas polski): push + SMS (SMSPLANET, tylko ze zgodą i na polski numer).
--  2) Po 3 dniach o 20:30: przypomnienie, ale tylko gdy klientka nie oznaczyła, że opinię wystawiła,
--     i nie kliknęła w karcie „Zostaw opinię w Google”.
--  Klientka, która ma oznaczoną opinię (sama na karcie albo ja w panelu), nie dostaje już próśb.
--  Najwyżej jedna prośba na 30 dni, żeby stałe klientki nie dostawały jej po każdej wizycie.
--  3) Test: +1 pieczątka za opinię (raz na klientkę). Włącznik w panelu (Wolne terminy → ustawienia) albo:
--     update public.booking_settings set review_stamp = false where id = 1;
--  Zastępuje dawne przypomnienia (dzień po wizycie i po 7 dniach).
-- Wymaga wcześniejszych urodziny-przypomnienia-i-zyczenia.sql i cisza-nocna-i-polskie-numery.sql.
-- Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych klientek.

-- ---------- Czy klientka wystawiła opinię ----------
alter table public.cards add column if not exists review_done_at timestamptz;     -- oznaczyła: wystawiłam opinię
alter table public.cards add column if not exists review_clicked_at timestamptz;  -- ostatnie kliknięcie „Zostaw opinię w Google”

-- ---------- Pieczątka za opinię (test, z włącznikiem) ----------
alter table public.booking_settings add column if not exists review_stamp boolean not null default true;
alter table public.cards add column if not exists review_stamp_at timestamptz;   -- kiedy dostała pieczątkę za opinię

-- nowy rodzaj wpisu w historii: pieczątka za opinię
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
  check (kind in ('stamp', 'package_buy', 'package_visit', 'birthday', 'referral', 'gap', 'review'));

-- pieczątka za opinię nie jest wizytą: nie nagradza polecającej
create or replace function public.visits_ref_reward() returns trigger
language plpgsql security definer set search_path = public as $$
declare ref uuid;
begin
  if new.kind in ('referral', 'review') then return new; end if;
  update public.cards set ref_rewarded_at = now()
   where id = new.card_id and referred_by is not null and ref_rewarded_at is null
  returning referred_by into ref;
  if ref is not null then
    update public.cards set bonus_stamps = bonus_stamps + 1 where id = ref;
    perform public.apply_bonus_stamps(ref);
  end if;
  perform public.apply_bonus_stamps(new.card_id);
  return new;
end $$;

-- Raz na klientkę, gdy włącznik jest włączony. Nie wypełnia 5. ani 10. kratki (tam jest rabat za wizytę):
-- wtedy pieczątka czeka i dopisze się przy najbliższej wizycie.
create or replace function public.review_give_stamp(p_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  if not coalesce((select review_stamp from public.booking_settings where id = 1), false) then return false; end if;
  select * into c from public.cards where id = p_id for update;
  if not found or c.review_stamp_at is not null then return false; end if;
  if c.stamps < 10 and c.stamps not in (4, 9) then
    update public.cards set stamps = stamps + 1, review_stamp_at = now() where id = c.id;
    insert into public.visits (card_id, kind) values (c.id, 'review');
  else
    update public.cards set bonus_stamps = bonus_stamps + 1, review_stamp_at = now() where id = c.id;
  end if;
  return true;
end $$;
revoke execute on function public.review_give_stamp(uuid) from public, anon, authenticated;

-- Panel: włącznik pieczątki za opinię
create or replace function public.review_stamp_get() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((select review_stamp from public.booking_settings where id = 1), false);
end $$;
create or replace function public.review_stamp_set(p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.booking_settings set review_stamp = coalesce(p_on, false) where id = 1;
  return coalesce(p_on, false);
end $$;
revoke all on function public.review_stamp_get(), public.review_stamp_set(boolean) from public, anon;
grant execute on function public.review_stamp_get(), public.review_stamp_set(boolean) to authenticated;

-- Klientka (po kluczu karty): stan i oznaczenie. p_what: 'clicked' albo 'done'.
create or replace function public.my_review(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('done', review_done_at is not null, 'clicked', review_clicked_at is not null,
    'stamp', review_stamp_at is null and coalesce((select review_stamp from public.booking_settings where id = 1), false))
  from public.cards where token = p_token
$$;

create or replace function public.mark_my_review(p_token text, p_what text)
returns json language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  if p_what = 'done' then
    update public.cards set review_done_at = coalesce(review_done_at, now()) where token = p_token returning id into cid;
    if cid is not null then perform public.review_give_stamp(cid); end if;
  elsif p_what = 'clicked' then
    update public.cards set review_clicked_at = now() where token = p_token;
  else
    raise exception 'Nieznana akcja.';
  end if;
  if not found then raise exception 'Nie znaleziono karty.'; end if;
  return public.my_review(p_token);
end $$;
grant execute on function public.my_review(text), public.mark_my_review(text, text) to anon, authenticated;

-- Panel: odczyt i ręczne oznaczenie
create or replace function public.review_get(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  return (select review_done_at is not null from public.cards where id = p_id);
end $$;

create or replace function public.review_set(p_id uuid, p_done boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.cards
     set review_done_at = case when coalesce(p_done, false) then coalesce(review_done_at, now()) else null end
   where id = p_id;
  if coalesce(p_done, false) then perform public.review_give_stamp(p_id); end if;
  return coalesce(p_done, false);
end $$;
revoke all on function public.review_get(uuid), public.review_set(uuid, boolean) from public, anon;
grant execute on function public.review_get(uuid), public.review_set(uuid, boolean) to authenticated;

-- ---------- Dziennik wysłanych próśb ----------
create table if not exists public.review_request_log (
  card_id    uuid not null references public.cards(id) on delete cascade,
  visit_day  date not null,
  step       smallint not null check (step in (1, 2)),   -- 1 = wieczór po wizycie, 2 = przypomnienie po 3 dniach
  push       boolean not null default false,
  sms        boolean not null default false,
  sent_at    timestamptz not null default now(),
  primary key (card_id, visit_day, step)
);
alter table public.review_request_log enable row level security;

-- ---------- Teksty (osobno, żeby łatwo je było poprawić) ----------
-- SMS bez polskich znaków, jedna wiadomość (do 160 znaków).
create or replace function public.review_text(p_step int, out title text, out body text, out sms text)
language plpgsql immutable as $$
begin
  if p_step = 1 then
    title := 'Jak było na wizycie?';
    body  := 'Dziękuję, że byłaś dziś u mnie. Jeśli masz chwilę, zostaw proszę opinię w Google. Będzie mi bardzo miło.';
    sms   := 'Dziekuje za dzisiejsza wizyte! Jesli masz chwile, zostaw prosze opinie: https://g.page/r/CQM4lNka6sVNEBM/review Bedzie mi milo. Justyna';
  else
    title := 'Masz chwilę na opinię?';
    body  := 'Twoja opinia w Google pomaga innym znaleźć drogę do mnie. To zajmie minutę. Dziękuję!';
    sms   := 'Przypominam o opinii po wizycie. To minuta, a bardzo mi pomoze: https://g.page/r/CQM4lNka6sVNEBM/review Dziekuje! Justyna';
  end if;
end $$;

-- Push z linkiem prosto do opinii w Google
create or replace function public.review_push(p_card uuid, p_title text, p_body text, p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/send-push',
    body := jsonb_build_object('card_id', p_card, 'title', p_title, 'body', p_body,
      'url', 'https://g.page/r/CQM4lNka6sVNEBM/review'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', p_secret)
  );
end $$;
revoke execute on function public.review_push(uuid, text, text, text) from public, anon, authenticated;

-- ---------- Wysyłka o 20:30 ----------
-- Wizyta dzisiaj = wpis w historii wizyt z dzisiejszą datą albo dzisiejsza pozycja w planie dnia
-- (już po godzinie wizyty, nie „pominięta”).
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'send_review_reminders'
  loop
    execute 'drop function ' || f.sig;
  end loop;
end $$;

create or replace function public.send_review_reminders(p_at timestamptz default now())
returns int language plpgsql security definer set search_path = public as $$
declare
  secret text; c record; t record; n int := 0; has_push boolean; do_sms boolean;
  local_now timestamp := p_at at time zone 'Europe/Warsaw';
  today date := (p_at at time zone 'Europe/Warsaw')::date;
begin
  if local_now::time not between time '20:20' and time '20:45' then return 0; end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then return 0; end if;

  -- 1) Wieczór w dniu wizyty
  t := public.review_text(1);
  for c in
    select k.id, k.phone, k.sms_ok
    from public.cards k
    where k.review_done_at is null
      and (exists (select 1 from public.visits v
                    where v.card_id = k.id and v.kind in ('stamp', 'package_buy', 'package_visit', 'birthday')
                      and (v.created_at at time zone 'Europe/Warsaw')::date = today)
        or exists (select 1 from public.day_plan p
                    where p.card_id = k.id and p.day = today and p.status <> 'skipped'
                      and (p.status <> 'planned' or p.start_at <= p_at)))
      and not exists (select 1 from public.review_request_log l
                       where l.card_id = k.id and l.step = 1 and l.visit_day > today - 30)
  loop
    has_push := exists (select 1 from public.push_subscriptions s where s.card_id = c.id);
    do_sms := c.sms_ok and public.phone_pl(c.phone);
    if not has_push and not do_sms then continue; end if;
    if has_push then perform public.review_push(c.id, t.title, t.body, secret); end if;
    if do_sms then perform public.sms_to(c.phone, t.sms, secret); end if;
    insert into public.review_request_log (card_id, visit_day, step, push, sms) values (c.id, today, 1, has_push, do_sms);
    n := n + 1;
  end loop;

  -- 2) Przypomnienie po 3 dniach: tylko bez oznaczonej opinii i bez kliknięcia w link po pierwszej prośbie
  t := public.review_text(2);
  for c in
    select k.id, k.phone, k.sms_ok, l.visit_day
    from public.review_request_log l
    join public.cards k on k.id = l.card_id
    where l.step = 1 and l.visit_day = today - 3
      and k.review_done_at is null
      and (k.review_clicked_at is null or k.review_clicked_at < l.sent_at)
      and not exists (select 1 from public.review_request_log x
                       where x.card_id = l.card_id and x.visit_day = l.visit_day and x.step = 2)
  loop
    has_push := exists (select 1 from public.push_subscriptions s where s.card_id = c.id);
    do_sms := c.sms_ok and public.phone_pl(c.phone);
    if not has_push and not do_sms then continue; end if;
    if has_push then perform public.review_push(c.id, t.title, t.body, secret); end if;
    if do_sms then perform public.sms_to(c.phone, t.sms, secret); end if;
    insert into public.review_request_log (card_id, visit_day, step, push, sms) values (c.id, c.visit_day, 2, has_push, do_sms);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.send_review_reminders(timestamptz) from public, anon, authenticated;

-- Test: prośba (push) na telefon studia, a z p_sms = true także SMS na numer studia (koszt jednego SMS).
-- Nic nie zapisuje. Użycie: select public.review_test();  albo  select public.review_test(2, true);
create or replace function public.review_test(p_step int default 1, p_sms boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare secret text; t record;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  t := public.review_text(p_step);
  perform net.http_post(
    url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/send-push',
    body := jsonb_build_object('owner', true, 'title', t.title, 'body', t.body, 'url', 'https://g.page/r/CQM4lNka6sVNEBM/review'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret)
  );
  if p_sms then perform public.sms_to('500694094', t.sms, secret); end if;
  return t.sms;
end $$;
revoke execute on function public.review_test(int, boolean) from public, anon, authenticated;

-- ---------- Harmonogram (UTC) ----------
-- Dwie godziny, bo funkcja sama wybiera tę, która w Polsce jest 20:30 (także po zmianie czasu).
select cron.unschedule(jobname) from cron.job where jobname = 'review-reminders';
select cron.schedule('review-reminders', '30 18,19 * * *', $$select public.send_review_reminders()$$);

-- Wyłączenie w razie potrzeby:  select cron.unschedule('review-reminders');
