// Testy rozpoznawania maili Booksy: node google/booksy-parser.test.js
// Próbki mają dokładny układ prawdziwych maili Booksy (październik 2026); dane klientek są zmyślone.
const fs = require('fs');
const path = require('path');
const Module = module.constructor;
const m = new Module();
m._compile(fs.readFileSync(path.join(__dirname, 'booksy-sync.gs'), 'utf8'), 'booksy-sync.gs');
const { rozpoznajMail } = m.exports;

const STOPKA = `
Informacja od usługodawcy:
Jak przygotować się przed masażem? 1. Zdejmij biżuterię, 2. Ubierz się wygodnie. Odwołanie wizyty
najpóźniej 24 h wcześniej.

* Rozwijaj biznes razem z Booksy *
[image: Booksy dla iOS]
<https://mandrillapp.com/track/click/30558554/itunes.apple.com?p=eyJzIjoi>

Masz pytania? Napisz do nas na czacie.
Nasz czat pracuje od poniedziałku do piątku w godzinach 9:00-19:00.
. Booksy International Sp. z o. o. z siedzibą w Warszawie, ul. Prosta 67,
piętro 28, 00-838 Warszawa, wpisana do rejestru pod nr KRS
0000515914, NIP 951-238-16-07, REGON 147315920.`;

const NOWA_TXT = `[image: Booksy]
<https://mandrillapp.com/track/click/30558554/booksy.com?p=eyJzIjoiOEgz>

* Anna Testowa: nowa rezerwacja *

Anna Testowa
600 100 200
anna.testowa@example.com
* poniedziałek, 26 października 2026, 17:30 - 19:00 *
CIAŁO I RELAKS: Masaż relaksacyjno-aromaterapeutyczny na ciepło
230,00 zł, 17:30 - 19:00
pracownik: Justyna Rogalska
` + STOPKA;

const NOWA_HTML = `<div bgcolor="#f9f9f9"><center><table><tbody><tr><td>
<span style="color:#5e5e5e"><b>
 Anna Testowa: nowa rezerwacja
</b></span><br><br>
<div style="line-height:18px"><div style="background-color:#f4f4f4;padding:15px">
<div style="font-size:16px;color:#666">
 Anna Testowa
</div>
<div style="font-size:12px;color:#999">
 600 100 200
</div>
<div><a href="mailto:anna.testowa@example.com">
 anna.testowa@example.com
</a></div></div>
<div style="padding:15px 0 10px 0"><b>
 poniedziałek, 26 października 2026, 17:30 - 19:00
</b></div>
<table><tbody><tr><td><img src="x.jpeg"></td><td>
<div>
 CIAŁO I RELAKS: Masaż relaksacyjno-aromaterapeutyczny na ciepło
</div>
<div>
 230,00 zł,
 17:30 - 19:00
</div>
<div>
 pracownik:
 Justyna Rogalska
</div></td></tr></tbody></table>
<div>Informacja od usługodawcy:</div><div>Odwołanie wizyty najpóźniej 24 h wcześniej. Tel. 500 694 094</div>
</div></td></tr></tbody></table></center></div>`;

const ZMIANA_TXT = `[image: Booksy]

* Ewa Próbna * przesunął swoją wizytę ✨ Kobido UP® Rytuał Naturalnego
Blasku ⭐ z dnia * poniedziałek, 19 października 2026 * * 14:30 * na inny
termin.

* Nowy termin wizyty: *

Ewa Próbna
601 300 400
ewa@example.com
* wtorek, 27 października 2026, 15:00 - 16:30 *
TWARZ I NATURALNY LIFTING: ✨ Kobido UP® Rytuał Naturalnego Blasku ⭐
200,00 zł, 15:00 - 16:30
pracownik: Justyna Rogalska
` + STOPKA;

const ZMIANA2_TXT = `* Maria Wzorcowa * przesunął swoją wizytę 💆 Masaż Relaksacyjny – Rytuał
Głębokiego Ukojenia z dnia * piątek, 23 października 2026 * * 18:00 * na
inny termin.

* Nowy termin wizyty: *

Maria Wzorcowa
+48 602 500 600
maria@example.com
* piątek, 30 października 2026, 10:00 - 11:00 *
CIAŁO I RELAKS: 💆 Masaż Relaksacyjny – Rytuał Głębokiego Ukojenia
150,00 zł, 10:00 - 11:00
pracownik: Justyna Rogalska
` + STOPKA;

