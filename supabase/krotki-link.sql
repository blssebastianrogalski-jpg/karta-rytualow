-- Krótki link do karty w SMS-ie: karta.twojecialotwojdobrostan.pl/?c=Ab3dE7hK zamiast długiego klucza.
-- Uruchom raz w Supabase → SQL Editor. Można uruchomić ponownie. Stare długie linki dalej działają.

create or replace function public.gen_link_code() returns text
language sql volatile set search_path = public, extensions as $$
  select string_agg(substr('23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', 1 + (get_byte(x.b, i) % 55), 1), '')
  from (select gen_random_bytes(8) as b) x, generate_series(0, 7) i
$$;

alter table public.cards add column if not exists link_code text unique;
update public.cards set link_code = public.gen_link_code() where link_code is null;
alter table public.cards alter column link_code set default public.gen_link_code();

-- nowy klucz karty (panel: „nowy link”) unieważnia też stary krótki link
create or replace function public.cards_new_link_code() returns trigger
language plpgsql as $$
begin
  if new.token is distinct from old.token then new.link_code := public.gen_link_code(); end if;
  return new;
end $$;
drop trigger if exists cards_new_link_code on public.cards;
create trigger cards_new_link_code before update of token on public.cards
  for each row execute function public.cards_new_link_code();

-- klientka otwiera krótki link: dostaje klucz swojej karty
create or replace function public.card_by_link(p_code text) returns text
language sql stable security definer set search_path = public as $$
  select token from public.cards where link_code = p_code and length(p_code) = 8
$$;

create or replace function public.card_json(c public.cards, with_token boolean default false) returns json
language sql stable as $$
  select json_build_object(
    'id', c.id, 'code', c.code, 'name', c.name, 'phone', c.phone, 'email', c.email,
    'bday_day', c.bday_day, 'bday_month', c.bday_month,
    'stamps', c.stamps, 'cards_completed', c.cards_completed,
    'birthday_used_year', c.birthday_used_year, 'source', c.source, 'note', c.note,
    'created_at', c.created_at,
    'token', case when with_token then c.token else null end,
    'link_code', case when with_token then c.link_code else null end,
    'bday_today', public.is_bday_today(c.bday_day, c.bday_month),
    'visits', coalesce((
      select json_agg(json_build_object('kind', v.kind, 'service', v.service, 'discount', v.discount, 'created_at', v.created_at) order by v.created_at desc)
      from (select * from public.visits where card_id = c.id order by created_at desc limit 12) v
    ), '[]'::json)
  );
$$;

revoke all on function public.gen_link_code(), public.card_json(public.cards, boolean) from public, anon, authenticated;
grant execute on function public.card_by_link(text) to anon, authenticated;
