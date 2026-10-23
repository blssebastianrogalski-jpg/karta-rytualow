-- ============================================================
--  Karta rytuałów – Twoje Ciało Twój Dobrostan
--  Baza danych (Supabase / PostgreSQL)
--  Wklej całość w Supabase → SQL Editor → Run.
--  Skrypt można uruchomić ponownie (nie kasuje danych).
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- Tabele ----------

create table if not exists public.cards (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,            -- krótki kod na karcie i w QR, np. K7Q2MX
  token            text not null unique default encode(gen_random_bytes(18), 'hex'), -- tajny klucz klientki
  name             text not null check (char_length(name) between 2 and 80),
  phone            text check (phone is null or char_length(phone) <= 30),
  bday_day         smallint check (bday_day between 1 and 31),
  bday_month       smallint check (bday_month between 1 and 12),
  stamps           smallint not null default 0 check (stamps between 0 and 10),
  cards_completed  int not null default 0,
  birthday_used_year int,                          -- rok, w którym wykorzystano rabat urodzinowy
  source           text not null default 'app' check (source in ('app', 'studio')),
  note             text,
  created_at       timestamptz not null default now()
);

create table if not exists public.visits (
  id         bigint generated always as identity primary key,
  card_id    uuid not null references public.cards(id) on delete cascade,
  -- stamp = zwykła wizyta (+1), package_buy = zakup pakietu (+1),
  -- package_visit = wizyta z pakietu (bez pieczątki), birthday = rabat urodzinowy
  kind       text not null check (kind in ('stamp', 'package_buy', 'package_visit', 'birthday')),
  service    text,
  discount   smallint not null default 0,          -- 0, 15, 30 lub 25 (%)
  created_at timestamptz not null default now()
);
create index if not exists visits_card_idx on public.visits(card_id, created_at desc);

-- Plan dnia (wizyty wpisane ręcznie – Booksy nie udostępnia kalendarza)
create table if not exists public.day_plan (
  id         bigint generated always as identity primary key,
  card_id    uuid not null references public.cards(id) on delete cascade,
  day        date not null default ((now() at time zone 'Europe/Warsaw')::date),
  service    text,
  status     text not null default 'planned' check (status in ('planned', 'stamp', 'package_buy', 'package_visit', 'birthday', 'skipped')),
  created_at timestamptz not null default now()
);
create index if not exists day_plan_day_idx on public.day_plan(day);

-- Konta studia (właścicielka i ewentualnie pracownice)
create table if not exists public.staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------- Bezpieczeństwo ----------

alter table public.cards  enable row level security;
alter table public.visits enable row level security;
alter table public.staff  enable row level security;
alter table public.day_plan enable row level security;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where user_id = auth.uid());
$$;

drop policy if exists staff_cards on public.cards;
create policy staff_cards on public.cards for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists staff_visits on public.visits;
create policy staff_visits on public.visits for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists staff_plan on public.day_plan;
create policy staff_plan on public.day_plan for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists staff_self on public.staff;
create policy staff_self on public.staff for select to authenticated
  using (user_id = auth.uid());

-- ---------- Pomocnicze ----------

create or replace function public.today_pl() returns date
language sql stable as $$ select (now() at time zone 'Europe/Warsaw')::date $$;

-- Czy dziś są urodziny (29 lutego świętujemy 28 lutego w latach nieprzestępnych)
create or replace function public.is_bday_today(d smallint, m smallint) returns boolean
language plpgsql stable as $$
declare t date := public.today_pl();
begin
  if d is null or m is null then return false; end if;
  if m = 2 and d = 29 and extract(day from (date_trunc('year', t) + interval '1 month 28 days')) <> 29 then
    return extract(month from t) = 2 and extract(day from t) = 28;
  end if;
  return extract(month from t) = m and extract(day from t) = d;
end $$;

create or replace function public.new_code() returns text
language plpgsql volatile as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  c text;
begin
  loop
    c := '';
    for i in 1..6 loop
      c := c || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.cards where code = c);
  end loop;
  return c;
end $$;

create or replace function public.card_json(c public.cards, with_token boolean default false) returns json
language sql stable as $$
  select json_build_object(
    'id', c.id, 'code', c.code, 'name', c.name, 'phone', c.phone,
    'bday_day', c.bday_day, 'bday_month', c.bday_month,
    'stamps', c.stamps, 'cards_completed', c.cards_completed,
    'birthday_used_year', c.birthday_used_year, 'source', c.source, 'note', c.note,
    'created_at', c.created_at,
    'token', case when with_token then c.token else null end,
    'bday_today', public.is_bday_today(c.bday_day, c.bday_month),
    'visits', coalesce((
      select json_agg(json_build_object('kind', v.kind, 'service', v.service, 'discount', v.discount, 'created_at', v.created_at) order by v.created_at desc)
      from (select * from public.visits where card_id = c.id order by created_at desc limit 12) v
    ), '[]'::json)
  );
