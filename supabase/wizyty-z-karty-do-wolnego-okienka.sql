-- Wizyty z karty do Wolnego Okienka (trzeci kierunek mostu).
-- Skrypt Google co 5 minut pobiera tą funkcją wizyty zaplanowane w karcie
-- (potwierdzone prośby o termin, wolne okienka, wpisy ręczne z godziną)
-- i przekazuje je do Wolnego Okienka. Wizyty, które przyszły z Booksy albo
-- z Wolnego Okienka (mają booking_id), są pomijane, bo tam już są.
-- Lista jest pełna (od dziś do 120 dni), więc Wolne Okienko samo widzi
-- przełożenia (inna godzina) i odwołania (wizyty nie ma już na liście albo ma status skipped).
-- Wizyta odbyta (pieczątka itp.) zostaje na liście, więc nie jest odwoływana.
-- Uruchom w Supabase → SQL Editor (raz, można ponownie). Nie zmienia ani nie kasuje żadnych danych.

create or replace function public.wo_script_karta_visits(p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.booksy_auth(p_key);
  return jsonb_build_object(
    'generated_at', now(),
    'from_day', public.today_pl(),
    'to_day', public.today_pl() + 120,
    'visits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'plan_id', p.id,
        'start', p.start_at,
        'minutes', coalesce(public.svc_minutes(p.service), 90),
        'service', p.service,
        'name', coalesce(nullif(trim(p.guest_name), ''), c.name),
        'phone', coalesce(
          (select nullif(trim(r.phone), '') from public.booking_requests r
            where r.plan_id = p.id and r.status = 'confirmed' order by r.id desc limit 1),
          c.phone),
        'status', p.status,
        'created_at', p.created_at) order by p.start_at)
      from public.day_plan p
      left join public.cards c on c.id = p.card_id
      where p.booking_id is null
        and p.start_at is not null
        and p.day between public.today_pl() and public.today_pl() + 120), '[]'::jsonb));
end $$;

revoke all on function public.wo_script_karta_visits(text) from public;
grant execute on function public.wo_script_karta_visits(text) to anon, authenticated;
