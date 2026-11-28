-- Kolejka SMS-ów: wysyłam po kilka naraz zamiast wszystkich w jednej sekundzie.
-- Powód: 27.11 o 9:20 oferta „Zwolnił się termin” poszła do 55 osób jednocześnie. Bramka SMS Gateway
-- (api.sms-gate.app) przyjęła część, a 29 odrzuciła z błędem 429 (za dużo zapytań naraz).
--
-- Co się zmienia:
--  1) public.sms_to (używają jej: wolne terminy, urodziny, opinie, przypomnienia o wizytach) nie wysyła od razu,
--     tylko wpisuje SMS do tabeli sms_queue.
--  2) Co 10 sekund sms_queue_tick wysyła najwyżej 2 SMS-y (czyli do 12 na minutę; 55 SMS-ów schodzi w ok. 5 minut).
--  3) Gdy bramka odpowie 429, ten sam SMS idzie jeszcze raz po 30 s, 60 s, 90 s… (najwyżej 5 prób).
--     Dopiero gdy wszystkie próby zawiodą, SMS trafia do ostrzeżenia „SMS-y nie wychodzą” w panelu.
--  4) SMS, który czeka dłużej niż 3 godziny, przepada (żeby stara oferta nie przyszła za późno).
-- Pojedyncze SMS-y z panelu (zadatek) i kody logowania idą jak dotąd, od razu.
-- Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych.
-- Cofnięcie: na dole pliku.

create table if not exists public.sms_queue (
  id         bigint generated always as identity primary key,
  phone      text not null,
  msg        text not null,
  polish     boolean not null default false,
  created_at timestamptz not null default now(),
  next_at    timestamptz not null default now(),
  attempts   int not null default 0,
  status     text not null default 'pending' check (status in ('pending', 'sent', 'ok', 'failed', 'expired')),
  req_id     bigint,
  req_ids    bigint[] not null default '{}',   -- wszystkie próby (żeby ostrzeżenie nie liczyło ponowionych)
  sent_at    timestamptz,
  error      text
);
create index if not exists sms_queue_pending on public.sms_queue (next_at) where status = 'pending';
create index if not exists sms_queue_sent on public.sms_queue (req_id) where status = 'sent';
create index if not exists sms_queue_req_ids on public.sms_queue using gin (req_ids);
alter table public.sms_queue enable row level security;

-- ---------- 1) sms_to: do kolejki zamiast od razu ----------
create or replace function public.sms_to(p_phone text, p_msg text, p_secret text, p_polish boolean default false)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.sms_queue (phone, msg, polish) values (p_phone, p_msg, coalesce(p_polish, false));
end $$;
revoke execute on function public.sms_to(text, text, text, boolean) from public, anon, authenticated;

-- ---------- 2) Wysyłka z kolejki ----------
create or replace function public.sms_queue_tick()
returns void language plpgsql security definer set search_path = public as $$
declare secret text; q public.sms_queue; r record; req bigint; err text;
begin
  -- a) odpowiedzi na wysłane SMS-y
  for q in select * from public.sms_queue where status = 'sent' for update skip locked loop
    select * into r from net._http_response where id = q.req_id;
    if not found then
      -- brak odpowiedzi po 15 minutach: nie ponawiam, żeby nie wysłać podwójnie
      if q.sent_at < now() - interval '15 minutes' then
        update public.sms_queue set status = 'ok', error = 'brak odpowiedzi' where id = q.id;
      end if;
      continue;
    end if;
    if coalesce(r.content, '') like '%"ok":true%' then
      update public.sms_queue set status = 'ok' where id = q.id;
    elsif coalesce(r.content, '') like '%429%' and q.attempts < 5 then
      update public.sms_queue set status = 'pending', next_at = now() + make_interval(secs => 30 * q.attempts),
             error = 'błąd 429, ponawiam' where id = q.id;
    else
      err := left(coalesce(substring(r.content from '"error":"([^"]*)"'), r.error_msg,
                           case when r.timed_out then 'brak odpowiedzi funkcji sms-wyslij' end, 'SMS odrzucony'), 300);
      update public.sms_queue set status = 'failed', error = err where id = q.id;
      -- do ostrzeżenia w panelu (tylko prawdziwe odmowy bramki, nie przekroczony czas)
      if coalesce(r.content, '') like '%"ok":false%' then
        insert into public.sms_failures (resp_id, at, error)
        values (r.id, now(), regexp_replace(err, '^SMSPLANET:\s*', ''))
        on conflict (resp_id) do nothing;
      end if;
    end if;
  end loop;

  -- b) za stare czekające SMS-y przepadają
  update public.sms_queue set status = 'expired'
   where status = 'pending' and created_at < now() - interval '3 hours';

  -- c) wysyłka: najwyżej 2 na raz
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then return; end if;
  for q in select * from public.sms_queue where status = 'pending' and next_at <= now()
            order by next_at, id limit 2 for update skip locked loop
    req := net.http_post(
      url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/sms-wyslij',
      body := jsonb_build_object('phone', q.phone, 'msg', q.msg, 'polish', q.polish),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret),
      timeout_milliseconds := 30000);
    update public.sms_queue set status = 'sent', req_id = req, req_ids = req_ids || req, attempts = attempts + 1, sent_at = now() where id = q.id;
  end loop;
