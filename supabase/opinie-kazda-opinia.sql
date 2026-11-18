-- Prośba o opinię (2026-11-18): każda opinia, pozytywna czy krytyczna, jest cenna.
-- SMS-y wspominają o dodatkowej pieczątce, gdy włącznik „Pieczątka za opinię” jest włączony
-- i klientka jeszcze jej nie dostała. Push-e bez wzmianki o pieczątce.
-- Zawiera też wszystko z opinie-sms-ladniej.sql (wystarczy uruchomić ten plik).
-- Wymaga wcześniejszego opinie-google.sql. Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych.

drop function if exists public.review_text(int);
drop function if exists public.review_text(int, text);
create or replace function public.review_text(p_step int, p_name text default null, p_stamp boolean default false,
  out title text, out body text, out sms text)
language plpgsql immutable as $$
declare imie text := public.call_name(p_name);
begin
  if p_step = 1 then
    title := 'Jak było na wizycie?';
    body  := 'Dziękuję, że byłaś dziś u mnie. Podziel się wrażeniami w Google. Każda szczera opinia, pozytywna czy krytyczna, jest dla mnie cenna.';
    sms   := case when imie <> '' then imie || ', dziękuję' else 'Dziękuję' end
          || ', że byłaś dziś u mnie. Mam nadzieję, że niesiesz w sobie jeszcze ten spokój. '
          || 'Jeśli zechcesz podzielić się wrażeniami, będzie mi bardzo miło: karta.twojecialotwojdobrostan.pl/opinia'
          || chr(10) || 'Każda szczera opinia, ta zachwycona i ta krytyczna, ma dla mnie ogromną wartość.'
          || case when p_stamp then ' W podziękowaniu za Twój czas na karcie pojawi się ode mnie dodatkowa pieczątka.' else '' end
          || chr(10) || 'Justyna';
  else
    title := 'Masz chwilę na opinię?';
    body  := 'Każda opinia, dobra czy gorsza, ma swoją moc i pomaga mi się rozwijać. To zajmie minutę. Dziękuję!';
    sms   := case when imie <> '' then imie || ', mam' else 'Mam' end
          || ' nadzieję, że efekt rytuału wciąż z Tobą jest. '
          || 'Jeśli znajdziesz chwilę na kilka słów w Google, bardzo mi to pomoże: karta.twojecialotwojdobrostan.pl/opinia'
          || chr(10) || 'Nie musi być idealnie. Każda opinia, dobra czy gorsza, ma swoją moc.'
          || case when p_stamp then ' Za Twój czas czeka na Ciebie mała niespodzianka: dodatkowa pieczątka na karcie.' else '' end
          || chr(10) || 'Ciepło pozdrawiam, Justyna';
  end if;
end $$;

create or replace function public.send_review_reminders(p_at timestamptz default now())
returns int language plpgsql security definer set search_path = public as $$
declare
  secret text; c record; t record; n int := 0; has_push boolean; do_sms boolean;
  stamp_on boolean := coalesce((select review_stamp from public.booking_settings where id = 1), false);
  local_now timestamp := p_at at time zone 'Europe/Warsaw';
  today date := (p_at at time zone 'Europe/Warsaw')::date;
begin
  if local_now::time not between time '20:20' and time '20:45' then return 0; end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then return 0; end if;

  -- 1) Wieczór w dniu wizyty
  for c in
    select k.id, k.name, k.phone, k.sms_ok, k.review_stamp_at
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
    t := public.review_text(1, c.name, stamp_on and c.review_stamp_at is null);
    has_push := exists (select 1 from public.push_subscriptions s where s.card_id = c.id);
    do_sms := c.sms_ok and public.phone_pl(c.phone);
    if not has_push and not do_sms then continue; end if;
    if has_push then perform public.review_push(c.id, t.title, t.body, secret); end if;
    if do_sms then perform public.sms_to(c.phone, t.sms, secret, true); end if;
    insert into public.review_request_log (card_id, visit_day, step, push, sms) values (c.id, today, 1, has_push, do_sms);
    n := n + 1;
  end loop;

  -- 2) Przypomnienie po 3 dniach: tylko bez oznaczonej opinii i bez kliknięcia w link po pierwszej prośbie
  for c in
    select k.id, k.name, k.phone, k.sms_ok, k.review_stamp_at, l.visit_day
    from public.review_request_log l
    join public.cards k on k.id = l.card_id
    where l.step = 1 and l.visit_day = today - 3
      and k.review_done_at is null
      and (k.review_clicked_at is null or k.review_clicked_at < l.sent_at)
      and not exists (select 1 from public.review_request_log x
                       where x.card_id = l.card_id and x.visit_day = l.visit_day and x.step = 2)
  loop
    t := public.review_text(2, c.name, stamp_on and c.review_stamp_at is null);
    has_push := exists (select 1 from public.push_subscriptions s where s.card_id = c.id);
    do_sms := c.sms_ok and public.phone_pl(c.phone);
    if not has_push and not do_sms then continue; end if;
    if has_push then perform public.review_push(c.id, t.title, t.body, secret); end if;
    if do_sms then perform public.sms_to(c.phone, t.sms, secret, true); end if;
    insert into public.review_request_log (card_id, visit_day, step, push, sms) values (c.id, c.visit_day, 2, has_push, do_sms);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.send_review_reminders(timestamptz) from public, anon, authenticated;

-- Test: oba SMS-y na numer studia (z p_sms = true). Użycie: select public.review_test(1, true); select public.review_test(2, true);
create or replace function public.review_test(p_step int default 1, p_sms boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare secret text; t record;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  t := public.review_text(p_step, 'Anna', coalesce((select review_stamp from public.booking_settings where id = 1), false));
  perform net.http_post(
    url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/send-push',
    body := jsonb_build_object('owner', true, 'title', t.title, 'body', t.body, 'url', 'https://g.page/r/CQM4lNka6sVNEBM/review'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret)
  );
  if p_sms then perform public.sms_to('500694094', t.sms, secret, true); end if;
  return t.sms;
end $$;
revoke execute on function public.review_test(int, boolean) from public, anon, authenticated;
