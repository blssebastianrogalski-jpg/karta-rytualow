-- Promocje: zakładka „Promocje” w aplikacji klientki (zamiast „Mój kod”) i dodawanie promocji w panelu.
-- Po dacie „ważna do” promocja sama znika z aplikacji. Nowa promocja może wysłać powiadomienie
-- do klientek, które mają włączone powiadomienia i zgodę na oferty (sms_ok).
-- Uruchom w Supabase → SQL Editor (raz). Nie kasuje żadnych danych klientek.
-- Wymaga: pg_net i sekretu push_secret w Vault (już są).

create table if not exists public.promotions (
  id          bigint generated always as identity primary key,
  title       text not null check (char_length(title) between 2 and 80),
  body        text check (body is null or char_length(body) <= 600),
  valid_until date,                                  -- ostatni dzień promocji (puste = bez końca)
  pushed      int,                                   -- ile klientek dostało powiadomienie (null = bez powiadomienia)
  created_at  timestamptz not null default now()
);
create index if not exists promotions_until_idx on public.promotions(valid_until);

alter table public.promotions enable row level security;
drop policy if exists staff_promotions on public.promotions;
create policy staff_promotions on public.promotions for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- Klientka (także bez logowania): aktualne promocje, najnowsze na górze.
create or replace function public.promotions_active()
returns json language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('id', id, 'title', title, 'body', body, 'valid_until', valid_until)
                  order by created_at desc), '[]'::json)
    from public.promotions
   where valid_until is null or valid_until >= public.today_pl();
$$;
grant execute on function public.promotions_active() to anon, authenticated;

-- Studio: wszystkie promocje (aktualne i ostatnie zakończone).
create or replace function public.promotions_list()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  perform public.staff_check();
  return (select coalesce(json_agg(row_to_json(p) order by p.created_at desc), '[]'::json)
            from (select id, title, body, valid_until, pushed, created_at,
                         (valid_until is not null and valid_until < public.today_pl()) as ended
                    from public.promotions order by created_at desc limit 30) p);
end $$;
grant execute on function public.promotions_list() to authenticated;

-- Studio: nowa promocja. p_notify = powiadomienie do klientek ze zgodą na oferty.
create or replace function public.promotion_add(p_title text, p_body text, p_until date, p_notify boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare pr public.promotions; secret text; c record; n int := 0;
begin
  perform public.staff_check();
  if char_length(trim(coalesce(p_title, ''))) < 2 then raise exception 'Wpisz nazwę promocji.'; end if;
  if p_until is not null and p_until < public.today_pl() then raise exception 'Data „ważna do” już minęła.'; end if;
  insert into public.promotions (title, body, valid_until)
    values (trim(p_title), nullif(trim(coalesce(p_body, '')), ''), p_until)
    returning * into pr;

  if p_notify then
    select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_secret';
    if secret is not null then
      for c in select distinct s.card_id from public.push_subscriptions s
                 join public.cards k on k.id = s.card_id where k.sms_ok loop
        begin
          perform net.http_post(
            url := 'https://pqvndgttgzaosjqjtxbg.supabase.co/functions/v1/send-push',
            body := jsonb_build_object('card_id', c.card_id, 'title', 'Nowa promocja: ' || pr.title,
              'body', coalesce(left(pr.body, 140), 'Zajrzyj do aplikacji.')
                      || case when pr.valid_until is not null then ' Ważna do ' || to_char(pr.valid_until, 'DD.MM') || '.' else '' end,
              'url', './#promo'),
            headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', secret));
          n := n + 1;
        exception when others then null; -- brak powiadomienia nie blokuje promocji
        end;
      end loop;
      update public.promotions set pushed = n where id = pr.id;
    end if;
  end if;
  return json_build_object('id', pr.id, 'pushed', case when p_notify then n end);
end $$;
grant execute on function public.promotion_add(text, text, date, boolean) to authenticated;

-- Studio: zakończenie promocji przed czasem (usuwa ją z aplikacji).
create or replace function public.promotion_remove(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.staff_check();
  delete from public.promotions where id = p_id;
end $$;
grant execute on function public.promotion_remove(bigint) to authenticated;
