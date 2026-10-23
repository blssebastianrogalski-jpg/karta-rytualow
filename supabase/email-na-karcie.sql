-- E-mail na karcie (opcjonalny). Panel wstawia go przy sprzedaży vouchera,
-- żeby voucher PDF i e-paragon trafiły do właściwej osoby.
alter table public.cards add column if not exists email text check (email is null or char_length(email) <= 160);

create or replace function public.card_json(c public.cards, with_token boolean default false) returns json
language sql stable as $$
  select json_build_object(
    'id', c.id, 'code', c.code, 'name', c.name, 'phone', c.phone, 'email', c.email,
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

create or replace function public.list_cards(p_query text default '')
returns json language plpgsql security definer set search_path = public as $$
declare q text := lower(trim(coalesce(p_query, '')));
begin
  perform public.staff_check();
  return coalesce((
    select json_agg(x order by x.bday_today desc, x.name)
    from (
      select id, code, name, phone, email, stamps, source, bday_day, bday_month, birthday_used_year,
             public.is_bday_today(bday_day, bday_month) as bday_today
      from public.cards
      where q = '' or lower(name) like '%' || q || '%' or replace(coalesce(phone, ''), ' ', '') like '%' || replace(q, ' ', '') || '%'
         or lower(code) = q or lower(coalesce(email, '')) like '%' || q || '%'
      limit 200
    ) x
  ), '[]'::json);
end $$;

-- p_email null = bez zmian (stara wersja panelu), '' = usuń e-mail
drop function if exists public.update_card(uuid, text, text, int, int, text);
create or replace function public.update_card(p_id uuid, p_name text, p_phone text, p_day int, p_month int, p_note text, p_email text default null)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  perform public.staff_check();
  update public.cards set name = trim(p_name), phone = nullif(trim(coalesce(p_phone, '')), ''),
    bday_day = p_day, bday_month = p_month, note = nullif(trim(coalesce(p_note, '')), ''),
    email = case when p_email is null then email else nullif(lower(trim(p_email)), '') end
  where id = p_id returning * into c;
  return public.card_json(c, true);
end $$;

drop function if exists public.create_studio_card(text, text, int, int, int);
create or replace function public.create_studio_card(p_name text, p_phone text, p_day int, p_month int, p_stamps int default 0, p_email text default null)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  perform public.staff_check();
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Podaj imię i nazwisko.'; end if;
  insert into public.cards (code, name, phone, email, bday_day, bday_month, source, stamps)
  values (public.new_code(), trim(p_name), nullif(trim(coalesce(p_phone, '')), ''), nullif(lower(trim(coalesce(p_email, ''))), ''),
          p_day, p_month, 'studio', greatest(0, least(9, coalesce(p_stamps, 0))))
  returning * into c;
  return public.card_json(c, true);
end $$;

revoke all on function public.update_card(uuid, text, text, int, int, text, text), public.create_studio_card(text, text, int, int, int, text) from public, anon;
grant execute on function public.update_card(uuid, text, text, int, int, text, text), public.create_studio_card(text, text, int, int, int, text) to authenticated;
