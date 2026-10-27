-- Karta rytuałów w Portfelu Google: odświeżanie pieczątek.
-- Uruchom w Supabase → SQL Editor (raz). Nie kasuje żadnych danych.
-- Po każdej zmianie pieczątek (wizyta, cofnięcie, nowa karta, przeniesienie z papierowej, zmiana imienia)
-- baza woła funkcję portfel-google, a ta odświeża kartę w Portfelu. Dotyczy tylko kart,
-- które klientka dodała do Portfela (kolumna google_wallet_at).

create extension if not exists pg_net with schema extensions;

alter table public.cards add column if not exists google_wallet_at timestamptz;

create or replace function public.google_wallet_sync()
returns trigger language plpgsql security definer set search_path = public as $$
declare secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
  if secret is null then return new; end if;
  perform net.http_post(
    url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/portfel-google',
    body := jsonb_build_object('action', 'update', 'card_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret)
  );
  return new;
end $$;
revoke execute on function public.google_wallet_sync() from public, anon, authenticated;

drop trigger if exists cards_google_wallet on public.cards;
create trigger cards_google_wallet
  after update of stamps, cards_completed, name, code on public.cards
  for each row
  when (new.google_wallet_at is not null and (
    old.stamps is distinct from new.stamps or old.cards_completed is distinct from new.cards_completed
    or old.name is distinct from new.name or old.code is distinct from new.code))
  execute function public.google_wallet_sync();
