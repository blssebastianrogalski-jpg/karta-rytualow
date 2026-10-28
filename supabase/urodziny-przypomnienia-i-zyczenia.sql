-- Urodziny: przypomnienia 14 i 3 dni przed (20:30) oraz życzenia w dniu urodzin (9:00, push + SMS).
-- Godziny w czasie polskim, także po zmianie czasu.
-- Uruchom w Supabase → SQL Editor (raz). Nie kasuje żadnych danych klientek.
-- Wymaga: pg_cron, pg_net, sekretu push_secret w Vault (już są) i funkcji sms-wyslij (Edge Function).

-- ---------- Zgoda na SMS ----------
-- Domyślnie nikt nie dostaje SMS. Zgodę zaznacza się w panelu na karcie klientki.
alter table public.cards add column if not exists sms_ok boolean not null default false;

create or replace function public.sms_consent_get(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  return (select sms_ok from public.cards where id = p_id);
end $$;

create or replace function public.sms_consent_set(p_id uuid, p_ok boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.cards set sms_ok = coalesce(p_ok, false) where id = p_id;
  return coalesce(p_ok, false);
end $$;
revoke all on function public.sms_consent_get(uuid), public.sms_consent_set(uuid, boolean) from public, anon;
grant execute on function public.sms_consent_get(uuid), public.sms_consent_set(uuid, boolean) to authenticated;

-- ---------- Wspólne ----------
-- Data urodzin w danym roku (29.02 w roku nieprzestępnym = 28.02).
create or replace function public.bday_in_year(d smallint, m smallint, y int)
returns date language sql immutable as $$
  select case
    when d is null or m is null then null
    when m = 2 and d = 29 and not ((y % 4 = 0 and y % 100 <> 0) or y % 400 = 0) then make_date(y, 2, 28)
    else make_date(y, m, d)
  end
$$;

-- Imię do życzeń: pierwszy wyraz z karty.
create or replace function public.first_name(p_name text)
returns text language sql immutable as $$
  select initcap(split_part(trim(coalesce(p_name, '')), ' ', 1))
$$;

create or replace function public.push_to_card(p_card uuid, p_title text, p_body text, p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/send-push',
    body := jsonb_build_object('card_id', p_card, 'title', p_title, 'body', p_body,
      'url', 'https://karta.twojecialotwojdobrostan.pl/'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', p_secret)
  );
end $$;
revoke execute on function public.push_to_card(uuid, text, text, text) from public, anon, authenticated;

-- ---------- Przypomnienia: 14 i 3 dni przed urodzinami, 20:30 ----------
create table if not exists public.birthday_reminder_log (
  card_id     uuid not null references public.cards(id) on delete cascade,
  bday        date not null,
  days_before int not null,
  sent_at     timestamptz not null default now(),
  primary key (card_id, bday, days_before)
);
alter table public.birthday_reminder_log enable row level security;

-- Teksty przypomnień (osobno, żeby łatwo je było poprawić).
create or replace function public.birthday_reminder_text(p_days int, out title text, out body text)
language sql immutable as $$
  select
    case when p_days = 14 then 'Za 2 tygodnie Twoje urodziny 🎂' else 'Już za 3 dni Twoje urodziny 🎂' end,
    case when p_days = 14
      then 'W dniu urodzin czeka na Ciebie rytuał −20%. Zarezerwuj termin już teraz. Jeśli w dniu urodzin nie ma wolnego terminu, daj mi od razu znać (500 694 094), a ustalę z Tobą inną datę. Prezent na pewno Ci nie przepadnie.'
      else 'Rytuał −20% czeka na Ciebie w dniu urodzin. Nie ma wolnego terminu? Zadzwoń albo napisz (500 694 094), a ustalę z Tobą inną datę.'
    end
$$;

drop function if exists public.send_birthday_reminders();
create or replace function public.send_birthday_reminders(p_at timestamptz default now())
returns int language plpgsql security definer set search_path = public as $$
declare
  secret text; c record; t record; n int := 0; days int;
  local_now timestamp := p_at at time zone 'Europe/Warsaw';
  today date := (p_at at time zone 'Europe/Warsaw')::date;
begin
  if local_now::time not between time '20:20' and time '20:45' then return 0; end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then return 0; end if;

  foreach days in array array[14, 3] loop
    for c in
      select k.id, b.bday
      from public.cards k
      cross join lateral (select public.bday_in_year(k.bday_day, k.bday_month, extract(year from today + days)::int) as bday) b
      where b.bday = today + days
        and k.birthday_used_year is distinct from extract(year from b.bday)::int
        and exists (select 1 from public.push_subscriptions s where s.card_id = k.id)
        and not exists (select 1 from public.birthday_reminder_log l where l.card_id = k.id and l.bday = b.bday and l.days_before = days)
    loop
      t := public.birthday_reminder_text(days);
      perform public.push_to_card(c.id, t.title, t.body, secret);
      insert into public.birthday_reminder_log (card_id, bday, days_before) values (c.id, c.bday, days);
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;
revoke execute on function public.send_birthday_reminders(timestamptz) from public, anon, authenticated;

-- ---------- Życzenia w dniu urodzin, 9:00 (push + SMS ze zgodą) ----------
create table if not exists public.birthday_wish_log (
  card_id  uuid not null references public.cards(id) on delete cascade,
  bday     date not null,
  push     boolean not null default false,
  sms      boolean not null default false,
  sent_at  timestamptz not null default now(),
  primary key (card_id, bday)
);
alter table public.birthday_wish_log enable row level security;

-- Tekst życzeń. p_gift = rabat −20% jeszcze niewykorzystany w tym roku.
-- SMS bez polskich znaków i emoji, żeby zmieścił się w jednej wiadomości.
create or replace function public.birthday_wish_text(p_name text, p_gift boolean, out title text, out body text, out sms text)
language plpgsql immutable as $$
declare imie text := public.first_name(p_name);
begin
  title := 'Wszystkiego najlepszego, ' || imie || '! 🎂';
  body  := 'Życzę Ci spokoju, czułości dla siebie i chwil tylko dla Ciebie.'
           || case when p_gift then ' W prezencie czeka na Ciebie rytuał −20%.' else '' end;
  sms   := imie || ', wszystkiego najlepszego! Zycze Ci spokoju, czulosci dla siebie i chwil tylko dla Ciebie.'
           || case when p_gift then ' W prezencie czeka na Ciebie rytual -20%.' else '' end
           || ' Justyna';
end $$;

create or replace function public.send_birthday_wishes(p_at timestamptz default now())
returns int language plpgsql security definer set search_path = public as $$
declare
  secret text; c record; t record; n int := 0; has_push boolean; do_sms boolean;
  local_now timestamp := p_at at time zone 'Europe/Warsaw';
  today date := (p_at at time zone 'Europe/Warsaw')::date;
begin
  if local_now::time not between time '08:50' and time '09:15' then return 0; end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then return 0; end if;

  for c in
    select k.id, k.name, k.phone, k.sms_ok, k.birthday_used_year
    from public.cards k
    where public.bday_in_year(k.bday_day, k.bday_month, extract(year from today)::int) = today
      and not exists (select 1 from public.birthday_wish_log l where l.card_id = k.id and l.bday = today)
  loop
    t := public.birthday_wish_text(c.name, c.birthday_used_year is distinct from extract(year from today)::int);
    has_push := exists (select 1 from public.push_subscriptions s where s.card_id = c.id);
    do_sms := c.sms_ok and length(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')) >= 9;
    if not has_push and not do_sms then continue; end if;

    if has_push then perform public.push_to_card(c.id, t.title, t.body, secret); end if;
    if do_sms then
      perform net.http_post(
        url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/sms-wyslij',
        body := jsonb_build_object('phone', c.phone, 'msg', t.sms),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret)
      );
    end if;
    insert into public.birthday_wish_log (card_id, bday, push, sms) values (c.id, today, has_push, do_sms);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.send_birthday_wishes(timestamptz) from public, anon, authenticated;

-- Test: życzenia (push) na telefon studia, a z p_sms = true także SMS na numer studia (koszt jednego SMS).
-- Nic nie zapisuje. Użycie: select public.birthday_wish_test();  albo  select public.birthday_wish_test(true);
create or replace function public.birthday_wish_test(p_sms boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare secret text; t record;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  t := public.birthday_wish_text('Anna', true);
  perform net.http_post(
    url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/send-push',
    body := jsonb_build_object('owner', true, 'title', t.title, 'body', t.body, 'url', 'https://karta.twojecialotwojdobrostan.pl/'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret)
  );
  if p_sms then
    perform net.http_post(
      url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/sms-wyslij',
      body := jsonb_build_object('phone', '500694094', 'msg', t.sms),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret)
    );
  end if;
  return t.sms;
end $$;
revoke execute on function public.birthday_wish_test(boolean) from public, anon, authenticated;

-- ---------- Harmonogram (UTC) ----------
-- Dwie godziny na wysyłkę, bo funkcje same wybierają tę, która w Polsce jest 20:30 / 9:00.
select cron.unschedule(jobname) from cron.job where jobname in ('birthday-reminders', 'birthday-wishes');
select cron.schedule('birthday-reminders', '30 18,19 * * *', $$select public.send_birthday_reminders()$$);
select cron.schedule('birthday-wishes', '0 7,8 * * *', $$select public.send_birthday_wishes()$$);

-- Wyłączenie w razie potrzeby:  select cron.unschedule('birthday-wishes');
