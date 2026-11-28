-- Strażnik integracji Booksy: gdy skrypt Google (konto studia) nie łączy się dłużej niż godzinę,
-- właścicielka dostaje push w panelu (7:00–21:00, najwyżej co 12 godzin, dopóki przerwa trwa).
-- Bezpieczne przy ponownym uruchomieniu.
alter table public.booksy_settings add column if not exists watchdog_push_at timestamptz;

create or replace function public.booksy_watchdog()
returns void language plpgsql security definer set search_path = public as $$
declare s public.booksy_settings; h int := extract(hour from now() at time zone 'Europe/Warsaw');
begin
  select * into s from public.booksy_settings where id = 1;
  if s is null or s.key_hash is null or s.script_last_seen is null then return; end if;
  if s.script_last_seen > now() - interval '1 hour' then return; end if;
  if h < 7 or h >= 21 then return; end if;
  if s.watchdog_push_at is not null and s.watchdog_push_at > s.script_last_seen
     and s.watchdog_push_at > now() - interval '12 hours' then return; end if;
  perform public.gap_owner_push('Booksy nie dopisuje rezerwacji',
    'Skrypt Google nie łączy się od ' || to_char(s.script_last_seen at time zone 'Europe/Warsaw', 'DD.MM HH24:MI')
    || '. Sprawdź na koncie jrtwojecialo@gmail.com, czy projekt skryptu nie jest w koszu.', 'panel.html');
  update public.booksy_settings set watchdog_push_at = now() where id = 1;
exception when others then
  null; -- strażnik nigdy nie psuje innych zadań
end $$;
revoke execute on function public.booksy_watchdog() from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname = 'booksy-watchdog';
select cron.schedule('booksy-watchdog', '*/15 * * * *', $$select public.booksy_watchdog()$$);
-- Wyłączenie w razie potrzeby:  select cron.unschedule('booksy-watchdog');
