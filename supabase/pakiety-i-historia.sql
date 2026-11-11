-- Pakiety i historia rytuałów na karcie klientki (2026-11-11).
-- 1) visits.package_size: ile rytuałów ma pakiet (zapisane przy wizycie „Zakup pakietu”).
--    Pakiety sprzedane przez sklep mają liczbę w nazwie („5 wizyt”), więc tam pole może zostać puste.
-- 2) my_visits(token): cała historia wizyt dla karty klientki (zakładki „Moje rytuały” i „Pakiet”).
-- 3) card_visits(id): to samo dla panelu studia.
-- 4) set_package_size(id, n): panel ustawia liczbę rytuałów w ostatnim pakiecie klientki.
-- Skrypt można uruchomić kilka razy, niczego nie psuje.

alter table public.visits add column if not exists package_size smallint
  check (package_size is null or package_size between 1 and 50);

create or replace function public.visits_json(p_card uuid)
returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object(
           'id', v.id, 'kind', v.kind, 'service', v.service, 'discount', v.discount,
           'package_size', v.package_size, 'created_at', v.created_at) order by v.created_at desc), '[]'::json)
  from (select * from public.visits where card_id = p_card order by created_at desc limit 500) v;
$$;

create or replace function public.my_visits(p_token text)
returns json language plpgsql stable security definer set search_path = public as $$
declare cid uuid;
begin
  select id into cid from public.cards where token = p_token;
  if cid is null then return '[]'::json; end if;
  return public.visits_json(cid);
end $$;

create or replace function public.card_visits(p_id uuid)
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_check();
  return public.visits_json(p_id);
end $$;

create or replace function public.set_package_size(p_id uuid, p_size int)
returns json language plpgsql security definer set search_path = public as $$
declare vid bigint;
begin
  perform public.staff_check();
  if p_size is null or p_size < 1 or p_size > 50 then raise exception 'Podaj liczbę rytuałów od 1 do 50.'; end if;
  select id into vid from public.visits where card_id = p_id and kind = 'package_buy' order by created_at desc limit 1;
  if vid is null then raise exception 'Ta klientka nie ma zapisanego zakupu pakietu.'; end if;
  -- pakiet TRANSFORMACJA ze sklepu to dwa wiersze „Zakup pakietu” naraz: liczba trafia do obu
  update public.visits set package_size = p_size
   where card_id = p_id and kind = 'package_buy'
     and created_at between (select created_at from public.visits where id = vid) - interval '10 minutes'
                        and (select created_at from public.visits where id = vid);
  return public.visits_json(p_id);
end $$;

revoke all on function public.visits_json(uuid) from public, anon, authenticated;
revoke all on function public.my_visits(text), public.card_visits(uuid), public.set_package_size(uuid, int) from public;
grant execute on function public.my_visits(text) to anon, authenticated;
grant execute on function public.card_visits(uuid), public.set_package_size(uuid, int) to authenticated;
