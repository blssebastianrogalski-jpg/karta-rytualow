// Aplikacja klientki: karta, urodziny, kod QR.
(function () {
  const CFG = window.APP_CONFIG;
  const { esc, $, toast } = UI;
  const main = $('#main');
  const nav = $('#nav');
  let card = null;
  let screen = 'card';
  let poll = null;
  let installEvt = null;
  // Karta działa tylko jako aplikacja z ikony na ekranie telefonu. W przeglądarce pokazujemy instrukcję instalacji.
  const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const UA = navigator.userAgent;
  const IOS = /iphone|ipad|ipod/i.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
  const IN_APP = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger|Line\/|; wv\)/i.test(UA);

  if (Api.demo) $('#demoBar').hidden = false;
  UI.registerSW();

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (screen === 'install') renderInstall(); else if (screen === 'card' && card) render(); });
  window.addEventListener('appinstalled', () => { installEvt = null; if (screen === 'install') renderInstall(true); });

  const VISIT_LABEL = {
    stamp: 'Pojedynczy rytuał',
    package_buy: 'Zakup pakietu',
    package_visit: 'Wizyta z pakietu',
    birthday: 'Rytuał urodzinowy −20%',
    referral: 'Pieczątka za polecenie'
  };

  // kod polecającej z linku …/?p=KOD (czeka, aż koleżanka założy kartę)
  const REF_KEY = 'tctd.ref';
  const RefStore = {
    get() { try { return localStorage.getItem(REF_KEY); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(REF_KEY, v); } catch (e) { /* ignore */ } },
    clear() { try { localStorage.removeItem(REF_KEY); } catch (e) { /* ignore */ } }
  };
  let refName = null;
  async function loadRefName() {
    const code = RefStore.get();
    if (!code || refName !== null) return refName;
    try { const r = await Api.referralInfo(code); refName = r ? r.name : ''; } catch (e) { return null; }
    if (!refName) RefStore.clear();
    return refName;
  }

  // ---------- start ----------
  async function start() {
    const params = new URLSearchParams(location.search);
    let linkToken = params.get('k');
    const shortLink = params.get('c');
    const refCode = (params.get('p') || '').trim().toUpperCase();
    if (/^[A-Z0-9]{6}$/.test(refCode)) RefStore.set(refCode);
    if (shortLink && !linkToken) {
      try { linkToken = await Api.cardByLink(shortLink); } catch (e) { /* bez połączenia: spróbuje zapisanej karty */ }
      if (!linkToken) {
        history.replaceState(null, '', location.pathname);
        if (!CardStore.get()) return renderJoin('Ten link do karty jest nieaktualny. Poproś w studiu o nowy albo zaloguj się kodem SMS.');
      }
    }
    if (!STANDALONE && !Api.demo) {
      if (linkToken) CardStore.set(linkToken);
      // iPhone trzyma aplikację z ekranu osobno od Safari, więc link karty musi trafić do ikony
      const keep = IOS && (linkToken || CardStore.get());
      const ref = IOS && !keep && RefStore.get();
      const query = keep ? '?k=' + encodeURIComponent(keep) : ref ? '?p=' + encodeURIComponent(ref) : '';
      history.replaceState(null, '', location.pathname + query);
      if (query) carryToIcon(query);
      return renderInstall();
    }
    if (linkToken || refCode) history.replaceState(null, '', location.pathname);
    if (linkToken) CardStore.set(linkToken);
    const token = CardStore.get();
    if (!token) return renderJoin();
    try {
      card = await Api.getMyCard(token);
    } catch (e) {
      main.innerHTML = '<div class="panel"><h2>Brak połączenia</h2><p class="lead">Sprawdź internet i spróbuj ponownie.</p><button class="btn btn--gold" onclick="location.reload()">Spróbuj ponownie</button></div>';
      return;
    }
    if (!card) {
      CardStore.clear();
      return renderJoin('Nie znalazłam tej karty. Załóż nową albo poproś w studiu o link do swojej karty.');
    }
    if (STANDALONE) Api.markAppOpen(token).catch(() => { /* bez wpływu na kartę */ });
    if (linkToken) toast('Witaj, ' + firstName() + '! Twoja karta jest już w aplikacji.');
    go(location.hash.replace('#', '') || 'card');
  }

  function firstName() { return card ? card.name.split(/\s+/)[0] : ''; }

  // ---------- instalacja (karta nie otwiera się w przeglądarce) ----------
  function carryToIcon(query) {
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return;
    const base = new URL('./', location.href).href;
    fetch(link.href).then((r) => r.json()).then((m) => {
      m.start_url = base + query + '#card';
      m.scope = base; m.id = base;
      m.icons = (m.icons || []).map((i) => ({ ...i, src: new URL(i.src, base).href }));
      link.href = 'data:application/manifest+json,' + encodeURIComponent(JSON.stringify(m));
    }).catch(() => { /* zostaje adres strony z linkiem karty */ });
  }

  function renderInstall(installed) {
    screen = 'install';
    nav.hidden = true;
    document.getElementById('app').classList.remove('app--nav');
    const hasCard = !!CardStore.get();
    const step = (n, html) => `<div class="install"><span class="install__n">${n}</span><span style="flex:1">${html}</span></div>`;
    let how;
    if (installed) {
      how = step('✓', 'Gotowe! Zamknij przeglądarkę i otwórz <b>Kartę rytuałów</b> z ikony na ekranie telefonu.');
    } else if (IN_APP) {
      how = step(1, 'Ten link otworzył się wewnątrz Messengera, Facebooka albo Instagrama. Stuknij <b>⋯</b> w rogu ekranu i wybierz <b>Otwórz w przeglądarce</b>' + (IOS ? ' (Safari)' : ' (Chrome)') + '.')
        + step(2, 'W przeglądarce zobaczysz tę stronę jeszcze raz, z instrukcją dodania karty do ekranu.');
    } else if (IOS) {
      how = step(1, 'Stuknij <b>Udostępnij</b> ⬆︎ na dole ekranu (w Safari).')
        + step(2, 'Przewiń w dół i wybierz <b>Do ekranu początkowego</b>, potem <b>Dodaj</b>.')
        + step(3, 'Otwórz <b>Kartę rytuałów</b> z nowej ikony na ekranie telefonu.');
    } else if (installEvt) {
      how = `<button class="btn btn--gold" id="installBtn">Zainstaluj aplikację</button>`
        + step(2, 'Potem otwórz <b>Kartę rytuałów</b> z ikony na ekranie telefonu.');
    } else {
      how = step(1, 'Stuknij menu <b>⋮</b> w rogu przeglądarki.')
        + step(2, 'Wybierz <b>Zainstaluj aplikację</b> albo <b>Dodaj do ekranu głównego</b>. Jeśli widzisz <b>Otwórz w aplikacji</b>, karta jest już zainstalowana.')
        + step(3, 'Otwórz <b>Kartę rytuałów</b> z ikony na ekranie telefonu.');
    }
    main.innerHTML = `
      <div class="center" style="display:flex;flex-direction:column;align-items:center;gap:10px;padding-top:6px">
        <img src="img/mark.png" alt="" style="width:120px;height:120px">
        <span class="eyebrow eyebrow--gold">Karta rytuałów</span>
        <h1>${hasCard ? 'Twoja karta<br>czeka w aplikacji' : 'Dodaj kartę<br>do ekranu telefonu'}</h1>
        <p class="lead">Karta rytuałów działa jako aplikacja na Twoim telefonie. Dzięki temu masz ją zawsze pod ręką i dostajesz przypomnienia o pieczątkach i urodzinach.</p>
      </div>
      <div class="chips"><span><strong>5. rytuał</strong> −15%</span><span><strong>10. rytuał</strong> −30%</span><span><strong>Urodziny</strong> −20%</span></div>
      ${!hasCard && RefStore.get() ? inviteBox('Dodaj kartę do ekranu telefonu i załóż ją w aplikacji. Rabat zapisze się na Twojej karcie.') : ''}
      <div class="panel" style="gap:10px">
        <span class="eyebrow eyebrow--gold">Jak dodać kartę</span>
        ${how}
      </div>
      ${hasCard && IOS ? '<p class="small center">Jeśli po otwarciu z ikony nie zobaczysz swojej karty, wybierz <b>Zaloguj kodem SMS</b> i wpisz numer zapisany w studiu. Pieczątki zostaną na swoim miejscu.</p>' : ''}`;
    fillInvite();
    const ib = $('#installBtn');
    if (ib) ib.addEventListener('click', async () => {
      installEvt.prompt();
      const r = await installEvt.userChoice.catch(() => null);
      if (r && r.outcome === 'accepted') renderInstall(true);
    });
  }

  // ---------- zakładanie karty ----------
  // zaproszenie od koleżanki (imię dociąga się z bazy)
  function inviteBox(text) {
    return `<section class="panel panel--gold" style="gap:8px" id="invite"><span class="eyebrow eyebrow--gold" data-ref-name>Zaproszenie z polecenia</span><span class="strong" style="font-size:17px">Na pierwszy rytuał masz −10%</span><span class="small" style="color:var(--text-2)">${text}</span></section>`;
  }
  function fillInvite() {
    if (!$('#invite')) return;
    loadRefName().then((n) => {
      const box = $('#invite');
      if (!box) return;
      if (n === '') { box.remove(); const f = $('#jPhoneL'); if (f) f.textContent = 'Telefon (opcjonalnie)'; return; }
      if (n) box.querySelector('[data-ref-name]').textContent = 'Zaprasza Cię ' + n;
    });
  }

  function renderJoin(msg) {
    const invited = !!RefStore.get();
    nav.hidden = true;
    document.getElementById('app').classList.remove('app--nav');
    main.innerHTML = `
      <div class="center" style="display:flex;flex-direction:column;align-items:center;gap:10px;padding-top:6px">
        <img src="img/mark.png" alt="" style="width:120px;height:120px">
        <span class="eyebrow eyebrow--gold">Karta rytuałów</span>
        <h1>Każdy rytuał<br>coś Ci daje</h1>
        <p class="lead">Zbieraj pieczątki za wizyty w studiu. Przy 5. rytuale masz −15%, przy 10. aż −30%. A w dniu urodzin czeka na Ciebie −20%.</p>
      </div>
      <div class="chips"><span><strong>5. rytuał</strong> −15%</span><span><strong>10. rytuał</strong> −30%</span><span><strong>Urodziny</strong> −20%</span></div>
      ${msg ? '<p class="error" role="alert">' + esc(msg) + '</p>' : ''}
      ${invited ? inviteBox('Załóż kartę poniżej i podaj swój numer telefonu. Rabat −10% zapisze się na karcie i naliczę go przy płatności. Rabat z polecenia jest dla nowych klientek.') : ''}
      <div class="panel">
        <span class="eyebrow eyebrow--gold">Masz już kartę?</span>
        <p class="lead" style="font-size:14px;margin:0">Wpisz numer telefonu zapisany na karcie, a wyślę Ci SMS z kodem. Pieczątki zostaną na swoim miejscu.</p>
        <button class="btn btn--line" id="smsLoginBtn">Zaloguj kodem SMS</button>
      </div>
      <form class="panel" id="joinForm" novalidate>
        <h2>Załóż swoją kartę</h2>
        <div class="field"><label for="jName">Imię i nazwisko</label><input class="input" id="jName" autocomplete="name" required placeholder="np. Anna Kowalska"></div>
        <div class="field"><label for="jPhone" id="jPhoneL">${invited ? 'Telefon (do rabatu z polecenia)' : 'Telefon (opcjonalnie)'}</label><input class="input" id="jPhone" type="tel" autocomplete="tel" placeholder="np. 600 000 000"></div>
        <div class="field">
          <span class="label" id="jBdayL">Data urodzin (do rabatu −20%)</span>
          <div class="split" role="group" aria-labelledby="jBdayL">
            <select class="input" id="jDay" aria-label="Dzień urodzin">${UI.dayOptions()}</select>
            <select class="input" id="jMonth" aria-label="Miesiąc urodzin">${UI.monthOptions()}</select>
          </div>
          <span class="small">Bez roku. Datę zmienisz później tylko w studiu.</span>
        </div>
        <label class="check"><input type="checkbox" id="jOk"> <span>Zgadzam się, aby studio ${esc(CFG.STUDIO_NAME)} przechowywało moje imię, telefon i datę urodzin, wyłącznie do prowadzenia karty rytuałów.</span></label>
        <p class="error" id="jErr" role="alert" hidden></p>
        <button class="btn btn--gold" type="submit" id="jBtn">Załóż kartę</button>
      </form>
      <div class="panel">
        <span class="eyebrow">Masz już kartę w studiu?</span>
        <p class="lead" style="font-size:14px">Jeśli kartę założyła Ci Justyna w studiu, nie zakładaj nowej. Zaloguj się kodem SMS na numer zapisany w studiu albo otwórz link z SMS-a. Pieczątki przejdą same.</p>
      </div>`;
    fillInvite();
    $('#smsLoginBtn').addEventListener('click', () => renderSmsLogin());
    $('#joinForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#jName').value.trim();
      const phone = $('#jPhone').value.trim();
      const day = +$('#jDay').value || null;
      const month = +$('#jMonth').value || null;
      const err = $('#jErr');
      const fail = (t) => { err.textContent = t; err.hidden = false; };
      if (name.length < 2) return fail('Wpisz imię i nazwisko.');
      if (!UI.validBday(day, month)) return fail('Sprawdź datę urodzin (dzień i miesiąc).');
      if (!$('#jOk').checked) return fail('Zaznacz zgodę, aby założyć kartę.');
      const btn = $('#jBtn'); btn.disabled = true; btn.textContent = 'Zakładam…';
      try {
        const ref = RefStore.get();
        if (ref && phone.replace(/\D/g, '').length < 9) throw new Error('Podaj numer telefonu, aby dostać rabat −10% z polecenia.');
        card = await Api.registerCard({ name, phone, day, month, ref });
        CardStore.set(card.token);
        RefStore.clear();
        if (STANDALONE) Api.markAppOpen(card.token).catch(() => {});
        toast('Witaj, ' + firstName() + '! Twoja karta jest gotowa.');
        try { card = (await Api.getMyCard(card.token)) || card; } catch (e) { /* karta z rejestracji wystarczy */ }
        go('card');
      } catch (ex) {
        fail(ex.message);
        btn.disabled = false; btn.textContent = 'Załóż kartę';
      }
    });
  }

  // ---------- powrót do karty kodem SMS ----------
  function renderSmsLogin(phone) {
    nav.hidden = true;
    document.getElementById('app').classList.remove('app--nav');
    main.innerHTML = `
      <div class="center" style="display:flex;flex-direction:column;align-items:center;gap:10px;padding-top:6px">
        <img src="img/mark.png" alt="" style="width:96px;height:96px">
        <span class="eyebrow eyebrow--gold">Karta rytuałów</span>
        <h1>Wróć do swojej karty</h1>
      </div>
      <form class="panel" id="smsForm" novalidate>
        <div class="field"><label for="sPhone">Numer telefonu z karty</label><input class="input" id="sPhone" type="tel" autocomplete="tel" inputmode="tel" placeholder="np. 600 000 000" value="${esc(phone || '')}"></div>
        <p class="error" id="sErr" role="alert" hidden></p>
        <button class="btn btn--gold" type="submit" id="sBtn">Wyślij kod SMS</button>
      </form>
      <button class="linkbtn" id="sBack" style="align-self:center">Wróć</button>
      <p class="small center">Na karcie nie ma telefonu albo SMS nie przychodzi? Poproś w studiu o link do swojej karty.</p>`;
    $('#sBack').addEventListener('click', () => renderJoin());
    $('#smsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const num = $('#sPhone').value.trim();
      const err = $('#sErr');
      if (num.replace(/\D/g, '').length < 9) { err.textContent = 'Wpisz numer komórki, np. 600 000 000.'; err.hidden = false; return; }
      const btn = $('#sBtn'); btn.disabled = true; btn.textContent = 'Wysyłam…';
      try {
        const r = await Api.smsLoginSend(num);
        renderSmsCode(num);
        if (r && r.demoCode) toast('Tryb pokazowy: kod to ' + r.demoCode + '.');
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false;
        btn.disabled = false; btn.textContent = 'Wyślij kod SMS';
      }
    });
  }

  function renderSmsCode(phone) {
    main.innerHTML = `
      <div class="center" style="display:flex;flex-direction:column;align-items:center;gap:10px;padding-top:6px">
        <img src="img/mark.png" alt="" style="width:96px;height:96px">
        <span class="eyebrow eyebrow--gold">Karta rytuałów</span>
        <h1>Wpisz kod z SMS-a</h1>
        <p class="lead">Jeśli numer ${esc(phone)} jest zapisany na karcie, SMS z kodem przyjdzie w ciągu minuty. Kod jest ważny 10 minut.</p>
      </div>
      <form class="panel" id="codeForm" novalidate>
        <div class="field"><label for="sCode">Kod z SMS-a</label><input class="input" id="sCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 cyfr" style="letter-spacing:.3em;font-size:22px;text-align:center"></div>
        <p class="error" id="cErr" role="alert" hidden></p>
        <button class="btn btn--gold" type="submit" id="cBtn">Zaloguj</button>
      </form>
      <div class="btn-row" style="justify-content:center">
        <button class="linkbtn" id="cAgain">Wyślij kod ponownie</button>
        <button class="linkbtn" id="cChange">Zmień numer</button>
      </div>
      <p class="small center">SMS nie przychodzi? Poproś w studiu o link do swojej karty.</p>`;
    $('#sCode').focus();
    $('#cChange').addEventListener('click', () => renderSmsLogin(phone));
    $('#cAgain').addEventListener('click', async () => {
      try { const r = await Api.smsLoginSend(phone); toast(r && r.demoCode ? 'Tryb pokazowy: kod to ' + r.demoCode + '.' : 'Wysłałam nowy kod.'); } catch (ex) { toast(ex.message); }
    });
    $('#codeForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = $('#sCode').value.replace(/\D/g, '');
      const err = $('#cErr');
      if (code.length !== 6) { err.textContent = 'Kod ma 6 cyfr.'; err.hidden = false; return; }
      const btn = $('#cBtn'); btn.disabled = true; btn.textContent = 'Sprawdzam…';
      try {
        const cards = await Api.smsLoginVerify(phone, code);
        if (!cards.length) throw new Error('Nie znalazłam karty z tym numerem. Poproś w studiu o link do swojej karty.');
        if (cards.length === 1) return openFound(cards[0].token);
        renderChooseCard(cards);
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false;
        btn.disabled = false; btn.textContent = 'Zaloguj';
      }
    });
  }

  // kilka kart z tym samym numerem (np. mama i córka)
  function renderChooseCard(cards) {
    main.innerHTML = `
      <h1>Która karta jest Twoja?</h1>
      <p class="lead">Na ten numer zapisanych jest kilka kart.</p>
      <div class="panel panel--tight">${cards.map((c, i) => `<button class="list-row" data-pick="${i}" style="width:100%;background:none;border:none;color:inherit;text-align:left;padding:14px 4px"><span>${esc(c.name)}</span><span>${c.stamps} / 10</span></button>`).join('')}</div>`;
    main.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => openFound(cards[+b.dataset.pick].token)));
  }

  function openFound(token) {
    CardStore.set(token);
    history.replaceState(null, '', location.pathname);
    start().then(() => { if (card) toast('Witaj ponownie, ' + firstName() + '!'); });
  }

  // ---------- nawigacja ----------
  function go(name) {
    if (!['card', 'bday', 'qr'].includes(name)) name = 'card';
    screen = name;
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    nav.hidden = false;
    document.getElementById('app').classList.add('app--nav');
    nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', b.dataset.go === name ? 'page' : 'false'));
    render();
    window.scrollTo(0, 0);
    setPolling(name === 'qr' ? 6000 : 30000);
  }
  nav.addEventListener('click', (e) => { const b = e.target.closest('button[data-go]'); if (b) go(b.dataset.go); });

  function render(animate) {
    if (screen === 'bday') return renderBday();
    if (screen === 'qr') return renderQr();
    return renderCard(animate);
  }

  // ---------- karta ----------
  function renderCard(animate) {
    const p = UI.progressText(card.stamps);
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    let install = '';
    if (!standalone) {
      if (installEvt) install = '<div class="install"><img src="img/mark-96.png" alt="" width="40" height="40"><span style="flex:1">Dodaj kartę do ekranu telefonu, będzie zawsze pod ręką.</span><button class="btn btn--line btn--sm" id="installBtn">Dodaj</button></div>';
      else if (ios) install = '<div class="install"><img src="img/mark-96.png" alt="" width="40" height="40"><span>Dodaj kartę do ekranu telefonu: stuknij <b>Udostępnij</b> ⬆︎, a potem <b>Do ekranu początkowego</b>.</span></div>';
    }
    const pushOffer = CFG.PUSH_PUBLIC_KEY && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && Notification.permission === 'default';
    if (pushOffer) install += '<div class="install"><img src="img/mark-96.png" alt="" width="40" height="40"><span style="flex:1">Chcesz przypomnienie o urodzinach i nowych pieczątkach?</span><button class="btn btn--line btn--sm" id="pushBtn">Włącz</button></div>';
    const pushBlocked = CFG.PUSH_PUBLIC_KEY && 'Notification' in window && Notification.permission === 'denied';
    if (pushBlocked) install += '<div class="install"><img src="img/mark-96.png" alt="" width="40" height="40"><span>Nie dostajesz przypomnień? Odblokuj powiadomienia: stuknij ikonę kłódki przy adresie, potem <b>Uprawnienia</b> → <b>Powiadomienia</b> → <b>Zezwól</b>.</span></div>';
    const visits = (card.visits || []).slice(0, 5);
    const upcoming = card.upcoming || [];
    const next = upcoming.length ? `<section class="panel" style="gap:6px" aria-label="Najbliższa wizyta">
        <span class="eyebrow eyebrow--gold">${upcoming.length > 1 ? 'Twoje najbliższe wizyty' : 'Twoja najbliższa wizyta'}</span>
        ${upcoming.map((u, i) => `<div style="display:flex;flex-direction:column;gap:2px${i ? ';padding-top:8px;border-top:1px solid var(--line-soft)' : ''}"><span class="strong" style="font-size:${i ? 15 : 17}px">${esc(visitWhen(u))}</span>${u.service ? '<span class="small" style="color:var(--text-2)">' + esc(cleanService(u.service)) + '</span>' : ''}</div>`).join('')}
        <a class="btn btn--line btn--sm" href="${esc(CFG.BOOKSY_URL)}" target="_blank" rel="noopener" style="margin-top:6px">Zmień lub odwołaj w Booksy</a>
      </section>` : '';
    const lastVisit = visits[0];
    const recentVisit = lastVisit && Date.now() - new Date(lastVisit.created_at) < 7 * 864e5;
    const review = CFG.GOOGLE_REVIEW_URL && recentVisit ? `<section class="panel panel--gold" style="gap:10px"><span class="strong">Jak było${lastVisit.service ? ' na rytuale ' + esc(lastVisit.service) : ' na wizycie'}?</span><span class="small">Podziel się opinią. To dla mnie bardzo ważne.</span><a class="btn btn--gold" href="${esc(CFG.GOOGLE_REVIEW_URL)}" target="_blank" rel="noopener">Zostaw opinię w Google</a></section>` : '';
    const tiles = linkTiles();
    const welcome = card.ref_welcome ? `<section class="panel panel--gold" style="gap:6px"><span class="eyebrow eyebrow--gold">Z polecenia${card.referred_by_name ? ' · ' + esc(card.referred_by_name.split(/\s+/)[0]) : ''}</span><span class="strong" style="font-size:17px">Twój pierwszy rytuał: −10%</span><span class="small" style="color:var(--text-2)">Rabat naliczę przy płatności.</span></section>` : '';
    const refCount = card.ref_count || 0, refDone = card.ref_rewarded || 0;
    const refer = refCount || card.bonus_stamps ? `<section class="panel" style="gap:8px" aria-label="Twoje polecenia">
        <span class="eyebrow eyebrow--gold">Twoje polecenia</span>
        <span class="small">Zaproszone koleżanki: ${refCount} · ${refDone ? 'pieczątki za polecenie: ' + refDone : 'czekam na ich pierwszą wizytę'}</span>
        ${card.bonus_stamps ? `<span class="small gold">Czeka na Ciebie ${card.bonus_stamps} ${UI.plural(card.bonus_stamps, 'pieczątka', 'pieczątki', 'pieczątek')} za polecenie. Dopiszę ${card.bonus_stamps > 1 ? 'je' : 'ją'} po Twoim najbliższym rytuale, żeby nie przepadł Ci rabat.</span>` : ''}
      </section>` : '';
    main.innerHTML = `
      <div class="hello"><small>${UI.greeting()},</small><h1>${esc(firstName())}</h1></div>
      ${welcome}
      ${card.bday_today && card.birthday_used_year !== Rules.todayPL().y ? '<button class="panel panel--gold bday-today" data-go="bday" style="text-align:left;color:inherit;cursor:pointer"><span class="eyebrow eyebrow--gold">Wszystkiego najpiękniejszego!</span><span class="strong" style="font-size:17px">Dziś masz −20% na dowolny rytuał →</span></button>' : ''}
      <section class="panel" aria-label="Karta rytuałów">
        <div class="row"><span class="eyebrow eyebrow--gold">Karta rytuałów</span><span class="strong" style="font-size:15px">${card.stamps} / 10</span></div>
        ${UI.stampGrid(card.stamps, { animate })}
        <div class="divider"><span class="strong gold">${esc(p.head)}</span><span class="small" style="font-size:14px;color:var(--text-2)">${esc(p.sub)}</span></div>
        <div class="chips"><span><strong>5. rytuał</strong> −15%</span><span><strong>10. rytuał</strong> −30%</span></div>
        ${card.cards_completed ? '<span class="small">Ukończone karty: ' + card.cards_completed + '. Dziękuję, że jesteś!</span>' : ''}
      </section>
      ${next}
      <a class="btn btn--gold" href="${esc(CFG.BOOKSY_URL)}" target="_blank" rel="noopener">Umów wizytę w Booksy</a>
      ${tiles}
      ${install}
      ${visits.length ? `<section style="display:flex;flex-direction:column;gap:10px"><span class="eyebrow">Ostatnie wizyty</span><div class="panel panel--tight">${visits.map((v) => `<div class="list-row"><span>${esc(v.service || VISIT_LABEL[v.kind])}${v.kind === 'package_visit' ? ' <span class="tag">z pakietu</span>' : ''}${v.discount ? ' <span class="tag tag--solid">−' + v.discount + '%</span>' : ''}</span><span>${UI.fmtShort(v.created_at)}</span></div>`).join('')}</div></section>` : ''}
      ${review}
      ${refer}
      <p class="small center">Wizyty z zakupionego pakietu nie dają pieczątek, bo pakiet ma już cenę promocyjną. Pieczątkę dostajesz za zakup pakietu.</p>
      <p class="small center">${esc(CFG.ADDRESS)} · <a href="tel:${esc(CFG.PHONE.replace(/\s/g, ''))}">${esc(CFG.PHONE)}</a></p>`;
    const ib = $('#installBtn');
    if (ib) ib.addEventListener('click', async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; render(); });
    const pb = $('#pushBtn');
    if (pb) pb.addEventListener('click', enablePush);
    const rb = $('#referBtn');
    if (rb) rb.addEventListener('click', shareInvite);
    const bb = main.querySelector('button[data-go]');
    if (bb) bb.addEventListener('click', () => go('bday'));
  }

  // zaproszenie: link z kodem karty, wysyłany z telefonu klientki (Messenger, SMS, WhatsApp…)
  async function shareInvite() {
    const url = new URL('./', location.href).href + '?p=' + encodeURIComponent(card.code);
    const text = 'Zapraszam Cię do studia ' + CFG.STUDIO_NAME + '. Z mojego polecenia masz −10% na pierwszy rytuał. Załóż kartę rytuałów tutaj:';
    if (navigator.share) {
      try { await navigator.share({ title: CFG.STUDIO_NAME, text, url }); } catch (e) { /* zamknięte okno udostępniania */ }
      return;
    }
    try { await navigator.clipboard.writeText(text + ' ' + url); toast('Skopiowałam zaproszenie. Wklej je koleżance w wiadomości.'); }
    catch (e) { location.href = 'sms:?&body=' + encodeURIComponent(text + ' ' + url); }
  }

  // Kafelki z linkami (pokazują się tylko te, które mają adres w config.js)
  const TILE_ICONS = {
    www: '<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.5 2.4 3.8 5.4 3.8 9s-1.3 6.6-3.8 9m0-18C9.5 5.4 8.2 8.4 8.2 12s1.3 6.6 3.8 9M3.5 9h17M3.5 15h17"/>',
    voucher: '<path d="M4 9h16v11H4zM3 6h18v3H3zM12 6v14M12 6c-1.5-3-5-3.2-5-1.1C7 6 9.5 6 12 6Zm0 0c1.5-3 5-3.2 5-1.1C17 6 14.5 6 12 6Z"/>',
    fb: '<path d="M14 8h3V4h-3c-2.8 0-4.5 1.8-4.5 4.6V11H7v4h2.5v6h4v-6H16l.6-4h-3.1V9c0-.6.4-1 1-1Z"/>',
    refer: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M18 8v6M15 11h6"/>'
  };
  function linkTiles() {
    const items = [
      [CFG.WEBSITE_URL, 'www', 'Odwiedź stronę', 'rytuały i o mnie'],
      [CFG.VOUCHER_URL, 'voucher', 'Kup voucher', 'prezent dla bliskiej osoby'],
      [CFG.FACEBOOK_URL, 'fb', 'Facebook', 'nowości i promocje'],
      ['#refer', 'refer', 'Poleć koleżance', '−10% dla niej, pieczątka dla Ciebie']
    ].filter((t) => t[0]);
    const svg = (icon) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${TILE_ICONS[icon]}</svg>`;
    return `<nav class="tiles" aria-label="Odkryj więcej">${items.map(([url, icon, title, sub]) => url === '#refer'
      ? `<button class="tile" id="referBtn">${svg(icon)}<span>${title}<small>${sub}</small></span></button>`
      : `<a class="tile" href="${esc(url)}" target="_blank" rel="noopener">${svg(icon)}<span>${title}<small>${sub}</small></span></a>`).join('')}</nav>`;
  }

  // „Jutro, 10:30” / „wtorek, 3 listopada, 15:00” (czas polski)
  function visitWhen(u) {
    const label = u.day === Rules.dayPL(0) ? 'Dziś' : u.day === Rules.dayPL(1) ? 'Jutro'
      : new Date(u.day + 'T12:00:00').toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' }).replace(/^./, (ch) => ch.toUpperCase());
    const time = u.start_at ? new Date(u.start_at).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' }) : '';
    return label + (time ? ', ' + time : '');
  }
  // nazwa usługi bez ozdobników z Booksy (gwiazdki, emotki)
  function cleanService(s) { return s.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, (ch) => '\u00AE\u00A9\u2122'.includes(ch) ? ch : '').replace(/\s{2,}/g, ' ').trim(); }

  // Zgoda na powiadomienia i zapis subskrypcji na karcie klientki.
  async function enablePush() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { UI.toast('Powiadomienia wyłączone. Możesz je włączyć później w ustawieniach telefonu.'); return render(); }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(CFG.PUSH_PUBLIC_KEY) });
      await Api.savePushSubscription(CardStore.get(), sub.toJSON());
      UI.toast('Powiadomienia włączone.');
    } catch (e) { UI.toast('Nie udało się włączyć powiadomień.'); }
    render();
  }
  function base64ToBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  }

  // ---------- urodziny ----------
  function renderBday() {
    const y = Rules.todayPL().y;
    const has = card.bday_day && card.bday_month;
    const date = UI.fmtBday(card.bday_day, card.bday_month);
    let status, body;
    if (!has) {
      status = 'Brak daty';
      body = '<p class="lead">Nie mam jeszcze Twojej daty urodzin. Podaj ją przy najbliższej wizycie, a dopiszę ją do karty.</p>';
    } else if (card.bday_today && card.birthday_used_year !== y) {
      status = 'Dziś!';
      body = '<p class="lead">Wszystkiego najpiękniejszego! Dziś masz −20% na dowolny rytuał. Zarezerwuj wizytę na dziś i pokaż swój kod przy płatności.</p>';
    } else if (card.birthday_used_year === y) {
      status = 'Wykorzystany w tym roku';
      body = '<p class="lead">Mam nadzieję, że urodzinowy rytuał był wyjątkowy. Kolejny prezent czeka za rok.</p>';
    } else {
      const d = Rules.daysToBday(card.bday_day, card.bday_month);
      status = 'Za ' + d.days + ' ' + UI.plural(d.days, 'dzień', 'dni', 'dni');
      body = '<p class="lead">Zarezerwuj wizytę dokładnie na dzień urodzin. Przy wizycie pokaż swój kod, a rabat zostanie naliczony.</p>';
    }
    main.innerHTML = `
      <h1>Prezent urodzinowy</h1>
      <section class="panel panel--gold bday-hero">
        <img src="img/mark.png" alt="">
        <span class="big">−20%</span>
        <span class="lead">na dowolny rytuał w dniu Twoich urodzin</span>
      </section>
      <section class="panel" style="gap:12px">
        <div class="row"><span class="small" style="font-size:14px">Twoje urodziny</span><span class="strong">${has ? esc(date) : '—'}</span></div>
        <div class="row"><span class="small" style="font-size:14px">Rabat ważny</span><span class="strong">${has ? 'tylko ' + esc(date) : 'w dniu urodzin'}</span></div>
        <div class="row"><span class="small" style="font-size:14px">Status</span><span class="strong gold">${esc(status)}</span></div>
      </section>
      ${body}
      <a class="btn btn--line" href="${esc(CFG.BOOKSY_URL)}" target="_blank" rel="noopener">${has ? 'Zarezerwuj na ' + esc(date) : 'Umów wizytę w Booksy'}</a>
      <p class="small">Rabat urodzinowy nie łączy się z innymi promocjami ani z pakietami.</p>`;
  }

  // ---------- kod QR ----------
  function renderQr() {
    main.innerHTML = `
      <h1>Mój kod</h1>
      <div class="qr-card">
        ${UI.qrSvg('TCTD:' + card.code, { label: 'Kod QR karty ' + card.name })}
        <span class="name">${esc(card.name)}</span>
        <span class="code">KARTA ${esc(card.code)}</span>
      </div>
      <p class="lead center">Pokaż ten kod po wizycie. Pieczątka pojawi się na Twojej karcie od razu.</p>
      <p class="small center">Zmieniasz telefon? Poproś w studiu o link do swojej karty, a wszystkie pieczątki przejdą na nowy telefon.</p>
      <button class="linkbtn" id="forgetBtn" style="align-self:center;color:var(--muted)">Wyloguj z karty na tym urządzeniu</button>`;
    $('#forgetBtn').addEventListener('click', forgetCard);
  }

  // wylogowanie: karta znika tylko z tego urządzenia, pieczątki zostają w studiu
  async function forgetCard() {
    if (!(await UI.ask('Wylogować z karty na tym urządzeniu? Pieczątki zostają zapisane w studiu. Kartę przywrócisz linkiem, o który poprosisz w studiu.', 'Wyloguj'))) return;
    try {
      const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
      const sub = reg && reg.pushManager && await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch (e) { /* bez powiadomień nic nie szkodzi */ }
    CardStore.clear();
    card = null;
    clearInterval(poll);
    history.replaceState(null, '', location.pathname);
    renderJoin();
    window.scrollTo(0, 0);
    toast('Wylogowano z karty na tym urządzeniu.');
  }

  // ---------- odświeżanie (pieczątka pojawia się sama) ----------
  async function refresh() {
    if (!card || document.hidden) return;
    try {
      const fresh = await Api.getMyCard(CardStore.get());
      if (!fresh) return;
      const before = card.stamps, bdayBefore = card.birthday_used_year, visitsBefore = (card.visits || []).length;
      card = fresh;
      if (fresh.stamps > before) {
        const n = fresh.stamps;
        const d = Rules.discountFor(n);
        const viaRef = (fresh.visits || [])[0] && fresh.visits[0].kind === 'referral';
        if (viaRef) toast('Koleżanka była na rytuale. Masz pieczątkę za polecenie! Dziękuję!', 'reward');
        else toast(d ? 'Pieczątka nr ' + n + '! Ten rytuał: −' + d + '%' : 'Nowa pieczątka! Masz już ' + n + ' / 10.', d ? 'reward' : '');
        screen = 'card';
        go('card');
        render(n);
      } else if (fresh.stamps !== before || fresh.birthday_used_year !== bdayBefore || (fresh.visits || []).length !== visitsBefore) {
        if (fresh.stamps < before && fresh.stamps === 0 && before === 10) toast('Zaczynasz nową kartę rytuałów!');
        render();
      }
    } catch (e) { /* cicho, spróbujemy później */ }
  }
  function setPolling(ms) { clearInterval(poll); poll = setInterval(refresh, ms); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('storage', (e) => { if (Api.demo && e.key === 'tctd.demoDb') refresh(); });

  start();
})();
