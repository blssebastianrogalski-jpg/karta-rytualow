/**
 * Twoje Ciało Twój Dobrostan: Booksy → aplikacja → Kalendarz Google
 *
 * Skrypt działa na koncie Google studia (jrtwojecialo@gmail.com), na serwerach Google.
 * Co 5 minut czyta maile od Booksy, zapisuje rezerwacje w aplikacji (plan dnia)
 * i w osobnym kalendarzu „Twoje Ciało Twój Dobrostan | Wizyty”.
 *
 * Jednorazowa konfiguracja:
 *  1. Wklej klucz z panelu (Integracje → Booksy / Kalendarz Google) w miejsce KLUCZ poniżej.
 *  2. Wybierz u góry funkcję „ustaw” i kliknij „Uruchom”, potem zatwierdź uprawnienia.
 */

const KLUCZ = 'WKLEJ_TUTAJ_KLUCZ_Z_PANELU';

const SUPABASE_URL = 'https://pqvndgttgzaosjqjtxbg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Fs1pn9qjzVEHJjr9Qt8dEw_WicjPg3C';   // klucz publiczny aplikacji (ten sam co na stronie)
const NADAWCA = 'no-reply@booksy.com';
const TAG = 'tctd_booking';                // znacznik wydarzeń założonych przez skrypt

// ---------------------------------------------------------------------------
//  Konfiguracja i uruchamianie
// ---------------------------------------------------------------------------

/** Jednorazowo: wyzwalacz co 5 minut + pierwszy przebieg. */
function ustaw() {
  if (!KLUCZ || KLUCZ.indexOf('WKLEJ') === 0) throw new Error('Najpierw wklej klucz z panelu w miejsce KLUCZ.');
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'synchronizuj') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('synchronizuj').timeBased().everyMinutes(5).create();
  synchronizuj();
  Logger.log('Gotowe. Synchronizacja będzie działać co 5 minut.');
}

/** Wyłącza automatyczną synchronizację (dane w aplikacji i kalendarzu zostają). */
function wylacz() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  Logger.log('Synchronizacja wyłączona.');
}

