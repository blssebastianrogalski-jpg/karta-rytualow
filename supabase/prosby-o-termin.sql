-- Prośby o termin (dla klientek bez Booksy).
-- Klientka zostawia na karcie prośbę: rytuał, dzień, pora, telefon, wiadomość.
-- Studio widzi ją w panelu, dzwoni lub pisze SMS, a potem potwierdza termin
-- (wizyta trafia do planu dnia) albo odpisuje, że termin nie pasuje.
-- Powiadomienia: nowa prośba → telefon studia, potwierdzenie/odmowa → klientka.
-- Uruchom w Supabase → SQL Editor (raz, można ponownie). Nie kasuje żadnych danych.

create extension if not exists pg_net with schema extensions;

create table if not exists public.booking_requests (
  id           bigint generated always as identity primary key,
  card_id      uuid not null references public.cards(id) on delete cascade,
  service      text check (service is null or char_length(service) <= 80),
  pref_day     date not null,
  pref_part    text not null default 'any' check (pref_part in ('any', 'morning', 'midday', 'evening')),
  pref_time    time,                     -- konkretna godzina, jeśli klientka podała
  phone        text not null check (char_length(phone) <= 30),
  message      text check (message is null or char_length(message) <= 500),
  status       text not null default 'new' check (status in ('new', 'confirmed', 'declined', 'cancelled')),
  confirmed_at timestamptz,              -- potwierdzony początek wizyty
  plan_id      bigint references public.day_plan(id) on delete set null,
  reply        text check (reply is null or char_length(reply) <= 300), -- odpowiedź studia widoczna na karcie
  handled_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists booking_requests_card_idx on public.booking_requests(card_id, created_at desc);
create index if not exists booking_requests_status_idx on public.booking_requests(status, created_at desc);
alter table public.booking_requests enable row level security;
-- Brak polityk: zapis i odczyt tylko przez funkcje poniżej.

-- „czwartek, 30 października” (bez zależności od ustawień językowych bazy)
create or replace function public.pl_day_label(d date) returns text
language sql immutable as $$
  select (array['niedziela','poniedziałek','wtorek','środa','czwartek','piątek','sobota'])[extract(dow from d)::int + 1]
    || ', ' || extract(day from d)::int || ' '
    || (array['stycznia','lutego','marca','kwietnia','maja','czerwca','lipca','sierpnia','września','października','listopada','grudnia'])[extract(month from d)::int]
$$;

create or replace function public.request_part_label(p text) returns text
language sql immutable as $$
  select case p when 'morning' then 'rano (do 12:00)' when 'midday' then 'w południe (12–16)'
                when 'evening' then 'po 16:00' else 'dowolna pora' end
$$;

create or replace function public.request_json(r public.booking_requests) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', r.id, 'card_id', r.card_id, 'service', r.service, 'pref_day', r.pref_day, 'pref_part', r.pref_part,
    'pref_time', to_char(r.pref_time, 'HH24:MI'), 'phone', r.phone, 'message', r.message, 'status', r.status,
    'confirmed_at', r.confirmed_at, 'reply', r.reply, 'handled_at', r.handled_at, 'created_at', r.created_at)
$$;

-- ---------- Klientka (po tokenie karty) ----------

create or replace function public.request_create(p_token text, p_service text, p_day date, p_part text, p_time text, p_phone text, p_message text)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards; r public.booking_requests; p9 text;
begin
  select * into c from public.cards where token = p_token;
  if not found then raise exception 'Nie znaleziono karty.'; end if;
  p9 := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if length(p9) < 9 then raise exception 'Podaj numer telefonu, żebym mogła oddzwonić.'; end if;
  if p_day is null or p_day < public.today_pl() then raise exception 'Wybierz dzień od dziś.'; end if;
  if p_day > public.today_pl() + 60 then raise exception 'Termin możesz wybrać najwyżej 60 dni naprzód.'; end if;
  if (select count(*) from public.booking_requests where card_id = c.id and status = 'new') >= 3 then
    raise exception 'Masz już 3 prośby czekające na odpowiedź. Odezwę się wkrótce.';
  end if;
  insert into public.booking_requests (card_id, service, pref_day, pref_part, pref_time, phone, message)
  values (c.id, nullif(trim(coalesce(p_service, '')), ''), p_day,
          case when p_part in ('morning', 'midday', 'evening') then p_part else 'any' end,
          nullif(trim(coalesce(p_time, '')), '')::time, trim(p_phone), nullif(trim(coalesce(p_message, '')), ''))
  returning * into r;
  return public.request_json(r)::json;
end $$;

-- prośby widoczne na karcie: czekające, potwierdzone (do dnia wizyty) i odpowiedzi „nie pasuje” z ostatnich 7 dni
create or replace function public.my_requests(p_token text)
returns json language plpgsql stable security definer set search_path = public as $$
declare cid uuid;
begin
  select id into cid from public.cards where token = p_token;
  if cid is null then return '[]'::json; end if;
  return coalesce((
    select json_agg(public.request_json(r) order by r.created_at desc)
    from (select * from public.booking_requests
           where card_id = cid and (status = 'new'
              or (status = 'confirmed' and confirmed_at > now() - interval '1 hour')
              or (status = 'declined' and handled_at > now() - interval '7 days'))
           order by created_at desc limit 5) r
  ), '[]'::json);
end $$;

