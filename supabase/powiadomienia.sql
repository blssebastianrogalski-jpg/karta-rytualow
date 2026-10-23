-- Powiadomienia push dla klientek.
-- Uruchom w Supabase → SQL Editor (raz). Nie kasuje żadnych danych.

create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  card_id    uuid references public.cards(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
-- Brak polityk: klientka i panel nie czytają tej tabeli. Zapis idzie tylko przez funkcję poniżej.

create or replace function public.save_push_subscription(p_token text, p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  select id into cid from public.cards where token = p_token;
  if cid is null then raise exception 'Nie znaleziono karty.'; end if;
  insert into public.push_subscriptions (card_id, endpoint, p256dh, auth) values (cid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set card_id = excluded.card_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;
grant execute on function public.save_push_subscription(text, text, text, text) to anon, authenticated;