/** Główny przebieg (uruchamiany co 5 minut). */
function synchronizuj() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;           // poprzedni przebieg jeszcze trwa
  const stats = { messages: 0, calendar: 0 };
  let preview = null;
  try {
    const gmailOk = sprawdz(() => GmailApp.getInboxUnreadCount());
    const cal = kalendarz();
    const cfg = rpc('booksy_script_start', { p_key: KLUCZ, p_info: { gmail_ok: gmailOk, calendar_ok: !!cal } });

    // 1) maile → aplikacja
    if (gmailOk) {
      const importMode = cfg.import_state === 'preview_requested' ? 'preview' : cfg.import_state === 'apply_requested' ? 'apply' : null;
      const since = cfg.sync_since ? new Date(cfg.sync_since) : new Date();
      // zwykły przebieg: tylko nowe maile od podłączenia; starsze tylko przez import z podglądem
      const events = importMode ? pobierzMaile(90, null) : pobierzMaile(3, since);
      for (let i = 0; i < events.length; i += 40) {
        const part = events.slice(i, i + 40);
        const out = rpc('booksy_script_ingest', { p_key: KLUCZ, p_events: part, p_dry_run: importMode === 'preview' });
        if (importMode === 'preview') {
          preview = (preview || []).concat(out.results);
        } else {
          out.results.filter((r) => r.result !== 'error' && r.result !== 'invalid').forEach((r) => zapamietaj(r.gmail_id));
          stats.messages += out.results.filter((r) => r.result === 'applied').length;
        }
      }
      if (importMode === 'preview') {
        preview = { at: new Date().toISOString(), items: (preview || []).map((r) => ({
          kind: r.kind, name: r.name, service: r.service, start: r.start, result: r.result })) };
      }
      if (importMode === 'apply') stats.import_applied = true;
    }

    // 2) aplikacja → Kalendarz Google
    if (cal) stats.calendar = zapiszWKalendarzu(cal, cfg);

    rpc('booksy_script_finish', { p_key: KLUCZ, p_ok: true, p_stats: stats, p_import_preview: preview });
  } catch (err) {
    try { rpc('booksy_script_finish', { p_key: KLUCZ, p_ok: false, p_error: String(err && err.message || err) }); } catch (e) { /* brak połączenia */ }
    throw err;
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
//  Gmail
// ---------------------------------------------------------------------------

function pobierzMaile(dni, since) {
  const threads = GmailApp.search('from:' + NADAWCA + ' newer_than:' + dni + 'd', 0, 200);
  const out = [];
  threads.forEach((t) => t.getMessages().forEach((m) => {
    if (since && (m.getDate() < since || przetworzone(m.getId()))) return;
    if (m.getFrom().toLowerCase().indexOf(NADAWCA) === -1) return;
    const e = rozpoznajMail(m.getSubject(), m.getPlainBody(), m.getBody(), m.getDate());
    e.gmail_id = m.getId();
    e.received_at = m.getDate().toISOString();
    out.push(e);
  }));
  return out;
}

// pamięć przetworzonych maili (baza i tak odrzuca duplikaty; to tylko oszczędza zapytania)
function przetworzone(id) {
  const done = PropertiesService.getScriptProperties().getProperty('done') || '';
  return done.indexOf(id) !== -1;
}
function zapamietaj(id) {
  const p = PropertiesService.getScriptProperties();
  const list = (p.getProperty('done') || '').split(',').filter(Boolean);
  if (list.indexOf(id) !== -1) return;
  list.push(id);
  p.setProperty('done', list.slice(-400).join(','));
}

// ---------------------------------------------------------------------------
//  Kalendarz Google
// ---------------------------------------------------------------------------

function kalendarz() {
  return sprawdz(() => {
    const name = 'Twoje Ciało Twój Dobrostan | Wizyty';
    const found = CalendarApp.getCalendarsByName(name);
    if (found.length) return found[0];
    return CalendarApp.createCalendar(name, { timeZone: 'Europe/Warsaw', color: CalendarApp.Color.YELLOW });
  }) || null;
}

function zapiszWKalendarzu(cal, cfg) {
  const pending = rpc('booksy_script_pending', { p_key: KLUCZ });
  if (!pending.length) return 0;
  const results = pending.map((b) => {
    try {
      return Object.assign({ id: b.id, version: b.version, ok: true }, zapiszWydarzenie(cal, b, cfg.gcal_mode));
    } catch (err) {
      return { id: b.id, version: b.version, ok: false, error: String(err && err.message || err).slice(0, 200) };
    }
  });
  rpc('booksy_script_result', { p_key: KLUCZ, p_results: results });
  return results.filter((r) => r.ok).length;
}

function zapiszWydarzenie(cal, b, mode) {
  // tylko wydarzenia założone przez skrypt (ze znacznikiem); ręcznych wpisów nie ruszamy
  let ev = b.event_id ? cal.getEventById(b.event_id) : null;
  if (ev && ev.getTag(TAG) !== String(b.id)) ev = null;
  const title = (b.service || 'Rytuał') + (b.who ? ' · ' + b.who : '');
  const desc = (status) => 'Status: ' + status + '\nŹródło: Booksy\nNr w aplikacji: TCTD-' + b.id +
    (b.conflict ? '\nUwaga: termin nakłada się na inną wizytę.' : '');

  if (b.status === 'cancelled') {
    if (!ev) return { event_id: null };
    if (mode === 'mark') {
      ev.setTitle('ODWOŁANA · ' + title);
      ev.setDescription(desc('odwołana'));
      ev.setColor(CalendarApp.EventColor.GRAY);
      return { event_id: ev.getId() };
    }
    ev.deleteEvent();
    return { event_id: null };
  }

  const start = new Date(b.start);
  const end = new Date(b.end);
  if (ev) {
    ev.setTime(start, end);
    ev.setTitle(title);
    ev.setDescription(desc('zarezerwowana'));
  } else {
    ev = cal.createEvent(title, start, end, { description: desc('zarezerwowana') });
    ev.setTag(TAG, String(b.id));
  }
  // kolizja z ręcznym wpisem w tym kalendarzu
  const clash = cal.getEvents(start, end).some((x) => !x.isAllDayEvent() && !x.getTag(TAG));
  return { event_id: ev.getId(), calendar_conflict: clash };
}

// ---------------------------------------------------------------------------
//  Połączenie z aplikacją
// ---------------------------------------------------------------------------

function rpc(name, body) {
  const res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 300) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch (e) { /* tekst */ }
    throw new Error('Aplikacja: ' + msg);
  }
  return text ? JSON.parse(text) : null;
}

