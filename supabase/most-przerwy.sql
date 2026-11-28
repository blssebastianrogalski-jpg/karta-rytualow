-- Most Karta <-> Wolne Okienko: przerwa po wizycie (2026-11-28).
-- Skrócona przerwa ustawiona w panelu Karty trafia do Wolnego Okienka i odwrotnie.
-- Skrypt Google studia (co 5 minut) pobiera przerwy z obu stron i przekazuje je dalej.
-- Wizyty łączy godzina początku. Wygrywa nowsza zmiana (break_changed_at), więc nic się nie odbija.
-- Wymaga wcześniejszego skracanie-przerwy.sql. Uruchom w Supabase → SQL Editor (można ponownie).
-- Nie kasuje danych.

alter table public.day_plan add column if not exists break_changed_at timestamptz;

-- panel: przerwa po jednej wizycie (jak w skracanie-przerwy.sql) + czas zmiany dla mostu
create or replace function public.plan_set_break(p_plan_id bigint, p_min int)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  if p_min is not null and (p_min < 0 or p_min > 240) then raise exception 'Przerwa może mieć od 0 do 240 minut.'; end if;
  update public.day_plan set break_min = p_min, break_changed_at = now() where id = p_plan_id and status = 'planned';
  if not found then raise exception 'Nie ma tej wizyty w planie.'; end if;
end $$;
revoke all on function public.plan_set_break(bigint, int) from public, anon;
grant execute on function public.plan_set_break(bigint, int) to authenticated;

-- skrypt Google: przerwy ustawione w Karcie dla przyszłych wizyt (także powrót do zwykłej: break_min null)
create or replace function public.wo_script_breaks(p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.booksy_auth(p_key);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('start', p.start_at, 'break_min', p.break_min, 'changed_at', p.break_changed_at)
                     order by p.start_at)
      from public.day_plan p
     where p.status = 'planned' and p.start_at is not null and p.start_at > now()
       and p.break_changed_at is not null), '[]'::jsonb));
end $$;

-- skrypt Google: przerwy z Wolnego Okienka; wizyta o tej samej godzinie dostaje przerwę, jeśli zmiana jest nowsza
create or replace function public.wo_script_breaks_apply(p_key text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; st timestamptz; m int; at timestamptz; n int := 0; k int;
begin
  perform public.booksy_auth(p_key);
  if p_items is null or jsonb_typeof(p_items) <> 'array' then return jsonb_build_object('applied', 0); end if;
  for v in select x from jsonb_array_elements(p_items) x loop
    begin
      st := (v ->> 'start')::timestamptz; m := (v ->> 'break_min')::int; at := (v ->> 'changed_at')::timestamptz;
      if st is null or at is null or (m is not null and (m < 0 or m > 240)) then continue; end if;
      update public.day_plan set break_min = m, break_changed_at = at
       where status = 'planned' and start_at = st and (break_changed_at is null or break_changed_at < at);
      get diagnostics k = row_count;
      n := n + k;
    exception when others then null;
    end;
  end loop;
  return jsonb_build_object('applied', n);
end $$;

revoke all on function public.wo_script_breaks(text), public.wo_script_breaks_apply(text, jsonb) from public;
grant execute on function public.wo_script_breaks(text), public.wo_script_breaks_apply(text, jsonb) to anon, authenticated;
