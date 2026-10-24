-- Logowanie do karty kodem SMS (klientka sama wraca do swojej karty).
-- Uruchom raz w Supabase → SQL Editor. Można uruchomić ponownie. Nie kasuje żadnych danych kart.
-- Kody i limity obsługuje funkcja Edge "kod-sms" (klucz service_role), przeglądarka nie ma tu dostępu.

create or replace function public.booksy_phone9(p text) returns text
language sql immutable as $$
  select case when length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) >= 9
    then right(regexp_replace(p, '\D', '', 'g'), 9) end
$$;

create table if not exists public.login_codes (
  id         bigint generated always as identity primary key,
  phone9     text not null,
  code_hash  text,                 -- null: numer bez karty (liczy się tylko do limitów)
  ip         text,
  attempts   int not null default 0,
  used       boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists login_codes_phone_idx on public.login_codes (phone9, created_at desc);
create index if not exists login_codes_ip_idx on public.login_codes (ip, created_at desc);
alter table public.login_codes enable row level security;  -- bez polityk: tylko service_role
revoke all on public.login_codes from public, anon, authenticated;

create or replace function public.login_code_hash(p_phone9 text, p_code text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(p_phone9 || ':' || p_code, 'UTF8')), 'hex')
$$;

-- Prośba o kod. Zwraca {send, phone9} albo {send:false, reason: phone|limit|global|nocard}.
create or replace function public.login_sms_request(p_phone text, p_code text, p_ip text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  ph text := public.booksy_phone9(p_phone);
  has_card boolean;
begin
  if ph is null or length(regexp_replace(p_phone, '\D', '', 'g')) not in (9, 11) or ph !~ '^[4-8]' then
    return json_build_object('send', false, 'reason', 'phone');
  end if;
  if p_code !~ '^\d{6}$' then raise exception 'Zły format kodu.'; end if;
  delete from public.login_codes where created_at < now() - interval '2 days';
  if (select count(*) from public.login_codes where phone9 = ph and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.login_codes where phone9 = ph and created_at > now() - interval '1 day') >= 6
     or (p_ip is not null and (select count(*) from public.login_codes where ip = p_ip and created_at > now() - interval '1 hour') >= 6) then
    return json_build_object('send', false, 'reason', 'limit');
  end if;
  if (select count(*) from public.login_codes where code_hash is not null and created_at > now() - interval '1 day') >= 100 then
    return json_build_object('send', false, 'reason', 'global');
  end if;
  has_card := exists (select 1 from public.cards where public.booksy_phone9(phone) = ph);
  insert into public.login_codes (phone9, code_hash, ip, expires_at)
  values (ph, case when has_card then public.login_code_hash(ph, p_code) end, p_ip, now() + interval '10 minutes');
  if not has_card then return json_build_object('send', false, 'reason', 'nocard'); end if;
  -- starsze kody dla tego numeru przestają działać
  update public.login_codes set used = true
    where phone9 = ph and not used and id <> (select max(id) from public.login_codes where phone9 = ph);
  return json_build_object('send', true, 'phone9', ph);
end $$;

-- Sprawdzenie kodu. Po dobrym kodzie zwraca karty z tym numerem (imię, pieczątki, klucz karty).
create or replace function public.login_sms_verify(p_phone text, p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare
  ph text := public.booksy_phone9(p_phone);
  r public.login_codes;
begin
  select * into r from public.login_codes
    where phone9 = ph and code_hash is not null and not used and expires_at > now()
    order by id desc limit 1;
  if not found then return json_build_object('ok', false, 'reason', 'expired'); end if;
  if r.attempts >= 5 then return json_build_object('ok', false, 'reason', 'attempts'); end if;
  if r.code_hash <> public.login_code_hash(ph, coalesce(p_code, '')) then
    update public.login_codes set attempts = attempts + 1, used = (attempts + 1 >= 5) where id = r.id;
    return json_build_object('ok', false, 'reason', 'code', 'left', 4 - r.attempts);
  end if;
  update public.login_codes set used = true where id = r.id;
  return json_build_object('ok', true, 'cards', coalesce((
    select json_agg(json_build_object('name', c.name, 'stamps', c.stamps, 'token', c.token) order by c.created_at desc)
    from public.cards c where public.booksy_phone9(c.phone) = ph), '[]'::json));
end $$;

revoke all on function public.login_sms_request(text, text, text), public.login_sms_verify(text, text),
  public.login_code_hash(text, text) from public, anon, authenticated;
grant execute on function public.login_sms_request(text, text, text), public.login_sms_verify(text, text) to service_role;
