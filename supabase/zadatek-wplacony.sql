-- Zadatek przy ostrzeżeniu o historii odwołań (dopisek do historia-odwolan.sql).
-- Uruchom w Supabase → SQL Editor (raz, po historia-odwolan.sql). Nie kasuje danych i nic nie wysyła klientkom.
--
-- • „SMS wysłano”: zaznaczasz, że SMS o zadatku wyszedł (np. z Twojego telefonu). Zapisuje datę.
-- • „Zadatek wpłacono”: zapisuje kwotę (podpowiedź: 50% ceny rytuału) i datę wpłaty.
-- • W planie dnia przy wizycie tej osoby pokazuje się „Zadatek wpłacony: X zł”, żeby pomniejszyć paragon
--   i opłatę w dniu zabiegu. Zadatek trzyma się pierwszej wizyty tej osoby od dnia ostrzeżenia
--   (także po przełożeniu na inny dzień), dopóki nie oznaczysz go jako rozliczony.

alter table public.risk_alerts add column if not exists sms_at             timestamptz;
alter table public.risk_alerts add column if not exists deposit_amount     numeric(8,2);
alter table public.risk_alerts add column if not exists deposit_paid_at    timestamptz;
alter table public.risk_alerts add column if not exists deposit_settled_at timestamptz;
alter table public.risk_alerts drop constraint if exists risk_alerts_status_check;
alter table public.risk_alerts add constraint risk_alerts_status_check check (status in ('new', 'sent', 'dismissed', 'paid'));
-- SMS-y wysłane wcześniej przez bramkę
update public.risk_alerts set sms_at = handled_at where status = 'sent' and sms_at is null;

-- ostrzeżenia: nowe, czekające na zadatek, wpłacone i nierozliczone, plus załatwione w ostatnich 14 dniach
create or replace function public.risk_alerts_list()
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((select json_agg(json_build_object(
      'id', a.id, 'card_id', a.card_id, 'name', coalesce(c.name, a.name, 'Klientka'), 'phone', a.phone,
      'day', a.day, 'visit_at', a.visit_at, 'service', a.service, 'source', a.source,
      'reasons', a.reasons->'reasons', 'history', a.reasons->'history',
      'status', a.status, 'sms_text', a.sms_text, 'sms_at', a.sms_at, 'handled_at', a.handled_at, 'created_at', a.created_at,
      'deposit_amount', a.deposit_amount, 'deposit_paid_at', a.deposit_paid_at, 'deposit_settled_at', a.deposit_settled_at)
      order by (a.status = 'new') desc, a.created_at desc)
    from public.risk_alerts a left join public.cards c on c.id = a.card_id
    where a.status = 'new'
       or (a.status = 'sent' and a.day >= public.today_pl() - 1)
       or (a.status = 'paid' and a.deposit_settled_at is null)
       or coalesce(a.deposit_settled_at, a.handled_at) > now() - interval '14 days'), '[]'::json);
end $$;

-- SMS przez bramkę (jak w historia-odwolan.sql) + data w sms_at
create or replace function public.risk_alert_sms(p_id bigint, p_text text)
returns json language plpgsql security definer set search_path = public as $$
declare a public.risk_alerts; secret text; msg text := trim(coalesce(p_text, ''));
begin
  perform public.staff_check();
  select * into a from public.risk_alerts where id = p_id for update;
  if not found then raise exception 'Nie ma już tego ostrzeżenia. Odśwież panel.'; end if;
  if a.sms_at is not null then raise exception 'SMS do tej osoby już wyszedł.'; end if;
  if char_length(msg) < 10 then raise exception 'Wpisz treść SMS-a.'; end if;
  if char_length(msg) > 459 then raise exception 'SMS jest za długi (najwyżej 459 znaków, czyli 3 części).'; end if;
  if public.risk_phone9(a.phone) is null then raise exception 'Brak numeru telefonu tej osoby.'; end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then raise exception 'Brak sekretu push_secret w bazie, SMS nie wyszedł.'; end if;
  perform net.http_post(
    url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/sms-wyslij',
    body := jsonb_build_object('phone', a.phone, 'msg', msg),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret));
  update public.risk_alerts
     set status = case when status = 'paid' then status else 'sent' end, sms_text = msg, sms_at = now(),
         handled_at = coalesce(handled_at, now())
   where id = a.id;
  return json_build_object('phone', a.phone);
