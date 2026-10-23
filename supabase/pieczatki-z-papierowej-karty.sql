-- Pieczątki przeniesione z papierowej karty dla karty, która już istnieje (np. z importu z Booksy).
-- Działa tylko przed pierwszą wizytą zapisaną w aplikacji, potem pieczątki liczą się z wizyt.
create or replace function public.transfer_paper_stamps(p_id uuid, p_stamps int)
returns json language plpgsql security definer set search_path = public as $$
declare c public.cards;
begin
  perform public.staff_check();
  select * into c from public.cards where id = p_id for update;
  if not found then raise exception 'Nie znaleziono karty.'; end if;
  if c.cards_completed > 0 or exists (select 1 from public.visits where card_id = p_id) then
    raise exception 'Pieczątki z papierowej karty można przenieść tylko przed pierwszą wizytą zapisaną w aplikacji.';
  end if;
  update public.cards set stamps = greatest(0, least(9, coalesce(p_stamps, 0))) where id = p_id returning * into c;
  return public.card_json(c, true);
end $$;

revoke all on function public.transfer_paper_stamps(uuid, int) from public, anon;
grant execute on function public.transfer_paper_stamps(uuid, int) to authenticated;
