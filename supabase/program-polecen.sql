-- Program poleceń: klientka wysyła koleżance link z aplikacji (…/?p=KOD_KARTY).
-- Koleżanka (nowa klientka, numer telefonu jeszcze nie w bazie) dostaje −10% na pierwszy pojedynczy rytuał.
-- Polecająca dostaje +1 pieczątkę po pierwszej wizycie koleżanki w studiu.
-- Wklej całość w Supabase → SQL Editor → Run. Można uruchomić kilka razy, nie kasuje danych.

alter table public.cards add column if not exists referred_by uuid references public.cards(id) on delete set null; -- kto poleciła
alter table public.cards add column if not exists ref_welcome boolean not null default false;    -- czeka −10% na pierwszy rytuał
alter table public.cards add column if not exists ref_rewarded_at timestamptz;                    -- kiedy polecająca dostała pieczątkę
alter table public.cards add column if not exists bonus_stamps smallint not null default 0;       -- pieczątki za polecenie czekające na dopisanie
create index if not exists cards_referred_by_idx on public.cards(referred_by);

-- nowy rodzaj wpisu w historii: pieczątka za polecenie
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
  check (kind in ('stamp', 'package_buy', 'package_visit', 'birthday', 'referral'));

-- Dopisuje czekające pieczątki za polecenie. Nigdy nie wypełnia 5. ani 10. kratki,
-- bo przy nich klientka ma rabat za wizytę: wtedy pieczątka czeka do jej najbliższej wizyty.
create or replace function public.apply_bonus_stamps(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  loop
    select * into c from public.cards where id = p_id for update;
    exit when not found or c.bonus_stamps <= 0 or c.stamps >= 10 or c.stamps in (4, 9);
    update public.cards set stamps = stamps + 1, bonus_stamps = bonus_stamps - 1 where id = p_id;
    insert into public.visits (card_id, kind) values (p_id, 'referral');
  end loop;
end $$;

-- przed zapisem wizyty: pierwszy pojedynczy rytuał koleżanki z polecenia dostaje −10%
create or replace function public.visits_ref_welcome() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'stamp' and coalesce(new.discount, 0) = 0 then
    update public.cards set ref_welcome = false where id = new.card_id and ref_welcome
    returning 10 into new.discount;
    new.discount := coalesce(new.discount, 0);
  end if;
  return new;
end $$;
drop trigger if exists visits_ref_welcome on public.visits;
create trigger visits_ref_welcome before insert on public.visits
  for each row execute function public.visits_ref_welcome();

-- po zapisie wizyty: pierwsza wizyta koleżanki daje pieczątkę polecającej; wizyta klientki dopisuje jej czekające pieczątki
create or replace function public.visits_ref_reward() returns trigger
language plpgsql security definer set search_path = public as $$
declare ref uuid;
begin
  if new.kind = 'referral' then return new; end if;
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
drop trigger if exists visits_ref_reward on public.visits;
create trigger visits_ref_reward after insert on public.visits
  for each row execute function public.visits_ref_reward();

-- dane o poleceniach dołączane do karty (aplikacja klientki i panel)
create or replace function public.referral_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ref_welcome', c.ref_welcome,
    'bonus_stamps', c.bonus_stamps,
    'referred_by_name', (select r.name from public.cards r where r.id = c.referred_by),
    'ref_count', (select count(*) from public.cards f where f.referred_by = c.id),
    'ref_rewarded', (select count(*) from public.cards f where f.referred_by = c.id and f.ref_rewarded_at is not null)
  ) from public.cards c where c.id = p_id
$$;

-- link polecający otwarty przez koleżankę: tylko imię polecającej
create or replace function public.referral_info(p_code text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('name', split_part(name, ' ', 1))
  from public.cards where code = upper(trim(coalesce(p_code, ''))) and length(trim(p_code)) = 6
$$;

-- zakładanie karty w aplikacji, z kodem polecającej (opcjonalnie)
drop function if exists public.register_card(text, text, int, int);
create or replace function public.register_card(p_name text, p_phone text, p_day int, p_month int, p_ref text default null)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards; ref public.cards; p9 text;
begin
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Podaj imię i nazwisko.'; end if;
  if nullif(trim(coalesce(p_ref, '')), '') is not null then
    select * into ref from public.cards where code = upper(trim(p_ref));
    if found then
      p9 := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
      if length(p9) < 9 then raise exception 'Podaj numer telefonu, aby dostać rabat −10%% z polecenia.'; end if;
      if exists (select 1 from public.cards where right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 9) = p9) then
        raise exception 'Ten numer ma już kartę rytuałów. Rabat z polecenia jest dla nowych klientek. Zaloguj się kodem SMS, aby wrócić do swojej karty.';
      end if;
    end if;
  end if;
  insert into public.cards (code, name, phone, bday_day, bday_month, source, referred_by, ref_welcome)
  values (public.new_code(), trim(p_name), nullif(trim(coalesce(p_phone, '')), ''), p_day, p_month, 'app', ref.id, ref.id is not null)
  returning * into c;
  return public.card_json(c, true);
end $$;

create or replace function public.get_my_card(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  select * into c from public.cards where token = p_token;
  if not found then return null; end if;
  return (public.card_json(c, true)::jsonb || public.referral_json(c.id) || jsonb_build_object('upcoming', coalesce((
    select jsonb_agg(jsonb_build_object('day', p.day, 'start_at', p.start_at, 'service', p.service) order by p.day, p.start_at nulls last)
    from (
      select day, start_at, service from public.day_plan
      where card_id = c.id and status = 'planned' and day >= public.today_pl()
        and (start_at is null or start_at > now() - interval '1 hour')
      order by day, start_at nulls last limit 3
    ) p), '[]'::jsonb)))::json;
end $$;

create or replace function public.get_card(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  perform public.staff_check();
  select * into c from public.cards where id = p_id;
  if not found then return null; end if;
  return (public.card_json(c, true)::jsonb || public.referral_json(c.id))::json;
end $$;

create or replace function public.find_card(p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  perform public.staff_check();
  select * into c from public.cards where code = upper(trim(p_code));
  if not found then return null; end if;
  return (public.card_json(c, true)::jsonb || public.referral_json(c.id))::json;
end $$;

-- panel: lista poleceń (najnowsze na górze)
create or replace function public.referrals_list()
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((
    select json_agg(x order by x.created_at desc)
    from (
      select f.id, f.name, f.created_at, f.ref_welcome, f.ref_rewarded_at,
             r.id as referrer_id, r.name as referrer_name, r.stamps as referrer_stamps, r.bonus_stamps as referrer_bonus
      from public.cards f join public.cards r on r.id = f.referred_by
      order by f.created_at desc limit 200
    ) x
  ), '[]'::json);
end $$;

revoke all on function public.apply_bonus_stamps(uuid), public.referral_json(uuid) from public, anon, authenticated;
grant execute on function public.register_card(text, text, int, int, text), public.referral_info(text), public.get_my_card(text) to anon, authenticated;
grant execute on function public.get_card(uuid), public.find_card(text), public.referrals_list() to authenticated;
