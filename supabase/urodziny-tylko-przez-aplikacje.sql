-- Przypomnienie urodzinowe (14 dni przed): jasna informacja, że rabat −20% obejmuje tylko
-- wizytę umówioną w aplikacji, a rezerwacja przez Booksy go nie obejmuje.
-- Zmienia tylko tekst. Harmonogram (cron birthday-reminders) i komu idzie wiadomość zostają bez zmian.
-- Życzenia w dniu urodzin (birthday_wish_text) nie wspominają o rabacie, więc ich nie zmieniam.
create or replace function public.birthday_reminder_text(out title text, out body text, out sms text)
language sql immutable as $$
  select
    'Za 2 tygodnie Twoje urodziny 🎂',
    'W dniu urodzin czeka na Ciebie rytuał −20%. Umów termin już teraz w aplikacji: rabat obejmuje tylko wizytę umówioną tutaj, rezerwacja przez Booksy go nie obejmuje. Nie ma wolnego terminu w dniu urodzin? Daj mi od razu znać (500 694 094), a ustalę z Tobą inną datę.',
    'Za 2 tygodnie Twoje urodziny! Rytual -20% tylko przy wizycie umowionej w aplikacji, nie w Booksy. Brak terminu w urodziny? Zadzwon: 500694094. Justyna'
$$;

-- Sprawdzenie: pokaże nowy tekst (nic nie wysyła)
select * from public.birthday_reminder_text();
