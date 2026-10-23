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

  if (Api.demo) $('#demoBar').hidden = false;
  UI.registerSW();

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (screen === 'card' && card) render(); });

  const VISIT_LABEL = {
    stamp: 'Pojedynczy rytuał',
    package_buy: 'Zakup pakietu',
    package_visit: 'Wizyta z pakietu',
    birthday: 'Rytuał urodzinowy −20%'
  };

  // ---------- start ----------
  async function start() {
    const params = new URLSearchParams(location.search);
    const linkToken = params.get('k');
    if (linkToken) {
      CardStore.set(linkToken);
      history.replaceState(null, '', location.pathname);
    }
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
    if (linkToken) toast('Witaj, ' + firstName() + '! Twoja karta jest już w aplikacji.');
    go(location.hash.replace('#', '') || 'card');
  }

  function firstName() { return card ? card.name.split(/\s+/)[0] : ''; }

  // ---------- zakładanie karty ----------
  function renderJoin(msg) {
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
      <form class="panel" id="joinForm" novalidate>
        <h2>Załóż swoją kartę</h2>
        <div class="field"><label for="jName">Imię i nazwisko</label><input class="input" id="jName" autocomplete="name" required placeholder="np. Anna Kowalska"></div>
        <div class="field"><label for="jPhone">Telefon (opcjonalnie)</label><input class="input" id="jPhone" type="tel" autocomplete="tel" placeholder="np. 600 000 000"></div>
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
        <p class="lead" style="font-size:14px">Jeśli kartę założyła Ci Justyna w studiu, nie zakładaj nowej. Otwórz link z SMS-a albo zeskanuj aparatem kod „Połącz z aplikacją”, który pokażę Ci w studiu. Pieczątki przejdą same.</p>
      </div>`;
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
        card = await Api.registerCard({ name, phone, day, month });
        CardStore.set(card.token);
        toast('Witaj, ' + firstName() + '! Twoja karta jest gotowa.');
        go('card');
      } catch (ex) {
        fail(ex.message);
        btn.disabled = false; btn.textContent = 'Załóż kartę';
      }
    });
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
    const visits = (card.visits || []).slice(0, 5);
    main.innerHTML = `
      <div class="hello"><small>${UI.greeting()},</small><h1>${esc(firstName())}</h1></div>
      ${card.bday_today && card.birthday_used_year !== Rules.todayPL().y ? '<button class="panel panel--gold bday-today" data-go="bday" style="text-align:left;color:inherit;cursor:pointer"><span class="eyebrow eyebrow--gold">Wszystkiego najpiękniejszego!</span><span class="strong" style="font-size:17px">Dziś masz −20% na dowolny rytuał →</span></button>' : ''}
      <section class="panel" aria-label="Karta rytuałów">
        <div class="row"><span class="eyebrow eyebrow--gold">Karta rytuałów</span><span class="strong" style="font-size:15px">${card.stamps} / 10</span></div>
        ${UI.stampGrid(card.stamps, { animate })}
        <div class="divider"><span class="strong gold">${esc(p.head)}</span><span class="small" style="font-size:14px;color:var(--text-2)">${esc(p.sub)}</span></div>
        <div class="chips"><span><strong>5. rytuał</strong> −15%</span><span><strong>10. rytuał</strong> −30%</span></div>
        ${card.cards_completed ? '<span class="small">Ukończone karty: ' + card.cards_completed + '. Dziękuję, że jesteś!</span>' : ''}
      </section>
      <a class="btn btn--gold" href="${esc(CFG.BOOKSY_URL)}" target="_blank" rel="noopener">Umów wizytę w Booksy</a>
      ${install}
      ${visits.length ? `<section style="display:flex;flex-direction:column;gap:10px"><span class="eyebrow">Ostatnie wizyty</span><div class="panel panel--tight">${visits.map((v) => `<div class="list-row"><span>${esc(v.service || VISIT_LABEL[v.kind])}${v.kind === 'package_visit' ? ' <span class="tag">z pakietu</span>' : ''}${v.discount ? ' <span class="tag tag--solid">−' + v.discount + '%</span>' : ''}</span><span>${UI.fmtShort(v.created_at)}</span></div>`).join('')}</div></section>` : ''}
      <p class="small center">Wizyty z zakupionego pakietu nie dają pieczątek, bo pakiet ma już cenę promocyjną. Pieczątkę dostajesz za zakup pakietu.</p>
      <p class="small center">${esc(CFG.ADDRESS)} · <a href="tel:${esc(CFG.PHONE.replace(/\s/g, ''))}">${esc(CFG.PHONE)}</a><br><a href="${esc(CFG.INSTAGRAM_URL)}" target="_blank" rel="noopener">Instagram</a> · <a href="${esc(CFG.FACEBOOK_URL)}" target="_blank" rel="noopener">Facebook</a> · <a href="${esc(CFG.WEBSITE_URL)}" target="_blank" rel="noopener">Strona studia</a></p>`;
    const ib = $('#installBtn');
    if (ib) ib.addEventListener('click', async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; render(); });
    const pb = $('#pushBtn');
    if (pb) pb.addEventListener('click', enablePush);
    const bb = main.querySelector('button[data-go]');
    if (bb) bb.addEventListener('click', () => go('bday'));
  }

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
      body = '<p class="lead">Wszystkiego najpiękniejszego! Dziś Twój rytuał jest o połowę tańszy. Zarezerwuj wizytę na dziś i pokaż swój kod przy płatności.</p>';
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
      <p class="small center">Zmieniasz telefon? Poproś w studiu o link do swojej karty, a wszystkie pieczątki przejdą na nowy telefon.</p>`;
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
        toast(d ? 'Pieczątka nr ' + n + '! Ten rytuał: −' + d + '%' : 'Nowa pieczątka! Masz już ' + n + ' / 10.', d ? 'reward' : '');
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
