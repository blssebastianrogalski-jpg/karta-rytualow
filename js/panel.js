// Panel studia: logowanie, plan dnia, skaner, pieczątki, karty bez aplikacji.
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

  if (Api.demo) $('#demoBar').hidden = false;
  UI.registerSW();

  const MODE_LABEL = {
    stamp: 'Pojedynczy rytuał',
    package_buy: 'Zakup pakietu',
    package_visit: 'Wizyta z pakietu',
    birthday: 'Rytuał urodzinowy −25%',
    skipped: 'Odwołana',
    planned: 'Zaplanowana'
  };
  const fail = (e) => toast(e.message || 'Coś poszło nie tak.', 'error');
  const appUrl = () => new URL('./', location.href).href;
  const linkFor = (c) => appUrl() + '?k=' + encodeURIComponent(c.token);

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
  async function renderHome() {
    main.innerHTML = `
      <h1>Panel studia</h1>
      <button class="btn btn--gold" id="scanBtn" style="min-height:58px">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3"/><path d="M16 4h3a1 1 0 0 1 1 1v3"/><path d="M20 16v3a1 1 0 0 1-1 1h-3"/><path d="M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M4 12h16"/></svg>
        Skanuj kod QR klientki
      </button>
      <button class="btn btn--line" id="newBtn">+ Nowa klientka bez aplikacji</button>
      <div id="bdays"></div>
      <section style="display:flex;flex-direction:column;gap:10px">
        <div class="row"><span class="eyebrow">Plan dnia · ${new Date().toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' })}</span></div>
        <div id="plan"><div class="spinner"></div></div>
        <p class="small" style="margin:0">Booksy nie udostępnia swojego kalendarza innym aplikacjom, więc rano dodaj klientki do planu (przycisk „+” przy nazwisku albo „Dodaj do planu dnia” na karcie).</p>
      </section>
      <section style="display:flex;flex-direction:column;gap:10px">
        <label class="eyebrow" for="search">Klientki</label>
        <input class="input" id="search" type="search" placeholder="Szukaj po imieniu, nazwisku lub telefonie" value="${esc(query)}" style="background:var(--surface)">
        <div class="panel panel--tight" id="list"><div class="spinner"></div></div>
      </section>`;
    $('#scanBtn').addEventListener('click', openScanner);
    $('#newBtn').addEventListener('click', () => openNewCard());
    $('#search').addEventListener('input', (e) => { query = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(loadList, 250); });
    loadPlan();
    loadList();
  }

  async function loadPlan() {
    const box = $('#plan');
    if (!box) return;
    let plan;
    try { plan = await Api.planList(); } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; return; }
    if (!plan.length) { box.innerHTML = '<div class="panel" style="padding:16px"><span class="small">Na dziś nikogo jeszcze nie dodano.</span></div>'; return; }
    const todo = plan.filter((p) => p.status === 'planned').length;
    box.innerHTML = '<div class="panel panel--tight">' + plan.map((p) => {
      const done = p.status !== 'planned';
      return `<div class="client">
        <button class="client__main" data-open="${esc(p.card_id)}" data-plan="${esc(p.id)}" style="${done ? 'opacity:.6' : ''}">
          <span class="avatar" style="${done ? 'background:var(--gold);color:var(--on-gold);border-color:var(--gold)' : ''}">${done ? '✓' : esc(UI.initials(p.name))}</span>
          <span><span class="client__name">${esc(p.name)}${p.bday_today && p.birthday_used_year !== Rules.todayPL().y ? ' <span class="tag tag--solid">urodziny</span>' : ''}</span>
          <span class="client__meta">${esc(p.service || 'rytuał')} · ${done ? esc(MODE_LABEL[p.status] || p.status) : p.stamps + '/10' + (p.stamps === 4 ? ' · teraz −15%' : p.stamps === 9 ? ' · teraz −30%' : '')}</span></span>
        </button>
        ${done ? '' : `<button class="plus" data-open="${esc(p.card_id)}" data-plan="${esc(p.id)}" aria-label="Zapisz wizytę: ${esc(p.name)}">›</button>`}
      </div>`;
    }).join('') + '</div>' + (todo ? '' : '<p class="small gold" style="margin:8px 0 0">Wszystkie wizyty z planu są zapisane.</p>');
    box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openCard(b.dataset.open, +b.dataset.plan || b.dataset.plan)));
  }

  async function loadList() {
    const box = $('#list');
    if (!box) return;
    let list;
    try { list = await Api.listCards(query); } catch (e) { box.innerHTML = '<p class="error" style="padding:12px">' + esc(e.message) + '</p>'; return; }
    const y = Rules.todayPL().y;
    const bdays = list.filter((c) => c.bday_today);
    const bBox = $('#bdays');
    if (bBox && !query) {
      bBox.innerHTML = bdays.length ? `<div class="panel panel--gold" style="padding:14px 16px;gap:6px"><span class="eyebrow eyebrow--gold">Urodziny dziś</span>${bdays.map((c) => `<button class="linkbtn" style="text-align:left;text-decoration:none;color:var(--text)" data-open="${esc(c.id)}">${esc(c.name)} · ${c.birthday_used_year === y ? 'rabat już wykorzystany' : '<span class="gold">−25% na dzisiejszy rytuał</span>'}</button>`).join('')}</div>` : '';
      bBox.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openCard(b.dataset.open)));
    }
    if (!list.length) { box.innerHTML = '<p class="small" style="padding:14px 4px">' + (query ? 'Brak klientek o tej nazwie.' : 'Nie ma jeszcze żadnych kart.') + '</p>'; return; }
    box.innerHTML = list.map((c) => {
      const tag = (c.bday_today ? ' · urodziny dziś' : c.stamps === 4 ? ' · następna −15%' : c.stamps === 9 ? ' · następna −30%' : c.stamps >= 10 ? ' · karta pełna' : '') + (c.source === 'studio' ? ' · bez aplikacji' : '');
      return `<div class="client">
        <button class="client__main" data-open="${esc(c.id)}">
          <span class="avatar">${esc(UI.initials(c.name))}</span>
          <span><span class="client__name">${esc(c.name)}</span><span class="client__meta">${c.stamps} / 10 pieczątek${esc(tag)}</span></span>
        </button>
        <button class="plus" data-plan-add="${esc(c.id)}" aria-label="Dodaj ${esc(c.name)} do planu dnia">+</button>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openCard(b.dataset.open)));
    box.querySelectorAll('[data-plan-add]').forEach((b) => b.addEventListener('click', async () => {
      try { await Api.planAdd(b.dataset.planAdd); toast('Dodano do planu dnia.'); loadPlan(); } catch (e) { fail(e); }
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
    loadPlan(); loadList();
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
    try { current = await Api.getCard(id); } catch (e) { return fail(e); }
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
        ${c.source === 'studio' ? '<span class="tag">bez aplikacji</span>' : '<span class="tag">w aplikacji</span>'}
        ${c.bday_today ? '<span class="tag tag--solid">urodziny dziś</span>' : ''}
      </div>
      ${currentPlan ? '<p class="small gold" style="margin:0">Wizyta z planu dnia. Po zapisaniu odhaczy się w planie.</p>' : ''}
      ${bdayAvail ? `<section class="panel panel--gold bday-today" style="gap:10px"><span class="eyebrow eyebrow--gold">Urodziny dziś · −25%</span><span class="small" style="color:var(--text-2)">Rabat urodzinowy na dzisiejszy rytuał. Nie łączy się z innymi promocjami, więc nie dodaje pieczątki.</span><button class="btn btn--gold" id="bdayBtn">Rytuał urodzinowy −25%</button></section>` : ''}
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
      ${currentPlan ? '' : '<button class="btn btn--ghost" id="planBtn">+ Dodaj do planu dnia</button>'}
      <section class="panel">
        <span class="eyebrow">Karta w telefonie klientki</span>
        <p class="small" style="margin:0">${c.source === 'studio' ? 'Klientka nie ma jeszcze aplikacji. Wyślij jej SMS z linkiem: gdy go otworzy, karta połączy się z aplikacją razem ze wszystkimi pieczątkami.' : 'Link przyda się, gdy klientka zmieni telefon albo usunie aplikację.'}</p>
        <a class="btn btn--line" id="smsBtn" href="#">Wyślij SMS ze stanem karty</a>
        <div class="btn-row">
          <button class="btn btn--ghost btn--sm" id="linkQrBtn">Pokaż kod do połączenia</button>
          <button class="btn btn--ghost btn--sm" id="printBtn">Drukuj kartę</button>
        </div>
        <div id="linkQr" hidden></div>
      </section>
      <section class="panel" style="gap:12px">
        <span class="eyebrow">Dane klientki</span>
        <div class="row"><span class="small">Telefon</span><span>${c.phone ? `<a href="tel:${esc(c.phone.replace(/\s/g, ''))}">${esc(c.phone)}</a>` : '—'}</span></div>
        <div class="row"><span class="small">Urodziny</span><span>${esc(UI.fmtBday(c.bday_day, c.bday_month) || '—')}${c.birthday_used_year === y ? ' <span class="tag">wykorzystane ' + y + '</span>' : ''}</span></div>
        <div class="row"><span class="small">Karta od</span><span>${esc(UI.fmtDate(c.created_at))}</span></div>
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
      try { current = await Api.useBirthday(c.id, svc(), currentPlan); currentPlan = null; toast('Rabat urodzinowy −25% zapisany: ' + c.name + '.', 'reward'); renderCard(); } catch (e) { fail(e); }
    });
    on('#planBtn', async () => { try { await Api.planAdd(c.id, svc()); toast('Dodano do planu dnia.'); } catch (e) { fail(e); } });
    on('#editBtn', () => openEdit());
    on('#delBtn', async () => {
      if (!(await UI.ask('Usunąć kartę: ' + c.name + '? Tego nie da się cofnąć.', 'Usuń'))) return;
      try { await Api.deleteCard(c.id); toast('Usunięto kartę.'); closeSheet(); } catch (e) { fail(e); }
    });
    on('#linkQrBtn', () => {
      const box = $('#linkQr');
      box.hidden = !box.hidden;
      box.innerHTML = box.hidden ? '' : `<div class="qr-card">${UI.qrSvg(linkFor(c), { label: 'Kod do połączenia karty z aplikacją' })}<span class="small" style="color:#5C4A24;text-align:center">Klientka skanuje ten kod aparatem w swoim telefonie. Otworzy się aplikacja z jej kartą.</span></div>`;
    });
    on('#printBtn', () => printCard(c));
    $('#smsBtn').setAttribute('href', smsHref(c));
  }

  function on(sel, fn) { const el = sheetIn.querySelector(sel); if (el) el.addEventListener('click', fn); }

  async function record(mode, service, btn) {
    const c = current;
    const n = c.stamps + 1;
    btn.disabled = true;
    try {
      current = await Api.recordVisit(c.id, mode, service, currentPlan);
      if (service) lastService = service;
      currentPlan = null;
      const first = c.name.split(' ')[0];
      if (mode === 'package_visit') toast('Zapisano wizytę z pakietu (bez pieczątki).');
      else if (n === 5) toast('5. rytuał ' + first + ': nalicz rabat −15%.', 'reward');
      else if (n === 10) toast('10. rytuał ' + first + ': nalicz rabat −30%.', 'reward');
      else toast('Dodano pieczątkę: ' + c.name + ' (' + n + '/10).');
      renderCard(mode === 'package_visit' ? null : n);
    } catch (e) { btn.disabled = false; fail(e); }
  }

  function smsText(c) {
    const p = UI.progressText(c.stamps);
    return 'Dzień dobry, ' + c.name.split(' ')[0] + '! Na Twojej karcie rytuałów w studiu ' + CFG.STUDIO_NAME + ' masz ' + c.stamps + '/10 pieczątek. ' +
      p.head + '. Kartę możesz mieć w telefonie: ' + linkFor(c) + ' Do zobaczenia!';
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
      <p>5. rytuał −15% · 10. rytuał −30% · w dniu urodzin −25%</p>
      <p>Pokaż ten kod przy każdej wizycie.</p>
      <p>${esc(CFG.PHONE)} · ${esc(CFG.ADDRESS)}</p>`;
    setTimeout(() => window.print(), 300);
  }

  // ---------- edycja / nowa karta ----------
  function cardForm(c, isNew) {
    return `
      <form class="panel" id="cardForm" novalidate>
        ${isNew ? '<span class="eyebrow eyebrow--gold">Karta prowadzona przez studio</span><p class="small" style="margin:0">Dla klientki, która nie chce lub nie może pobrać aplikacji. Pieczątki dodajesz tutaj. Możesz jej wydrukować kartę z kodem albo wysłać SMS. Gdy kiedyś otworzy link z SMS-a, karta połączy się z aplikacją.</p>' : ''}
        <div class="field"><label for="fName">Imię i nazwisko</label><input class="input" id="fName" value="${esc(c.name || '')}" placeholder="np. Halina Mazur" autocomplete="off"></div>
        <div class="field"><label for="fPhone">Telefon (do SMS)</label><input class="input" id="fPhone" type="tel" value="${esc(c.phone || '')}" placeholder="np. 600 000 000" autocomplete="off"></div>
        <div class="field"><span class="label" id="fBdayL">Data urodzin (do rabatu −25%)</span>
          <div class="split" role="group" aria-labelledby="fBdayL"><select class="input" id="fDay" aria-label="Dzień">${UI.dayOptions(c.bday_day)}</select><select class="input" id="fMonth" aria-label="Miesiąc">${UI.monthOptions(c.bday_month)}</select></div></div>
        ${isNew ? `<div class="field"><label for="fStamps">Pieczątki przeniesione z papierowej karty</label><select class="input" id="fStamps">${Array.from({ length: 10 }, (_, i) => `<option value="${i}">${i}</option>`).join('')}</select></div>` : `<div class="field"><label for="fNote">Notatka (widzi tylko studio)</label><textarea class="input" id="fNote">${esc(c.note || '')}</textarea></div>`}
        <p class="error" id="fErr" role="alert" hidden></p>
        <button class="btn btn--gold" type="submit">${isNew ? 'Załóż kartę' : 'Zapisz zmiany'}</button>
      </form>`;
  }
  function readForm() {
    const day = +$('#fDay').value || null, month = +$('#fMonth').value || null;
    const f = { name: $('#fName').value.trim(), phone: $('#fPhone').value.trim(), day, month };
    if (f.name.length < 2) throw new Error('Wpisz imię i nazwisko.');
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
        toast('Zapisano zmiany.');
        renderCard();
      } catch (ex) { const el = $('#fErr'); el.textContent = ex.message; el.hidden = false; }
    });
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
