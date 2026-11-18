-- Historia wizyt z Booksy na kartach klientek (jednorazowy import, 2026-11-18).
--
-- Co robi:
--  1) Dodaje nowy rodzaj wpisu w historii: 'booksy' = wizyta odbyta wcześniej, przeniesiona z Booksy.
--     Taki wpis to TYLKO historia: nie zmienia liczby pieczątek, nie daje pieczątki polecającej,
--     nie dopisuje czekających pieczątek, nie wysyła push, SMS ani prośby o opinię w Google
--     (prośby o opinię liczą tylko wizyty stamp/package_buy/package_visit/birthday).
--  2) Przeniesienie pieczątek z papierowej karty dalej działa, gdy klientka ma tylko historię z Booksy.
--  3) (osobny plik z danymi, poza repozytorium) Wpisuje wizyty o statusie „Zakończone” z Booksy z datą i godziną wykonania usługi.
--     Dopasowanie po numerze telefonu (ostatnie 9 cyfr). Pomija dzień, w którym karta ma już
--     wizytę zapisaną w aplikacji, wizyty z dzisiaj i z przyszłości oraz wpisy już zaimportowane.
--
-- Uruchom w Supabase → SQL Editor. Można uruchomić ponownie: niczego nie zdubluje.
-- Cofnięcie (gdyby było potrzebne): delete from public.visits where kind = 'booksy';

begin;

-- ---------- 1) Nowy rodzaj wpisu ----------
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
  check (kind in ('stamp', 'package_buy', 'package_visit', 'birthday', 'referral', 'gap', 'review', 'booksy'));

-- historia z Booksy nie jest nową wizytą: nie nagradza polecającej i nie dopisuje pieczątek
create or replace function public.visits_ref_reward() returns trigger
language plpgsql security definer set search_path = public as $$
declare ref uuid;
begin
  if new.kind in ('referral', 'review', 'booksy') then return new; end if;
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

-- ---------- 2) Papierowa karta: historia z Booksy nie blokuje przeniesienia ----------
create or replace function public.transfer_paper_stamps(p_id uuid, p_stamps int)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  perform public.staff_check();
  select * into c from public.cards where id = p_id for update;
  if not found then raise exception 'Nie znaleziono karty.'; end if;
  if c.cards_completed > 0 or exists (select 1 from public.visits where card_id = p_id and kind <> 'booksy') then
    raise exception 'Pieczątki z papierowej karty można przenieść tylko przed pierwszą wizytą zapisaną w aplikacji.';
  end if;
  update public.cards set stamps = greatest(0, least(9, coalesce(p_stamps, 0))) where id = p_id returning * into c;
  return public.card_json(c, true);
end $$;

revoke all on function public.transfer_paper_stamps(uuid, int) from public, anon;
grant execute on function public.transfer_paper_stamps(uuid, int) to authenticated;

commit;

-- ---------- 3) Wizyty z Booksy ----------
-- Lista wizyt zawiera dane klientek (telefony), dlatego nie ma jej w repozytorium.
-- Pełny plik do jednorazowego uruchomienia: import-wizyt-z-booksy.sql w plikach projektu.