function sprawdz(fn) {
  try { return fn() || true; } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
//  Rozpoznawanie maili Booksy
//  Zwraca { kind, booksy_id, client_name, client_phone, service, start_local, end_local, old_start_local, subject }
// ---------------------------------------------------------------------------

const MIESIACE = {
  stycznia: 1, lutego: 2, marca: 3, kwietnia: 4, maja: 5, czerwca: 6, lipca: 7, sierpnia: 8,
  wrzesnia: 9, pazdziernika: 10, listopada: 11, grudnia: 12,
  styczen: 1, luty: 2, marzec: 3, kwiecien: 4, maj: 5, czerwiec: 6, lipiec: 7, sierpien: 8,
  wrzesien: 9, pazdziernik: 10, listopad: 11, grudzien: 12,
  sty: 1, lut: 2, mar: 3, kwi: 4, cze: 6, lip: 7, sie: 8, wrz: 9, paz: 10, lis: 11, gru: 12
};

function bezOgonkow(s) {
  return s.replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (c) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
    Ą: 'A', Ć: 'C', Ę: 'E', Ł: 'L', Ń: 'N', Ó: 'O', Ś: 'S', Ź: 'Z', Ż: 'Z' })[c]);
}

function pad(n) { return (n < 10 ? '0' : '') + n; }

/** Wszystkie terminy w tekście: [{ start: 'RRRR-MM-DDTHH:MM', end, index }] */
function znajdzTerminy(text, received) {
  const t = bezOgonkow(text);
  const out = [];
  const nazwy = Object.keys(MIESIACE).sort((a, b) => b.length - a.length).join('|');
  const reDate = new RegExp('(\\d{4})-(\\d{2})-(\\d{2})|(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?(?!\\d)|(\\d{1,2})\\s+(' + nazwy + ')\\.?(?:\\s+(\\d{4}))?', 'gi');
  const reTime = /(\d{1,2})[:.](\d{2})(?:\s*(?:-|–|—|do)\s*(\d{1,2})[:.](\d{2}))?/;
  let m;
  while ((m = reDate.exec(t))) {
    let y, mo, d;
    if (m[1]) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if (m[4]) { d = +m[4]; mo = +m[5]; y = m[6] ? +m[6] : null; if (y && y < 100) y += 2000; }
    else { d = +m[7]; mo = MIESIACE[m[8].toLowerCase()]; y = m[9] ? +m[9] : null; }
    if (!mo || mo > 12 || !d || d > 31) continue;
    if (m[4] && !m[6] && t.charAt(m.index + m[0].length) === ':') continue;   // to była godzina, nie data
    // godzina: po dacie (do 60 znaków), a jeśli brak, to tuż przed datą
    const after = t.slice(reDate.lastIndex, reDate.lastIndex + 60);
    const before = t.slice(Math.max(0, m.index - 30), m.index);
    let tm = reTime.exec(after);
    if (!tm) { const all = before.match(new RegExp(reTime.source, 'g')); tm = all ? reTime.exec(all[all.length - 1]) : null; }
    if (!tm || +tm[1] > 23 || +tm[2] > 59) continue;
    if (!y) {
      // rok nie podany: najbliższy termin nie wcześniejszy niż ~miesiąc przed mailem
      const r = received || new Date();
      y = r.getFullYear();
      if (new Date(y, mo - 1, d) < new Date(r.getTime() - 31 * 864e5)) y += 1;
    }
    const day = y + '-' + pad(mo) + '-' + pad(d);
    const term = { start: day + 'T' + pad(+tm[1]) + ':' + tm[2], end: tm[3] ? day + 'T' + pad(+tm[3]) + ':' + tm[4] : null, index: m.index };
    // ten sam termin podany drugi raz (np. w temacie i w treści): zostaje wersja z godziną końca
    const same = out.find((x) => x.start === term.start);
    if (same) { if (!same.end) same.end = term.end; } else out.push(term);
  }
  return out;
}

/** HTML maila → zwykły tekst (linia po linii, bez linków) */
function htmlNaTekst(html) {
  return (html || '')
    .replace(/<(style|head|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|table|td|center)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n));
}

/** Tekst → niepuste linie bez gwiazdek (pogrubienia z wersji tekstowej) i nadmiarowych spacji */
function linie(text) {
  return text.replace(/\r/g, '').split('\n')
    .map((l) => l.replace(/\*/g, ' ').replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean);
}

function czystaUsluga(s) {
  if (!s) return null;
  return s.replace(/^[A-ZĄĆĘŁŃÓŚŹŻ0-9 ,.&/+-]{3,}:\s*/, '')          // kategoria, np. „CIAŁO I RELAKS: ”
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '') // emoji
    .replace(/\s+/g, ' ').trim().slice(0, 80) || null;
}