create or replace function public.request_cancel(p_token text, p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.booking_requests r set status = 'cancelled', handled_at = now()
    from public.cards c
   where r.id = p_id and r.card_id = c.id and c.token = p_token and r.status = 'new';
  if not found then raise exception 'Tej prośby nie można już anulować. Zadzwoń do studia.'; end if;
end $$;

-- ---------- Studio ----------

create or replace function public.requests_list()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((
    select json_agg(public.request_json(r) || jsonb_build_object('name', c.name, 'stamps', c.stamps, 'card_phone', c.phone)
                    order by (r.status = 'new') desc, case when r.status = 'new' then r.created_at end, r.handled_at desc nulls last)
    from public.booking_requests r join public.cards c on c.id = r.card_id
    where r.status = 'new' or r.handled_at > now() - interval '14 days'
  ), '[]'::json);
end $$;

-- potwierdzenie: wizyta trafia do planu dnia z godziną
create or replace function public.request_confirm(p_id bigint, p_day date, p_time text, p_service text default null)
returns json language plpgsql security definer set search_path = public as $$
declare r public.booking_requests; t time; st timestamptz; pid bigint; svc text;
begin
  perform public.staff_check();
  select * into r from public.booking_requests where id = p_id for update;
  if not found then raise exception 'Nie znaleziono prośby.'; end if;
  if r.status not in ('new', 'declined') then raise exception 'Ta prośba jest już załatwiona.'; end if;
  if p_day is null or p_day < public.today_pl() then raise exception 'Wybierz dzień od dziś.'; end if;
  if p_day > public.today_pl() + 60 then raise exception 'Termin najwyżej 60 dni naprzód.'; end if;
  t := nullif(trim(coalesce(p_time, '')), '')::time;
  if t is null then raise exception 'Podaj godzinę wizyty.'; end if;
  st := (p_day + t) at time zone 'Europe/Warsaw';
  svc := coalesce(nullif(trim(coalesce(p_service, '')), ''), r.service);
  -- klientka już jest w planie na ten dzień (bez Booksy): uzupełniamy godzinę
  select id into pid from public.day_plan
   where card_id = r.card_id and day = p_day and status = 'planned' and booking_id is null order by id limit 1;
  if pid is not null then
    update public.day_plan set start_at = st, service = coalesce(svc, service) where id = pid;
  else
    insert into public.day_plan (card_id, day, service, start_at) values (r.card_id, p_day, svc, st) returning id into pid;
  end if;
  update public.booking_requests
     set status = 'confirmed', confirmed_at = st, plan_id = pid, service = svc, reply = null, handled_at = now()
   where id = p_id returning * into r;
  return public.request_json(r)::json;
end $$;

-- termin nie pasuje: krótka odpowiedź widoczna na karcie klientki
create or replace function public.request_decline(p_id bigint, p_reply text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  update public.booking_requests set status = 'declined', reply = nullif(trim(coalesce(p_reply, '')), ''), handled_at = now()
   where id = p_id and status = 'new';
  if not found then raise exception 'Ta prośba jest już załatwiona.'; end if;
end $$;

-- ---------- Powiadomienia (funkcja send-push, sekret z Vault jak w przypomnieniach) ----------

create or replace function public.booking_request_push()
returns trigger language plpgsql security definer set search_path = public as $$
declare secret text; payload jsonb; nm text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then return new; end if;
  if tg_op = 'INSERT' then
    select name into nm from public.cards where id = new.card_id;
    payload := jsonb_build_object('owner', true, 'title', 'Prośba o termin',
      'body', coalesce(nm, 'Klientka') || ' · ' || coalesce(new.service, 'rytuał') || ' · ' || public.pl_day_label(new.pref_day)
              || ', ' || coalesce(to_char(new.pref_time, 'HH24:MI'), public.request_part_label(new.pref_part)),
      'url', 'panel.html#prosby');
  elsif new.status = 'confirmed' and old.status is distinct from 'confirmed' then
    payload := jsonb_build_object('card_id', new.card_id, 'title', 'Termin potwierdzony',
      'body', (select upper(left(l, 1)) || substr(l, 2) from public.pl_day_label((new.confirmed_at at time zone 'Europe/Warsaw')::date) l) || ', '
              || to_char(new.confirmed_at at time zone 'Europe/Warsaw', 'HH24:MI') || '. Do zobaczenia!',
      'url', './');
  elsif new.status = 'declined' and old.status is distinct from 'declined' then
    payload := jsonb_build_object('card_id', new.card_id, 'title', 'Odpowiedź na prośbę o termin',
      'body', coalesce(new.reply, 'Ten termin jest niestety zajęty. Zajrzyj do karty.'), 'url', './');
  else
    return new;
  end if;
  perform net.http_post(
    url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/send-push',
    body := payload,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret)
  );
  return new;
exception when others then
  return new; -- brak powiadomienia nie może blokować prośby
end $$;
revoke execute on function public.booking_request_push() from public, anon, authenticated;

drop trigger if exists booking_requests_push on public.booking_requests;
create trigger booking_requests_push
  after insert or update of status on public.booking_requests
  for each row execute function public.booking_request_push();

-- ---------- Uprawnienia ----------
revoke all on function public.request_create(text, text, date, text, text, text, text), public.my_requests(text),
  public.request_cancel(text, bigint), public.requests_list(), public.request_confirm(bigint, date, text, text),
  public.request_decline(bigint, text) from public;
grant execute on function public.request_create(text, text, date, text, text, text, text), public.my_requests(text),
  public.request_cancel(text, bigint) to anon, authenticated;
grant execute on function public.requests_list(), public.request_confirm(bigint, date, text, text),
  public.request_decline(bigint, text) to authenticated;