end $$;
revoke execute on function public.sms_queue_tick() from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname = 'sms-queue';
select cron.schedule('sms-queue', '10 seconds', $$select public.sms_queue_tick()$$);

-- ---------- 3) Ostrzeżenie w panelu: odpowiedzi z kolejki ocenia sms_queue_tick ----------
-- (tak samo jak w sms-z-karty-sim.sql, tylko pomija SMS-y z kolejki, bo 429 jest tam ponawiany)
alter table public.sms_alert_state add column if not exists last_fail bigint;
update public.sms_alert_state set last_fail = (select coalesce(max(id), 0) from public.sms_failures) where last_fail is null;
alter table public.sms_alert_state alter column last_fail set default 0;
create or replace function public.sms_check()
returns void language plpgsql security definer set search_path = public as $$
declare st public.sms_alert_state; top bigint; n int; err text; mx bigint;
begin
  select * into st from public.sms_alert_state where id = 1 for update;
  select max(id) into top from net._http_response;
  if top is null then return; end if;
  if top < st.last_resp then st.last_resp := 0; end if;  -- licznik odpowiedzi zaczął się od nowa
  insert into public.sms_failures (resp_id, at, error)
  select r.id, r.created, left(coalesce(regexp_replace(substring(r.content from '"error":"([^"]*)"'), '^SMSPLANET:\s*', ''), 'SMS odrzucony'), 300)
    from net._http_response r
   where r.id > st.last_resp and r.content like '%"ok":false%'
     and (r.content like '%SMSPLANET%' or r.content like '%Telefon studia%')
     and not exists (select 1 from public.sms_queue q where q.req_ids @> array[r.id])
  on conflict (resp_id) do nothing;
  -- nowe odmowy od ostatniego sprawdzenia (także te dopisane przez kolejkę)
  select count(*), max(error), max(id) into n, err, mx from public.sms_failures where id > st.last_fail;
  update public.sms_alert_state set last_resp = top, last_fail = greatest(st.last_fail, coalesce(mx, 0)) where id = 1;
  if n > 0 and (st.last_push is null or st.last_push < now() - interval '3 hours') then
    perform public.gap_owner_push('SMS-y nie wychodzą',
      n || case when n = 1 then ' SMS nie wyszedł'
                when n % 10 between 2 and 4 and n % 100 not between 12 and 14 then ' SMS-y nie wyszły'
                else ' SMS-ów nie wyszło' end
      || ' (' || coalesce(err, '') || '). '
      || case when err like 'Telefon studia%' then 'Sprawdź telefon studia i aplikację SMS Gateway.' else 'Sprawdź środki w SMSPLANET.' end,
      'panel.html');
    update public.sms_alert_state set last_push = now() where id = 1;
  end if;
exception when others then
  null; -- sprawdzanie nigdy nie psuje innych zadań
end $$;
revoke execute on function public.sms_check() from public, anon, authenticated;

-- Podgląd kolejki:
--   select status, count(*) from public.sms_queue where created_at > now() - interval '1 day' group by 1;
--
-- Cofnięcie (SMS-y znów od razu, bez kolejki):
--   select cron.unschedule('sms-queue');
--   create or replace function public.sms_to(p_phone text, p_msg text, p_secret text, p_polish boolean default false)
--   returns void language plpgsql security definer set search_path = public as $$
--   begin
--     perform net.http_post(url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/sms-wyslij',
--       body := jsonb_build_object('phone', p_phone, 'msg', p_msg, 'polish', p_polish),
--       headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', p_secret));
--   end $$;
