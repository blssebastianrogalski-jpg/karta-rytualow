-- Kto ma kartę w aplikacji (otwartą z ikony na ekranie telefonu).
-- Wklej całość w Supabase → SQL Editor → Run. Można uruchomić kilka razy.

alter table public.cards add column if not exists app_opened_at timestamptz; -- pierwsze otwarcie z ikony
alter table public.cards add column if not exists app_seen_at   timestamptz; -- ostatnie otwarcie z ikony

-- karta otwarta z ikony zapisuje, że klientka ma aplikację
create or replace function public.mark_app_open(p_token text)
returns void language sql security definer set search_path = public as $$
  update public.cards
     set app_opened_at = coalesce(app_opened_at, now()), app_seen_at = now()
   where token = p_token;
$$;
grant execute on function public.mark_app_open(text) to anon, authenticated;

-- panel: lista kart, które mają aplikację
create or replace function public.cards_app_status()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((
    select json_object_agg(id, json_build_object('first', app_opened_at, 'last', app_seen_at))
      from public.cards where app_opened_at is not null
  ), '{}'::json);
end $$;
grant execute on function public.cards_app_status() to authenticated;
