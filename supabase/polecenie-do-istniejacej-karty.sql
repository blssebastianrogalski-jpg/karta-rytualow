-- Program poleceń: polecenie do karty, która już istnieje.
-- Powód: koleżanka często najpierw rezerwuje w Booksy. Wtedy karta zakłada się sama z rezerwacji
-- i link polecający (…/?p=KOD) nie miał już do czego się podpiąć, więc polecenie przepadało.
-- 1) Panel: przy karcie przycisk „Przypisz polecenie” (właścicielka wybiera polecającą).
-- 2) Aplikacja: gdy klientka otworzy link polecający, a potem wejdzie na swoją kartę
--    (link ze studia albo kod SMS), polecenie dopisze się samo, jeśli nie miała jeszcze wizyty.
-- Reguły bez zmian: tylko nowa klientka (bez historii z Booksy, karta po starcie programu),
-- −10% na pierwszy pojedynczy rytuał, +1 pieczątka dla polecającej po pierwszej wizycie.
-- Wklej całość w Supabase → SQL Editor → Run. Można uruchomić kilka razy, nie kasuje danych.

create or replace function public.attach_referral(p_card uuid, p_ref uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c public.cards; n int;
begin
  select * into c from public.cards where id = p_card for update;
  if not found then raise exception 'Nie znaleziono karty.'; end if;
  if p_ref is null or p_ref = p_card or not exists (select 1 from public.cards where id = p_ref) then
    raise exception 'Wybierz inną klientkę jako polecającą.';
  end if;
  if c.referred_by is not null then raise exception 'Ta karta ma już zapisane polecenie.'; end if;
  if exists (select 1 from public.cards where id = p_ref and referred_by = p_card) then
    raise exception 'Ta klientka sama poleciła wybraną osobę. Polecenie nie działa w obie strony.';
  end if;
  if c.created_at < timestamptz '2026-10-26' or c.cards_completed > 0
     or exists (select 1 from public.visits where card_id = p_card and kind = 'booksy') then
    raise exception 'To stała klientka (była w studiu przed programem poleceń). Polecenie jest dla nowych klientek.';
  end if;
  select count(*) into n from public.visits where card_id = p_card and kind in ('stamp', 'package_buy', 'package_visit', 'birthday');
  if n = 0 then
    update public.cards set referred_by = p_ref, ref_welcome = true where id = p_card;
    return 'welcome';
  end if;
  if n > 1 then raise exception 'Ta klientka ma już kilka wizyt w aplikacji. Polecenie liczy się tylko przed pierwszą wizytą albo zaraz po niej.'; end if;
  -- pierwsza wizyta już była: pieczątka dla polecającej od razu (rabat −10% przepadł, wizyta jest opłacona)
  update public.cards set referred_by = p_ref, ref_welcome = false, ref_rewarded_at = now() where id = p_card;
  update public.cards set bonus_stamps = bonus_stamps + 1 where id = p_ref;
  perform public.apply_bonus_stamps(p_ref);
  return 'rewarded';
end $$;

-- panel: właścicielka przypisuje polecenie
create or replace function public.staff_set_referral(p_card uuid, p_ref uuid) returns json
language plpgsql security definer set search_path = public as $$
declare res text; r public.cards;
begin
  perform public.staff_check();
  res := public.attach_referral(p_card, p_ref);
  select * into r from public.cards where id = p_ref;
  return json_build_object('result', res, 'referrer_id', r.id, 'referrer_name', r.name,
    'referrer_stamps', r.stamps, 'referrer_bonus', r.bonus_stamps);
end $$;

-- aplikacja: kod z linku polecającego, karta już istnieje (tylko przed pierwszą wizytą)
create or replace function public.claim_referral(p_token text, p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare c public.cards; r public.cards;
begin
  select * into c from public.cards where token = p_token;
  if not found or c.referred_by is not null then return null; end if;
  select * into r from public.cards where code = upper(trim(coalesce(p_code, '')));
  if not found or r.id = c.id then return null; end if;
  if exists (select 1 from public.visits where card_id = c.id and kind in ('stamp', 'package_buy', 'package_visit', 'birthday')) then return null; end if;
  begin
    return public.attach_referral(c.id, r.id);
  exception when others then return null;
  end;
end $$;

revoke all on function public.attach_referral(uuid, uuid) from public, anon, authenticated;
revoke all on function public.staff_set_referral(uuid, uuid), public.claim_referral(text, text) from public;
grant execute on function public.staff_set_referral(uuid, uuid) to authenticated;
grant execute on function public.claim_referral(text, text) to anon, authenticated;
