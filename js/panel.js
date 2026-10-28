// Panel studia: logowanie, plan dnia, skaner, pieczątki, karty bez aplikacji, sprzedaż voucherów.
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
  let tab = 'home';        // 'home' = klientki i plan dnia, 'sale' = sprzedaż vouchera
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
    return `<div class="tabs" role="tablist" aria-label="Sekcje panelu">
      <button role="tab" data-tab="home" aria-selected="${tab === 'home'}">Klientki</button>
      <button role="tab" data-tab="sale" aria-selected="${tab === 'sale'}">Sprzedaż vouchera</button>
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
    if (tab === 'integr') return Integracje.render(main, () => { tab = 'home'; renderHome(); });
    main.innerHTML = `
      ${tabsHtml()}
      <h1>Panel studia</h1>
      <button class="btn btn--gold" id="scanBtn" style="min-height:58px">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3"/><path d="M16 4h3a1 1 0 0 1 1 1v3"/><path d="M20 16v3a1 1 0 0 1-1 1h-3"/><path d="M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M4 12h16"/></svg>
        Skanuj kod QR klientki
      </button>
      <button class="btn btn--line" id="newBtn">+ Nowa klientka bez aplikacji</button>
      ${'Notification' in window && 'PushManager' in window && Notification.permission !== 'denied' ? '<button class="btn btn--line" id="ownerPushBtn">Powiadomienia o dniu w studiu na tym telefonie</button>' : ''}
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
        <p class="small" style="margin:0">Wizyty z Booksy dopisują się same (z godziną), gdy integracja jest podłączona. Ręcznie dodasz klientkę przyciskiem „+” przy nazwisku, do dnia wybranego wyżej. „×” usuwa odwołaną wizytę.</p>
      </section>
      <section style="display:flex;flex-direction:column;gap:10px">
        <label class="eyebrow" for="search">Klientki</label>
        <input class="input" id="search" type="search" placeholder="Szukaj po imieniu, nazwisku lub telefonie" value="${esc(query)}" style="background:var(--surface)">
        <div class="panel panel--tight" id="list"><div class="spinner"></div></div>
      </section>
      <button class="btn btn--ghost" id="integrBtn">Integracje: Booksy i Kalendarz Google</button>`;
    bindTabs();
    $('#scanBtn').addEventListener('click', openScanner);
    $('#newBtn').addEventListener('click', () => openNewCard());
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
    const opb = $('#ownerPushBtn');
    if (opb) opb.addEventListener('click', enableOwnerPush);
    $('#search').addEventListener('input', (e) => { query = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(loadList, 250); });
    loadRefs().then(loadPlan);
    loadList();
    loadRequests();
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

  // Powiadomienia dla studia (dzień w studiu, urodziny) na tym telefonie.
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
    if (!plan.length) { box.innerHTML = '<div class="panel" style="padding:16px"><span class="small">' + (day < 2 ? 'Na ' + DAY_NAME[day] + ' nikogo jeszcze nie dodano.' : 'Na kolejne ' + PLAN_AHEAD + ' dni nie ma jeszcze żadnych wizyt.') + '</span></div>'; return; }
    const todo = plan.filter((p) => p.status === 'planned').length;
    const hhmm = (iso) => new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    const row = (p) => {
      const done = p.status !== 'planned';
      const tags = (p.booking_id ? ' <span class="tag">Booksy</span>' : '') + (p.conflict ? ' <span class="tag">kolizja</span>' : '') +
        (!day && p.bday_today && p.birthday_used_year !== Rules.todayPL().y ? ' <span class="tag tag--solid">urodziny</span>' : '') +
        (refWelcome.has(p.card_id) && !done ? ' <span class="tag tag--solid">z polecenia −10%</span>' : '');
      const meta = (p.start_at ? hhmm(p.start_at) + ' · ' : '') + (p.service || 'rytuał') + ' · ' +
        (!p.card_id ? 'bez karty, przypisz w Integracjach' : done ? (MODE_LABEL[p.status] || p.status) : p.stamps + '/10' + (p.stamps === 4 ? (day ? ' · −15%' : ' · teraz −15%') : p.stamps === 9 ? (day ? ' · −30%' : ' · teraz −30%') : ''));
      const target = p.card_id ? `data-open="${esc(p.card_id)}" data-plan="${day ? '' : esc(p.id)}"` : 'data-integr="1"';
      return `<div class="client">
        <button class="client__main" ${target} style="${done ? 'opacity:.6' : ''}">
          <span class="avatar" style="${done ? 'background:var(--gold);color:var(--on-gold);border-color:var(--gold)' : ''}">${done ? '✓' : esc(UI.initials(p.name))}</span>
          <span><span class="client__name">${esc(p.name)}${tags}</span>
          <span class="client__meta">${esc(meta)}</span></span>
        </button>
        ${done ? '' : `<button class="plus plus--ghost" data-plan-del="${esc(p.id)}" aria-label="Usuń z planu: ${esc(p.name)}">×</button>${day || !p.card_id ? '' : `<button class="plus" data-open="${esc(p.card_id)}" data-plan="${esc(p.id)}" aria-label="Zapisz wizytę: ${esc(p.name)}">›</button>`}`}
      </div>`;
    };
    if (day < 2) {
      box.innerHTML = '<div class="panel panel--tight">' + plan.map(row).join('') + '</div>' + (todo || day ? '' : '<p class="small gold" style="margin:8px 0 0">Wszystkie wizyty z planu są zapisane.</p>');
    } else {
      // kolejne dni: wizyty pogrupowane według dnia
      const days = [...new Set(plan.map((p) => p.day))];
      box.innerHTML = '<div style="display:flex;flex-direction:column;gap:12px">' + days.map((d) => {
        const list = plan.filter((p) => p.day === d);
        return `<div style="display:flex;flex-direction:column;gap:6px"><span class="small">${esc(dateLabel(d).replace(/^./, (ch) => ch.toUpperCase()))} · ${list.length} ${list.length === 1 ? 'wizyta' : list.length < 5 ? 'wizyty' : 'wizyt'}</span><div class="panel panel--tight">${list.map(row).join('')}</div></div>`;
      }).join('') + '</div>';
    }
    box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openCard(b.dataset.open, +b.dataset.plan || b.dataset.plan)));
    box.querySelectorAll('[data-integr]').forEach((b) => b.addEventListener('click', () => { tab = 'integr'; renderHome(); window.scrollTo(0, 0); }));
    // odwołana wizyta: usunięcie z planu (karta i pieczątki zostają bez zmian)
    box.querySelectorAll('[data-plan-del]').forEach((b) => b.addEventListener('click', async () => {
      const p = plan.find((x) => String(x.id) === b.dataset.planDel);
      const when = day < 2 ? DAY_NAME[day] : dateLabel(p.day);
      if (!(await UI.ask('Usunąć ' + p.name + ' z planu na ' + when + '? Karta i pieczątki zostaną bez zmian.' + (p.booking_id ? ' Rezerwację w Booksy odwołaj w Booksy.' : ''), 'Usuń z planu'))) return;
      try { await Api.planRemove(p.id); toast('Usunięto z planu.'); loadPlan(); } catch (e) { fail(e); }
    }));
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
    box.querySelectorAll('[data-plan-add]').forEach((b) => b.addEventListener('click', async () => {
      try { await Api.planAdd(b.dataset.planAdd, null, planTarget()); toast('Dodano do planu na ' + targetName() + '.'); loadPlan(); } catch (e) { fail(e); }
    }));
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
        <div class="row"><span class="small">Karta od</span><span>${esc(UI.fmtDate(c.created_at))}</span></div>
        ${c.referred_by_name ? `<div class="row"><span class="small">Z polecenia</span><span>${esc(c.referred_by_name)}</span></div>` : ''}
        ${c.ref_count ? `<div class="row"><span class="small">Poleciła</span><span>${c.ref_count} ${UI.plural(c.ref_count, 'osobę', 'osoby', 'osób')}${c.ref_rewarded < c.ref_count ? ' · ' + (c.ref_count - c.ref_rewarded) + ' przed wizytą' : ''}</span></div>` : ''}
        ${c.bonus_stamps ? `<div class="hint">Czeka ${c.bonus_stamps} ${UI.plural(c.bonus_stamps, 'pieczątka', 'pieczątki', 'pieczątek')} za polecenie. Dopisze się sama po najbliższej wizycie (nie zajmuje kratki z rabatem).</div>` : ''}
        ${c.cards_completed ? `<div class="row"><span class="small">Ukończone karty</span><span>${c.cards_completed}</span></div>` : ''}
        ${c.note ? `<div class="hint">${esc(c.note)}</div>` : ''}
        <button class="btn btn--ghost btn--sm" id="editBtn">Edytuj dane</button>
      </section>
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
    document.querySelectorAll('[data-plan-btn]').forEach((b) => b.addEventListener('click', async () => {
      const o = +b.dataset.planBtn;
      try { await Api.planAdd(c.id, svc(), Rules.dayPL(o)); toast('Dodano do planu na ' + DAY_NAME[o] + '.'); } catch (e) { fail(e); }
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
    $('#smsBtn').setAttribute('href', smsHref(c));
    const smsOk = $('#smsOk');
    if (c.phone) Api.smsConsent(c.id).then((ok) => { smsOk.checked = !!ok; $('#smsOkRow').hidden = false; }).catch(() => {});
    smsOk.addEventListener('change', async () => {
      try { await Api.setSmsConsent(c.id, smsOk.checked); toast(smsOk.checked ? 'Zapisano zgodę na SMS.' : 'Bez SMS dla tej karty.'); }
      catch (e) { smsOk.checked = !smsOk.checked; fail(e); }
    });
  }

  function on(sel, fn) { const el = sheetIn.querySelector(sel); if (el) el.addEventListener('click', fn); }

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

  // ---------- skaner QR ----------
  const scanner = $('#scanner');
  const video = $('#video');
  let stream = null, scanning = false, detector = null, canvas = null;

  function loadJsQR() {
    if (window.jsQR) return Promise.resolve();
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/jsQR.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }

  async function openScanner() {
    scanner.hidden = false;
    $('#scanMsg').textContent = 'Skieruj aparat na kod QR klientki.';
    $('#codeInput').value = '';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      video.srcObject = stream;
      await video.play();
      if ('BarcodeDetector' in window) {
        try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; }
      }
      if (!detector) await loadJsQR();
      scanning = true;
      tick();
    } catch (e) {
      $('#scanMsg').textContent = 'Nie mam dostępu do aparatu. Zezwól na aparat w przeglądarce albo wpisz kod karty poniżej.';
    }
  }
  function closeScanner() {
    scanning = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    scanner.hidden = true;
  }
  async function tick() {
    if (!scanning) return;
    let text = null;
    try {
      if (video.readyState >= 2) {
        if (detector) {
          const codes = await detector.detect(video);
          if (codes.length) text = codes[0].rawValue;
        } else {
          canvas = canvas || document.createElement('canvas');
          const w = Math.min(640, video.videoWidth), h = Math.round(video.videoHeight * (w / video.videoWidth));
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(video, 0, 0, w, h);
          const r = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
          if (r) text = r.data;
        }
      }
    } catch (e) { /* kolejna klatka */ }
    if (text) return handleCode(text);
    setTimeout(tick, 200);
  }
  async function handleCode(text) {
    let code = String(text).trim();
    const m = code.match(/^TCTD:([A-Z0-9]{4,10})$/i);
    if (m) code = m[1];
    if (!/^[A-Z0-9]{4,10}$/i.test(code)) {
      $('#scanMsg').textContent = 'To nie jest kod karty rytuałów. Spróbuj jeszcze raz.';
      if (scanning) setTimeout(tick, 1200);
      return;
    }
    if (navigator.vibrate) navigator.vibrate(60);
    try {
      const c = await Api.findCard(code);
      if (!c) {
        $('#scanMsg').textContent = 'Nie znaleziono karty ' + code.toUpperCase() + '.';
        if (scanning) setTimeout(tick, 1500);
        return;
      }
      closeScanner();
      current = c;
      // jeśli klientka jest w dzisiejszym planie, podepnij wizytę
      currentPlan = null;
      try {
        const p = (await Api.planList()).find((x) => x.card_id === c.id && x.status === 'planned');
        if (p) { currentPlan = p.id; if (p.service) lastService = p.service; }
      } catch (e) { /* bez planu */ }
      toast('Zeskanowano: ' + c.name);
      renderCard();
    } catch (e) { fail(e); if (scanning) setTimeout(tick, 1500); }
  }
  $('#scanClose').addEventListener('click', closeScanner);
  $('#codeForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#codeInput').value.trim(); if (v) handleCode(v); });

  start();
})();