end $$;

-- „SMS wysłano” (wysłany z Twojego telefonu albo inną drogą)
create or replace function public.risk_alert_sms_mark(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.risk_alerts
     set status = case when status = 'paid' then status else 'sent' end, sms_at = coalesce(sms_at, now()),
         handled_at = case when status = 'paid' then handled_at else now() end
   where id = p_id;
  if not found then raise exception 'Nie ma już tego ostrzeżenia. Odśwież panel.'; end if;
end $$;

-- „Zadatek wpłacono”: kwota w zł (podpowiada panel: 50% ceny rytuału)
create or replace function public.risk_alert_deposit(p_id bigint, p_amount numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  if p_amount is null or p_amount < 1 or p_amount > 2000 then raise exception 'Wpisz kwotę zadatku (od 1 do 2000 zł).'; end if;
  update public.risk_alerts
     set status = 'paid', deposit_amount = round(p_amount, 2), deposit_paid_at = now(), deposit_settled_at = null, handled_at = now()
   where id = p_id;
  if not found then raise exception 'Nie ma już tego ostrzeżenia. Odśwież panel.'; end if;
end $$;

-- „Pomiń” działa też, gdy SMS wyszedł, a zadatek nie przyszedł
create or replace function public.risk_alert_dismiss(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.risk_alerts set status = 'dismissed', handled_at = now() where id = p_id and status in ('new', 'sent');
end $$;

-- pomyłka: cofnij wpłatę
create or replace function public.risk_alert_deposit_undo(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.risk_alerts
     set status = case when sms_at is not null then 'sent' else 'new' end,
         deposit_amount = null, deposit_paid_at = null, deposit_settled_at = null,
         handled_at = case when sms_at is not null then sms_at else null end
   where id = p_id and status = 'paid';
end $$;

-- zadatek rozliczony przy paragonie (albo przepadł po odwołaniu): znika z planu dnia
create or replace function public.risk_alert_deposit_settle(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.risk_alerts set deposit_settled_at = now() where id = p_id and status = 'paid' and deposit_settled_at is null;
end $$;

-- wpłacone zadatki przypisane do wizyt w planie w podanych dniach
-- (pierwsza wizyta tej osoby od dnia ostrzeżenia; najpierw ta w dniu z ostrzeżenia)
create or replace function public.deposits_plan(p_from date, p_to date)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((select json_agg(json_build_object('plan_id', m.plan_id, 'alert_id', m.id, 'amount', m.deposit_amount,
                                                    'paid_at', m.deposit_paid_at, 'service', m.service, 'day', m.pday))
    from (
      select distinct on (a.id) a.id, a.deposit_amount, a.deposit_paid_at, a.service, p.id as plan_id, p.day as pday
        from public.risk_alerts a
        join public.day_plan p on p.day >= least(a.day, (a.created_at at time zone 'Europe/Warsaw')::date)
        left join public.cards c on c.id = p.card_id
        left join public.booksy_bookings b on b.id = p.booking_id
       where a.status = 'paid' and a.deposit_settled_at is null
         and (p.id = a.plan_id
              or (a.booking_id is not null and p.booking_id = a.booking_id)
              or (a.card_id is not null and p.card_id = a.card_id)
              or (a.phone9 is not null and a.phone9 in (public.risk_phone9(c.phone), b.client_phone9)))
       order by a.id, (p.day = a.day) desc, p.day, p.start_at nulls last
    ) m
   where m.pday between p_from and p_to), '[]'::json);
end $$;

revoke all on function public.risk_alerts_list(), public.risk_alert_sms(bigint, text), public.risk_alert_dismiss(bigint), public.risk_alert_sms_mark(bigint),
  public.risk_alert_deposit(bigint, numeric), public.risk_alert_deposit_undo(bigint), public.risk_alert_deposit_settle(bigint),
  public.deposits_plan(date, date) from public, anon;
grant execute on function public.risk_alerts_list(), public.risk_alert_sms(bigint, text), public.risk_alert_dismiss(bigint), public.risk_alert_sms_mark(bigint),
  public.risk_alert_deposit(bigint, numeric), public.risk_alert_deposit_undo(bigint), public.risk_alert_deposit_settle(bigint),
  public.deposits_plan(date, date) to authenticated;

select 'Zadatek przy ostrzeżeniach gotowy' as wynik;
