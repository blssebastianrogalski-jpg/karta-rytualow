-- Poprawka: teksty powiadomień w liczbie pojedynczej (studio prowadzi jedna osoba).
-- Przechodzi po funkcjach w bazie (przypomnienia o opinii, urodziny, wolne terminy itd.)
-- i zamienia formy "nam / nas / dziękujemy..." na "mi / mnie / dziękuję...".
-- Na końcu pokazuje listę funkcji, w których coś zostało zmienione.

do $$
declare
  f record;
  d text;
  nowy text;
  zamiany text[][] := array[
    ['będzie nam bardzo miło', 'będzie mi bardzo miło'],
    ['Będzie nam bardzo miło', 'Będzie mi bardzo miło'],
    ['będzie nam miło', 'będzie mi miło'],
    ['Będzie nam miło', 'Będzie mi miło'],
    ['dla nas', 'dla mnie'],
    ['Dla nas', 'Dla mnie'],
    ['u nas', 'u mnie'],
    ['U nas', 'U mnie'],
    ['do nas', 'do mnie'],
    ['Do nas', 'Do mnie'],
    ['Dziękujemy', 'Dziękuję'],
    ['dziękujemy', 'dziękuję'],
    ['Zapraszamy', 'Zapraszam'],
    ['zapraszamy', 'zapraszam'],
    ['Czekamy', 'Czekam'],
    ['czekamy na', 'czekam na'],
    ['Cieszymy się', 'Cieszę się'],
    ['cieszymy się', 'cieszę się'],
    ['Życzymy', 'Życzę'],
    ['życzymy', 'życzę'],
    ['Przypominamy', 'Przypominam'],
    ['przypominamy', 'przypominam'],
    ['Pozdrawiamy', 'Pozdrawiam'],
    ['Twoja opinia pomaga nam', 'Twoja opinia pomaga mi'],
    ['pomoże nam', 'pomoże mi'],
    ['naszego studia', 'mojego studia'],
    ['naszym studiu', 'moim studiu'],
    ['nasze studio', 'moje studio'],
    ['Nasze studio', 'Moje studio']
  ];
  i int;
begin
  create temp table if not exists _zmienione(funkcja text) on commit drop;
  for f in
    select p.oid, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    d := pg_get_functiondef(f.oid);
    nowy := d;
    for i in 1 .. array_length(zamiany, 1) loop
      nowy := replace(nowy, zamiany[i][1], zamiany[i][2]);
    end loop;
    if nowy <> d then
      execute nowy;
      insert into _zmienione values (f.proname);
    end if;
  end loop;
  raise notice 'Poprawione funkcje: %', (select string_agg(funkcja, ', ') from _zmienione);
end $$;

-- Kontrola: czy gdzieś w funkcjach zostało jeszcze "nam", "nas" albo "nasz..."
select p.proname as funkcja
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'
  and pg_get_functiondef(p.oid) ~ '\m(nam|nas|nasz\w*|dziękujemy|zapraszamy)\M';