/**
 * Rozpoznanie maila Booksy. Układ (sprawdzony na prawdziwych mailach, X.2026):
 *  temat: „<Imię Nazwisko>: nowa rezerwacja <data> <godz>” | „<…>: zmienił rezerwację” | „<…>: odwołał wizytę z dnia <data> <godz>”
 *  blok: <Imię Nazwisko> / <telefon> / <e-mail> / <dzień, D miesiąca RRRR, HH:MM - HH:MM> / <KATEGORIA: usługa> / <cena, godziny> / pracownik: …
 *  zmiana: przed blokiem zdanie „… przesunął swoją wizytę <usługa> z dnia <data> <godz> na inny termin.” i „Nowy termin wizyty:”
 * Numeru rezerwacji w mailach nie ma: wizytę wiąże telefon + termin.
 */
function rozpoznajMail(subject, plain, html, received) {
  subject = (subject || '').replace(/^\s*(fwd?|pd|re):\s*/i, '');
  const text = html ? htmlNaTekst(html) : (plain || '');
  const rows = linie(text);
  const all = subject + '\n' + rows.join('\n');
  const subj = bezOgonkow(subject).toLowerCase();

  // rodzaj: z tematu (treść może zawierać np. zasady odwoływania w opisie usługi)
  let kind = 'unknown';
  if (/: odwolal|odwolal\w* wizyt|anulowal/.test(subj)) kind = 'cancel';
  else if (/: zmienil|zmienil\w* rezerwacj|przesunal|przelozyl/.test(subj)) kind = 'change';
  else if (/: nowa rezerwacja|nowa rezerwacja/.test(subj)) kind = 'new';

  // klientka: z tematu („Imię Nazwisko: …”)
  let name = null;
  const sm = /^([^:]{2,80}):/.exec(subject);
  if (sm && kind !== 'unknown') name = sm[1].trim();

  // blok z terminem: linia „dzień, D miesiąca RRRR, HH:MM - HH:MM”
  const reBlock = /\d{1,2}\s+[a-ząćęłńóśźż]+\s+\d{4},?\s+\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}/i;
  let bi = -1;
  rows.forEach((l, i) => { if (bi === -1 && reBlock.test(l) && !/z dnia|w dniu/i.test(l)) bi = i; });
  const termRow = bi >= 0 ? znajdzTerminy(rows[bi], received)[0] : null;

  // telefon: z linii tuż nad terminem (imię / telefon / e-mail)
  let phone = null;
  for (let i = Math.max(0, bi - 3); bi > 0 && i < bi; i++) {
    const pm = /^(?:\+?48[\s-]?)?(\d{3})[\s-]?(\d{3})[\s-]?(\d{3})$/.exec(rows[i]);
    if (pm) phone = pm[1] + pm[2] + pm[3];
  }
  if (!name && bi > 0) {
    const cand = rows.slice(Math.max(0, bi - 3), bi).find((l) => /^[A-ZĄĆĘŁŃÓŚŹŻ][^\d@]{1,60}$/.test(l));
    if (cand) name = cand;
  }

  // usługa: linia pod terminem
  const service = bi >= 0 && rows[bi + 1] && !/zł/.test(rows[bi + 1]) ? czystaUsluga(rows[bi + 1]) : null;

  // stary termin przy zmianie: ze zdania przed „Nowy termin wizyty”
  let old = null;
  if (kind === 'change') {
    const ni = rows.findIndex((l) => /nowy termin/i.test(l));
    const before = rows.slice(0, ni > 0 ? ni : bi > 0 ? bi : rows.length).join(' ');
    const zi = bezOgonkow(before).toLowerCase().indexOf('z dnia');
    old = znajdzTerminy(zi >= 0 ? before.slice(zi) : before, received)[0] || null;
  }

  return {
    kind: kind,
    booksy_id: null,
    client_name: name ? name.slice(0, 80) : null,
    client_phone: phone,
    service: service,
    start_local: termRow ? termRow.start : null,
    end_local: termRow ? termRow.end : null,
    old_start_local: old ? old.start : null,
    subject: kind === 'unknown' || !termRow ? subject.slice(0, 150) : null
  };
}

if (typeof module !== 'undefined') module.exports = { rozpoznajMail: rozpoznajMail, znajdzTerminy: znajdzTerminy, htmlNaTekst: htmlNaTekst };
