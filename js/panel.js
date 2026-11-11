// Panel studia: logowanie, plan dnia, pieczątki, karty bez aplikacji, sprzedaż voucherów, promocje.
(function () {
  const CFG = window.APP_CONFIG;
  const { esc, $, toast } = UI;
  const main = $('#main');
  const sheet = $('#sheet');
  const sheetIn = $('#sheetIn');
  let query = '';
  let searchTimer;
  let current = null;      // otwarta karta
  let currentPlan = null;  // pozycja planu dnia, z której otwarto kartę
  let lastService = '';
  let tab = 'home';        // 'home' = klientki i plan dnia, 'sale' = sprzedaż vouchera, 'promo' = promocje
  let planDay = 0;         // 0 = plan na dziś, 1 = plan na jutro, 2 = kolejne dni
  let planMoreDay = null;  // dzień, na który „+” dodaje klientkę w widoku „Kolejne dni”
  const PLAN_AHEAD = 30;   // ile dni naprzód można układać plan
  const DAY_NAME = ['dziś', 'jutro'];
  const dateLabel = (d) => new Date(d + 'T12:00:00').toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
  const dayLabel = (o) => o < 2 ? dateLabel(Rules.dayPL(o)) : 'kolejne dni';
  const planTarget = () => planDay < 2 ? Rules.dayPL(planDay) : (planMoreDay || Rules.dayPL(2));
  const targetName = () => planDay < 2 ? DAY_NAME[planDay] : dateLabel(planTarget());

  if (Api.demo) $('#demoBar').hidden = false;
  UI.registerSW();

  const MODE_LABEL = {
    stamp: 'Pojedynczy rytuał',
    package_buy: 'Zakup pakietu',
    package_visit: 'Wizyta z pakietu',
    birthday: 'Rytuał urodzinowy −20%',
    referral: 'Pieczątka za polecenie',
    gap: 'Dodatkowa pieczątka za wolny termin',
    review: 'Pieczątka za opinię',
    skipped: 'Odwołana',
    planned: 'Zaplanowana'
  };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const fail = (e) => toast(e.message || 'Coś poszło nie tak.', 'error');
  const appUrl = () => CFG.APP_URL || new URL('./', location.href).href;
  // krótki link (?c=) po uruchomieniu krotki-link.sql, wcześniej długi klucz (?k=)
  const linkFor = (c) => appUrl() + (c.link_code ? '?c=' + encodeURIComponent(c.link_code) : '?k=' + encodeURIComponent(c.token));

  // ---------- logowanie ----------
  async function start() {
    let s = null;
    try { s = await Api.session(); } catch (e) { /* brak sesji */ }
    if (!s) return renderLogin();
    if (s.notStaff) return renderLogin('To konto nie ma dostępu do panelu studia.');
    $('#logoutBtn').hidden = false;
    renderHome();
  }

  function renderLogin(msg) {
    $('#logoutBtn').hidden = true;
    main.innerHTML = `
      <h1>Panel studia</h1>
      <form class="panel" id="loginForm">
        <div class="field"><label for="lEmail">E-mail</label><input class="input" id="lEmail" type="email" autocomplete="username" required ${Api.demo ? 'value="studio@demo.pl"' : ''}></div>
        <div class="field"><label for="lPass">Hasło</label><input class="input" id="lPass" type="password" autocomplete="current-password" required></div>
        <p class="error" id="lErr" role="alert" ${msg ? '' : 'hidden'}>${esc(msg || '')}</p>
        <button class="btn btn--gold" type="submit">Zaloguj</button>
      </form>
      ${Api.demo ? '<p class="small center">W trybie pokazowym hasło to <b>demo</b>.</p>' : ''}`;
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await Api.login($('#lEmail').value.trim(), $('#lPass').value);
        start();
      } catch (ex) { const el = $('#lErr'); el.textContent = ex.message; el.hidden = false; }
    });
  }
  $('#logoutBtn').addEventListener('click', async () => { await Api.logout(); start(); });

  // ---------- ekran główny ----------
  function tabsHtml() {
    return `<div class="tabs tabs--three" role="tablist" aria-label="Sekcje panelu">
      <button role="tab" data-tab="home" aria-selected="${tab === 'home'}">Klientki</button>
      <button role="tab" data-tab="sale" aria-selected="${tab === 'sale'}">Sprzedaż vouchera</button>
      <button role="tab" data-tab="promo" aria-selected="${tab === 'promo'}">Promocje</button>
    </div>`;
  }
  function bindTabs() {
    main.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.tab === tab) return;
      tab = b.dataset.tab;
      renderHome();
    }));
  }

  async function renderHome() {
    if (tab === 'sale') return renderSale();
    if (tab === 'promo') return renderPromos();
    if (tab === 'integr') return Integracje.render(main, () => { tab = 'home'; renderHome(); });
    main.innerHTML = `
      ${tabsHtml()}
      <h1>Panel studia</h1>
      <div id="pushLog"></div>
      <button class="btn btn--gold" id="receiptBtn">Wystaw paragon</button>
      <button class="btn btn--line" id="newBtn">+ Nowa klientka bez aplikacji</button>
      <div id="smsAlert"></div>
      <div id="risks"></div>
      <div id="reqs"></div>
      <div id="bdays"></div>
      <div id="refs"></div>
      <section style="display:flex;flex-direction:column;gap:10px">
        <div class="row"><span class="eyebrow" id="planTitle">Plan dnia · ${dayLabel(planDay)}</span></div>
        <div class="tabs tabs--small tabs--three" role="tablist" aria-label="Dzień planu">
          <button role="tab" data-plan-day="0" aria-selected="${planDay === 0}">Dziś</button>
          <button role="tab" data-plan-day="1" aria-selected="${planDay === 1}">Jutro</button>
          <button role="tab" data-plan-day="2" aria-selected="${planDay === 2}">Kolejne dni</button>
        </div>
        <div id="planPick" class="field" ${planDay === 2 ? '' : 'hidden'}>
          <label class="small" for="planDate">„+” przy klientce doda ją na dzień:</label>
          <input class="input" id="planDate" type="date" min="${Rules.dayPL(2)}" max="${Rules.dayPL(PLAN_AHEAD)}" value="${planMoreDay || Rules.dayPL(2)}" style="background:var(--surface)">
        </div>
        <div id="plan"><div class="spinner"></div></div>
        <p class="small" style="margin:0">Wizyty z Booksy dopisują się same (z godziną), gdy integracja jest podłączona. Ręcznie dodasz klientkę przyciskiem „+” przy nazwisku, do dnia wybranego wyżej, i od razu ustawisz godzinę. „Przesuń lub usuń wizytę” pod nazwiskiem zmienia dzień, godzinę albo rytuał, a „×” usuwa wizytę z planu. Wizyty z Booksy przesuwasz w Booksy.</p>
      </section>
      <div id="gaps"></div>
      <section style="display:flex;flex-direction:column;gap:10px">
        <span class="eyebrow">Moje dni wolne</span>
        <div id="absences"><div class="spinner"></div></div>
        <button class="btn btn--line" id="absAddBtn">+ Dodaj dzień wolny</button>
      </section>
      <section style="display:flex;flex-direction:column;gap:10px">
        <label class="eyebrow" for="search">Klientki</label>
        <input class="input" id="search" type="search" placeholder="Szukaj po imieniu, nazwisku lub telefonie" value="${esc(query)}" style="background:var(--surface)">
        <div class="panel panel--tight" id="list"><div class="spinner"></div></div>
      </section>
      <button class="btn btn--ghost" id="integrBtn">Integracje: Booksy i Kalendarz Google</button>
      <section class="panel" id="ownerPushBox" style="gap:8px" hidden></section>`;
    bindTabs();
    $('#newBtn').addEventListener('click', () => openNewCard());
    $('#receiptBtn').addEventListener('click', () => openReceipt());
    $('#integrBtn').addEventListener('click', () => { tab = 'integr'; renderHome(); window.scrollTo(0, 0); });
    document.querySelectorAll('[data-plan-day]').forEach((b) => b.addEventListener('click', () => {
      planDay = +b.dataset.planDay;
      document.querySelectorAll('[data-plan-day]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      $('#planTitle').textContent = 'Plan dnia · ' + dayLabel(planDay);
      $('#planPick').hidden = planDay !== 2;
      loadPlan(); loadList();
    }));
    $('#planDate').addEventListener('change', (e) => {
      const v = e.target.value;
      if (v && v >= Rules.dayPL(2) && v <= Rules.dayPL(PLAN_AHEAD)) planMoreDay = v;
      else { e.target.value = planTarget(); UI.toast('Wybierz dzień od pojutrza do ' + PLAN_AHEAD + ' dni naprzód.'); }
      loadList();
    });
    $('#absAddBtn').addEventListener('click', openAbsenceAdd);
    loadOwnerPush();
    loadPushLog();
    $('#search').addEventListener('input', (e) => { query = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(loadList, 250); });
    Promise.all([loadRefs(), loadAbsences()]).then(loadPlan);
    loadList();
    loadRequests();
    loadSmsAlert();
    loadRisks();
    loadGaps();
  }

  // ---------- wolne terminy (po odwołaniu wysyłają się same, zwykłe luki tylko ręcznie z „Wolne godziny”) ----------
  const GAP_STATUS = { pending: 'wyślę za kilka minut', open: 'wysłana, czeka na chętną', closed: 'zajęta albo minęła', skipped: 'nie wysłana' };
  const GAP_DAYS = 5;      // dziś + tyle dni naprzód
  let gapOpen = false;     // „Wolne godziny” domyślnie zwinięte
  const CHANNEL = { both: 'Push i SMS', push: 'Tylko push', sms: 'Tylko SMS' };
  let gaps = [], forecast = null, gapChannel = 'both';
  const range = (g) => hhmm(g.start_at) + '–' + hhmm(g.end_at);
  const bigDay = (d) => d === Rules.dayPL(0) ? 'Dziś' : d === Rules.dayPL(1) ? 'Jutro' : dateLabel(d).replace(/^./, (ch) => ch.toUpperCase());
  // Ostrzeżenie: SMSPLANET odrzuca SMS-y (np. brak środków)
  async function loadSmsAlert() {
    const box = $('#smsAlert');
    let a = null;
    try { a = await Api.smsAlert(); } catch (e) { a = null; } // baza jeszcze bez ostrzeżeń o SMS-ach
    if (!box) return;
    if (!a || !a.n) { box.innerHTML = ''; return; }
    const when = new Date(a.last_at).toLocaleString('pl-PL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
    box.innerHTML = `<div class="hint hint--error" style="display:flex;flex-direction:column;gap:10px">
      <span><span class="strong">SMS-y nie wychodzą.</span> Przez ostatnią dobę SMSPLANET odrzucił ${a.n} ${UI.plural(a.n, 'SMS', 'SMS-y', 'SMS-ów')} (ostatnio ${esc(when)})${a.error ? ': ' + esc(a.error) : ''}.${/środk/i.test(a.error || '') ? '' : ' Najczęściej to brak środków.'} Klientki z aplikacją dostały push.</span>
      <span style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn btn--line btn--sm" href="https://panel.smsplanet.pl/" target="_blank" rel="noopener">Doładuj SMSPLANET</a>
        <button class="btn btn--ghost btn--sm" id="smsAlertHide">Ukryj</button>
      </span>
    </div>`;
    $('#smsAlertHide').addEventListener('click', async () => {
      try { await Api.smsAlertDismiss(); } catch (e) { /* zostaw */ }
      box.innerHTML = '';
    });
  }

  // ---------- rezerwacje osób z historią odwołań (Regulamin wizyt, pkt 3 i 5) ----------
  // Panel tylko ostrzega. SMS do klientki wychodzi wyłącznie po kliknięciu „Wyślij SMS”.
  const INC_KIND = { cancel: 'odwołanie ponad 24 h przed', late: 'odwołanie później niż 24 h przed', noshow: 'nie przyszła' };
  const INC_SRC = { booksy: 'Booksy', app: 'aplikacja', panel: 'panel', manual: 'wpis ręczny' };
  const RISK_SRC = { booksy: 'rezerwacja w Booksy', app: 'prośba o termin w aplikacji', plan: 'wpis w planie' };
  const SMS_MAX = 459;
  const NUM_WORD = { 2: 'dwie', 3: 'trzy', 4: 'cztery' };
  const shortDay = (iso) => new Date(iso).toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric', timeZone: 'Europe/Warsaw' });
  const incLine = (l) => (l || []).map((i) => shortDay(i.at) + ' (' + (INC_KIND[i.kind] || i.kind).replace('odwołanie później niż 24 h przed', 'późne odwołanie').replace('odwołanie ponad 24 h przed', 'odwołanie') + ')').join(', ');
  const riskReason = (r) => r.rule === 'year'
    ? r.n + ' ' + UI.plural(r.n, 'nieodbyta wizyta', 'nieodbyte wizyty', 'nieodbytych wizyt') + ' w tym roku: ' + incLine(r.list)
    : 'Dwie ostatnie rezerwacje odwołane: ' + incLine(r.list);
  // „pon. 16.11, 14:00”
  const smsWhen = (day, iso) => ['niedz.', 'pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.'][new Date(day + 'T12:00:00').getDay()] + ' ' +
    day.slice(8, 10) + '.' + day.slice(5, 7) + (iso ? ', ' + hhmm(iso) : '');
  // Pani czy Pan: po imieniu (w polskich imionach żeńskich zwykle końcówka -a); w oknie SMS da się zmienić
  const MALE_A = ['kuba', 'barnaba', 'bonawentura', 'kosma', 'jarema', 'dyzma', 'zawisza', 'sasza', 'misza', 'nikita', 'luca', 'andrea'];
  const FEMALE = ['beatrycze', 'noemi', 'miriam', 'nel', 'abigail', 'ingrid', 'karmen', 'carmen', 'rut', 'dagmar', 'ines', 'inez', 'iris', 'margot', 'nicole', 'vivien', 'lilian', 'agnes', 'dolores', 'mercedes'];
  function guessPani(name) {
    const f = String(name || '').trim().split(/\s+/)[0].toLowerCase();
    if (!f) return true;
    if (FEMALE.includes(f)) return true;
    if (MALE_A.includes(f)) return false;
    return f.endsWith('a');
  }
  // Ciepły zwrot po imieniu (wołacz zdrobnienia), ta sama lista co w życzeniach urodzinowych (call_name w bazie)
  const CALL = { Anna: 'Aniu', Ania: 'Aniu', Hanna: 'Haniu', Katarzyna: 'Kasiu', Kasia: 'Kasiu', Magdalena: 'Madziu', Magda: 'Madziu',
    'Małgorzata': 'Gosiu', Gosia: 'Gosiu', Joanna: 'Asiu', Asia: 'Asiu', Barbara: 'Basiu', Agnieszka: 'Agnieszko',
    Marta: 'Martusiu', Renata: 'Renatko', Justyna: 'Justynko', Ewa: 'Ewuniu', Dorota: 'Dorotko', Zuzanna: 'Zuziu',
    Sylwia: 'Sylwio', Paulina: 'Paulinko', Patrycja: 'Patrycjo', Monika: 'Moniko', Karolina: 'Karolinko', Jolanta: 'Jolu',
    Iwona: 'Iwonko', Daria: 'Dario', 'Bożena': 'Bożenko', 'Bożenna': 'Bożenko', Aleksandra: 'Olu', Ola: 'Olu', Adrianna: 'Adrianno',
    Beata: 'Beatko', 'Elżbieta': 'Elu', Ela: 'Elu', Natalia: 'Natalko', Weronika: 'Weroniko', Julia: 'Julio', Alicja: 'Alu',
    Emilia: 'Emilko', Kinga: 'Kingo', Izabela: 'Izo', Aneta: 'Anetko', Edyta: 'Edytko', Klaudia: 'Klaudio', Wioletta: 'Wioletko',
    Teresa: 'Tereso', 'Grażyna': 'Grażynko', Danuta: 'Danusiu', Halina: 'Halinko', Krystyna: 'Krysiu', Urszula: 'Ulu',
    Wiktoria: 'Wiktorio', Maria: 'Marysiu', Marysia: 'Marysiu', Martyna: 'Martynko', Kamila: 'Kamilko', Dominika: 'Dominiko',
    Angelika: 'Angeliko', Ilona: 'Ilonko', Lucyna: 'Lucynko', Anita: 'Anitko', Milena: 'Milenko', Oliwia: 'Oliwio',
    Gabriela: 'Gabrysiu', Ewelina: 'Ewelinko', Marzena: 'Marzenko', Sandra: 'Sandro', 'Mirosława': 'Mirko', Zofia: 'Zosiu',
    Wojtek: 'Wojtku', Wojciech: 'Wojtku', 'Radosław': 'Radku', 'Przemysław': 'Przemku', Marek: 'Marku', Piotr: 'Piotrze',
    Tomasz: 'Tomku', 'Paweł': 'Pawle', 'Michał': 'Michale', Krzysztof: 'Krzysiu', Adam: 'Adamie', 'Łukasz': 'Łukaszu',
    Jakub: 'Kubo', Kamil: 'Kamilu', Mateusz: 'Mateuszu', Andrzej: 'Andrzeju', Robert: 'Robercie', 'Rafał': 'Rafale',
    Dariusz: 'Darku', Grzegorz: 'Grzesiu', Jan: 'Janku', Marcin: 'Marcinie', Bartosz: 'Bartku', Sebastian: 'Sebastianie' };
  function callName(name) {
    const w = String(name || '').trim().split(/\s+/)[0] || '';
    const n = w ? w.charAt(0).toLocaleUpperCase('pl-PL') + w.slice(1).toLocaleLowerCase('pl-PL') : '';
    if (!n) return '';
    if (CALL[n]) return CALL[n];
    if (/ia$/.test(n)) return n.replace(/a$/, 'u');
    if (/a$/.test(n)) return n.replace(/a$/, 'o');
    return n;
  }
  const greetFor = (name, pani) => { const c = callName(name); return (pani ? 'Pani' : 'Panie') + (c ? ' ' + c : ''); };
  const longDay = (day) => new Date(day + 'T12:00:00').toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' });
  const todayPL = () => Rules.dayPL(0);
  // Termin wpłaty zadatku: jutro, ale najpóźniej dzień przed wizytą (przy wizycie jutro lub dziś: dzisiaj)
  function payByDefault(day) {
    const tomorrow = Rules.dayPL(1);
    if (!day || day > tomorrow) return tomorrow;
    return todayPL();
  }
  const NUM_F = { 1: 'jedna', 2: 'dwie', 3: 'trzy', 4: 'cztery' };
  const NUM_ADJ = { 1: 'wcześniejsza', few: 'wcześniejsze', many: 'wcześniejszych' };
  // o: { greet, extra, payBy } — pola z okna SMS
  function riskSms(a, pani, o) {
    o = o || {};
    const P = pani ? 'Pani' : 'Pana';
    const year = (a.reasons || []).find((r) => r.rule === 'year');
    const row = (a.reasons || []).find((r) => r.rule === 'row');
    const visitDay = longDay(a.day);
    const lines = [];
    lines.push('Dzień dobry' + (o.greet ? ' ' + o.greet : '') + '.');
    lines.push(a.source === 'app' && !a.visit_at
      ? 'Dziękuję za wiadomość i prośbę o termin ' + visitDay + '.'
      : 'Dziękuję, że ' + (pani ? 'wybrała Pani' : 'wybrał Pan') + ' termin ' + visitDay + (a.visit_at ? ', godz. ' + hhmm(a.visit_at) : '') + '.');
    if (o.extra && o.extra.trim()) lines.push(o.extra.trim());

    let why, rule, lost;
    if (year) {
      const list = year.list || [];
      const n = year.n || list.length || 2;
      const kinds = list.map((i) => i.kind);
      const allLate = kinds.length && kinds.every((k) => k === 'late');
      const allNo = kinds.length && kinds.every((k) => k === 'noshow');
      const last = list.length ? list[list.length - 1] : null;
      const lastToday = last && new Date(last.at).toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' }) === todayPL();
      let subject, many;
      if (lastToday) {
        const m = n - 1;
        subject = 'Dzisiejsza wizyta i ' + (m < 5 ? (NUM_F[m] || m) + ' ' + (m === 1 ? NUM_ADJ[1] : NUM_ADJ.few) : m + ' ' + NUM_ADJ.many);
        many = false;
      } else {
        subject = 'W tym roku ' + (n < 5 ? (NUM_F[n] || n) + ' ' + P + ' wizyty' : n + ' ' + P + ' wizyt');
        many = n >= 5;
      }
      const odw = many ? 'zostało odwołanych' : 'zostały odwołane';
      const nie = many ? 'nie odbyło się' : 'nie odbyły się';
      why = subject + ' ' + (allLate ? odw + ' w czasie krótszym niż 24 godz. przed wizytą.'
        : allNo ? nie + ' bez wcześniejszego odwołania.'
        : odw + ' w czasie krótszym niż 24 godz. przed wizytą lub ' + nie + ' bez odwołania.');
      rule = allLate ? 'po dwóch odwołaniach krótszych niż 24 godziny przed wizytą'
        : 'po dwóch wizytach, które się nie odbyły (odwołanych krócej niż 24 godziny przed terminem lub bez odwołania),';
      lost = 'W takiej sytuacji nie mam już szansy zaproponować tego czasu osobie, która czeka na wolny termin.';
    } else {
      why = 'Dwie ostatnie ' + P + ' rezerwacje zostały odwołane, jedna po drugiej.';
      rule = 'po dwóch odwołaniach z rzędu';
      lost = 'Każdy taki termin trudno mi potem zaproponować osobie, która czeka na wolne miejsce.';
    }
    lines.push('Muszę jednak napisać o jednej ważnej rzeczy. ' + why);
    lines.push(lost);
    lines.push('Dlatego zgodnie z Regulaminem wizyt ' + rule + ' ' + 'kolejną rezerwację potwierdzam po wpłacie zadatku w wysokości 50% ceny rytuału.');
    lines.push('Zadatek można wpłacić tutaj (wybieramy rytuał i wpisujemy termin ' + a.day.slice(8, 10) + '.' + a.day.slice(5, 7) + '): https://twojecialotwojdobrostan.pl/produkt/zadatek-za-wizyte/');
    const payBy = o.payBy || payByDefault(a.day);
    lines.push('Proszę o wpłatę ' + (payBy <= todayPL() ? 'jeszcze dzisiaj' : 'do ' + longDay(payBy)) + '. Bez niej będę musiała zwolnić termin dla innej osoby.');
    lines.push('Zadatek zaliczę w całości na poczet ceny rytuału. Zgodnie z regulaminem nie podlega zwrotowi: jeśli wizyta zostanie odwołana i nie odbędzie się z ' + P + ' strony, zadatek przepada.');
    lines.push('Pełne zasady: twojecialotwojdobrostan.pl/regulamin-wizyt');
    lines.push('Wiem, że życie czasem układa plany po swojemu, i nie biorę tego do siebie. Zależy mi po prostu, żeby każdy termin w studiu mógł komuś posłużyć. Cieszę się na nasze spotkanie.');
    lines.push('Z troską o Twój Dobrostan,\nJustyna');
    return lines.join('\n');
  }
  const smsParts = (t) => t.length <= 160 ? 1 : Math.ceil(t.length / 153);
  let risks = [];
  async function loadRisks() {
    const box = $('#risks');
    try { risks = await Api.riskAlerts(); } catch (e) { risks = []; } // baza jeszcze bez historii odwołań
    if (!box) return;
    const open = risks.filter((a) => a.status === 'new');
    const done = risks.filter((a) => a.status !== 'new');
    if (!risks.length) { box.innerHTML = ''; return; }
    const when = (a) => (a.visit_at ? dateLabel(a.day) + ', ' + hhmm(a.visit_at) : dateLabel(a.day) + (a.source === 'app' ? ' (prośba, godzina do ustalenia)' : ''));
    box.innerHTML = `
      ${open.length ? `<div class="hint hint--error" id="ostrzezenia" style="display:flex;flex-direction:column;gap:12px">
        <span class="strong">${open.length === 1 ? 'Umówiła się osoba z historią odwołań' : 'Umówiły się osoby z historią odwołań: ' + open.length}</span>
        ${open.map((a, i) => `<div style="display:flex;flex-direction:column;gap:4px${i ? ';padding-top:10px;border-top:1px solid var(--line-soft)' : ''}">
          ${a.card_id ? `<button class="linkbtn" style="text-align:left;text-decoration:none;color:var(--text);font-weight:600" data-open="${esc(a.card_id)}">${esc(a.name)}</button>` : `<span class="strong">${esc(a.name)}</span>`}
          <span class="strong gold">${esc(when(a))}${a.service ? ' · ' + esc(a.service) : ''}</span>
          <span class="small" style="color:var(--text-2)">${esc(RISK_SRC[a.source] || a.source)}${a.phone ? ' · ' + esc(a.phone) : ''}</span>
          ${(a.reasons || []).map((r) => `<span class="small" style="color:var(--text)">${esc(riskReason(r))}</span>`).join('')}
          <span class="small" style="color:var(--text-2)">Według regulaminu (pkt 5) ta wizyta wymaga zadatku 50%. Decyzja należy do Ciebie.</span>
          <div class="btn-row" style="margin-top:4px">
            <button class="btn btn--gold btn--sm" data-risk-sms="${a.id}">Napisz SMS o zadatku</button>
            <button class="btn btn--ghost btn--sm" data-risk-no="${a.id}">Pomiń</button>
          </div>
        </div>`).join('')}
      </div>` : ''}
      ${done.length ? `<details class="panel" style="padding:14px 16px;gap:8px">
        <summary class="eyebrow" style="cursor:pointer">Historia odwołań · załatwione (14 dni): ${done.length}</summary>
        <div style="display:flex;flex-direction:column;gap:2px;margin-top:8px">${done.map((a) => `<div class="list-row" style="flex-direction:column;align-items:flex-start;gap:2px"><span>${esc(a.name)}</span><span class="small">${esc(when(a))} · ${a.status === 'sent' ? 'SMS wysłany ' + esc(UI.fmtShort(a.handled_at)) : 'pominięte'}</span></div>`).join('')}</div>
      </details>` : ''}`;
    box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openCard(b.dataset.open)));
    box.querySelectorAll('[data-risk-sms]').forEach((b) => b.addEventListener('click', () => openRiskSms(risks.find((a) => a.id === +b.dataset.riskSms))));
    box.querySelectorAll('[data-risk-no]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await Api.riskAlertDismiss(+b.dataset.riskNo); toast('Pominięte. Nic nie zostało wysłane.'); } catch (e) { fail(e); }
      loadRisks();
    }));
    if (location.hash === '#ostrzezenia' && open.length) { history.replaceState(null, '', location.pathname); box.scrollIntoView({ block: 'start' }); }
  }

  // Zapamiętany zwrot do osoby (np. „Pani Iwonko”), żeby nie poprawiać go drugi raz
  const greetKey = (a) => 'zwrot:' + (a.card_id || risk_phone(a.phone));
  const risk_phone = (p) => String(p || '').replace(/\D/g, '').slice(-9);
  const greetGet = (a) => { try { return localStorage.getItem(greetKey(a)) || ''; } catch (e) { return ''; } };
  const greetSet = (a, v) => { try { localStorage.setItem(greetKey(a), v); } catch (e) { /* bez pamięci */ } };

  function openRiskSms(a) {
    if (!a) return;
    const saved = greetGet(a);
    let pani = saved ? /^pani\b/i.test(saved) : guessPani(a.name), edited = false;
    const night = () => { const h = +new Date().toLocaleTimeString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Warsaw' }); return h >= 21 || h < 8; };
    const payMax = a.day && a.day > todayPL() ? a.day : todayPL();
    openSheet(`${bar('SMS o zadatku')}
      <p class="lead" style="margin-top:-8px">${esc(a.name)} · ${esc(smsWhen(a.day, a.visit_at))}</p>
      <form class="panel" id="rsForm" novalidate>
        <span class="eyebrow">Zwrot grzecznościowy</span>
        <div class="btn-row">
          <label class="check" style="flex:1"><input type="radio" name="rsForm" value="pani" ${pani ? 'checked' : ''}> <span>Pani</span></label>
          <label class="check" style="flex:1"><input type="radio" name="rsForm" value="pan" ${pani ? '' : 'checked'}> <span>Pan</span></label>
        </div>
        <div class="field"><label for="rsGreet">Jak się zwracam (po „Dzień dobry”)</label><input class="input" id="rsGreet" maxlength="40" value="${esc(saved || greetFor(a.name, pani))}"></div>
        <div class="field"><label for="rsExtra">Osobiste zdanie (nieobowiązkowe)</label><input class="input" id="rsExtra" maxlength="120" placeholder="np. Życzę szybkiego powrotu do zdrowia."></div>
        <div class="field"><label for="rsPay">Zadatek do</label><input class="input" id="rsPay" type="date" style="min-width:0;width:100%" min="${todayPL()}" max="${payMax}" value="${payByDefault(a.day)}"></div>
        <div class="field"><label for="rsText">Treść wiadomości (możesz ją zmienić)</label><textarea class="input" id="rsText" rows="14"></textarea></div>
        <span class="small" id="rsCount" style="margin-top:-6px"></span>
        <p class="error" id="rsNight" role="status" ${night() ? '' : 'hidden'} style="margin:0">Jest pora ciszy nocnej (21:00–8:00). Możesz też wysłać wiadomość rano.</p>
        <p class="error" id="rsErr" role="alert" hidden></p>
        ${a.phone ? `<a class="btn btn--gold" id="rsPhone" href="#">Wyślij z mojego telefonu</a>
        <p class="small" style="margin:0">Otworzy się SMS w Twoim telefonie z gotową treścią, z polskimi literami, na numer <b>${esc(a.phone)}</b>.</p>` : '<p class="small" style="margin:0">Brak numeru telefonu tej osoby.</p>'}
        <button class="btn btn--ghost btn--sm" type="submit" id="rsSend" ${a.phone ? '' : 'disabled'}>Wyślij przez bramkę SMS (TwojeCialo)</button>
        <p class="small" id="rsGate" style="margin:0"></p>
      </form>`);
    const ta = $('#rsText');
    const count = () => {
      const t = ta.value.trim(), n = t.length;
      $('#rsCount').textContent = n + ' znaków';
      const ph = $('#rsPhone');
      if (ph) ph.setAttribute('href', 'sms:' + a.phone.replace(/[^\d+]/g, '') + '?&body=' + encodeURIComponent(t));
      const tooLong = n > SMS_MAX;
      $('#rsSend').disabled = !a.phone || tooLong;
      $('#rsGate').textContent = tooLong
        ? 'Przez bramkę SMS da się wysłać najwyżej ' + SMS_MAX + ' znaków (bez polskich liter), więc ta dłuższa wiadomość idzie z Twojego telefonu.'
        : 'Bramka wyśle ' + smsParts(t) + ' ' + UI.plural(smsParts(t), 'SMS', 'SMS-y', 'SMS-ów') + ' z nazwy TwojeCialo, bez polskich liter, dopiero gdy potwierdzisz.';
    };
    const opts = () => ({ greet: $('#rsGreet').value.trim(), extra: $('#rsExtra').value, payBy: $('#rsPay').value });
    const fill = () => { ta.value = riskSms(a, pani, opts()); count(); };
    fill();
    ta.addEventListener('input', () => { edited = true; count(); });
    const refill = async () => {
      if (edited && !(await UI.ask('Ułożyć treść od nowa? Twoje ręczne zmiany w treści zostaną zastąpione.', 'Ułóż od nowa'))) return false;
      edited = false; fill(); return true;
    };
    ['rsGreet', 'rsExtra', 'rsPay'].forEach((id) => $('#' + id).addEventListener('change', refill));
    $('#rsGreet').addEventListener('input', () => { if (!edited) fill(); });
    $('#rsExtra').addEventListener('input', () => { if (!edited) fill(); });
    sheetIn.querySelectorAll('input[name="rsForm"]').forEach((r) => r.addEventListener('change', async () => {
      const next = r.value === 'pani';
      if (next === pani) return;
      const prev = pani; pani = next;
      $('#rsGreet').value = greetFor(a.name, pani);
      if (!(await refill())) {
        pani = prev; $('#rsGreet').value = greetFor(a.name, pani);
        sheetIn.querySelector('input[name="rsForm"][value="' + (pani ? 'pani' : 'pan') + '"]').checked = true;
      }
    }));
    const remember = () => { const g = $('#rsGreet').value.trim(); if (g && g !== greetFor(a.name, pani)) greetSet(a, g); };
    const ph = $('#rsPhone');
    if (ph) ph.addEventListener('click', async (e) => {
      if (!(await UI.ask('Otworzę SMS w Twoim telefonie z gotową treścią. Po wysłaniu oznaczę ostrzeżenie jako załatwione.', 'Otwórz'))) { e.preventDefault(); return; }
      remember();
      Api.riskAlertDismiss(a.id).catch(() => {});
      setTimeout(() => { closeSheet(); loadRisks(); }, 300);
    });
    $('#rsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      const err = $('#rsErr'); err.hidden = true;
      if (text.length < 10) { err.textContent = 'Wpisz treść SMS-a.'; err.hidden = false; return; }
      if (text.length > SMS_MAX) { err.textContent = 'Ta wiadomość jest za długa dla bramki SMS. Wyślij ją ze swojego telefonu.'; err.hidden = false; return; }
      if (!(await UI.ask('Wysłać ten SMS do: ' + a.name + ' (' + a.phone + ')?', 'Wyślij'))) return;
      const btn = $('#rsSend'); btn.disabled = true;
      try {
        const r = await Api.riskAlertSms(a.id, text);
        remember();
        closeSheet(); loadRisks();
        toast(r && r.demo ? 'Tryb pokazowy: SMS nie został naprawdę wysłany.' : 'SMS wysłany do: ' + a.name + '.');
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    });
  }

  async function loadGaps() {
    const box = $('#gaps');
    try { gaps = await Api.gapList(); } catch (e) { gaps = []; } // baza jeszcze bez wolnych terminów
    try { forecast = await Api.gapForecast(GAP_DAYS); } catch (e) { forecast = null; } // baza jeszcze bez wolne-terminy-recznie.sql
    if (!box) return;
    const rest = gaps.filter((g) => g.status !== 'ask');
    const live = rest.some((g) => g.status === 'open' || g.status === 'pending');
    const taken = (g) => (g.taken || []).map((t) => `<span class="small" style="color:var(--text)">✓ ${esc(t.name)} · ${esc(hhmm(t.start_at))}${t.service ? ' · ' + esc(t.service) : ''} · <span class="gold">${t.bonus ? 'dodatkowa pieczątka dopisana' : '+1 pieczątka po wizycie'}</span></span>`).join('');
    const dayRow = (f, i) => {
      const free = f.windows.filter((w) => !w.sent), sent = f.windows.filter((w) => w.sent);
      const why = f.state === 'closed' ? 'nieczynne' : f.state === 'off' ? 'dzień wolny' : f.state === 'unknown' ? 'godziny pracy nieustawione' : !f.windows.length ? 'brak wolnych godzin' : '';
      return `<div style="display:flex;flex-direction:column;gap:6px${i ? ';padding-top:10px;border-top:1px solid var(--line-soft)' : ''}">
        <div class="row" style="align-items:baseline;gap:8px"><span class="strong">${esc(bigDay(f.day))}</span><span class="small">${f.state === 'open' && f.hours ? esc(f.hours[0] + '–' + f.hours[1]) + ' · ' + f.visits + ' ' + UI.plural(f.visits, 'wizyta', 'wizyty', 'wizyt') : ''}</span></div>
        ${why ? `<span class="small">${esc(why)}</span>` : ''}
        ${free.length ? `<span class="gold" style="font-size:16px">${esc(free.map(range).join(', '))}</span>` : ''}
        ${sent.length ? `<span class="small">Oferta już wyszła: ${esc(sent.map(range).join(', '))}</span>` : ''}
        ${free.length ? `<button class="btn btn--line btn--sm" data-gap-day="${esc(f.day)}" style="align-self:flex-start">Wyślij ofertę klientkom</button>` : ''}
      </div>`;
    };
    box.innerHTML = `
      ${forecast ? `<details class="panel panel--gold" id="gapFc" style="padding:14px 16px;gap:10px"${gapOpen || location.hash === '#wolne' ? ' open' : ''}>
        <summary class="eyebrow eyebrow--gold" style="cursor:pointer">Wolne godziny · dziś i ${GAP_DAYS} kolejnych dni${forecast.some((f) => f.windows.some((w) => !w.sent)) ? ' · są wolne' : ''}</summary>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">${forecast.map(dayRow).join('')}</div>
        <div id="gapAuto"></div>
        <div id="reviewStampBox"></div>
        <p class="small" style="margin:10px 0 0">Liczę z planu dnia, godzin pracy i dni wolnych. Oferta o wolnych godzinach wychodzi tylko wtedy, gdy ją wyślesz. Po odwołaniu wizyty oferta wychodzi sama, ale między 21:00 a 8:00 czeka do rana. SMS idzie tylko na polskie numery.</p>
      </details>` : ''}
      ${rest.length ? `<details class="panel" style="padding:14px 16px;gap:8px"${live ? ' open' : ''}>
        <summary class="eyebrow" style="cursor:pointer">Wysłane oferty · ostatnie 7 dni: ${rest.length}</summary>
        <div style="display:flex;flex-direction:column;gap:2px;margin-top:8px">${rest.map((g) => `<div style="display:flex;flex-direction:column;gap:3px;padding:10px 0;border-bottom:1px solid var(--line-soft)">
          <span>${esc(dateLabel(g.day))}, ${esc(range(g))} <span class="tag">${g.kind === 'cancel' ? 'po odwołaniu' : 'wolne godziny'}</span></span>
          <span class="small">${g.info && (g.kind === 'cancel' || /ręcznie/.test(g.info)) ? esc(g.info) + ' · ' : ''}${esc(GAP_STATUS[g.status] || g.status)}${g.sent_at ? ' · push: ' + (g.push_n || 0) + ', SMS: ' + (g.sms_n || 0) : ''}</span>
          ${taken(g)}
          ${g.status === 'open' ? `<button class="btn btn--line btn--sm" data-gap-sms="${esc(String(g.id))}" style="align-self:flex-start;margin-top:4px">SMS z mojego telefonu</button>` : ''}
        </div>`).join('')}</div>
      </details>` : ''}`;
    const fc = $('#gapFc');
    if (fc) fc.addEventListener('toggle', () => { gapOpen = fc.open; }); // zwinięte, dopóki sama nie rozwiniesz
    box.querySelectorAll('[data-gap-day]').forEach((b) => b.addEventListener('click', () => openGapSend(forecast.find((f) => f.day === b.dataset.gapDay))));
    box.querySelectorAll('[data-gap-sms]').forEach((b) => b.addEventListener('click', () => openGapPhone(b.dataset.gapSms)));
    loadGapAuto();
    loadReviewStamp();
    if (location.hash === '#wolne') { history.replaceState(null, '', location.pathname); box.scrollIntoView({ block: 'start' }); }
  }

  // wysyłka oferty na wybrany dzień: które godziny i jak (push, SMS, oba)
  function openGapSend(f) {
    if (!f) return;
    const free = f.windows.filter((w) => !w.sent);
    const picked = new Set(free.map((w, i) => i));
    const count = () => gapChannel === 'push' ? f.push_n : gapChannel === 'sms' ? f.sms_n : f.any_n;
    openSheet(`${bar('Wyślij wolny termin')}
      <p class="lead" style="margin-top:-8px">${esc(bigDay(f.day))}. Zaznacz godziny, które chcesz zaproponować.</p>
      <div class="picks" id="gsWins">${free.map((w, i) => `<button type="button" class="pick" role="checkbox" aria-checked="true" data-w="${i}">
        <span><span class="pick__name">${esc(range(w))}</span><span class="pick__meta">${esc(gapLen(w))}</span></span><span class="pick__price" aria-hidden="true">✓</span></button>`).join('')}</div>
      <span class="eyebrow" style="margin-top:6px">Jak wysłać</span>
      <div class="tabs tabs--small tabs--three" role="radiogroup" aria-label="Jak wysłać">${Object.keys(CHANNEL).map((k) => `<button role="radio" data-ch="${k}" aria-selected="${k === gapChannel}">${esc(CHANNEL[k])}</button>`).join('')}</div>
      <p class="small" id="gsInfo" style="margin:0"></p>
      <p class="error" id="gsErr" role="alert" hidden></p>
      <button class="btn btn--gold" id="gsSend">Wyślij</button>`);
    const upd = () => {
      const n = count();
      $('#gsInfo').innerHTML = `Push: ${f.push_n} ${UI.plural(f.push_n, 'klientka', 'klientki', 'klientek')} z aplikacją. SMS: ${f.sms_n} ${UI.plural(f.sms_n, 'klientka', 'klientki', 'klientek')} (najwyżej 2 SMS-y w tygodniu na klientkę). Tylko klientki ze zgodą na powiadomienia i bez wizyty tego dnia. Kto pierwsza stuknie „Biorę”, ta ma termin i dodatkową pieczątkę.`;
      const b = $('#gsSend');
      b.textContent = picked.size ? 'Wyślij do ' + n + ' ' + UI.plural(n, 'klientki', 'klientek', 'klientek') : 'Zaznacz godzinę';
      b.disabled = !picked.size || !n;
    };
    sheetIn.querySelectorAll('[data-w]').forEach((b) => b.addEventListener('click', () => {
      const i = +b.dataset.w;
      if (picked.has(i)) picked.delete(i); else picked.add(i);
      b.setAttribute('aria-checked', String(picked.has(i)));
      b.querySelector('.pick__price').textContent = picked.has(i) ? '✓' : '';
      upd();
    }));
    sheetIn.querySelectorAll('[data-ch]').forEach((b) => b.addEventListener('click', () => {
      gapChannel = b.dataset.ch;
      sheetIn.querySelectorAll('[data-ch]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      upd();
    }));
    $('#gsSend').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      try {
        const r = await Api.gapSendNow(f.day, free.filter((w, i) => picked.has(i)).map((w) => ({ start_at: w.start_at, end_at: w.end_at })), gapChannel);
        toast('Oferta wysłana do ' + r.sent + ' ' + UI.plural(r.sent, 'klientki', 'klientek', 'klientek') + ' (push: ' + r.push + ', SMS: ' + r.sms + ').');
        closeSheet(); loadGaps();
      } catch (ex) { const el = $('#gsErr'); el.textContent = ex.message; el.hidden = false; btn.disabled = false; }
    });
    upd();
  }
  // Po odwołaniu: SMS automatycznie przez SMSPLANET albo tylko push (SMS-y z mojego telefonu)
  async function loadGapAuto() {
    const box = $('#gapAuto');
    if (!box) return;
    let on;
    try { on = await Api.gapSmsAutoGet(); } catch (e) { box.innerHTML = ''; return; } // baza jeszcze bez sms-z-telefonu.sql
    box.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line-soft)">
      <span class="eyebrow">SMS po odwołaniu wizyty</span>
      <div class="tabs tabs--small" role="radiogroup" aria-label="SMS po odwołaniu wizyty">
        <button role="radio" data-auto="1" aria-selected="${on}">Sam (SMSPLANET)</button>
        <button role="radio" data-auto="0" aria-selected="${!on}">Z mojego telefonu</button>
      </div>
      <span class="small">${on ? 'Push i SMS wychodzą same, SMS-y z kredytów SMSPLANET.' : 'Sam wychodzi tylko push. SMS-y wyślesz z telefonu: „SMS z mojego telefonu” przy wysłanej ofercie.'}</span>
    </div>`;
    box.querySelectorAll('[data-auto]').forEach((b) => b.addEventListener('click', async () => {
      try { await Api.gapSmsAutoSet(b.dataset.auto === '1'); loadGapAuto(); } catch (e) { toast(e.message); }
    }));
  }

  // Pieczątka za opinię w Google (test z włącznikiem)
  async function loadReviewStamp() {
    const box = $('#reviewStampBox');
    if (!box) return;
    let on;
    try { on = await Api.reviewStampGet(); } catch (e) { box.innerHTML = ''; return; } // baza jeszcze bez opinie-google.sql
    box.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line-soft)">
      <span class="eyebrow">Pieczątka za opinię w Google</span>
      <div class="tabs tabs--small" role="radiogroup" aria-label="Pieczątka za opinię w Google">
        <button role="radio" data-rs="1" aria-selected="${on}">Włączona</button>
        <button role="radio" data-rs="0" aria-selected="${!on}">Wyłączona</button>
      </div>
      <span class="small">${on ? 'Klientka dostaje +1 pieczątkę raz, gdy oznaczy na karcie „Już wystawiłam opinię” (albo Ty w panelu).' : 'Prośby o opinię wychodzą dalej, ale bez pieczątki.'}</span>
    </div>`;
    box.querySelectorAll('[data-rs]').forEach((b) => b.addEventListener('click', async () => {
      try { await Api.reviewStampSet(b.dataset.rs === '1'); loadReviewStamp(); } catch (e) { toast(e.message); }
    }));
  }

  // SMS-y z mojego telefonu: przy każdej klientce link sms: z gotowym numerem i treścią
  async function openGapPhone(offerId) {
    let r;
    try { r = await Api.gapSmsRecipients(offerId); } catch (e) { toast(e.message); return; }
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const href = (tel) => 'sms:' + tel + (ios ? '&' : '?') + 'body=' + encodeURIComponent(r.msg || '');
    const left = () => r.list.filter((c) => !c.done).length;
    const row = (c) => `<div class="list-row" style="gap:12px${c.done ? ';opacity:.55' : ''}" data-row="${esc(c.card_id)}">
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0"><span class="strong">${esc(c.name)}</span><span class="small">${esc(c.phone)}</span></div>
        ${c.done ? '<span class="small gold" style="flex:0 0 auto">✓ wysłany</span>' : `<a class="btn btn--gold btn--sm" style="flex:0 0 auto;width:auto" href="${esc(href(c.tel))}" data-sms="${esc(c.card_id)}">SMS</a>`}
      </div>`;
    const paint = () => {
      $('#gpLeft').textContent = r.list.length ? 'Zostało ' + left() + ' z ' + r.list.length + '.' : '';
      $('#gpList').innerHTML = r.list.length ? r.list.map(row).join('') : '<p class="small" style="margin:0">Brak klientek ze zgodą na SMS i polskim numerem.</p>';
      sheetIn.querySelectorAll('[data-sms]').forEach((a) => a.addEventListener('click', () => {
        const c = r.list.find((x) => x.card_id === a.dataset.sms);
        // najpierw otwiera się aplikacja SMS, a panel odhacza klientkę w tle
        setTimeout(async () => { try { await Api.gapSmsMark(offerId, c.card_id); c.done = true; paint(); } catch (e) { toast(e.message); } }, 300);
      }));
    };
    openSheet(`${bar('SMS z mojego telefonu')}
      ${r.msg ? `<p class="lead" style="margin-top:-8px">Stuknij „SMS”. Otworzy się Twoja aplikacja do wiadomości z gotowym numerem i treścią, wystarczy „Wyślij”. Potem wróć tutaj do kolejnej klientki.</p>
      <div class="hint">${esc(r.msg)}</div>
      <p class="small" id="gpLeft" style="margin:0"></p>
      <div class="panel panel--tight" id="gpList"></div>
      <p class="small" style="margin:0">Każda klientka dostaje osobnego SMS-a, nikt nie widzi cudzych numerów. Tylko klientki ze zgodą, z polskim numerem i bez wizyty tego dnia.</p>`
      : '<p class="lead" style="margin-top:-8px">Ten termin jest już zajęty albo minął, więc nie ma czego wysyłać.</p><p id="gpLeft" hidden></p><div id="gpList" hidden></div>'}`);
    if (r.msg) paint();
  }

  // „do 3 h” – ile czasu jest w oknie
  function gapLen(w) {
    const m = Math.round((new Date(w.end_at) - new Date(w.start_at)) / 6e4);
    return m >= 60 ? (m % 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m / 60 + ' h') + ' wolnego' : m + ' min wolnego';
  }

  // ---------- dni wolne studia (prośby o termin i wolne terminy je omijają) ----------
  let absences = [];
  const absTime = (a) => a.time_from ? a.time_from + '–' + a.time_to : 'cały dzień';
  const absDays = (a) => {
    const short = (d) => new Date(d + 'T12:00:00').toLocaleDateString('pl-PL', { weekday: 'short', day: 'numeric', month: 'long' });
    return a.day_from === a.day_to ? short(a.day_from) : short(a.day_from) + ' – ' + short(a.day_to);
  };
  // „wolne” / „wolne 12:00–15:00” dla dnia planu, null = dzień pracy
  const absenceNote = (d) => {
    const a = absences.find((x) => x.day_from <= d && d <= x.day_to);
    return a ? 'wolne' + (a.time_from ? ' ' + absTime(a) : '') : null;
  };
  const offBanner = (txt) => `<div class="panel panel--gold" style="padding:12px 16px;margin-bottom:8px"><span class="small" style="color:var(--text)">Masz ${esc(txt === 'wolne' ? 'ten dzień wolny' : txt)}. Klientki nie mogą prosić o termin w tym czasie.</span></div>`;
  const clashText = (c) => dateLabel(c.day) + (c.start_at ? ', ' + hhmm(c.start_at) : '') + ' · ' + c.name + (c.service ? ' · ' + c.service : '') + (c.booksy ? ' (Booksy)' : '');
  async function loadAbsences() {
    try { absences = await Api.absenceList(); } catch (e) { absences = []; } // baza jeszcze bez dni wolnych
    const box = $('#absences');
    if (!box) return;
    box.innerHTML = absences.length ? `<div class="panel panel--tight">${absences.map((a) => `<div class="list-row" style="align-items:flex-start;gap:12px">
        <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
          <span class="strong">${esc(absDays(a))}</span>
          <span class="small">${esc(absTime(a))}${a.note ? ' · ' + esc(a.note) : ''}</span>
          ${(a.clashes || []).length ? `<span class="small gold" style="white-space:normal">W planie ${a.clashes.length === 1 ? 'jest wizyta' : 'są wizyty'} w tym czasie:</span>${a.clashes.map((c) => `<span class="small gold" style="white-space:normal">${esc(clashText(c))}</span>`).join('')}` : ''}
        </div>
        <button class="btn btn--ghost btn--sm" data-abs-del="${a.id}" style="flex:0 0 auto;width:auto">Usuń</button>
      </div>`).join('')}</div>` : '<p class="small" style="margin:0">Nie masz zaplanowanych dni wolnych. Dodaj urlop albo wolne godziny, a aplikacja nie przyjmie na nie próśb o termin i nie zaproponuje ich klientkom.</p>';
    box.querySelectorAll('[data-abs-del]').forEach((b) => b.addEventListener('click', async () => {
      const a = absences.find((x) => String(x.id) === b.dataset.absDel);
      if (!(await UI.ask('Usunąć dzień wolny: ' + absDays(a) + ' (' + absTime(a) + ')? Klientki znów będą mogły prosić o termin w tym czasie.', 'Usuń'))) return;
      try { await Api.absenceDelete(a.id); toast('Dzień wolny usunięty.'); await loadAbsences(); loadPlan(); } catch (e) { fail(e); }
    }));
  }
  function openAbsenceAdd() {
    openSheet(`${bar('Dzień wolny')}
      <p class="lead" style="margin-top:-8px">W tym czasie klientka nie wyśle prośby o termin (zobaczy, że studio jest nieczynne, i najbliższe wolne dni), a oferty wolnych terminów go ominą.</p>
      <form class="panel" id="absForm" novalidate>
        <div class="split" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
          <div class="field"><label for="absFrom">Od</label><input class="input" id="absFrom" style="min-width:0;width:100%" type="date" min="${Rules.dayPL(0)}" value="${Rules.dayPL(1)}"></div>
          <div class="field"><label for="absTo">Do (włącznie)</label><input class="input" id="absTo" style="min-width:0;width:100%" type="date" min="${Rules.dayPL(0)}" value="${Rules.dayPL(1)}"></div>
        </div>
        <label class="check"><input type="checkbox" id="absPart"> <span>Tylko kilka godzin (jeden dzień)</span></label>
        <div class="split" id="absHours" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)" hidden>
          <div class="field"><label for="absTf">Od godziny</label><input class="input" id="absTf" style="min-width:0;width:100%" type="time" step="900" value="12:00"></div>
          <div class="field"><label for="absTt">Do godziny</label><input class="input" id="absTt" style="min-width:0;width:100%" type="time" step="900" value="15:00"></div>
        </div>
        <div class="field"><label for="absNote">Notatka (widzisz tylko Ty)</label><input class="input" id="absNote" maxlength="80" placeholder="np. urlop, szkolenie, lekarz" autocomplete="off"></div>
        <p class="small" style="margin:0">Klientki nie widzą powodu, tylko to, że studio jest nieczynne. <b>Zablokuj ten czas także w Booksy</b>, bo tam aplikacja nie sięga.</p>
        <p class="error" id="absErr" role="alert" hidden></p>
        <button class="btn btn--gold" type="submit" id="absSave">Zapisz dzień wolny</button>
      </form>`);
    const from = $('#absFrom'), to = $('#absTo'), partBox = $('#absPart');
    from.addEventListener('change', () => { if (!to.value || to.value < from.value || partBox.checked) to.value = from.value; });
    partBox.addEventListener('change', () => { $('#absHours').hidden = !partBox.checked; to.disabled = partBox.checked; if (partBox.checked) to.value = from.value; });
    $('#absForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const part = partBox.checked, btn = $('#absSave');
      btn.disabled = true;
      try {
        const r = await Api.absenceAdd({ from: from.value, to: part ? from.value : to.value, timeFrom: part ? $('#absTf').value : null, timeTo: part ? $('#absTt').value : null, note: $('#absNote').value });
        await loadAbsences();
        if (!r.clashes || !r.clashes.length) { toast('Dzień wolny zapisany.'); closeSheet(); return; }
        openSheet(`${bar('Wizyty w czasie wolnego')}
          <p class="lead" style="margin-top:-8px">Dzień wolny zapisany. W planie ${r.clashes.length === 1 ? 'jest wizyta' : 'są wizyty'} w tym czasie. ${r.clashes.length === 1 ? 'Przełóż ją albo odwołaj, bo aplikacja jej nie rusza sama.' : 'Przełóż je albo odwołaj, bo aplikacja ich nie rusza sama.'}</p>
          <div class="panel panel--tight">${r.clashes.map((c) => `<div class="list-row"><span style="white-space:normal;min-width:0">${esc(clashText(c))}</span></div>`).join('')}</div>
          <p class="small">Wizyty z Booksy zmienisz w Booksy. Pozostałe usuniesz z planu krzyżykiem „×” i umówisz z klientką nowy termin.</p>
          <button class="btn btn--gold" data-close>Rozumiem</button>`);
      } catch (ex) { const el = $('#absErr'); el.textContent = ex.message; el.hidden = false; btn.disabled = false; }
    });
  }

  // ---------- prośby o termin (klientki bez Booksy) ----------
  const PART = { any: 'dowolna pora', morning: 'rano (do 12:00)', midday: 'w południe (12–16)', evening: 'po 16:00' };
  const REQ_STATUS = { confirmed: 'potwierdzona', declined: 'nie pasowało', cancelled: 'anulowana przez klientkę' };
  let requests = [];
  async function loadRequests() {
    const box = $('#reqs');
    try { requests = await Api.requestsList(); } catch (e) { requests = []; } // baza jeszcze bez próśb o termin
    if (!box) return;
    const open = requests.filter((r) => r.status === 'new' || r.status === 'suggested');
    const done = requests.filter((r) => r.status !== 'new' && r.status !== 'suggested');
    if (!requests.length) { box.innerHTML = ''; return; }
    const when = (r) => dateLabel(r.pref_day) + ', ' + (r.pref_time ? 'ok. ' + r.pref_time : PART[r.pref_part]);
    const tel = (r) => r.phone.replace(/[^\d+]/g, '');
    box.innerHTML = `
      ${open.length ? `<div class="panel panel--gold" style="padding:14px 16px;gap:10px">
        <span class="eyebrow eyebrow--gold">${open.length === 1 ? 'Nowa prośba o termin' : 'Prośby o termin: ' + open.length}</span>
        ${open.map((r, i) => `<div style="display:flex;flex-direction:column;gap:4px${i ? ';padding-top:10px;border-top:1px solid var(--line-soft)' : ''}">
          <button class="linkbtn" style="text-align:left;text-decoration:none;color:var(--text);font-weight:600" data-open="${esc(r.card_id)}">${esc(r.name)} <span class="small">· ${r.stamps}/10</span>${r.move_of ? ' <span class="tag">przełożenie</span>' : ''}${r.status === 'suggested' ? ' <span class="tag">czeka na wybór klientki</span>' : r.conflict ? ' <span class="tag tag--solid">konflikt</span>' : ''}</button>
          ${r.move_from ? `<span class="small" style="color:var(--text-2)">Obecny termin: ${esc(dateLabel(r.move_from.day) + (r.move_from.start_at ? ', ' + hhmm(r.move_from.start_at) : ''))}. Zniknie z planu po potwierdzeniu nowego.</span>` : ''}
          <span class="strong gold">${esc(when(r))}</span>
          ${r.conflict ? `<span class="small" style="color:var(--text)">${esc(r.conflict)}</span>` : ''}
          ${r.status === 'suggested' ? `<span class="small" style="color:var(--text-2)">Zaproponowałam: ${esc((r.suggestions || []).map((iso) => dateLabel(dayOf(iso)) + ' ' + hhmm(iso)).join(' · '))}</span>` : ''}
          <span class="small" style="color:var(--text-2)">${esc(r.service || 'rytuał do ustalenia')} · ${esc(r.phone)} · wysłana ${esc(UI.fmtShort(r.created_at))}</span>
          ${r.message ? `<span class="small" style="color:var(--text);font-style:italic">„${esc(r.message)}”</span>` : ''}
          <div class="btn-row" style="margin-top:4px">
            <a class="btn btn--line btn--sm" href="tel:${esc(tel(r))}">Zadzwoń</a>
            <a class="btn btn--line btn--sm" href="${esc(reqSms(r))}">SMS</a>
          </div>
          <div class="btn-row">
            <button class="btn btn--gold btn--sm" data-req-ok="${r.id}">Potwierdź termin</button>
            <button class="btn btn--ghost btn--sm" data-req-no="${r.id}">Nie pasuje</button>
          </div>
        </div>`).join('')}
      </div>` : ''}
      ${done.length ? `<details class="panel" style="padding:14px 16px;gap:8px">
        <summary class="eyebrow" style="cursor:pointer">Prośby o termin · załatwione (14 dni): ${done.length}</summary>
        <div style="display:flex;flex-direction:column;gap:2px;margin-top:8px">${done.map((r) => `<button class="list-row" data-open="${esc(r.card_id)}" style="width:100%;background:none;border:none;border-bottom:1px solid var(--line-soft);color:inherit;text-align:left;padding:10px 0;flex-direction:column;align-items:flex-start;gap:2px"><span>${esc(r.name)}</span><span class="small">${r.status === 'confirmed' || r.confirmed_at ? esc(dateLabel(dayOf(r.confirmed_at)) + ', ' + hhmm(r.confirmed_at)) : esc(when(r))} · ${esc(r.status === 'cancelled' && r.reply ? r.reply.toLowerCase() : (r.move_of && r.status === 'confirmed' ? 'przełożona' : REQ_STATUS[r.status]))}</span></button>`).join('')}</div>
      </details>` : ''}`;
    box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openCard(b.dataset.open)));
    box.querySelectorAll('[data-req-ok]').forEach((b) => b.addEventListener('click', () => openConfirm(requests.find((r) => r.id === +b.dataset.reqOk))));
    box.querySelectorAll('[data-req-no]').forEach((b) => b.addEventListener('click', () => openDecline(requests.find((r) => r.id === +b.dataset.reqNo))));
    if (location.hash === '#prosby' && open.length) { history.replaceState(null, '', location.pathname); box.scrollIntoView({ block: 'start' }); }
  }
  const dayOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Warsaw' });
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
  function reqSms(r) {
    const text = 'Dzień dobry, ' + r.name.split(' ')[0] + '! Dziękuję za prośbę o termin w studiu ' + CFG.STUDIO_NAME +
      (r.service ? ' (' + r.service + ')' : '') + '. ';
    return 'sms:' + r.phone.replace(/[^\d+]/g, '') + '?&body=' + encodeURIComponent(text);
  }

  // potwierdzenie: dzień i godzina trafiają do planu dnia, klientka dostaje powiadomienie
  function openConfirm(r) {
    const services = CFG.SERVICES.map((x) => `<option${x === r.service ? ' selected' : ''}>${esc(x)}</option>`).join('');
    openSheet(`${bar('Potwierdź termin')}
      <p class="lead" style="margin-top:-8px">${esc(r.name)} prosi o: ${esc(dateLabel(r.pref_day))}, ${esc(r.pref_time ? 'ok. ' + r.pref_time : PART[r.pref_part])}.</p>
      <form class="panel" id="okForm">
        <div class="split">
          <div class="field"><label for="okDay">Dzień</label><input class="input" id="okDay" type="date" min="${Rules.dayPL(0)}" max="${Rules.dayPL(60)}" value="${esc(r.pref_day < Rules.dayPL(0) ? Rules.dayPL(0) : r.pref_day)}"></div>
          <div class="field"><label for="okTime">Godzina</label><input class="input" id="okTime" type="time" step="900" value="${esc(r.pref_time || '')}" required></div>
        </div>
        <div class="field"><label for="okSvc">Rytuał</label><select class="input" id="okSvc"><option value="">${esc(r.service || 'do ustalenia')}</option>${services}</select></div>
        <p class="error" id="okWarn" role="status" hidden style="margin:0"></p>
        <p class="small" style="margin:0">Wizyta wejdzie do planu dnia, a klientka zobaczy ją na karcie i dostanie powiadomienie oraz SMS.${r.move_from ? ' Stary termin zniknie z planu.' : ''} <b>Wpisz ten termin także w Booksy</b>${r.move_from ? ' (i usuń tam stary)' : ''}, żeby nikt inny go nie zarezerwował.</p>
        <p class="error" id="okErr" role="alert" hidden></p>
        <button class="btn btn--gold" type="submit">Potwierdź</button>
      </form>`);
    // ostrzeżenie o kolizji z planem dnia (nie blokuje potwierdzenia)
    const warn = async () => {
      const el = $('#okWarn'); if (!el) return;
      const day = $('#okDay').value, time = $('#okTime').value;
      let res = null;
      if (day && time) { try { res = await Api.slotConflict(day, time, $('#okSvc').value || r.service); } catch (ex) { res = null; } }
      el.textContent = res ? 'Uwaga: ' + res : ''; el.hidden = !res;
    };
    ['#okDay', '#okTime', '#okSvc'].forEach((id) => $(id).addEventListener('change', warn));
    warn();
    $('#okForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await Api.requestConfirm(r.id, $('#okDay').value, $('#okTime').value, $('#okSvc').value || r.service);
        toast('Termin potwierdzony i dodany do planu.');
        closeSheet(); loadRequests();
      } catch (ex) { const el = $('#okErr'); el.textContent = ex.message; el.hidden = false; }
    });
  }

  function openDecline(r) {
    openSheet(`${bar('Termin nie pasuje')}
      <p class="lead" style="margin-top:-8px">${esc(r.name)} · ${esc(dateLabel(r.pref_day))}. Odpowiedź zobaczy na karcie i w powiadomieniu.</p>
      <form class="panel" id="noForm">
        <div class="field"><label for="noMsg">Odpowiedź dla klientki</label><textarea class="input" id="noMsg" rows="3" maxlength="300">Ten termin jest już zajęty. Wolne mam np. </textarea></div>
        <p class="error" id="noErr" role="alert" hidden></p>
        <button class="btn btn--gold" type="submit">Wyślij odpowiedź</button>
      </form>`);
    $('#noForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await Api.requestDecline(r.id, $('#noMsg').value);
        toast('Odpowiedź wysłana.');
        closeSheet(); loadRequests();
      } catch (ex) { const el = $('#noErr'); el.textContent = ex.message; el.hidden = false; }
    });
  }

  // ---------- program poleceń ----------
  // refs: lista poleceń z bazy; refWelcome: karty z czekającym −10% (znaczek w planie dnia)
  let refs = [], refWelcome = new Set();
  const REF_SEEN = 'tctd.refSeen';
  const refSeen = () => { try { return localStorage.getItem(REF_SEEN) || ''; } catch (e) { return ''; } };
  async function loadRefs() {
    try { refs = await Api.referralsList(); } catch (e) { refs = []; } // baza jeszcze bez programu poleceń
    refWelcome = new Set(refs.filter((r) => r.ref_welcome).map((r) => r.id));
    const box = $('#refs');
    if (!box || !refs.length) { if (box) box.innerHTML = ''; return; }
    const seen = refSeen();
    const fresh = refs.filter((r) => !seen || r.created_at > seen);
    const status = (r) => !r.ref_rewarded_at ? '<span class="gold">czeka na 1. wizytę · −10%</span>'
      : 'była ✓ · pieczątka dla ' + esc(r.referrer_name.split(/\s+/)[0]) + (r.ref_welcome ? ' · −10% jeszcze na pojedynczy rytuał' : '');
    box.innerHTML = `
      ${fresh.length ? `<div class="panel panel--gold" style="padding:14px 16px;gap:8px">
        <span class="eyebrow eyebrow--gold">${fresh.length === 1 ? 'Nowa karta z polecenia' : 'Nowe karty z polecenia: ' + fresh.length}</span>
        ${fresh.map((r) => `<button class="linkbtn" style="text-align:left;text-decoration:none;color:var(--text)" data-open="${esc(r.id)}"><b>${esc(r.name)}</b> · poleciła ją ${esc(r.referrer_name)} · <span class="gold">pierwszy rytuał −10%</span></button>`).join('')}
        <button class="btn btn--line btn--sm" id="refSeenBtn">OK, widzę</button>
      </div>` : ''}
      <details class="panel" style="padding:14px 16px;gap:8px">
        <summary class="eyebrow" style="cursor:pointer">Program poleceń · ${refs.length} ${UI.plural(refs.length, 'polecenie', 'polecenia', 'poleceń')}${refWelcome.size ? ' · ' + refWelcome.size + ' z −10%' : ''}</summary>
        <div style="display:flex;flex-direction:column;gap:2px;margin-top:8px">${refs.map((r) => `<button class="list-row" data-open="${esc(r.id)}" style="width:100%;background:none;border:none;border-bottom:1px solid var(--line-soft);color:inherit;text-align:left;padding:10px 0;flex-direction:column;align-items:flex-start;gap:2px"><span>${esc(r.name)} <span class="small">← ${esc(r.referrer_name)}</span></span><span class="small">${UI.fmtShort(r.created_at)} · ${status(r)}</span></button>`).join('')}</div>
      </details>`;
    box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openCard(b.dataset.open)));
    const sb = $('#refSeenBtn');
    if (sb) sb.addEventListener('click', () => { try { localStorage.setItem(REF_SEEN, refs[0].created_at); } catch (e) { /* ignore */ } loadRefs(); });
  }

  // Kropka na ikonie aplikacji = powiadomienie, które wciąż wisi na pasku telefonu.
  // Po wejściu do panelu pokazujemy, czego dotyczyło, i zdejmujemy je z paska (kropka znika).
  const PUSH_SEEN = 'tctd.pushSeen';
  const pushTime = (iso) => {
    const d = new Date(iso), t = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    const day = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
    return day === Rules.dayPL(0) ? 'dziś ' + t : day === Rules.dayPL(-1) ? 'wczoraj ' + t : d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' }) + ' ' + t;
  };
  async function readPushLog() {
    try {
      const c = await caches.open('powiadomienia');
      const r = await c.match('dziennik.json');
      return r ? await r.json() : [];
    } catch (e) { return []; }
  }
  async function loadPushLog() {
    const box = $('#pushLog');
    if (!box || !('serviceWorker' in navigator)) return;
    let reg = null, shown = [];
    try { reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 3000))]); } catch (e) { reg = null; }
    try { shown = reg && reg.getNotifications ? await reg.getNotifications() : []; } catch (e) { shown = []; }
    const log = await readPushLog();
    let seen = '';
    try { seen = localStorage.getItem(PUSH_SEEN) || ''; } catch (e) { /* ignore */ }
    const fresh = log.filter((n) => !seen || n.at > seen);
    // powiadomienia z paska, które przyszły jeszcze przed tą wersją (bez wpisu w dzienniku)
    shown.forEach((n) => {
      if (!fresh.some((f) => f.title === n.title && f.body === n.body)) fresh.push({ title: n.title, body: n.body, at: new Date(n.timestamp || Date.now()).toISOString() });
    });
    fresh.sort((a, b) => (a.at < b.at ? 1 : -1));
    // treść jest już w panelu, więc zdejmujemy powiadomienia z paska i kropkę z ikony
    shown.forEach((n) => { try { n.close(); } catch (e) { /* ignore */ } });
    try { if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch (e) { /* ignore */ }
    if (!document.body.contains(box)) return;
    if (!fresh.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="panel panel--gold" style="padding:14px 16px;gap:10px">
      <span class="eyebrow eyebrow--gold">${fresh.length === 1 ? 'Nowe powiadomienie' : 'Nowe powiadomienia: ' + fresh.length}</span>
      ${fresh.slice(0, 10).map((n) => `<div style="display:flex;flex-direction:column;gap:2px;border-bottom:1px solid var(--line-soft);padding-bottom:8px">
        <span><b>${esc(n.title || 'Powiadomienie')}</b> <span class="small">· ${esc(pushTime(n.at))}</span></span>
        ${n.body ? `<span class="small" style="color:var(--text-2);white-space:pre-line">${esc(n.body)}</span>` : ''}
      </div>`).join('')}
      <button class="btn btn--line btn--sm" id="pushSeenBtn">OK, widzę</button>
    </div>`;
    $('#pushSeenBtn').addEventListener('click', () => {
      try { localStorage.setItem(PUSH_SEEN, new Date().toISOString()); } catch (e) { /* ignore */ }
      box.innerHTML = '';
    });
  }

  // Powiadomienia dla studia na tym telefonie: włącza się raz, nie codziennie (sekcja na dole panelu).
  async function loadOwnerPush() {
    const box = $('#ownerPushBox');
    if (!box || !('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) return;
    let sub = null;
    try {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 3000))]);
      sub = reg ? await reg.pushManager.getSubscription() : null;
    } catch (e) { sub = null; }
    if (!document.body.contains(box)) return;
    const perm = Notification.permission, on = perm === 'granted' && !!sub;
    box.hidden = false;
    box.innerHTML = `<span class="eyebrow">Ustawienia · powiadomienia studia</span>
      <span class="small" style="color:var(--text-2)">${on ? '<span class="gold">Włączone na tym telefonie.</span> Nie trzeba ich klikać codziennie: telefon sam dostaje wieczorny przegląd jutrzejszego dnia i urodzin oraz nowe prośby o termin.'
        : perm === 'denied' ? 'Zablokowane w ustawieniach telefonu dla tej strony. Odblokuj powiadomienia w ustawieniach przeglądarki, a potem wróć tutaj.'
        : 'Wyłączone na tym telefonie. Włącz raz, a telefon będzie dostawał wieczorny przegląd jutrzejszego dnia i urodzin oraz nowe prośby o termin.'}</span>
      ${perm === 'denied' ? '' : `<button class="btn btn--line btn--sm" id="ownerPushBtn" style="align-self:flex-start">${on ? 'Włącz ponownie (gdyby nie przychodziły)' : 'Włącz powiadomienia'}</button>`}`;
    const log = await readPushLog();
    if (log.length && document.body.contains(box)) box.insertAdjacentHTML('beforeend', `<details style="margin-top:4px">
      <summary class="small" style="cursor:pointer">Historia powiadomień na tym telefonie (${log.length})</summary>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">${log.map((n) => `<div style="display:flex;flex-direction:column;gap:2px"><span class="small"><b>${esc(n.title || 'Powiadomienie')}</b> · ${esc(pushTime(n.at))}</span>${n.body ? `<span class="small" style="color:var(--text-2);white-space:pre-line">${esc(n.body)}</span>` : ''}</div>`).join('')}</div>
    </details>`);
    const b = $('#ownerPushBtn');
    if (b) b.addEventListener('click', enableOwnerPush);
  }
  async function enableOwnerPush() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { UI.toast('Bez zgody powiadomień nie będzie.'); return renderHome(); }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(CFG.PUSH_PUBLIC_KEY) });
      await Api.saveStaffPush(sub.toJSON());
      UI.toast('Powiadomienia dla studia włączone na tym telefonie.');
      renderHome();
    } catch (e) { fail(e); }
  }
  function base64ToBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  }

  async function loadPlan() {
    const box = $('#plan');
    if (!box) return;
    let plan;
    const day = planDay;
    try { plan = day < 2 ? await Api.planList(Rules.dayPL(day)) : await Api.planRange(Rules.dayPL(2), Rules.dayPL(PLAN_AHEAD)); } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; return; }
    if (day !== planDay) return; // w międzyczasie wybrano inny dzień
    if (!plan.length && day < 2 && absenceNote(Rules.dayPL(day))) { box.innerHTML = offBanner(absenceNote(Rules.dayPL(day))); return; }
    if (!plan.length) { box.innerHTML = '<div class="panel" style="padding:16px"><span class="small">' + (day < 2 ? 'Na ' + DAY_NAME[day] + ' nikogo jeszcze nie dodano.' : 'Na kolejne ' + PLAN_AHEAD + ' dni nie ma jeszcze żadnych wizyt.') + '</span></div>'; return; }
    const todo = plan.filter((p) => p.status === 'planned').length;
    const hhmm = (iso) => new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    const row = (p) => {
      const done = p.status !== 'planned';
      const tags = (p.booking_id ? ' <span class="tag">Booksy</span>' : '') + (p.conflict ? ' <span class="tag">kolizja</span>' : '') +
        (!day && p.bday_today && p.birthday_used_year !== Rules.todayPL().y ? ' <span class="tag tag--solid">urodziny</span>' : '') +
        (refWelcome.has(p.card_id) && !done ? ' <span class="tag tag--solid">z polecenia −10%</span>' : '');
      const meta = (p.start_at ? hhmm(p.start_at) + ' · ' : done || p.booking_id ? '' : 'bez godziny · ') + (p.service || 'rytuał') + ' · ' +
        (!p.card_id ? 'bez karty, przypisz w Integracjach' : done ? (MODE_LABEL[p.status] || p.status) : p.stamps + '/10' + (p.stamps === 4 ? (day ? ' · −15%' : ' · teraz −15%') : p.stamps === 9 ? (day ? ' · −30%' : ' · teraz −30%') : ''));
      const target = p.card_id ? `data-open="${esc(p.card_id)}" data-plan="${day ? '' : esc(p.id)}"` : 'data-integr="1"';
      const timeLink = done ? '' : `<button class="linkbtn" data-plan-edit="${esc(p.id)}" style="flex-basis:100%;text-align:left;min-height:34px;padding:0 6px 4px 58px;font-size:13.5px">${p.booking_id ? 'Usuń z planu' : p.start_at ? 'Przesuń lub usuń wizytę' : 'Ustaw godzinę, przesuń lub usuń'}</button>`;
      return `<div class="client" style="flex-wrap:wrap;row-gap:0">
        <button class="client__main" ${target} style="${done ? 'opacity:.6' : ''}">
          <span class="avatar" style="${done ? 'background:var(--gold);color:var(--on-gold);border-color:var(--gold)' : ''}">${done ? '✓' : esc(UI.initials(p.name))}</span>
          <span><span class="client__name">${esc(p.name)}${tags}</span>
          <span class="client__meta">${esc(meta)}</span></span>
        </button>
        ${done ? '' : `<button class="plus plus--ghost" data-plan-del="${esc(p.id)}" aria-label="Usuń z planu: ${esc(p.name)}">×</button>${day || !p.card_id ? '' : `<button class="plus" data-open="${esc(p.card_id)}" data-plan="${esc(p.id)}" aria-label="Zapisz wizytę: ${esc(p.name)}">›</button>`}`}
        ${timeLink}
      </div>`;
    };
    if (day < 2) {
      const off = absenceNote(Rules.dayPL(day));
      box.innerHTML = (off ? offBanner(off) : '') + '<div class="panel panel--tight">' + plan.map(row).join('') + '</div>' + (todo || day ? '' : '<p class="small gold" style="margin:8px 0 0">Wszystkie wizyty z planu są zapisane.</p>');
    } else {
      // kolejne dni: wizyty pogrupowane według dnia
      const days = [...new Set(plan.map((p) => p.day))];
      box.innerHTML = '<div style="display:flex;flex-direction:column;gap:12px">' + days.map((d) => {
        const list = plan.filter((p) => p.day === d);
        const off = absenceNote(d);
        return `<div style="display:flex;flex-direction:column;gap:6px"><span class="small">${esc(dateLabel(d).replace(/^./, (ch) => ch.toUpperCase()))} · ${list.length} ${list.length === 1 ? 'wizyta' : list.length < 5 ? 'wizyty' : 'wizyt'}${off ? ' <span class="tag">' + esc(off) + '</span>' : ''}</span><div class="panel panel--tight">${list.map(row).join('')}</div></div>`;
      }).join('') + '</div>';
    }
    box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openCard(b.dataset.open, +b.dataset.plan || b.dataset.plan)));
    box.querySelectorAll('[data-integr]').forEach((b) => b.addEventListener('click', () => { tab = 'integr'; renderHome(); window.scrollTo(0, 0); }));
    const pick = (id) => { const p = plan.find((x) => String(x.id) === id); if (p && !p.day) p.day = Rules.dayPL(day); return p; };
    box.querySelectorAll('[data-plan-edit]').forEach((b) => b.addEventListener('click', () => {
      const p = pick(b.dataset.planEdit);
      if (p && p.booking_id) openPlanCancel(p); else openPlanEdit(p);
    }));
    // odwołana wizyta: usunięcie z planu (karta i pieczątki zostają bez zmian)
    box.querySelectorAll('[data-plan-del]').forEach((b) => b.addEventListener('click', () => openPlanCancel(pick(b.dataset.planDel))));
  }

  // kto ma kartę w aplikacji (otwartą z ikony); null = baza jeszcze bez tej funkcji, wtedy jak dawniej
  let appMap = null;
  async function loadAppStatus() {
    try { appMap = await Api.appStatus(); } catch (e) { appMap = null; }
  }
  const hasApp = (c) => appMap ? !!appMap[c.id] : c.source !== 'studio';

  async function loadList() {
    const box = $('#list');
    if (!box) return;
    let list;
    try { [list] = await Promise.all([Api.listCards(query), loadAppStatus()]); } catch (e) { box.innerHTML = '<p class="error" style="padding:12px">' + esc(e.message) + '</p>'; return; }
    const y = Rules.todayPL().y;
    const bdays = list.filter((c) => c.bday_today);
    const bBox = $('#bdays');
    if (bBox && !query) {
      bBox.innerHTML = bdays.length ? `<div class="panel panel--gold" style="padding:14px 16px;gap:6px"><span class="eyebrow eyebrow--gold">Urodziny dziś</span>${bdays.map((c) => `<button class="linkbtn" style="text-align:left;text-decoration:none;color:var(--text)" data-open="${esc(c.id)}">${esc(c.name)} · ${c.birthday_used_year === y ? 'rabat już wykorzystany' : '<span class="gold">−20% na dzisiejszy rytuał</span>'}</button>`).join('')}</div>` : '';
      bBox.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openCard(b.dataset.open)));
    }
    if (!list.length) { box.innerHTML = '<p class="small" style="padding:14px 4px">' + (query ? 'Brak klientek o tej nazwie.' : 'Nie ma jeszcze żadnych kart.') + '</p>'; return; }
    const appCount = appMap && !query ? `<p class="small" style="padding:10px 4px 2px;margin:0">Aplikację ma ${list.filter(hasApp).length} z ${list.length} klientek.</p>` : '';
    box.innerHTML = appCount + list.map((c) => {
      const tag = (c.bday_today ? ' · urodziny dziś' : c.stamps === 4 ? ' · następna −15%' : c.stamps === 9 ? ' · następna −30%' : c.stamps >= 10 ? ' · karta pełna' : '') + (hasApp(c) ? '' : ' · bez aplikacji');
      return `<div class="client">
        <button class="client__main" data-open="${esc(c.id)}">
          <span class="avatar">${esc(UI.initials(c.name))}</span>
          <span><span class="client__name">${esc(c.name)}</span><span class="client__meta">${c.stamps} / 10 pieczątek${esc(tag)}</span></span>
        </button>
        <button class="plus" data-plan-add="${esc(c.id)}" aria-label="Dodaj ${esc(c.name)} do planu na ${esc(targetName())}">+</button>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openCard(b.dataset.open)));
    box.querySelectorAll('[data-plan-add]').forEach((b) => b.addEventListener('click', () => {
      const c = list.find((x) => String(x.id) === b.dataset.planAdd);
      openPlanAdd(c, planTarget());
    }));
  }

  // ---------- godzina wizyty w planie ----------
  const svcOptions = (sel) => CFG.SERVICES.map((x) => `<option${x === sel ? ' selected' : ''}>${esc(x)}</option>`).join('');
  // ostrzeżenie o kolizji z planem / godzinami pracy (nie blokuje zapisu); self = imię tej klientki (jej stara godzina to nie kolizja)
  function timeWarn(dayOf, timeSel, svcSel, warnSel, self, more) {
    const run = async () => {
      const el = $(warnSel); if (!el) return;
      const time = $(timeSel).value, day = typeof dayOf === 'function' ? dayOf() : dayOf;
      let res = null;
      if (day && time) { try { res = await Api.slotConflict(day, time, $(svcSel) ? $(svcSel).value : null); } catch (ex) { res = null; } }
      if (res && self && /^Nakłada się na: /.test(res)) {
        const others = res.replace(/^Nakłada się na: /, '').split(', ').filter((x) => x.indexOf(self + ' ') !== 0);
        res = others.length ? 'Nakłada się na: ' + others.join(', ') : null;
      }
      el.textContent = res ? 'Uwaga: ' + res : ''; el.hidden = !res;
    };
    [timeSel, svcSel, ...(more || [])].forEach((id) => { const el = id && $(id); if (el) el.addEventListener('change', run); });
    run();
  }

  // dodanie do planu: dowolny dzień (do 30 dni naprzód) i godzina; fromCard = wróć do karty klientki po zapisie
  const whenName = (d) => d === Rules.dayPL(0) ? 'dziś' : d === Rules.dayPL(1) ? 'jutro' : dateLabel(d);
  function openPlanAdd(c, day, service, fromCard) {
    if (!c) return;
    openSheet(`${bar('Dodaj do planu')}
      <p class="lead" style="margin-top:-8px">${esc(c.name)}</p>
      <form class="panel" id="paForm" novalidate>
        <div class="split" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
          <div class="field"><label for="paDay">Dzień</label><input class="input" id="paDay" type="date" min="${Rules.dayPL(0)}" max="${Rules.dayPL(PLAN_AHEAD)}" value="${esc(day)}" style="min-width:0;width:100%"></div>
          <div class="field"><label for="paTime">Godzina</label><input class="input" id="paTime" type="time" step="900" style="min-width:0;width:100%"></div>
        </div>
        <span class="small" id="paWhen" style="margin-top:-4px"></span>
        <div class="field"><label for="paSvc">Rytuał</label><select class="input" id="paSvc"><option value="">— wybierz (opcjonalnie) —</option>${svcOptions(service)}</select></div>
        <p class="error" id="paWarn" role="status" hidden style="margin:0"></p>
        <p class="error" id="paErr" role="alert" hidden></p>
        <button class="btn btn--gold" type="submit" id="paSave">Dodaj do planu</button>
      </form>`);
    if (fromCard) {
      const back = sheetIn.querySelector('[data-close]'), fresh = back.cloneNode(true);
      back.replaceWith(fresh); fresh.addEventListener('click', () => renderCard());
    }
    const t = $('#paTime'), d = $('#paDay');
    const label = () => {
      const ok = d.value && d.value >= Rules.dayPL(0) && d.value <= Rules.dayPL(PLAN_AHEAD);
      $('#paWhen').textContent = ok ? whenName(d.value).replace(/^./, (ch) => ch.toUpperCase()) + (t.value ? ', ' + t.value : ', bez godziny') : 'Wybierz dzień od dziś do ' + PLAN_AHEAD + ' dni naprzód.';
      $('#paSave').textContent = t.value ? 'Dodaj na ' + t.value : 'Dodaj bez godziny';
    };
    [t, d].forEach((el) => { el.addEventListener('input', label); el.addEventListener('change', label); });
    label();
    timeWarn(() => d.value, '#paTime', '#paSvc', '#paWarn', null, ['#paDay']);
    $('#paForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#paErr');
      if (!d.value || d.value < Rules.dayPL(0) || d.value > Rules.dayPL(PLAN_AHEAD)) { err.textContent = 'Wybierz dzień od dziś do ' + PLAN_AHEAD + ' dni naprzód.'; err.hidden = false; return; }
      const btn = $('#paSave'); btn.disabled = true;
      try {
        await Api.planAdd(c.id, $('#paSvc').value, d.value, t.value);
        const msg = 'Dodano do planu: ' + whenName(d.value) + (t.value ? ', ' + t.value : '') + '.';
        if (fromCard) renderCard(); else closeSheet();
        toast(msg);
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    });
  }

  // zmiana wizyty dodanej w aplikacji: inny dzień, godzina, rytuał; stąd też usunięcie z planu
  function openPlanEdit(p) {
    if (!p) return;
    const cur = p.start_at ? new Date(p.start_at).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) : '';
    const hasSvc = p.service && CFG.SERVICES.indexOf(p.service) >= 0;
    openSheet(`${bar('Zmień wizytę')}
      <p class="lead" style="margin-top:-8px">${esc(p.name)}</p>
      <p class="small" style="margin:-10px 0 4px">Teraz: ${esc(whenName(p.day))}${cur ? ', ' + esc(cur) : ', bez godziny'}${p.service ? ' · ' + esc(p.service) : ''}</p>
      <form class="panel" id="peForm" novalidate>
        <div class="split" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
          <div class="field"><label for="peDay">Dzień</label><input class="input" id="peDay" type="date" min="${Rules.dayPL(0)}" max="${Rules.dayPL(PLAN_AHEAD)}" value="${esc(p.day)}" style="min-width:0;width:100%"></div>
          <div class="field"><label for="peTime">Godzina</label><input class="input" id="peTime" type="time" step="900" value="${esc(cur)}" style="min-width:0;width:100%"></div>
        </div>
        <div class="field"><label for="peSvc">Rytuał</label><select class="input" id="peSvc">${hasSvc ? '' : `<option value="">${esc(p.service || '— bez zmian —')}</option>`}${svcOptions(p.service)}</select></div>
        <p class="error" id="peWarn" role="status" hidden style="margin:0"></p>
        ${p.card_id ? '<label class="check"><input type="checkbox" id="peSms"> <span>Powiadom klientkę o nowym terminie (SMS i powiadomienie w aplikacji)</span></label>' : ''}
        <p class="small" style="margin:0">Bez zaznaczenia klientka nic nie dostanie. Zwolnione okienko nie idzie samo do innych klientek; zobaczysz je w „Wolne godziny”. Jeśli wizyta jest też w Booksy, zmień ją również tam.</p>
        <p class="error" id="peErr" role="alert" hidden></p>
        <button class="btn btn--gold" type="submit" id="peSave">Zapisz zmianę</button>
      </form>
      <div class="panel" style="padding:14px 16px;gap:8px;margin-top:12px">
        <span class="small">Klientka odwołała albo wizyta trafiła do planu przez pomyłkę?</span>
        <button class="btn btn--line btn--sm" type="button" id="peDel" style="align-self:flex-start">Usuń z planu</button>
      </div>`);
    const d = $('#peDay'), t = $('#peTime');
    const label = () => {
      const changed = d.value !== p.day || t.value !== cur;
      $('#peSave').textContent = !changed ? 'Zapisz zmianę' : 'Przesuń na ' + whenName(d.value || p.day) + (t.value ? ', ' + t.value : '');
    };
    [d, t].forEach((el) => { el.addEventListener('input', label); el.addEventListener('change', label); });
    label();
    timeWarn(() => d.value, '#peTime', '#peSvc', '#peWarn', p.name, ['#peDay']);
    $('#peDel').addEventListener('click', () => openPlanCancel(p));
    $('#peForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#peErr');
      if (!d.value || d.value < Rules.dayPL(0) || d.value > Rules.dayPL(PLAN_AHEAD)) { err.textContent = 'Wybierz dzień od dziś do ' + PLAN_AHEAD + ' dni naprzód.'; err.hidden = false; return; }
      const sms = !!($('#peSms') && $('#peSms').checked);
      const btn = $('#peSave'); btn.disabled = true;
      try {
        const r = await Api.planMove(p, d.value, t.value, $('#peSvc').value, sms);
        closeSheet();
        toast('Wizyta: ' + whenName(d.value) + (t.value ? ', ' + t.value : ', bez godziny') + '.' + (sms ? (r && r.sms ? ' Klientka dostanie SMS.' : ' Brak numeru telefonu, SMS nie poszedł.') : ''));
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    });
  }

  // usunięcie z planu: powód (odwołała / pomyłka) i SMS tylko po zaznaczeniu
  function openPlanCancel(p) {
    if (!p) return;
    const cur = p.start_at ? new Date(p.start_at).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) : '';
    const future = (p.start_at ? new Date(p.start_at) : new Date(p.day + 'T23:59')) > new Date();
    // „Nie przyszła” ma sens od dnia wizyty (godzina już minęła albo wizyta bez godziny dziś)
    const started = p.start_at ? new Date(p.start_at) <= new Date() : p.day <= Rules.dayPL(0);
    openSheet(`${bar('Usuń z planu')}
      <p class="lead" style="margin-top:-8px">${esc(p.name)}</p>
      <p class="small" style="margin:-10px 0 4px">${esc(whenName(p.day))}${cur ? ', ' + esc(cur) : ''}${p.service ? ' · ' + esc(p.service) : ''}</p>
      <form class="panel" id="pcForm" novalidate>
        <span class="eyebrow">Dlaczego usuwasz?</span>
        <label class="check"><input type="radio" name="pcWhy" value="client" checked> <span><b>Klientka odwołała.</b> Wolne okienko może trafić do automatu „Wolne terminy”, tak jak przy odwołaniu w aplikacji. Odwołanie zapisze się w historii odwołań.</span></label>
        ${started ? '<label class="check"><input type="radio" name="pcWhy" value="noshow"> <span><b>Nie przyszła.</b> Bez uprzedzenia. Zapisze się w historii odwołań jako nieodbyta wizyta.</span></label>' : ''}
        <label class="check"><input type="radio" name="pcWhy" value="mistake"> <span><b>Pomyłka w planie.</b> Nikt nie dostanie oferty tego okienka i nic nie trafi do historii odwołań.</span></label>
        ${p.card_id && !p.booking_id && future ? '<label class="check" id="pcSmsRow"><input type="checkbox" id="pcSms"> <span>Wyślij klientce SMS, że wizyta jest odwołana (i powiadomienie w aplikacji)</span></label>' : ''}
        <p class="small" style="margin:0">Karta i pieczątki zostają bez zmian.${p.booking_id ? ' Rezerwację odwołaj też w Booksy, Booksy samo powiadomi klientkę.' : ''}</p>
        <p class="error" id="pcErr" role="alert" hidden></p>
        <button class="btn btn--gold" type="submit" id="pcSave">Usuń z planu</button>
      </form>`);
    // „Nie przyszła”: bez SMS-u o odwołaniu
    sheetIn.querySelectorAll('input[name="pcWhy"]').forEach((r) => r.addEventListener('change', () => {
      const row = $('#pcSmsRow'); if (row) row.hidden = r.value === 'noshow' && r.checked;
    }));
    $('#pcForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const why = (sheetIn.querySelector('input[name="pcWhy"]:checked') || {}).value || 'client';
      const sms = why !== 'noshow' && !!($('#pcSms') && $('#pcSms').checked);
      const btn = $('#pcSave'); btn.disabled = true;
      try {
        const r = await Api.planCancel(p.id, why, sms);
        closeSheet();
        toast((why === 'noshow' ? 'Zapisano: nie przyszła.' : 'Usunięto z planu.') + (sms ? (r && r.sms ? ' Klientka dostanie SMS.' : ' Brak numeru telefonu, SMS nie poszedł.') : ''));
      } catch (ex) { const el = $('#pcErr'); el.textContent = ex.message; el.hidden = false; btn.disabled = false; }
    });
  }

  // ---------- okno ----------
  function openSheet(html) {
    sheetIn.innerHTML = html;
    sheet.hidden = false;
    sheet.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    const back = sheetIn.querySelector('[data-close]');
    if (back) back.addEventListener('click', closeSheet);
  }
  function closeSheet() {
    sheet.hidden = true;
    document.body.style.overflow = '';
    current = null; currentPlan = null;
    if (tab === 'home') { loadPlan(); loadList(); }
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });
  const bar = (title) => `<div class="sheet__bar"><button class="back" data-close>‹ Wróć</button></div><h1 id="sheetTitle">${esc(title)}</h1>`;

  // ---------- karta klientki ----------
  async function openCard(id, planId) {
    currentPlan = planId || null;
    if (currentPlan) {
      try {
        const plan = await Api.planList();
        const p = plan.find((x) => String(x.id) === String(currentPlan));
        if (p && p.service) lastService = p.service;
        if (p && p.status !== 'planned') currentPlan = null;
      } catch (e) { /* bez planu */ }
    }
    try { [current] = await Promise.all([Api.getCard(id), loadAppStatus()]); } catch (e) { return fail(e); }
    if (!current) return toast('Nie znaleziono karty.', 'error');
    renderCard();
  }

  function renderCard(animate) {
    const c = current;
    const y = Rules.todayPL().y;
    const info = UI.nextVisitInfo(c.stamps);
    const full = c.stamps >= 10;
    const bdayAvail = c.bday_today && c.birthday_used_year !== y;
    const services = CFG.SERVICES.map((s) => `<option${s === lastService ? ' selected' : ''}>${esc(s)}</option>`).join('');
    openSheet(`
      ${bar(c.name)}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:-8px">
        <span class="tag">KARTA ${esc(c.code)}</span>
        ${hasApp(c) ? '<span class="tag tag--solid">ma aplikację' + (appMap && appMap[c.id] ? ' · ostatnio ' + esc(UI.fmtShort(appMap[c.id].last)) : '') + '</span>' : '<span class="tag">bez aplikacji</span>'}
        ${c.bday_today ? '<span class="tag tag--solid">urodziny dziś</span>' : ''}
      </div>
      ${currentPlan ? '<p class="small gold" style="margin:0">Wizyta z planu dnia. Po zapisaniu odhaczy się w planie.</p>' : ''}
      ${c.ref_welcome ? `<section class="panel panel--gold" style="gap:6px"><span class="eyebrow eyebrow--gold">Z polecenia${c.referred_by_name ? ' · ' + esc(c.referred_by_name) : ''}</span><span class="strong">Pierwszy pojedynczy rytuał −10%</span><span class="small" style="color:var(--text-2)">Rabat zapisze się sam przy „Pojedynczy rytuał”. Polecająca dostanie pieczątkę po tej wizycie.</span></section>` : ''}
      ${bdayAvail ? `<section class="panel panel--gold bday-today" style="gap:10px"><span class="eyebrow eyebrow--gold">Urodziny dziś · −20%</span><span class="small" style="color:var(--text-2)">Rabat urodzinowy na dzisiejszy rytuał. Nie łączy się z innymi promocjami, więc nie dodaje pieczątki.</span><button class="btn btn--gold" id="bdayBtn">Rytuał urodzinowy −20%</button></section>` : ''}
      <section class="panel">
        <div class="row"><span class="eyebrow eyebrow--gold">Karta rytuałów</span><span class="strong gold" style="font-size:16px">${c.stamps} / 10</span></div>
        ${UI.stampGrid(c.stamps, { small: true, animate })}
        <div class="hint${info.discount ? ' hint--reward' : ''}">${esc(info.text)}</div>
        ${full ? '<button class="btn btn--paper" id="newCardBtn">Rozpocznij nową kartę</button>' : `
          <div class="field"><label for="svc">Rytuał</label><select class="input" id="svc"><option value="">— wybierz (opcjonalnie) —</option>${services}</select></div>
          <span class="label small">Rodzaj wizyty</span>
          <button class="btn btn--gold" data-mode="stamp">Pojedynczy rytuał · +1 pieczątka</button>
          <button class="btn btn--line" data-mode="package_buy">Zakup pakietu · +1 pieczątka</button>`}
        <button class="btn btn--ghost" data-mode="package_visit">Wizyta z pakietu · bez pieczątki</button>
        ${c.stamps > 0 ? '<button class="linkbtn" id="undoBtn" style="align-self:center">Cofnij ostatnią pieczątkę</button>' : ''}
      </section>
      <div class="btn-row">
        ${currentPlan ? '' : '<button class="btn btn--ghost" data-plan-btn="0">+ Plan dziś</button>'}
        <button class="btn btn--ghost" data-plan-btn="1">+ Plan jutro</button>
      </div>
      <button class="btn btn--ghost" data-plan-btn="2" style="margin-top:-6px">+ Plan · inny dzień i godzina</button>
      <section class="panel">
        <span class="eyebrow">Karta w telefonie klientki</span>
        <p class="small" style="margin:0">${!hasApp(c) ? 'Klientka nie ma jeszcze aplikacji. Wyślij jej SMS z linkiem: gdy go otworzy, karta połączy się z aplikacją razem ze wszystkimi pieczątkami.' : 'Link przyda się, gdy klientka zmieni telefon albo usunie aplikację.'}</p>
        <a class="btn btn--line" id="smsBtn" href="#">Wyślij SMS ze stanem karty</a>
        <div class="btn-row">
          <button class="btn btn--ghost btn--sm" id="linkQrBtn">Pokaż kod do połączenia</button>
          <button class="btn btn--ghost btn--sm" id="printBtn">Drukuj kartę</button>
        </div>
        <div id="linkQr" hidden></div>
      </section>
      <section class="panel" style="gap:12px">
        <span class="eyebrow">Dane klientki</span>
        ${c.email ? `<div class="row"><span class="small">E-mail</span><span style="overflow-wrap:anywhere;text-align:right">${esc(c.email)}</span></div>` : ''}
        <div class="row"><span class="small">Telefon</span><span>${c.phone ? `<a href="tel:${esc(c.phone.replace(/\s/g, ''))}">${esc(c.phone)}</a>` : '—'}</span></div>
        <div class="row"><span class="small">Urodziny</span><span>${esc(UI.fmtBday(c.bday_day, c.bday_month) || '—')}${c.birthday_used_year === y ? ' <span class="tag">wykorzystane ' + y + '</span>' : ''}</span></div>
        <label class="check" id="smsOkRow" hidden><input type="checkbox" id="smsOk"> <span>Zgoda na SMS (życzenia urodzinowe przychodzą też SMS-em)</span></label>
        <label class="check" id="reviewRow" hidden><input type="checkbox" id="reviewDone"> <span>Wystawiła opinię w Google (nie dostaje już próśb o opinię)</span></label>
        <div class="row"><span class="small">Karta od</span><span>${esc(UI.fmtDate(c.created_at))}</span></div>
        ${c.referred_by_name ? `<div class="row"><span class="small">Z polecenia</span><span>${esc(c.referred_by_name)}</span></div>` : ''}
        ${c.ref_count ? `<div class="row"><span class="small">Poleciła</span><span>${c.ref_count} ${UI.plural(c.ref_count, 'osobę', 'osoby', 'osób')}${c.ref_rewarded < c.ref_count ? ' · ' + (c.ref_count - c.ref_rewarded) + ' przed wizytą' : ''}</span></div>` : ''}
        ${c.bonus_stamps ? `<div class="hint">Czeka ${c.bonus_stamps} ${UI.plural(c.bonus_stamps, 'pieczątka', 'pieczątki', 'pieczątek')} za polecenie. Dopisze się sama po najbliższej wizycie (nie zajmuje kratki z rabatem).</div>` : ''}
        ${c.cards_completed ? `<div class="row"><span class="small">Ukończone karty</span><span>${c.cards_completed}</span></div>` : ''}
        ${c.note ? `<div class="hint">${esc(c.note)}</div>` : ''}
        <button class="btn btn--ghost btn--sm" id="editBtn">Edytuj dane</button>
      </section>
      <section style="display:flex;flex-direction:column;gap:10px" id="incBox" hidden></section>
      <section style="display:flex;flex-direction:column;gap:10px">
        <span class="eyebrow">Historia wizyt</span>
        <div class="panel panel--tight">${(c.visits || []).length ? c.visits.map((v) => `<div class="list-row"><span>${esc(MODE_LABEL[v.kind])}${v.service ? ' · ' + esc(v.service) : ''}${v.discount ? ' <span class="tag tag--solid">−' + v.discount + '%</span>' : ''}${v.kind === 'package_visit' || v.kind === 'birthday' ? ' <span class="tag">bez pieczątki</span>' : ''}</span><span>${UI.fmtShort(v.created_at)}</span></div>`).join('') : '<p class="small" style="padding:12px 0;margin:0">Brak wizyt.</p>'}</div>
      </section>
      <button class="btn btn--danger btn--sm" id="delBtn" style="align-self:center">Usuń kartę</button>`);

    const svc = () => { const el = $('#svc'); return el ? el.value : ''; };
    sheetIn.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => record(b.dataset.mode, svc(), b)));
    on('#newCardBtn', async () => { try { current = await Api.startNewCard(c.id); toast('Nowa karta: ' + c.name + '. Teraz zapisz dzisiejszą wizytę.'); renderCard(); } catch (e) { fail(e); } });
    on('#undoBtn', async () => {
      if (!(await UI.ask('Cofnąć ostatnią pieczątkę? Klientka: ' + c.name + '.', 'Cofnij'))) return;
      try { current = await Api.removeStamp(c.id); toast('Cofnięto pieczątkę (' + current.stamps + '/10).'); renderCard(); } catch (e) { fail(e); }
    });
    on('#bdayBtn', async () => {
      try { current = await Api.useBirthday(c.id, svc(), currentPlan); current = (await Api.getCard(c.id).catch(() => null)) || current; currentPlan = null; toast('Rabat urodzinowy −20% zapisany: ' + c.name + '.', 'reward'); renderCard(); if (c.referred_by_name && !(c.visits || []).length) refReward(c); } catch (e) { fail(e); }
    });
    document.querySelectorAll('[data-plan-btn]').forEach((b) => b.addEventListener('click', () => {
      const o = +b.dataset.planBtn;
      openPlanAdd(c, o === 2 ? Rules.dayPL(2) : Rules.dayPL(o), svc(), true);
    }));
    on('#editBtn', () => openEdit());
    on('#delBtn', async () => {
      if (!(await UI.ask('Usunąć kartę: ' + c.name + '? Tego nie da się cofnąć.', 'Usuń'))) return;
      try { await Api.deleteCard(c.id); toast('Usunięto kartę.'); closeSheet(); } catch (e) { fail(e); }
    });
    on('#linkQrBtn', () => {
      const box = $('#linkQr');
      box.hidden = !box.hidden;
      box.innerHTML = box.hidden ? '' : `<div class="qr-card">${UI.qrSvg(linkFor(c), { label: 'Kod do połączenia karty z aplikacją' })}<span class="small" style="color:#5C4A24;text-align:center">Klientka skanuje ten kod aparatem w swoim telefonie i dodaje kartę do ekranu telefonu.</span></div>`;
    });
    on('#printBtn', () => printCard(c));
    loadIncidents(c);
    $('#smsBtn').setAttribute('href', smsHref(c));
    const smsOk = $('#smsOk');
    if (c.phone) Api.smsConsent(c.id).then((ok) => { smsOk.checked = !!ok; $('#smsOkRow').hidden = false; }).catch(() => {});
    smsOk.addEventListener('change', async () => {
      try { await Api.setSmsConsent(c.id, smsOk.checked); toast(smsOk.checked ? 'Zapisano zgodę na SMS.' : 'Bez SMS dla tej karty.'); }
      catch (e) { smsOk.checked = !smsOk.checked; fail(e); }
    });
    const revDone = $('#reviewDone');
    Api.reviewDone(c.id).then((ok) => { revDone.checked = !!ok; $('#reviewRow').hidden = false; }).catch(() => {});
    revDone.addEventListener('change', async () => {
      try { await Api.setReviewDone(c.id, revDone.checked); toast(revDone.checked ? 'Zapisano: opinia wystawiona.' : 'Prośby o opinię znów włączone.'); if (revDone.checked) { const fresh = await Api.getCard(c.id).catch(() => null); if (fresh && fresh.stamps !== c.stamps) { current = fresh; Api.notifyStamp(c.id, fresh.stamps).catch(() => {}); toast('Dopisano pieczątkę za opinię: ' + c.name + ' (' + fresh.stamps + '/10).'); renderCard(); } } }
      catch (e) { revDone.checked = !revDone.checked; fail(e); }
    });
  }

  function on(sel, fn) { const el = sheetIn.querySelector(sel); if (el) el.addEventListener('click', fn); }

  // historia odwołań w karcie: automatycznie z Booksy, aplikacji i planu + ręczne wpisy (starsza historia)
  async function loadIncidents(c) {
    let r = null;
    try { r = await Api.incidentsCard(c.id); } catch (e) { r = null; }
    const box = sheetIn.querySelector('#incBox');
    if (!r || !box || current !== c) return; // baza jeszcze bez historii odwołań albo karta już zamknięta
    const list = r.list || [], risk = r.risk || [];
    box.hidden = false;
    box.innerHTML = `
      <span class="eyebrow">Historia odwołań</span>
      ${risk.length ? `<div class="hint hint--error" style="display:flex;flex-direction:column;gap:4px"><span class="strong">Następna wizyta z zadatkiem 50% (regulamin, pkt 5)</span>${risk.map((x) => `<span class="small" style="color:var(--text)">${esc(riskReason(x))}</span>`).join('')}</div>` : ''}
      <div class="panel panel--tight">${list.length ? list.map((i) => `<div class="list-row"><span>${esc(INC_KIND[i.kind] || i.kind)}${i.service ? ' · ' + esc(i.service) : ''} <span class="small">· ${esc(INC_SRC[i.source] || i.source)}${i.note ? ' · ' + esc(i.note) : ''}</span></span><span style="display:flex;align-items:center;gap:6px;white-space:nowrap">${esc(new Date(i.at).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Warsaw' }))}<button class="linkbtn" data-inc-del="${i.id}" aria-label="Usuń wpis" style="min-height:30px;padding:0 4px">×</button></span></div>`).join('') : '<p class="small" style="padding:12px 0;margin:0">Brak odwołań. Tak trzymać!</p>'}</div>
      <button class="btn btn--ghost btn--sm" id="incAddBtn">+ Dopisz odwołanie albo nieobecność</button>`;
    box.querySelector('#incAddBtn').addEventListener('click', () => openIncidentAdd(c));
    box.querySelectorAll('[data-inc-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await UI.ask('Usunąć ten wpis z historii odwołań?', 'Usuń'))) return;
      try { await Api.incidentDelete(+b.dataset.incDel); toast('Usunięto wpis.'); loadIncidents(c); } catch (e) { fail(e); }
    }));
  }

  function openIncidentAdd(c) {
    const back = c;
    openSheet(`${bar('Dopisz do historii odwołań')}
      <p class="lead" style="margin-top:-8px">${esc(c.name)}</p>
      <form class="panel" id="incForm" novalidate>
        <div class="field"><label for="incDay">Dzień wizyty</label><input class="input" id="incDay" type="date" min="2025-01-01" max="${Rules.dayPL(0)}" value="${Rules.dayPL(0)}"></div>
        <span class="eyebrow">Co się stało?</span>
        <label class="check"><input type="radio" name="incKind" value="late" checked> <span>Odwołała później niż 24 h przed wizytą</span></label>
        <label class="check"><input type="radio" name="incKind" value="noshow"> <span>Nie przyszła bez uprzedzenia</span></label>
        <label class="check"><input type="radio" name="incKind" value="cancel"> <span>Odwołała wcześniej niż 24 h przed wizytą</span></label>
        <div class="field"><label for="incNote">Notatka (opcjonalnie)</label><input class="input" id="incNote" maxlength="200" placeholder="np. telefon rano w dniu wizyty"></div>
        <p class="small" style="margin:0">Regulamin liczy dwie nieodbyte wizyty w roku kalendarzowym oraz dwa odwołania pod rząd.</p>
        <p class="error" id="incErr" role="alert" hidden></p>
        <button class="btn btn--gold" type="submit">Zapisz</button>
      </form>`);
    $('#incForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const kind = (sheetIn.querySelector('input[name="incKind"]:checked') || {}).value;
      try {
        await Api.incidentAdd(back.id, $('#incDay').value, kind, $('#incNote').value);
        toast('Zapisano w historii odwołań.');
        current = back; renderCard();
      } catch (ex) { const el = $('#incErr'); el.textContent = ex.message; el.hidden = false; }
    });
  }

  async function record(mode, service, btn) {
    const c = current;
    const n = c.stamps + 1;
    btn.disabled = true;
    try {
      current = await Api.recordVisit(c.id, mode, service, currentPlan);
      current = (await Api.getCard(c.id).catch(() => null)) || current; // pieczątki za polecenie dopisuje baza
      if (mode !== 'package_visit') Api.notifyStamp(c.id, current.stamps).catch(() => {});
      if (service) lastService = service;
      currentPlan = null;
      const first = c.name.split(' ')[0];
      if (mode === 'package_visit') toast('Zapisano wizytę z pakietu (bez pieczątki).');
      else if (mode === 'stamp' && c.ref_welcome && n !== 5 && n !== 10) toast('Pierwszy rytuał z polecenia ' + first + ': nalicz rabat −10%.', 'reward');
      else if (n === 5) toast('5. rytuał ' + first + ': nalicz rabat −15%.', 'reward');
      else if (n === 10) toast('10. rytuał ' + first + ': nalicz rabat −30%.', 'reward');
      else toast('Dodano pieczątkę: ' + c.name + ' (' + n + '/10).');
      renderCard(mode === 'package_visit' ? null : n);
      if (c.referred_by_name && !(c.visits || []).length) refReward(c);
    } catch (e) { btn.disabled = false; fail(e); }
  }

  // pierwsza wizyta koleżanki z polecenia: baza dodała pieczątkę polecającej; pokaż komu i wyślij jej powiadomienie
  async function refReward(c) {
    await loadRefs();
    const r = refs.find((x) => x.id === c.id);
    if (!r || !r.referrer_id) return;
    const head = c.name + ' była pierwszy raz. Poleciła ją ' + r.referrer_name + '. ';
    if (r.referrer_bonus > 0) {
      await UI.ask(head + 'Polecająca ma teraz w kolejce rytuał z rabatem, więc pieczątka za polecenie dopisze się sama po jej najbliższej wizycie.', 'OK', true);
    } else {
      Api.notifyStamp(r.referrer_id, r.referrer_stamps).catch(() => {});
      await UI.ask(head + 'Pieczątka za polecenie jest już dodana na jej karcie (' + r.referrer_stamps + '/10) i dostała powiadomienie.', 'OK', true);
    }
  }

  function smsText(c) {
    const p = UI.progressText(c.stamps);
    return 'Dzień dobry, ' + c.name.split(' ')[0] + '! Na Twojej karcie rytuałów w studiu ' + CFG.STUDIO_NAME + ' masz ' + c.stamps + '/10 pieczątek. ' +
      p.head.replace(/[.!]$/, '') + '. Otwórz link i dodaj kartę do ekranu telefonu, potem otwieraj ją z ikony: ' + linkFor(c) + ' Do zobaczenia!';
  }
  function smsHref(c) {
    const num = (c.phone || '').replace(/[^\d+]/g, '');
    return 'sms:' + num + '?&body=' + encodeURIComponent(smsText(c));
  }

  function printCard(c) {
    $('#printCard').innerHTML = `
      <img class="logo" src="img/logo.png" alt="">
      <h3>Karta rytuałów</h3>
      ${UI.qrSvg('TCTD:' + c.code, { bg: '#ffffff' })}
      <p><b>${esc(c.name)}</b> · karta ${esc(c.code)}</p>
      <p>5. rytuał −15% · 10. rytuał −30% · w dniu urodzin −20%</p>
      <p>Pokaż ten kod przy każdej wizycie.</p>
      <p>${esc(CFG.PHONE)} · ${esc(CFG.ADDRESS)}</p>`;
    setTimeout(() => window.print(), 300);
  }

  // ---------- edycja / nowa karta ----------
  // Pieczątki z papierowej karty można ustawić przy nowej karcie albo na karcie bez żadnej wizyty w aplikacji.
  const canTransfer = (c) => !c.cards_completed && !(c.visits || []).length;
  const stampsField = (n) => `<div class="field"><label for="fStamps">Pieczątki przeniesione z papierowej karty</label><select class="input" id="fStamps">${Array.from({ length: 10 }, (_, i) => `<option value="${i}"${i === n ? ' selected' : ''}>${i}</option>`).join('')}</select></div>`;
  function cardForm(c, isNew) {
    return `
      <form class="panel" id="cardForm" novalidate>
        ${isNew ? '<span class="eyebrow eyebrow--gold">Karta prowadzona przez studio</span><p class="small" style="margin:0">Dla klientki, która nie chce lub nie może pobrać aplikacji. Pieczątki dodajesz tutaj. Możesz jej wydrukować kartę z kodem albo wysłać SMS. Gdy kiedyś otworzy link z SMS-a, karta połączy się z aplikacją.</p>' : ''}
        <div class="field"><label for="fName">Imię i nazwisko</label><input class="input" id="fName" value="${esc(c.name || '')}" placeholder="np. Halina Mazur" autocomplete="off"></div>
        <div class="field"><label for="fPhone">Telefon (do SMS)</label><input class="input" id="fPhone" type="tel" value="${esc(c.phone || '')}" placeholder="np. 600 000 000" autocomplete="off"></div>
        <div class="field"><label for="fEmail">E-mail (opcjonalnie, do voucherów i e-paragonów)</label><input class="input" id="fEmail" type="email" inputmode="email" value="${esc(c.email || '')}" placeholder="np. anna@example.com" autocomplete="off"></div>
        <div class="field"><span class="label" id="fBdayL">Data urodzin (do rabatu −20%)</span>
          <div class="split" role="group" aria-labelledby="fBdayL"><select class="input" id="fDay" aria-label="Dzień">${UI.dayOptions(c.bday_day)}</select><select class="input" id="fMonth" aria-label="Miesiąc">${UI.monthOptions(c.bday_month)}</select></div></div>
        ${isNew ? stampsField(0) : (canTransfer(c) ? stampsField(c.stamps || 0) : '') + `<div class="field"><label for="fNote">Notatka (widzi tylko studio)</label><textarea class="input" id="fNote">${esc(c.note || '')}</textarea></div>`}
        <p class="error" id="fErr" role="alert" hidden></p>
        <button class="btn btn--gold" type="submit">${isNew ? 'Załóż kartę' : 'Zapisz zmiany'}</button>
      </form>`;
  }
  function readForm() {
    const day = +$('#fDay').value || null, month = +$('#fMonth').value || null;
    const f = { name: $('#fName').value.trim(), phone: $('#fPhone').value.trim(), email: $('#fEmail').value.trim().toLowerCase(), day, month };
    if (f.name.length < 2) throw new Error('Wpisz imię i nazwisko.');
    if (f.email && !EMAIL_RE.test(f.email)) throw new Error('Sprawdź adres e-mail.');
    if (!UI.validBday(day, month)) throw new Error('Sprawdź datę urodzin (dzień i miesiąc).');
    return f;
  }
  function openNewCard() {
    openSheet(bar('Nowa klientka') + cardForm({}, true));
    $('#fName').focus();
    $('#cardForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const f = readForm();
        f.stamps = +$('#fStamps').value || 0;
        current = await Api.createStudioCard(f);
        toast('Założono kartę: ' + current.name + '.');
        renderCard();
      } catch (ex) { const el = $('#fErr'); el.textContent = ex.message; el.hidden = false; }
    });
  }
  function openEdit() {
    const c = current;
    openSheet(bar('Edytuj dane') + cardForm(c, false));
    const back = sheetIn.querySelector('[data-close]');
    const fresh = back.cloneNode(true);
    back.replaceWith(fresh);
    fresh.addEventListener('click', () => renderCard());
    $('#cardForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const f = readForm();
        f.note = $('#fNote').value.trim();
        current = await Api.updateCard(c.id, f);
        const st = $('#fStamps');
        if (st && +st.value !== (c.stamps || 0)) current = await Api.transferStamps(c.id, +st.value);
        toast('Zapisano zmiany.');
        renderCard();
      } catch (ex) { const el = $('#fErr'); el.textContent = ex.message; el.hidden = false; }
    });
  }

  // ---------- sprzedaż vouchera ----------
  // Panel tworzy opłacone zamówienie w sklepie (przez funkcję sprzedaz-vouchera),
  // a sklep sam drukuje paragon i wysyła voucher e-mailem.
  // BLIK (kod przez PayU) i BLIK na telefon (przelew) rozdziela Gotówka, żeby się nie myliły.
  // Wartości dla sklepu: blik = kod BLIK przez PayU, blik_telefon = przelew na telefon, opłacony od razu.
  const PAY = [['blik', 'BLIK'], ['gotowka', 'Gotówka'], ['blik_telefon', 'BLIK na telefon']];
  const PAY_LABEL = { blik: 'BLIK kodem (PayU)', gotowka: 'gotówka', blik_telefon: 'BLIK na telefon', karta: 'karta' };
  const BLIK_PHONE = CFG.BLIK_PHONE || CFG.PHONE;
  const RECEIPT = {
    pending: 'w trakcie',
    waiting_payment: 'czeka na płatność BLIK',
    queued: 'paragon w kolejce',
    sent: 'paragon wysłany do drukarki',
    confirmed: 'paragon wydrukowany ✅',
    error: 'błąd paragonu',
    failed: 'sprzedaż nieudana'
  };
  const zl = (n) => Number(n || 0).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' zł';
  const stampWord = (n) => n + ' ' + UI.plural(n, 'pieczątka', 'pieczątki', 'pieczątek');
  const newSale = () => ({ productId: null, qty: 1, payment: null, transferOk: false, card: null, name: '', email: '', phone: '' });
  let vouchers = null;
  let sale = newSale();
  let pollRun = 0;
  // Płatność BLIK w toku. Zapamiętana w telefonie, żeby po powrocie z PayU panel wiedział, co śledzić.
  const PENDING_KEY = 'tctd.blikPending';
  const pending = {
    get() { try { return JSON.parse(localStorage.getItem(PENDING_KEY)); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(PENDING_KEY, JSON.stringify(v)); } catch (e) { /* bez zapamiętania */ } },
    clear() { try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ } }
  };
  document.addEventListener('visibilitychange', () => {
    const p = pending.get();
    if (document.visibilityState === 'visible' && tab === 'sale' && p && $('#rStatus')) pollReceipt(p.order_id, true);
  });

  // ---------- paragon za rytuał ----------
  // Okno „Wystaw paragon”: rytuał, kwota, płatność i dane klientki. Sklep (fragment paragon-za-rytual.php)
  // tworzy opłacone zamówienie, a wtyczka eparagony.pl drukuje paragon i wysyła e-paragon na e-mail.
  const RC_PAY = [['gotowka', 'Gotówka'], ['blik_telefon', 'BLIK na telefon'], ['karta', 'Karta']];
  const RC_OFF = [[0, 'cena'], [15, '−15%'], [20, '−20%'], [30, '−30%']];
  let rituals = null;
  let rc = null;
  let rcPoll = 0;
  const newRc = () => ({ productId: null, off: 0, amount: '', payment: null, transferOk: false, name: '', email: '', phone: '' });
  const toAmount = (v) => { const n = Number(String(v).replace(',', '.').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
  const rcRitual = () => (rituals || []).find((r) => r.id === rc.productId) || null;

  function openReceipt() {
    rc = newRc();
    openSheet(bar('Wystaw paragon') + `
      <div id="rcResult"></div>
      <section style="display:flex;flex-direction:column;gap:10px">
        <span class="eyebrow">1 · Rytuał lub zadatek</span>
        <div id="rcList"><div class="spinner"></div></div>
      </section>
      <section id="rcRest" style="display:flex;flex-direction:column;gap:16px" hidden>
        <section style="display:flex;flex-direction:column;gap:10px">
          <span class="eyebrow">2 · Kwota</span>
          <div class="pay pay--four" id="rcOff" role="radiogroup" aria-label="Rabat">${RC_OFF.map(([v, l]) => `<button type="button" role="radio" data-off="${v}" aria-checked="false">${l}</button>`).join('')}</div>
          <div class="field"><label for="rcAmount">Do zapłaty (zł)</label><input class="input" id="rcAmount" inputmode="decimal" autocomplete="off"></div>
          <p class="small" id="rcOffInfo" style="margin:0"></p>
        </section>
        <section style="display:flex;flex-direction:column;gap:10px">
          <span class="eyebrow">3 · Płatność</span>
          <div class="pay" role="radiogroup" aria-label="Sposób płatności">${RC_PAY.map(([k, l]) => `<button type="button" role="radio" data-rcpay="${k}" aria-checked="false">${l}</button>`).join('')}</div>
          <div class="panel panel--tight" id="rcPayInfo" hidden></div>
        </section>
        <section style="display:flex;flex-direction:column;gap:10px">
          <span class="eyebrow">4 · Klientka</span>
          <div class="panel" style="gap:12px">
            <div class="field"><label for="rcName">Imię i nazwisko</label><input class="input" id="rcName" autocomplete="off" placeholder="np. Anna Kowalska"></div>
            <div id="rcHints"></div>
            <div class="field"><label for="rcEmail">E-mail (na niego przyjdzie e-paragon)</label><input class="input" id="rcEmail" type="email" inputmode="email" autocomplete="off"></div>
            <div class="field"><label for="rcPhone">Telefon (nieobowiązkowy)</label><input class="input" id="rcPhone" type="tel" autocomplete="off"></div>
          </div>
        </section>
        <section class="panel panel--gold" style="gap:12px">
          <div class="row"><span class="eyebrow eyebrow--gold">Do zapłaty</span><span class="strong gold" id="rcTotal" style="font-size:22px">—</span></div>
          <p class="error" id="rcErr" role="alert" hidden></p>
          <button class="btn btn--gold" id="rcIssue" style="min-height:58px">Wystaw paragon</button>
        </section>
      </section>
      <section style="display:flex;flex-direction:column;gap:10px">
        <div class="row"><span class="eyebrow">Ostatnie paragony za rytuały i zadatki</span><button class="linkbtn" id="rcReload" style="min-height:0;padding:0">Odśwież</button></div>
        <div class="panel panel--tight" id="rcHistory"><div class="spinner"></div></div>
      </section>`);
    sheetIn.querySelectorAll('[data-off]').forEach((b) => b.addEventListener('click', () => { rc.off = +b.dataset.off; setRcAmount(); }));
    sheetIn.querySelectorAll('[data-rcpay]').forEach((b) => b.addEventListener('click', () => { if (rc.payment !== b.dataset.rcpay) rc.transferOk = false; rc.payment = b.dataset.rcpay; updateRc(); }));
    $('#rcAmount').addEventListener('input', (e) => { rc.amount = e.target.value; rc.off = null; updateRc(); });
    [['#rcName', 'name'], ['#rcEmail', 'email'], ['#rcPhone', 'phone']].forEach(([sel, key]) => $(sel).addEventListener('input', (e) => { rc[key] = e.target.value; }));
    bindRcHints();
    $('#rcIssue').addEventListener('click', issueRc);
    $('#rcReload').addEventListener('click', () => loadRcHistory());
    loadRituals();
    loadRcHistory();
  }

  async function loadRituals() {
    const box = $('#rcList');
    if (!box) return;
    if (!rituals) {
      try { rituals = await Api.ritualsList(); } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; return; }
    }
    if (!box.isConnected) return;
    if (!rituals.length) { box.innerHTML = '<p class="small">Sklep nie zwrócił żadnego rytuału.</p>'; return; }
    box.innerHTML = '<div class="picks" role="radiogroup" aria-label="Rytuał">' + rituals.map((r) => `
      <button type="button" class="pick" role="radio" data-rc="${r.id}" aria-checked="false">
        <span><span class="pick__name">${esc(r.name)}</span>${r.deposit ? '<span class="pick__meta">wpisujesz kwotę zadatku</span>' : ''}</span>
        <span class="pick__price">${r.deposit ? 'dowolna' : zl(r.price)}</span>
      </button>`).join('') + '</div>';
    box.querySelectorAll('[data-rc]').forEach((b) => b.addEventListener('click', () => {
      const first = !rc.productId;
      const wasDeposit = !!(rcRitual() || {}).deposit;
      rc.productId = +b.dataset.rc;
      const r = rcRitual();
      if (r.deposit) { rc.off = null; if (!wasDeposit) rc.amount = ''; }
      else rc.off = rc.off == null || wasDeposit ? 0 : rc.off;
      setRcAmount();
      if (r.deposit && !first) { const a = $('#rcAmount'); if (a) a.focus(); }
      if (first) { $('#rcRest').hidden = false; $('#rcRest').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }));
  }

  function setRcAmount() {
    const r = rcRitual();
    if (r && !r.deposit && rc.off != null) rc.amount = (Math.round(r.price * (100 - rc.off)) / 100).toFixed(2).replace('.', ',');
    const el = $('#rcAmount'); if (el) el.value = rc.amount;
    updateRc();
  }

  function updateRc() {
    const r = rcRitual();
    sheetIn.querySelectorAll('[data-rc]').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.rc === rc.productId)));
    sheetIn.querySelectorAll('[data-off]').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.off === rc.off)));
    sheetIn.querySelectorAll('[data-rcpay]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.rcpay === rc.payment)));
    const amount = toAmount(rc.amount);
    const t = $('#rcTotal'); if (t) t.textContent = r && amount ? zl(amount) : '—';
    const dep = !!(r && r.deposit);
    const offBox = $('#rcOff'); if (offBox) offBox.hidden = dep;
    const lab = sheetIn.querySelector('label[for="rcAmount"]'); if (lab) lab.textContent = dep ? 'Kwota zadatku (zł)' : 'Do zapłaty (zł)';
    const info = $('#rcOffInfo');
    if (info) info.textContent = dep ? 'Na paragonie: „' + r.name + '”. Przy rytuale wystawiasz paragon już tylko na resztę kwoty.'
      : r && amount && amount < r.price ? `Na paragonie: ${r.name} ${zl(r.price)} i rabat ${zl(r.price - amount)}.` : '−15% za 5. rytuał, −20% w urodziny, −30% za 10. rytuał.';
    const box = $('#rcPayInfo');
    if (box) {
      box.hidden = rc.payment !== 'blik_telefon';
      box.innerHTML = rc.payment !== 'blik_telefon' ? '' : `
        <div class="row" style="align-items:center"><span class="small">Numer</span><span class="strong gold" style="font-size:20px;letter-spacing:.04em">${esc(BLIK_PHONE)}</span></div>
        <div class="row" style="align-items:center"><span class="small">Kwota</span><span class="strong">${amount ? zl(amount) : '—'}</span></div>
        <label class="check"><input type="checkbox" id="rcTransfer" ${rc.transferOk ? 'checked' : ''}> <span>Przelew dotarł na moje konto</span></label>`;
      const cb = $('#rcTransfer'); if (cb) cb.addEventListener('change', (e) => { rc.transferOk = e.target.checked; });
    }
  }

  // Podpowiedzi z kart lojalnościowych przy wpisywaniu nazwiska (uzupełniają e-mail i telefon).
  function bindRcHints() {
    let timer;
    $('#rcName').addEventListener('input', (e) => {
      clearTimeout(timer);
      const q = e.target.value.trim();
      timer = setTimeout(async () => {
        const box = $('#rcHints');
        if (!box) return;
        if (q.length < 3) { box.innerHTML = ''; return; }
        let list = [];
        try { list = (await Api.listCards(q)).slice(0, 4); } catch (ex) { /* bez podpowiedzi */ }
        if (!box.isConnected || $('#rcName').value.trim() !== q) return;
        box.innerHTML = list.length ? '<div class="panel panel--tight" style="background:var(--bg)">' + list.map((c) => `
          <div class="client"><button class="client__main" data-rchint="${esc(c.id)}">
            <span class="avatar">${esc(UI.initials(c.name))}</span>
            <span><span class="client__name">${esc(c.name)}</span><span class="client__meta">${esc(c.email || 'bez e-maila')}${c.phone ? ' · ' + esc(c.phone) : ''}</span></span>
          </button></div>`).join('') + '</div>' : '';
        box.querySelectorAll('[data-rchint]').forEach((b) => b.addEventListener('click', () => {
          const c = list.find((x) => x.id === b.dataset.rchint);
          rc.name = c.name; rc.email = c.email || rc.email; rc.phone = c.phone || rc.phone;
          $('#rcName').value = rc.name; $('#rcEmail').value = rc.email; $('#rcPhone').value = rc.phone;
          box.innerHTML = '';
        }));
      }, 250);
    });
  }

  async function issueRc() {
    const r = rcRitual();
    const err = $('#rcErr');
    err.hidden = true;
    const amount = toAmount(rc.amount);
    const name = rc.name.trim(), email = rc.email.trim().toLowerCase(), phone = rc.phone.trim();
    const problem = !r ? 'Wybierz rytuał lub zadatek.' : !(amount >= 1) ? (r.deposit ? 'Wpisz kwotę zadatku.' : 'Wpisz kwotę.')
      : r.deposit && r.max && amount > r.max ? 'Zadatek może mieć najwyżej ' + zl(r.max) + '.'
      : !r.deposit && amount > r.price ? 'Kwota nie może być wyższa niż cena rytuału (' + zl(r.price) + ').'
      : !rc.payment ? 'Wybierz sposób płatności.' : rc.payment === 'blik_telefon' && !rc.transferOk ? 'Zaznacz, że przelew BLIK dotarł na konto.'
      : name.length < 2 ? 'Wpisz imię i nazwisko.' : !EMAIL_RE.test(email) ? 'Wpisz poprawny e-mail, na który przyjdzie e-paragon.' : '';
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const payLabel = RC_PAY.find((x) => x[0] === rc.payment)[1].toLowerCase();
    if (!(await UI.ask(`Wystawić paragon fiskalny na ${zl(amount)}? ${r.deposit ? 'Zadatek na poczet rezerwacji terminu' : r.name}, płatność: ${payLabel}. E-paragon pójdzie na ${email}.`, 'Wystaw paragon'))) return;
    const btn = $('#rcIssue');
    btn.disabled = true;
    btn.textContent = 'Wysyłam do sklepu…';
    try {
      const res = await Api.issueReceipt({
        client_ref: rc.ref || (rc.ref = crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
        product_id: r.id, amount, payment: rc.payment, name, email, phone: phone || undefined
      });
      showRcResult(res);
      rc = newRc();
      sheetIn.querySelectorAll('#rcAmount, #rcName, #rcEmail, #rcPhone').forEach((x) => { x.value = ''; });
      $('#rcRest').hidden = true;
      updateRc();
      sheet.scrollTop = 0;
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
    btn.disabled = false;
    btn.textContent = 'Wystaw paragon';
  }

  function showRcResult(r) {
    const box = $('#rcResult');
    if (!box) return;
    box.innerHTML = `<section class="panel panel--gold" style="gap:10px">
      <span class="eyebrow eyebrow--gold">${r.duplicate ? 'Ten paragon był już wysłany' : 'Paragon wystawiony'} · ${esc(r.service)}</span>
      <span class="strong" style="font-size:17px">Zamówienie nr ${esc(r.order_number)} · ${zl(r.total)}</span>
      <span class="small">E-paragon pójdzie na ${esc(r.email || 'e-mail klientki')}, gdy drukarka potwierdzi paragon.</span>
      <div class="hint" id="rcStatus" role="status">Paragon w kolejce…</div>
      <button class="btn btn--ghost btn--sm" id="rcCheck" hidden>Sprawdź ponownie</button>
    </section>`;
    $('#rcCheck').addEventListener('click', () => pollRc(r.order_id));
    pollRc(r.order_id);
  }

  // Status co 3 s, najdłużej 60 s (jak przy voucherach).
  async function pollRc(orderId) {
    const run = ++rcPoll;
    const started = Date.now();
    const again = $('#rcCheck'); if (again) again.hidden = true;
    const set = (text, kind) => { const el = $('#rcStatus'); if (el) { el.textContent = text; el.className = 'hint' + (kind ? ' hint--' + kind : ''); } };
    while (run === rcPoll && $('#rcStatus')) {
      let s = null;
      try { s = await Api.ritualReceiptStatus(orderId); } catch (e) { /* spróbuję jeszcze raz */ }
      if (run !== rcPoll) return;
      if (s && s.receipt === 'confirmed') { set('Paragon wydrukowany ✅ E-paragon wysłany.', 'reward'); loadRcHistory(); return; }
      if (s && s.receipt === 'error') { set('Błąd paragonu' + (s.error ? ': ' + s.error : '') + '. Sprawdź program eDPS i zamówienie w WooCommerce.', 'error'); loadRcHistory(); break; }
      if (Date.now() - started >= 60000) { set('Paragon czeka – sprawdź, czy komputer z eDPS jest włączony.', 'error'); loadRcHistory(); break; }
      set(s && s.receipt === 'sent' ? 'Paragon wysłany do drukarki…' : 'Paragon w kolejce…');
      await new Promise((res) => setTimeout(res, 3000));
    }
    const b = $('#rcCheck'); if (b && run === rcPoll) b.hidden = false;
  }

  async function loadRcHistory() {
    const box = $('#rcHistory');
    if (!box) return;
    let list;
    try { list = await Api.ritualReceipts(); } catch (e) { box.innerHTML = '<p class="error" style="padding:12px 0">' + esc(e.message) + '</p>'; return; }
    if (!box.isConnected) return;
    if (!list.length) { box.innerHTML = '<p class="small" style="padding:12px 0;margin:0">Nie ma jeszcze paragonów za rytuały i zadatki z panelu.</p>'; return; }
    box.innerHTML = list.map((s) => {
      const d = new Date(s.created_at);
      const when = UI.fmtShort(s.created_at) + ', ' + d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
      const ok = s.receipt === 'confirmed', bad = s.receipt === 'error';
      return `<div class="list-row" style="flex-direction:column;gap:4px">
        <div class="row" style="align-items:baseline"><span>${esc(s.service)}</span><span class="strong" style="color:var(--text)">${zl(s.total)}</span></div>
        <div class="row" style="align-items:center"><span class="small">${esc(when)} · ${esc(s.name || '')}${s.order_number ? ' · nr ' + esc(s.order_number) : ''}</span>
          <span class="small ${ok ? 'gold' : bad ? 'error' : ''}">${esc(RECEIPT[s.receipt] || s.receipt)}</span></div>
        ${s.error ? `<span class="error" style="font-size:12.5px">${esc(s.error)}</span>` : ''}
      </div>`;
    }).join('');
  }

  // ---------- promocje (zakładka „Promocje” w aplikacji klientki) ----------
  function renderPromos() {
    main.innerHTML = `
      ${tabsHtml()}
      <h1>Promocje</h1>
      <form class="panel" id="promoForm" style="gap:12px" novalidate>
        <span class="eyebrow eyebrow--gold">Nowa promocja</span>
        <div class="field"><label for="pTitle">Nazwa</label><input class="input" id="pTitle" maxlength="80" placeholder="np. Head SPA Premium −20% w listopadzie" autocomplete="off"></div>
        <div class="field"><label for="pBody">Opis (nieobowiązkowy)</label><textarea class="input" id="pBody" rows="3" maxlength="600" placeholder="Co obejmuje, dla kogo, jak skorzystać"></textarea></div>
        <div class="field"><label for="pUntil">Ważna do (włącznie, puste = bez końca)</label><input class="input" id="pUntil" type="date" min="${Rules.dayPL(0)}"></div>
        <label class="check"><input type="checkbox" id="pNotify" checked> <span>Wyślij powiadomienie klientkom, które mają aplikację z powiadomieniami i zgodę na oferty</span></label>
        <button class="btn btn--gold" type="submit" id="pSave">Opublikuj promocję</button>
      </form>
      <section style="display:flex;flex-direction:column;gap:10px">
        <span class="eyebrow">Promocje w aplikacji</span>
        <div id="promoList"><div class="spinner"></div></div>
        <p class="small" style="margin:0">Klientki widzą promocje w zakładce „Promocje” na dole aplikacji. Po dacie „ważna do” promocja sama znika.</p>
      </section>`;
    bindTabs();
    $('#promoForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = $('#pTitle').value.trim(), notify = $('#pNotify').checked;
      if (title.length < 2) { toast('Wpisz nazwę promocji.', 'error'); $('#pTitle').focus(); return; }
      if (notify && !(await UI.ask('Opublikować promocję „' + title + '” i wysłać powiadomienie klientkom? Powiadomienia nie da się cofnąć.', 'Opublikuj'))) return;
      const btn = $('#pSave'); btn.disabled = true;
      try {
        const r = await Api.promotionAdd({ title, body: $('#pBody').value, until: $('#pUntil').value || null, notify });
        toast(r && r.pushed != null ? 'Promocja opublikowana. Powiadomienie: ' + r.pushed + ' ' + UI.plural(r.pushed, 'klientka', 'klientki', 'klientek') + '.' : 'Promocja opublikowana.', 'reward');
        renderPromos();
      } catch (err) { fail(err); btn.disabled = false; }
    });
    loadPromos();
  }
  async function loadPromos() {
    const box = $('#promoList');
    let list;
    try { list = await Api.promotionsList(); } catch (e) { box.innerHTML = `<p class="small">${esc(e.message)}</p>`; return; }
    if (!box.isConnected) return;
    const until = (d) => new Date(d + 'T12:00:00').toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' });
    box.innerHTML = list.length ? `<div class="panel panel--tight">${list.map((p) => `<div class="list-row" style="align-items:flex-start;gap:12px">
        <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
          <div class="strong">${esc(p.title)}${p.ended ? ' <span class="tag">zakończona</span>' : ''}</div>
          ${p.body ? `<div class="small" style="white-space:pre-line">${esc(p.body)}</div>` : ''}
          <div class="small">${p.valid_until ? 'Ważna do ' + esc(until(p.valid_until)) : 'Bez daty końca'}${p.pushed != null ? ' · powiadomienie: ' + p.pushed : ''}</div>
        </div>
        <button class="btn btn--ghost btn--sm" data-promo-del="${p.id}" style="flex:0 0 auto;width:auto">${p.ended ? 'Usuń' : 'Zakończ'}</button>
      </div>`).join('')}</div>` : '<p class="small">Nie ma jeszcze żadnej promocji. Klientki widzą wtedy napis, że wkrótce coś się pojawi.</p>';
    box.querySelectorAll('[data-promo-del]').forEach((b) => b.addEventListener('click', async () => {
      const p = list.find((x) => String(x.id) === b.dataset.promoDel);
      if (!(await UI.ask((p.ended ? 'Usunąć' : 'Zakończyć teraz') + ' promocję „' + p.title + '”? Zniknie z aplikacji klientek.', p.ended ? 'Usuń' : 'Zakończ'))) return;
      try { await Api.promotionRemove(p.id); toast('Promocja usunięta z aplikacji.'); loadPromos(); } catch (e) { fail(e); }
    }));
  }

  async function renderSale() {
    main.innerHTML = `
      ${tabsHtml()}
      <h1>Sprzedaż vouchera</h1>
      <div id="saleResult"></div>
      <section style="display:flex;flex-direction:column;gap:10px">
        <div class="row"><span class="eyebrow">1 · Voucher</span><button class="linkbtn" id="vReload" style="min-height:0;padding:0">Odśwież ceny</button></div>
        <div id="vList"><div class="spinner"></div></div>
      </section>
      <section style="display:flex;flex-direction:column;gap:10px">
        <span class="eyebrow">2 · Ilość</span>
        <div class="stepper">
          <button type="button" id="qMinus" aria-label="Mniej">−</button>
          <output id="qVal" aria-live="polite">1</output>
          <button type="button" id="qPlus" aria-label="Więcej">+</button>
        </div>
      </section>
      <section style="display:flex;flex-direction:column;gap:10px">
        <span class="eyebrow">3 · Płatność</span>
        <div class="pay" role="radiogroup" aria-label="Sposób płatności">
          ${PAY.map(([k, l]) => `<button type="button" role="radio" data-pay="${k}" aria-checked="false">${l}</button>`).join('')}
        </div>
        <div class="panel panel--tight" id="payInfo" hidden></div>
      </section>
      <section style="display:flex;flex-direction:column;gap:10px">
        <span class="eyebrow">4 · Dane do zamówienia</span>
        <div class="panel" style="gap:12px">
          <div id="cardPick"></div>
          <div class="field"><label for="sName">Imię i nazwisko</label><input class="input" id="sName" autocomplete="off"></div>
          <div class="field"><label for="sEmail">E-mail (na niego przyjdzie voucher PDF i e-paragon)</label><input class="input" id="sEmail" type="email" inputmode="email" autocomplete="off"></div>
          <div class="field"><label for="sPhone">Telefon</label><input class="input" id="sPhone" type="tel" autocomplete="off"></div>
          <p class="small" style="margin:0">Wszystkie pola są opcjonalne. Bez e-maila voucher PDF nie przyjdzie pocztą.</p>
        </div>
      </section>
      <section class="panel panel--gold" style="gap:12px">
        <div class="row"><span class="eyebrow eyebrow--gold">Do zapłaty</span><span class="strong gold" id="sTotal" style="font-size:22px">—</span></div>
        <div class="small" id="sStampInfo" hidden></div>
        <p class="error" id="sErr" role="alert" hidden></p>
        <button class="btn btn--gold" id="sellBtn" style="min-height:58px">Sprzedaj i wystaw paragon</button>
      </section>
      <section style="display:flex;flex-direction:column;gap:10px">
        <div class="row"><span class="eyebrow">Ostatnie sprzedaże</span><button class="linkbtn" id="hReload" style="min-height:0;padding:0">Odśwież</button></div>
        <div class="panel panel--tight" id="sHistory"><div class="spinner"></div></div>
      </section>`;
    bindTabs();
    $('#vReload').addEventListener('click', () => { vouchers = null; loadVouchers(); });
    $('#hReload').addEventListener('click', () => loadHistory());
    $('#qMinus').addEventListener('click', () => { sale.qty = Math.max(1, sale.qty - 1); updateSale(); });
    $('#qPlus').addEventListener('click', () => { sale.qty = Math.min(10, sale.qty + 1); updateSale(); });
    main.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => { if (sale.payment !== b.dataset.pay) sale.transferOk = false; sale.payment = b.dataset.pay; updateSale(); }));
    [['#sName', 'name'], ['#sEmail', 'email'], ['#sPhone', 'phone']].forEach(([sel, key]) => {
      const el = $(sel);
      el.value = sale[key];
      el.addEventListener('input', () => { sale[key] = el.value; });
    });
    $('#sellBtn').addEventListener('click', sell);
    renderCardPick();
    updateSale();
    loadVouchers();
    loadHistory();
    const p = pending.get();
    if (p && !$('#saleResult').innerHTML) showResult(p, p.product_name);
  }

  async function loadVouchers() {
    const box = $('#vList');
    if (!box) return;
    if (!vouchers) {
      box.innerHTML = '<div class="spinner"></div>';
      try { vouchers = await Api.vouchersList(); } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; return; }
    }
    if (!vouchers.length) { box.innerHTML = '<p class="small">Sklep nie zwrócił żadnych voucherów.</p>'; return; }
    if (sale.productId && !vouchers.some((v) => v.id === sale.productId)) sale.productId = null;
    box.innerHTML = '<div class="picks" role="radiogroup" aria-label="Voucher">' + vouchers.map((v) => `
      <button type="button" class="pick" role="radio" data-v="${v.id}" aria-checked="false">
        <span><span class="pick__name">${esc(v.name)}</span>${v.stamps ? `<span class="pick__meta">pakiet · ${stampWord(v.stamps)} na karcie</span>` : ''}</span>
        <span class="pick__price">${zl(v.price)}</span>
      </button>`).join('') + '</div>';
    box.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { sale.productId = +b.dataset.v; updateSale(); }));
    updateSale();
  }

  function selected() { return (vouchers || []).find((v) => v.id === sale.productId) || null; }

  function updateSale() {
    const v = selected();
    main.querySelectorAll('[data-v]').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.v === sale.productId)));
    main.querySelectorAll('[data-pay]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.pay === sale.payment)));
    const q = $('#qVal'); if (q) q.textContent = sale.qty;
    renderPayInfo(v);
    const sb = $('#sellBtn');
    if (sb && !sb.disabled) sb.textContent = sale.payment === 'blik' ? 'Utwórz płatność BLIK' : 'Sprzedaj i wystaw paragon';
    const t = $('#sTotal'); if (t) t.textContent = v ? zl(v.price * sale.qty) : '—';
    const info = $('#sStampInfo');
    if (info) {
      const n = v ? v.stamps * sale.qty : 0;
      info.hidden = !v;
      info.innerHTML = !v ? '' : !n ? 'Ten voucher nie daje pieczątki przy zakupie. Pieczątka przysługuje przy wizycie.'
        : sale.card ? `${sale.payment === 'blik' ? 'Po opłaceniu' : 'Po sprzedaży'} na kartę ${esc(sale.card.name)} trafi <b class="gold">+${stampWord(n)}</b> (zakup pakietu).`
          : `Pakiet daje ${stampWord(n)}. Wybierz kartę lojalnościową, żeby dodały się same.`;
    }
  }

  // Podpowiedź pod płatnością: dla BLIK-a na telefon numer, kwota i potwierdzenie przelewu.
  function renderPayInfo(v) {
    const box = $('#payInfo');
    if (!box) return;
    const total = v ? zl(v.price * sale.qty) : '—';
    if (sale.payment === 'blik_telefon') {
      box.hidden = false;
      box.innerHTML = `
        <span class="small">Klientka robi przelew BLIK na telefon:</span>
        <div class="row" style="align-items:center"><span class="small">Numer</span><span class="strong gold" style="font-size:20px;letter-spacing:.04em">${esc(BLIK_PHONE)}</span></div>
        <div class="row" style="align-items:center"><span class="small">Kwota</span><span class="strong">${total}</span></div>
        <div class="row" style="align-items:center"><span class="small">Tytuł</span><span class="small" style="text-align:right">${v ? 'Voucher ' + esc(v.name) : 'wybierz voucher'}</span></div>
        <label class="check"><input type="checkbox" id="transferOk" ${sale.transferOk ? 'checked' : ''}> <span>Przelew dotarł na moje konto</span></label>`;
      $('#transferOk').addEventListener('change', (e) => { sale.transferOk = e.target.checked; });
    } else if (sale.payment === 'blik') {
      box.hidden = false;
      box.innerHTML = '<span class="small">Po kliknięciu otworzy się okno PayU. Wpisujesz kod BLIK od klientki, a ona zatwierdza płatność w swojej aplikacji. Paragon wydrukuje się dopiero po opłaceniu.</span>';
    } else {
      box.hidden = true;
      box.innerHTML = '';
    }
  }

  function renderCardPick() {
    const box = $('#cardPick');
    if (!box) return;
    if (sale.card) {
      box.innerHTML = `<div class="row" style="align-items:center">
        <span><span class="eyebrow eyebrow--gold">Karta lojalnościowa</span><br><span class="strong">${esc(sale.card.name)}</span> <span class="small">· ${sale.card.stamps}/10 · karta ${esc(sale.card.code)}</span></span>
        <button class="linkbtn" id="cardUnpick" style="min-height:0;padding:0">Odłącz</button></div>`;
      $('#cardUnpick').addEventListener('click', () => { sale.card = null; renderCardPick(); updateSale(); });
      return;
    }
    box.innerHTML = `<div class="field"><label for="cSearch">Karta lojalnościowa (szukaj po telefonie, nazwisku lub e-mailu)</label>
      <input class="input" id="cSearch" type="search" autocomplete="off" placeholder="np. 600 100 200 albo Kowalska"></div>
      <div id="cResults"></div>`;
    let timer;
    $('#cSearch').addEventListener('input', (e) => {
      clearTimeout(timer);
      const q = e.target.value.trim();
      timer = setTimeout(async () => {
        const res = $('#cResults');
        if (!res) return;
        if (q.length < 2) { res.innerHTML = ''; return; }
        let list;
        try { list = await Api.listCards(q); } catch (ex) { res.innerHTML = '<p class="error">' + esc(ex.message) + '</p>'; return; }
        res.innerHTML = list.length ? '<div class="panel panel--tight" style="background:var(--bg)">' + list.slice(0, 6).map((c) => `
          <div class="client"><button class="client__main" data-card="${esc(c.id)}">
            <span class="avatar">${esc(UI.initials(c.name))}</span>
            <span><span class="client__name">${esc(c.name)}</span><span class="client__meta">${esc(c.phone || 'bez telefonu')}${c.email ? ' · ' + esc(c.email) : ''} · ${c.stamps}/10</span></span>
          </button></div>`).join('') + '</div>' : '<p class="small" style="margin:0">Brak kart dla tego wyszukiwania.</p>';
        res.querySelectorAll('[data-card]').forEach((b) => b.addEventListener('click', () => {
          const c = list.find((x) => x.id === b.dataset.card);
          // dane z poprzednio wybranej karty nie mogą zostać przy nowej
          const prev = sale.filled || {};
          sale.card = c;
          sale.name = c.name;
          sale.phone = c.phone || (sale.phone === prev.phone ? '' : sale.phone);
          sale.email = c.email || (sale.email === prev.email ? '' : sale.email);
          sale.filled = { phone: c.phone || '', email: c.email || '' };
          $('#sName').value = sale.name;
          $('#sPhone').value = sale.phone;
          $('#sEmail').value = sale.email;
          renderCardPick();
          updateSale();
        }));
      }, 250);
    });
  }

  async function sell() {
    const v = selected();
    const err = $('#sErr');
    err.hidden = true;
    const problem = !v ? 'Wybierz voucher.' : !sale.payment ? 'Wybierz sposób płatności.'
      : sale.payment === 'blik_telefon' && !sale.transferOk ? 'Zaznacz, że przelew BLIK dotarł na konto.'
      : sale.email.trim() && !EMAIL_RE.test(sale.email.trim()) ? 'Sprawdź adres e-mail.' : '';
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const total = v.price * sale.qty;
    const q = sale.payment === 'blik'
      ? [`Utworzyć płatność BLIK na ${zl(total)}? ${v.name} × ${sale.qty}. Paragon wydrukuje się po opłaceniu.`, 'Utwórz płatność']
      : [`Wystawić paragon fiskalny na ${zl(total)}? ${v.name} × ${sale.qty}, płatność: ${PAY_LABEL[sale.payment]}.`, 'Wystaw paragon'];
    if (!(await UI.ask(q[0], q[1]))) return;
    // Okno płatności otwieramy od razu po kliknięciu (inaczej przeglądarka je zablokuje),
    // a adres PayU wstawiamy, gdy sklep utworzy zamówienie.
    const payWin = sale.payment === 'blik' ? window.open('', '_blank') : null;
    if (payWin) payWin.document.write('<meta name="viewport" content="width=device-width"><p style="font:18px sans-serif;padding:24px">Otwieram płatność BLIK…</p>');
    const btn = $('#sellBtn');
    btn.disabled = true;
    btn.textContent = 'Wysyłam do sklepu…';
    try {
      const r = await Api.sellVoucher({
        client_ref: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
        product_id: v.id, qty: sale.qty, payment: sale.payment,
        name: sale.name.trim() || undefined, email: sale.email.trim() || undefined, phone: sale.phone.trim() || undefined,
        card_id: sale.card ? sale.card.id : undefined
      });
      if (r.duplicate) throw new Error('Ta sprzedaż została już wysłana. Sprawdź listę ostatnich sprzedaży.');
      if (payWin) { if (r.pay_url) payWin.location.href = r.pay_url; else payWin.close(); }
      if (r.card && r.stamps_added) Api.notifyStamp(r.card.id, r.card.stamps).catch(() => {});
      rememberEmail(sale.card, sale.email.trim().toLowerCase());
      sale = newSale();
      renderSale();
      showResult(r, v.name);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (payWin) payWin.close();
      btn.disabled = false;
      btn.textContent = sale.payment === 'blik' ? 'Utwórz płatność BLIK' : 'Sprzedaj i wystaw paragon';
      err.textContent = e.message;
      err.hidden = false;
    }
  }

  // E-mail wpisany przy sprzedaży zapisuje się na karcie, żeby następnym razem wstawił się sam.
  async function rememberEmail(card, email) {
    if (!card || !email || card.email === email) return;
    try {
      const c = await Api.getCard(card.id);
      if (c) await Api.updateCard(c.id, { name: c.name, phone: c.phone, day: c.bday_day, month: c.bday_month, note: c.note, email });
    } catch (e) { /* sprzedaż się udała, e-mail można dopisać ręcznie */ }
  }

  function showResult(r, productName) {
    const box = $('#saleResult');
    if (!box) return;
    const waiting = r.paid === false;
    if (waiting) pending.set({ order_id: r.order_id, order_number: r.order_number, total: r.total, paid: false, pay_url: r.pay_url, stamps_expected: r.stamps_expected, product_name: productName });
    box.innerHTML = `<section class="panel panel--gold" style="gap:10px">
      <span class="eyebrow eyebrow--gold">${waiting ? 'Płatność BLIK' : 'Sprzedano'} · ${esc(productName)}</span>
      <span class="strong" style="font-size:17px">Zamówienie nr ${esc(r.order_number)} · ${zl(r.total)}</span>
      ${waiting ? `<div id="rPay" style="display:flex;flex-direction:column;gap:8px">
        <span class="small">Okno PayU otworzyło się w nowej karcie. Wpisz tam kod BLIK, który poda Ci klientka, a klientka zatwierdzi płatność w aplikacji swojego banku. Potem wróć tutaj, paragon wydrukuje się sam.</span>
        <a class="btn btn--gold" href="${esc(r.pay_url)}" target="_blank" rel="noopener">Otwórz płatność BLIK ponownie</a>
      </div>` : ''}
      <div class="hint" id="rStatus" role="status">${waiting ? 'Czekam na płatność BLIK…' : 'Paragon w kolejce…'}</div>
      <div id="rStamps">${stampsHtml(r)}</div>
      <button class="btn btn--ghost btn--sm" id="rCheck" hidden>Sprawdź ponownie</button>
    </section>`;
    $('#rCheck').addEventListener('click', () => pollReceipt(r.order_id, waiting));
    pollReceipt(r.order_id, waiting);
  }

  function stampsHtml(r) {
    const ok = r.stamps_added ? `<span class="small gold">Dodano ${stampWord(r.stamps_added)} na kartę (zakup pakietu).</span>` : '';
    const bad = r.stamp_error ? `<span class="error" style="font-size:13px">Pieczątki: ${esc(r.stamp_error)} Dodano ${r.stamps_added} z ${r.stamps_expected}.</span>` : '';
    const later = r.paid === false && r.stamps_expected ? `<span class="small">Po opłaceniu na kartę trafi +${stampWord(r.stamps_expected)}.</span>` : '';
    return ok + bad + later;
  }

  // Odpytuje status co 3 s. Paragon czekamy najdłużej 60 s, płatność BLIK do 5 minut.
  async function pollReceipt(orderId, waitPay) {
    const run = ++pollRun;
    let started = Date.now();
    let paying = !!waitPay;
    const again = $('#rCheck');
    if (again) again.hidden = true;
    const set = (text, kind) => { const el = $('#rStatus'); if (el) { el.textContent = text; el.className = 'hint' + (kind ? ' hint--' + kind : ''); } };
    set(paying ? 'Czekam na płatność BLIK…' : 'Paragon w kolejce…');
    while (run === pollRun && tab === 'sale') {
      let s = null;
      try { s = await Api.receiptStatus(orderId); } catch (e) { /* spróbujemy jeszcze raz */ }
      if (run !== pollRun) return;
      if (s && s.stamps_added !== undefined) { const st = $('#rStamps'); if (st) st.innerHTML = stampsHtml(s); if (s.card && s.stamps_added) Api.notifyStamp(s.card.id, s.card.stamps).catch(() => {}); }
      if (s && s.failed) { pending.clear(); set('Płatność nieudana lub anulowana. Paragonu nie ma.', 'error'); const p = $('#rPay'); if (p) p.hidden = true; loadHistory(); return; }
      if (s && s.paid === false) {
        if (Date.now() - started >= 300000) { set('Płatność BLIK jeszcze nie dotarła. Sprawdź ponownie za chwilę.', 'error'); loadHistory(); break; }
        set('Czekam na płatność BLIK…');
      } else {
        if (paying) { paying = false; started = Date.now(); pending.clear(); const p = $('#rPay'); if (p) p.hidden = true; }
        if (s && s.receipt === 'confirmed') { set('Paragon wydrukowany ✅', 'reward'); loadHistory(); return; }
        if (s && s.receipt === 'error') { set('Błąd paragonu. Sprawdź program eDPS i zamówienie w WooCommerce.', 'error'); loadHistory(); break; }
        if (Date.now() - started >= 60000) { set('Paragon czeka – sprawdź, czy komputer z eDPS jest włączony.', 'error'); loadHistory(); break; }
        set(s && s.receipt === 'sent' ? 'Paragon wysłany do drukarki…' : 'Opłacone. Paragon w kolejce…');
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
    const b = $('#rCheck');
    if (b && run === pollRun) b.hidden = false;
  }

  // Po wczytaniu historii dociąga ze sklepu aktualny status sprzedaży z ostatnich 7 dni,
  // które nie mają jeszcze wydrukowanego paragonu (np. stary, fałszywy błąd).
  async function loadHistory(refreshed) {
    const box = $('#sHistory');
    if (!box) return;
    let list;
    try { list = await Api.voucherSales(); } catch (e) { box.innerHTML = '<p class="error" style="padding:12px 0">' + esc(e.message) + '</p>'; return; }
    if (!list.length) { box.innerHTML = '<p class="small" style="padding:12px 0;margin:0">Nie ma jeszcze sprzedaży z panelu.</p>'; return; }
    box.innerHTML = list.map((s) => {
      const d = new Date(s.created_at);
      const when = UI.fmtShort(s.created_at) + ', ' + d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
      const ok = s.receipt === 'confirmed';
      const bad = s.receipt === 'error' || s.receipt === 'failed';
      return `<div class="list-row" style="flex-direction:column;gap:4px">
        <div class="row" style="align-items:baseline"><span>${esc(s.product_name)}${s.qty > 1 ? ' × ' + s.qty : ''}</span><span class="strong" style="color:var(--text)">${zl(s.total)}</span></div>
        <div class="row" style="align-items:center"><span class="small">${esc(when)}${s.order_number ? ' · nr ' + esc(s.order_number) : ''}${s.stamps_added > 0 ? ' · +' + s.stamps_added + ' piecz.' : ''}</span>
          <span class="small ${ok ? 'gold' : bad ? 'error' : ''}" style="${bad ? 'font-size:13px' : ''}">${esc(s.receipt === 'pending' && s.order_id ? RECEIPT.waiting_payment : RECEIPT[s.receipt] || s.receipt)}${!ok && s.receipt !== 'failed' && s.order_id ? ` <button class="linkbtn" data-check="${s.order_id}" style="min-height:0;padding:0;font-size:13px">sprawdź</button>` : ''}</span></div>
        ${s.error ? `<span class="error" style="font-size:12.5px">${esc(s.error)}</span>` : ''}
      </div>`;
    }).join('');
    box.querySelectorAll('[data-check]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { const r = await Api.receiptStatus(+b.dataset.check); toast('Zamówienie ' + (r.order_number || b.dataset.check) + ': ' + (r.failed ? 'płatność nieudana' : r.paid === false ? RECEIPT.waiting_payment : RECEIPT[r.receipt] || r.receipt) + '.'); } catch (e) { fail(e); }
      loadHistory();
    }));
    if (refreshed) return;
    const weekAgo = Date.now() - 7 * 864e5;
    const stale = list.filter((s) => s.order_id && !['confirmed', 'failed'].includes(s.receipt) && new Date(s.created_at) > weekAgo);
    if (!stale.length) return;
    for (const s of stale) { try { await Api.receiptStatus(s.order_id); } catch (e) { /* zostaje stary status */ } }
    loadHistory(true);
  }

  start();
})();
