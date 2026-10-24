-- Najbliższe wizyty na karcie klientki (z planu dnia: rezerwacje z Booksy i wpisy ze studia).
-- Uruchom raz w Supabase → SQL Editor. Można uruchomić ponownie.

create or replace function public.get_my_card(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  select * into c from public.cards where token = p_token;
  if not found then return null; end if;
  return (public.card_json(c, true)::jsonb || jsonb_build_object('upcoming', coalesce((
    select jsonb_agg(jsonb_build_object('day', p.day, 'start_at', p.start_at, 'service', p.service) order by p.day, p.start_at nulls last)
    from (
      select day, start_at, service from public.day_plan
      where card_id = c.id and status = 'planned' and day >= public.today_pl()
        and (start_at is null or start_at > now() - interval '1 hour')
      order by day, start_at nulls last limit 3
    ) p), '[]'::jsonb)))::json;
end $$;

grant execute on function public.get_my_card(text) to anon, authenticated;
