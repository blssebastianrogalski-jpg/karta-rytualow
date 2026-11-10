-- SMS-y z karty SIM telefonu studia (zamiast bramki SMSPLANET).
-- Wysyłką zajmują się funkcje sms-wyslij i kod-sms (sekrety SMSGATE_USER, SMSGATE_PASS, SMS_PROVIDER).
-- Ten plik zmienia tylko dwie rzeczy w bazie:
--  1) SMS o zadatku z panelu może mieć do 1530 znaków (10 części), bo z karty SIM nie ma limitu 459 znaków.
--  2) Ostrzeżenie „SMS-y nie wychodzą” łapie też błędy telefonu studia (np. zły login bramki), nie tylko SMSPLANET.
-- Wymaga wcześniejszego cisza-nocna-i-polskie-numery.sql i historia-odwolan.sql.
-- Uruchom w Supabase → SQL Editor (można ponownie). Nie kasuje danych.

-- ---------- 1) Dłuższy SMS o zadatku ----------
create or replace function public.risk_alert_sms(p_id bigint, p_text text)
returns json language plpgsql security definer set search_path = public as $$
declare a public.risk_alerts; secret text; msg text := trim(coalesce(p_text, ''));
begin
  perform public.staff_check();
  select * into a from public.risk_alerts where id = p_id for update;
  if not found then raise exception 'Nie ma już tego ostrzeżenia. Odśwież panel.'; end if;
  if a.status = 'sent' then raise exception 'SMS do tej osoby już wyszedł.'; end if;
  if char_length(msg) < 10 then raise exception 'Wpisz treść SMS-a.'; end if;
  if char_length(msg) > 1530 then raise exception 'SMS jest za długi (najwyżej 1530 znaków, czyli 10 części).'; end if;
  if public.risk_phone9(a.phone) is null then raise exception 'Brak numeru telefonu tej osoby.'; end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then raise exception 'Brak sekretu push_secret w bazie, SMS nie wyszedł.'; end if;
  perform net.http_post(
    url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/sms-wyslij',
    body := jsonb_build_object('phone', a.phone, 'msg', msg),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret));
  update public.risk_alerts set status = 'sent', sms_text = msg, handled_at = now() where id = a.id;
  return json_build_object('phone', a.phone);
end $$;

-- ---------- 2) Ostrzeżenie, gdy SMS-y nie wychodzą (SMSPLANET albo telefon studia) ----------
create or replace function public.sms_check()
returns void language plpgsql security definer set search_path = public as $$
declare st public.sms_alert_state; top bigint; n int; err text;
begin
  select * into st from public.sms_alert_state where id = 1 for update;
  select max(id) into top from net._http_response;
  if top is null then return; end if;
  if top < st.last_resp then st.last_resp := 0; end if;  -- licznik odpowiedzi zaczął się od nowa
  with x as (
    insert into public.sms_failures (resp_id, at, error)
    select r.id, r.created, left(coalesce(regexp_replace(substring(r.content from '"error":"([^"]*)"'), '^SMSPLANET:\s*', ''), 'SMS odrzucony'), 300)
      from net._http_response r
     where r.id > st.last_resp and r.content like '%"ok":false%'
       and (r.content like '%SMSPLANET%' or r.content like '%Telefon studia%')
    on conflict (resp_id) do nothing
    returning error)
  select count(*), max(error) into n, err from x;
  update public.sms_alert_state set last_resp = top where id = 1;
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