$$;

-- ---------- Funkcje dla klientek (bez logowania) ----------

create or replace function public.register_card(p_name text, p_phone text, p_day int, p_month int)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Podaj imię i nazwisko.'; end if;
  insert into public.cards (code, name, phone, bday_day, bday_month, source)
  values (public.new_code(), trim(p_name), nullif(trim(coalesce(p_phone, '')), ''), p_day, p_month, 'app')
  returning * into c;
  return public.card_json(c, true);
end $$;

create or replace function public.get_my_card(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  select * into c from public.cards where token = p_token;
  if not found then return null; end if;
  return public.card_json(c, true);
end $$;

-- ---------- Funkcje dla studia (wymagają logowania) ----------

create or replace function public.staff_check() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Brak dostępu.'; end if;
end $$;

create or replace function public.find_card(p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  perform public.staff_check();
  select * into c from public.cards where code = upper(trim(p_code));
  if not found then return null; end if;
  return public.card_json(c, true);
end $$;

create or replace function public.get_card(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  perform public.staff_check();
  select * into c from public.cards where id = p_id;
  if not found then return null; end if;
  return public.card_json(c, true);
end $$;

create or replace function public.list_cards(p_query text default '')
returns json language plpgsql security definer set search_path = public as $$
declare q text := lower(trim(coalesce(p_query, '')));
begin
  perform public.staff_check();
  return coalesce((
    select json_agg(x order by x.bday_today desc, x.name)
    from (
      select id, code, name, phone, stamps, source, bday_day, bday_month, birthday_used_year,
             public.is_bday_today(bday_day, bday_month) as bday_today
      from public.cards
      where q = '' or lower(name) like '%' || q || '%' or replace(coalesce(phone, ''), ' ', '') like '%' || replace(q, ' ', '') || '%' or lower(code) = q
      limit 200
    ) x
  ), '[]'::json);
end $$;

create or replace function public.create_studio_card(p_name text, p_phone text, p_day int, p_month int, p_stamps int default 0)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  perform public.staff_check();
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Podaj imię i nazwisko.'; end if;
  insert into public.cards (code, name, phone, bday_day, bday_month, source, stamps)
  values (public.new_code(), trim(p_name), nullif(trim(coalesce(p_phone, '')), ''), p_day, p_month, 'studio', greatest(0, least(9, coalesce(p_stamps, 0))))
  returning * into c;
  return public.card_json(c, true);
end $$;

create or replace function public.update_card(p_id uuid, p_name text, p_phone text, p_day int, p_month int, p_note text)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  perform public.staff_check();
  update public.cards set name = trim(p_name), phone = nullif(trim(coalesce(p_phone, '')), ''),
    bday_day = p_day, bday_month = p_month, note = nullif(trim(coalesce(p_note, '')), '')
  where id = p_id returning * into c;
  return public.card_json(c, true);
end $$;

-- Zapis wizyty. p_mode: stamp | package_buy | package_visit
create or replace function public.record_visit(p_id uuid, p_mode text, p_service text default null, p_plan_id bigint default null)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards; n int; d int := 0;
begin
  perform public.staff_check();
  if p_mode not in ('stamp', 'package_buy', 'package_visit') then raise exception 'Nieznany rodzaj wizyty.'; end if;
  select * into c from public.cards where id = p_id for update;
  if not found then raise exception 'Nie znaleziono karty.'; end if;
  if p_mode <> 'package_visit' then
    if c.stamps >= 10 then raise exception 'Karta jest pełna. Rozpocznij nową kartę.'; end if;
    n := c.stamps + 1;
    d := case when n = 5 then 15 when n = 10 then 30 else 0 end;
    update public.cards set stamps = n where id = p_id returning * into c;
  end if;
  insert into public.visits (card_id, kind, service, discount) values (p_id, p_mode, nullif(trim(coalesce(p_service, '')), ''), d);
  if p_plan_id is not null then
    update public.day_plan set status = p_mode, service = coalesce(nullif(trim(coalesce(p_service, '')), ''), service) where id = p_plan_id;
  end if;
  return public.card_json(c, true);
end $$;

create or replace function public.remove_stamp(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  perform public.staff_check();
  select * into c from public.cards where id = p_id for update;
  if c.stamps <= 0 then raise exception 'Na karcie nie ma pieczątek.'; end if;
  update public.cards set stamps = stamps - 1 where id = p_id returning * into c;
  delete from public.visits where id = (select id from public.visits where card_id = p_id and kind in ('stamp', 'package_buy') order by created_at desc limit 1);
  return public.card_json(c, true);
end $$;

create or replace function public.start_new_card(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  perform public.staff_check();
  update public.cards set stamps = 0, cards_completed = cards_completed + 1
  where id = p_id and stamps >= 10 returning * into c;
  if not found then raise exception 'Nową kartę można rozpocząć dopiero po 10 pieczątkach.'; end if;
  return public.card_json(c, true);
end $$;

create or replace function public.use_birthday(p_id uuid, p_service text default null, p_plan_id bigint default null)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards; y int := extract(year from public.today_pl());
begin
  perform public.staff_check();
  select * into c from public.cards where id = p_id for update;
  if not public.is_bday_today(c.bday_day, c.bday_month) then raise exception 'Rabat urodzinowy działa tylko w dniu urodzin.'; end if;
  if c.birthday_used_year = y then raise exception 'Rabat urodzinowy został już wykorzystany w tym roku.'; end if;
  update public.cards set birthday_used_year = y where id = p_id returning * into c;
  insert into public.visits (card_id, kind, service, discount) values (p_id, 'birthday', nullif(trim(coalesce(p_service, '')), ''), 25);
  if p_plan_id is not null then update public.day_plan set status = 'birthday' where id = p_plan_id; end if;
  return public.card_json(c, true);
end $$;

create or replace function public.plan_list(p_day date default null)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((
    select json_agg(json_build_object(
      'id', p.id, 'card_id', p.card_id, 'service', p.service, 'status', p.status,
      'name', c.name, 'stamps', c.stamps, 'source', c.source, 'phone', c.phone,
      'bday_today', public.is_bday_today(c.bday_day, c.bday_month),
      'birthday_used_year', c.birthday_used_year
    ) order by p.created_at)
    from public.day_plan p join public.cards c on c.id = p.card_id
    where p.day = coalesce(p_day, public.today_pl())
  ), '[]'::json);
end $$;

create or replace function public.plan_add(p_card uuid, p_service text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  insert into public.day_plan (card_id, service) values (p_card, nullif(trim(coalesce(p_service, '')), ''));
end $$;

create or replace function public.plan_set(p_plan_id bigint, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  if p_status not in ('planned', 'skipped') then raise exception 'Nieprawidłowy status.'; end if;
  update public.day_plan set status = p_status where id = p_plan_id;
end $$;

create or replace function public.plan_remove(p_plan_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  delete from public.day_plan where id = p_plan_id;
end $$;

create or replace function public.delete_card(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  delete from public.cards where id = p_id;
end $$;

create or replace function public.reset_token(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  perform public.staff_check();
  update public.cards set token = encode(gen_random_bytes(18), 'hex') where id = p_id returning * into c;
  return public.card_json(c, true);
end $$;

-- ---------- Uprawnienia ----------

revoke all on function public.card_json(public.cards, boolean) from public, anon, authenticated;
revoke all on function public.new_code() from public, anon, authenticated;
grant execute on function public.register_card(text, text, int, int) to anon, authenticated;
grant execute on function public.get_my_card(text) to anon, authenticated;
grant execute on function
  public.find_card(text), public.get_card(uuid), public.list_cards(text),
  public.create_studio_card(text, text, int, int, int), public.update_card(uuid, text, text, int, int, text),
  public.record_visit(uuid, text, text, bigint), public.remove_stamp(uuid), public.start_new_card(uuid),
  public.use_birthday(uuid, text, bigint), public.delete_card(uuid), public.reset_token(uuid),
  public.plan_list(date), public.plan_add(uuid, text), public.plan_set(bigint, text), public.plan_remove(bigint)
  to authenticated;

-- ============================================================
--  PO ZAŁOŻENIU KONTA WŁAŚCICIELKI (Authentication → Users → Add user)
--  uruchom tę linijkę, wpisując jej adres e-mail:
--
--  insert into public.staff (user_id)
--  select id from auth.users where email = 'jrtwojecialo@gmail.com'
--  on conflict do nothing;
-- ============================================================
-- Powiadomienia push dla klientek.
-- Uruchom w Supabase → SQL Editor (raz). Nie kasuje żadnych danych.

create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  card_id    uuid references public.cards(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
-- Brak polityk: klientka i panel nie czytają tej tabeli. Zapis idzie tylko przez funkcję poniżej.

create or replace function public.save_push_subscription(p_token text, p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  select id into cid from public.cards where token = p_token;
  if cid is null then raise exception 'Nie znaleziono karty.'; end if;
  insert into public.push_subscriptions (card_id, endpoint, p256dh, auth) values (cid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set card_id = excluded.card_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;
grant execute on function public.save_push_subscription(text, text, text, text) to anon, authenticated;
