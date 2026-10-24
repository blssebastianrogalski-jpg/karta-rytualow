// Testy rozpoznawania maili Booksy: node google/booksy-parser.test.js
// Próbki są przykładowe; po otrzymaniu prawdziwych maili trzeba dopisać ich wierne kopie (bez danych klientek).
const fs = require('fs');
const path = require('path');
const Module = module.constructor;
const m = new Module();
m._compile(fs.readFileSync(path.join(__dirname, 'booksy-sync.gs'), 'utf8'), 'booksy-sync.gs');
const { rozpoznajMail } = m.exports;

const rcv = new Date('2026-10-24T08:00:00Z');
const cases = [
  ['nowa (etykiety)', 'Nowa rezerwacja', `Masz nową rezerwację!\nKlient: Anna Kowalska\nTelefon: +48 601 222 333\nUsługa: Kobido UP® 90 min\nTermin: sobota, 7 listopada 2026, 10:00 - 11:30\nNumer rezerwacji: 123456789\nTwoje Ciało Twój Dobrostan, tel. 500 694 094`,
    { kind: 'new', booksy_id: '123456789', client_name: 'Anna Kowalska', client_phone: '601222333', service: 'Kobido UP®', start_local: '2026-11-07T10:00', end_local: '2026-11-07T11:30' }],
  ['nowa (temat z nazwiskiem, data numeryczna)', 'Nowa rezerwacja: Ewa Nowak, 12.11.2026 10:00', `Ewa Nowak zarezerwowała wizytę.\nHead SPA Premium\n12.11.2026 10:00–11:00\n605 999 888`,
    { kind: 'new', client_name: 'Ewa Nowak', client_phone: '605999888', service: 'Head SPA Premium', start_local: '2026-11-12T10:00', end_local: '2026-11-12T11:00' }],
  ['zmiana (stary i nowy termin)', 'Zmiana terminu wizyty', `Klientka: Maria Zielińska\nUsługa: Masaż gorącą świecą\nPoprzedni termin: 20.11.2026, 15:30\nNowy termin: 21.11.2026, 17:00 - 18:00`,
    { kind: 'change', client_name: 'Maria Zielińska', service: 'Masaż gorącą świecą', start_local: '2026-11-21T17:00', end_local: '2026-11-21T18:00', old_start_local: '2026-11-20T15:30' }],
  ['zmiana (nowy termin pierwszy)', 'Wizyta została przełożona', `Nowy termin: 3 grudnia, 12:00\nZ terminu: 1 grudnia, 9:00\nKlient: Zofia Nowa\nTelefon: 511-222-333\nUsługa: Access Bars®`,
    { kind: 'change', client_name: 'Zofia Nowa', client_phone: '511222333', start_local: '2026-12-03T12:00', old_start_local: '2026-12-01T09:00' }],
  ['odwołanie', 'Wizyta odwołana', `Anna Kowalska odwołała wizytę.\nUsługa: Kobido UP®\nTermin: 07.11.2026 o 10:00\nID rezerwacji: 123456789`,
    { kind: 'cancel', booksy_id: '123456789', client_name: 'Anna Kowalska', start_local: '2026-11-07T10:00' }],
  ['anulowanie z linkiem w HTML', 'Rezerwacja anulowana przez klienta', `Klient: Ewa Nowak\nRefleksologia Stóp Premium\n19.11 10:00`,
    { kind: 'cancel', booksy_id: '987654', client_name: 'Ewa Nowak', service: 'Refleksologia Stóp Premium', start_local: '2026-11-19T10:00' },
    '<a href="https://booksy.com/biz/appointments/987654">Zobacz</a>'],
  ['rok na przełomie (styczeń w październiku)', 'Nowa rezerwacja', `Klient: Anna Kowalska\nUsługa: Kobido UP®\n15 stycznia, 10:00`,
    { kind: 'new', start_local: '2027-01-15T10:00' }],
  ['mail marketingowy', 'Podsumowanie tygodnia w Booksy', `Zobacz, jak minął Twój tydzień.`, { kind: 'unknown', start_local: null }]
];

let ok = 0;
cases.forEach(([name, subject, body, exp, html]) => {
  const got = rozpoznajMail(subject, body, html || '', rcv);
  const bad = Object.keys(exp).filter((k) => got[k] !== exp[k]);
  if (bad.length) console.log('BŁĄD ' + name + ': ' + bad.map((k) => k + '=' + JSON.stringify(got[k]) + ' (oczekiwane ' + JSON.stringify(exp[k]) + ')').join(', '));
  else { ok++; console.log('OK   ' + name); }
});
console.log('RAZEM: ' + ok + ' / ' + cases.length);
process.exitCode = ok === cases.length ? 0 : 1;
