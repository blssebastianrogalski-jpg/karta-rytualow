-- Pomiar instalacji karty (listopad i grudzień 2026): ile klientek widzi instrukcję,
-- ile dochodzi do ikony na ekranie, na jakich telefonach i dlaczego część nie dodaje karty.
-- Zapisuję tylko typ telefonu (android / iphone / inny), bez modelu, lokalizacji i innych danych.
-- Wklej całość w Supabase → SQL Editor → Run. Można uruchomić kilka razy.

-- 1. typ telefonu przy karcie otwieranej z ikony
alter table public.cards add column if not exists app_platform text;

-- 2. wpisy z ekranu instrukcji (przeglądarka, przed dodaniem karty do ekranu)
create table if not exists public.install_events (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  device     text not null,                 -- losowy znacznik przeglądarki, żeby liczyć osoby, a nie odświeżenia
  card_id    uuid references public.cards(id) on delete set null,
  platform   text not null check (platform in ('android', 'iphone', 'inny')),
  in_app     boolean not null default false, -- link otwarty w Messengerze, Facebooku albo Instagramie
  event      text not null check (event in ('view', 'prompt', 'accepted', 'dismissed')),
  words      text not null default 'stara' check (words in ('stara', 'nowa'))
);
create index if not exists install_events_created_idx on public.install_events (created_at);
alter table public.install_events enable row level security; -- dostęp tylko przez funkcje niżej

-- 3. odpowiedź klientki „Dlaczego nie masz karty w telefonie?” (zaznacza studio przy wizycie)
create table if not exists public.install_reasons (
  card_id    uuid primary key references public.cards(id) on delete cascade,
  reason     text not null check (reason in ('nie_wiedziala', 'spoza_sklepu', 'nie_potrzebuje', 'inne')),
  note       text check (char_length(note) <= 200),
  updated_at timestamptz not null default now()
);
alter table public.install_reasons enable row level security;

-- karta otwarta z ikony: zapisuje, że klientka ma aplikację, i typ telefonu
drop function if exists public.mark_app_open(text);
create or replace function public.mark_app_open(p_token text, p_platform text default null)
returns void language sql security definer set search_path = public as $$
  update public.cards
     set app_opened_at = coalesce(app_opened_at, now()), app_seen_at = now(),
         app_platform  = case when p_platform in ('android', 'iphone', 'inny') then p_platform else app_platform end
   where token = p_token;
$$;
grant execute on function public.mark_app_open(text, text) to anon, authenticated;

-- ekran instrukcji: jeden wpis na zdarzenie (to samo zdarzenie z tej samej przeglądarki liczy się raz na 6 godzin)
create or replace function public.log_install_event(p_device text, p_platform text, p_in_app boolean, p_event text, p_words text default 'stara', p_token text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_card uuid;
begin
  if p_device is null or char_length(p_device) not between 8 and 64 then return; end if;
  if p_platform not in ('android', 'iphone', 'inny') or p_event not in ('view', 'prompt', 'accepted', 'dismissed') then return; end if;
  if exists (select 1 from public.install_events
              where device = p_device and event = p_event and created_at > now() - interval '6 hours') then return; end if;
  if p_token is not null then select id into v_card from public.cards where token = p_token; end if;
  insert into public.install_events (device, card_id, platform, in_app, event, words)
  values (p_device, v_card, p_platform, coalesce(p_in_app, false), p_event, case when p_words = 'nowa' then 'nowa' else 'stara' end);
end $$;
grant execute on function public.log_install_event(text, text, boolean, text, text, text) to anon, authenticated;

-- panel: lista kart z aplikacją (teraz także z typem telefonu)
create or replace function public.cards_app_status()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_check();
  return coalesce((
    select json_object_agg(id, json_build_object('first', app_opened_at, 'last', app_seen_at, 'platform', app_platform))
      from public.cards where app_opened_at is not null
  ), '{}'::json);
end $$;
grant execute on function public.cards_app_status() to authenticated;

-- panel: zapis odpowiedzi „Dlaczego nie masz karty w telefonie?” (pusty powód = usuń odpowiedź)
create or replace function public.install_reason_set(p_card uuid, p_reason text, p_note text default null)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  if p_reason is null or p_reason = '' then
    delete from public.install_reasons where card_id = p_card;
    return null;
  end if;
  insert into public.install_reasons (card_id, reason, note, updated_at)
  values (p_card, p_reason, nullif(left(trim(coalesce(p_note, '')), 200), ''), now())
  on conflict (card_id) do update set reason = excluded.reason, note = excluded.note, updated_at = now();
  return (select json_build_object('reason', reason, 'note', note, 'at', updated_at) from public.install_reasons where card_id = p_card);
end $$;
grant execute on function public.install_reason_set(uuid, text, text) to authenticated;

-- panel: podsumowanie pomiaru (od p_from, domyślnie od startu pomiaru)
create or replace function public.install_stats(p_from timestamptz default null)
returns json language plpgsql stable security definer set search_path = public as $$
declare v_from timestamptz;
begin
  perform public.staff_check();
  v_from := coalesce(p_from, (select min(created_at) from public.install_events), now());
  return json_build_object(
    'from', v_from,
    -- lejek z ekranu instrukcji: liczba różnych przeglądarek na każdym kroku
    'funnel', coalesce((
      select json_agg(r) from (
        select platform, words,
               count(distinct device) filter (where event = 'view')                as viewed,
               count(distinct device) filter (where event = 'view' and in_app)     as in_app,
               count(distinct device) filter (where event = 'prompt')              as prompt,
               count(distinct device) filter (where event = 'accepted')            as accepted,
               count(distinct device) filter (where event = 'dismissed')           as dismissed
          from public.install_events where created_at >= v_from
         group by platform, words
      ) r), '[]'::json),
    -- karty: z aplikacją (wg telefonu) i bez aplikacji
    'cards', (select json_build_object(
        'total',    count(*),
        'app',      count(*) filter (where app_opened_at is not null),
        'android',  count(*) filter (where app_platform = 'android'),
        'iphone',   count(*) filter (where app_platform = 'iphone'),
        'other',    count(*) filter (where app_platform = 'inny'),
        'unknown',  count(*) filter (where app_opened_at is not null and app_platform is null),
        'new_app',  count(*) filter (where app_opened_at >= v_from),
        'new_android', count(*) filter (where app_opened_at >= v_from and app_platform = 'android'),
        'new_iphone',  count(*) filter (where app_opened_at >= v_from and app_platform = 'iphone')
      ) from public.cards),
    -- klientki bez aplikacji, które otworzyły link w przeglądarce (wg telefonu)
    'no_app_seen', coalesce((
      select json_object_agg(platform, n) from (
        select e.platform, count(distinct e.card_id) as n
          from public.install_events e join public.cards c on c.id = e.card_id
         where e.created_at >= v_from and c.app_opened_at is null
         group by e.platform) x), '{}'::json),
    -- odpowiedzi „Dlaczego nie masz karty w telefonie?”
    'reasons', coalesce((select json_object_agg(reason, n) from (
        select reason, count(*) as n from public.install_reasons group by reason) x), '{}'::json),
    'notes', coalesce((select json_agg(json_build_object('name', c.name, 'reason', r.reason, 'note', r.note, 'at', r.updated_at) order by r.updated_at desc)
        from public.install_reasons r join public.cards c on c.id = r.card_id), '[]'::json),
    'reason_map', coalesce((select json_object_agg(card_id, json_build_object('reason', reason, 'note', note, 'at', updated_at))
        from public.install_reasons), '{}'::json)
  );
end $$;
grant execute on function public.install_stats(timestamptz) to authenticated;