const ODWOLANIE_TXT = `[image: Booksy]

Klient * Iza Przykładowa * odwołał swoją usługę * ✨ Kobido UP® Rytuał
Naturalnego Blasku ⭐ * w dniu * wtorek, 27 października 2026 * o godzinie *
17:30 * .

Dzięki Booksy wiesz, że ten klient nie przyjdzie na pewno na umówioną
wizytę i możesz w tym czasie obsłużyć innego klienta.

Iza Przykładowa
603 700 800
iza@example.com
* wtorek, 27 października 2026, 17:30 - 19:00 *
TWARZ I NATURALNY LIFTING: ✨ Kobido UP® Rytuał Naturalnego Blasku ⭐
200,00 zł, 17:30 - 19:00
pracownik: Justyna Rogalska
` + STOPKA;

const rcv = new Date('2026-10-14T11:45:00Z');
const cases = [
  ['nowa rezerwacja (tekst)', 'Anna Testowa: nowa rezerwacja poniedziałek, 26 października 2026 17:30', NOWA_TXT, '',
    { kind: 'new', client_name: 'Anna Testowa', client_phone: '600100200', service: 'Masaż relaksacyjno-aromaterapeutyczny na ciepło', start_local: '2026-10-26T17:30', end_local: '2026-10-26T19:00', old_start_local: null }],
  ['nowa rezerwacja (HTML, jak w Gmailu)', 'Anna Testowa: nowa rezerwacja poniedziałek, 26 października 2026 17:30', '', NOWA_HTML,
    { kind: 'new', client_name: 'Anna Testowa', client_phone: '600100200', service: 'Masaż relaksacyjno-aromaterapeutyczny na ciepło', start_local: '2026-10-26T17:30', end_local: '2026-10-26T19:00' }],
  ['zmiana terminu (Kobido)', 'Ewa Próbna: zmienił rezerwację', ZMIANA_TXT, '',
    { kind: 'change', client_name: 'Ewa Próbna', client_phone: '601300400', service: 'Kobido UP® Rytuał Naturalnego Blasku', start_local: '2026-10-27T15:00', end_local: '2026-10-27T16:30', old_start_local: '2026-10-19T14:30' }],
  ['zmiana terminu (masaż, +48)', 'Maria Wzorcowa: zmienił rezerwację', ZMIANA2_TXT, '',
    { kind: 'change', client_name: 'Maria Wzorcowa', client_phone: '602500600', service: 'Masaż Relaksacyjny – Rytuał Głębokiego Ukojenia', start_local: '2026-10-30T10:00', end_local: '2026-10-30T11:00', old_start_local: '2026-10-23T18:00' }],
  ['odwołanie', 'Iza Przykładowa: odwołał wizytę z dnia wtorek, 27 października 2026 17:30', ODWOLANIE_TXT, '',
    { kind: 'cancel', client_name: 'Iza Przykładowa', client_phone: '603700800', service: 'Kobido UP® Rytuał Naturalnego Blasku', start_local: '2026-10-27T17:30', end_local: '2026-10-27T19:00' }],
  ['nowa rezerwacja z „odwołaniem” w opisie usługi zostaje nową', 'Anna Testowa: nowa rezerwacja poniedziałek, 26 października 2026 17:30', NOWA_TXT.replace('Informacja od usługodawcy:', 'Informacja od usługodawcy: odwołał? odwołanie wizyty'), '',
    { kind: 'new' }],
  ['przekazany dalej (Fwd:)', 'Fwd: Iza Przykładowa: odwołał wizytę z dnia wtorek, 27 października 2026 17:30', ODWOLANIE_TXT, '',
    { kind: 'cancel', client_name: 'Iza Przykładowa' }],
  ['kategoria pisana zwykłymi literami', 'Anna Testowa: nowa rezerwacja poniedziałek, 9 listopada 2026 17:10', NOWA_TXT.replace('CIAŁO I RELAKS: Masaż relaksacyjno-aromaterapeutyczny na ciepło', 'Vouchery i Pakiety: Pakiety Kobido UP®').replace(/26 października 2026, 17:30 - 19:00/, '9 listopada 2026, 17:10 - 18:40'), '',
    { kind: 'new', service: 'Pakiety Kobido UP®', start_local: '2026-11-09T17:10' }],
  ['inny mail Booksy', 'Podsumowanie tygodnia w Booksy', 'Zobacz, jak minął Twój tydzień.', '', { kind: 'unknown', start_local: null }]
];

let ok = 0;
cases.forEach(([name, subject, body, html, exp]) => {
  const got = rozpoznajMail(subject, body, html, rcv);
  const bad = Object.keys(exp).filter((k) => got[k] !== exp[k]);
  if (bad.length) console.log('BŁĄD ' + name + ': ' + bad.map((k) => k + '=' + JSON.stringify(got[k]) + ' (oczekiwane ' + JSON.stringify(exp[k]) + ')').join(', '));
  else { ok++; console.log('OK   ' + name); }
});
console.log('RAZEM: ' + ok + ' / ' + cases.length);
process.exitCode = ok === cases.length ? 0 : 1;
