// Wspólne elementy interfejsu.
(function () {
  const MONTHS = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
  const MONTHS_NOM = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'];
  const SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root) => (root || document).querySelector(sel);

  function plural(n, one, few, many) {
    if (n === 1) return one;
    const d = n % 10, h = n % 100;
    if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
    return many;
  }

  function fmtBday(day, month) { return day && month ? day + ' ' + MONTHS[month - 1] : ''; }
  function fmtShort(iso) { const d = new Date(iso); return d.getDate() + ' ' + SHORT[d.getMonth()]; }
  function fmtDate(iso) { const d = new Date(iso); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }

  function initials(name) { return String(name).trim().split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase(); }

  // Siatka 10 pieczątek: wypełnione = mini logo, 5. i 10. = rabat
  function stampGrid(stamps, opts) {
    opts = opts || {};
    let html = '<div class="stamps' + (opts.small ? ' stamps--small' : '') + '" role="img" aria-label="' + stamps + ' z 10 pieczątek">';
    for (let i = 1; i <= 10; i++) {
      const filled = i <= stamps;
      const reward = i === 5 ? '−15%' : i === 10 ? '−30%' : '';
      const cls = ['stamp', filled ? 'is-filled' : '', reward ? 'is-reward' : '', opts.animate === i ? 'is-new' : ''].join(' ');
      let inner;
      if (filled) inner = '<img src="img/mark-96.png" alt="">' + (reward ? '<span class="stamp__badge">' + reward + '</span>' : '');
      else inner = reward ? '<span class="stamp__reward">' + reward + '</span>' : '<span class="stamp__num">' + i + '</span>';
      html += '<div class="' + cls + '">' + inner + '</div>';
    }
    return html + '</div>';
  }

  // Tekst zachęty pod kartą (dla klientki)
  function progressText(stamps) {
    if (stamps >= 10) return { head: 'Karta pełna. Dziękuję!', sub: 'Przy następnej wizycie rozpoczniemy nową kartę rytuałów.' };
    if (stamps === 4) return { head: 'Twój następny rytuał: −15%', sub: 'To będzie Twoja 5. wizyta. Rabat naliczę przy płatności.' };
    if (stamps === 9) return { head: 'Twój następny rytuał: −30%', sub: 'To będzie Twoja 10. wizyta. Rabat naliczę przy płatności.' };
    if (stamps < 4) { const n = 4 - stamps; return { head: 'Jeszcze ' + n + ' ' + plural(n, 'wizyta', 'wizyty', 'wizyt') + ' do rabatu −15%', sub: stamps === 0 ? 'Każdy rytuał to jedna pieczątka. Przy 5. wizycie −15%, przy 10. aż −30%.' : 'A przy 10. rytuale czeka na Ciebie −30%.' }; }
    const n = 9 - stamps; return { head: 'Jeszcze ' + n + ' ' + plural(n, 'wizyta', 'wizyty', 'wizyt') + ' do rabatu −30%', sub: 'Rabat −15% już za Tobą. Pięknie dbasz o siebie!' };
  }

  // Podpowiedź dla studia: co oznacza TA wizyta
  function nextVisitInfo(stamps) {
    const n = stamps + 1;
    if (stamps >= 10) return { text: 'Karta pełna. Rozpocznij nową kartę, a potem dodaj pieczątkę.', discount: 0 };
    if (n === 5) return { text: 'Ta wizyta to 5. rytuał: nalicz rabat −15%.', discount: 15 };
    if (n === 10) return { text: 'Ta wizyta to 10. rytuał: nalicz rabat −30%.', discount: 30 };
    const to = n < 5 ? 5 - n : 10 - n;
    return { text: 'Ta wizyta to ' + n + '. rytuał. Do rabatu ' + (n < 5 ? '−15%' : '−30%') + ' zostaną jeszcze ' + to + ' ' + plural(to, 'wizyta', 'wizyty', 'wizyt') + '.', discount: 0 };
  }

  function qrSvg(text, opts) {
    opts = opts || {};
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const q = 2; // margines
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += 'M' + (c + q) + ' ' + (r + q) + 'h1v1h-1z';
    const size = n + q * 2;
    return '<svg class="qr" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" role="img" aria-label="' + esc(opts.label || 'Kod QR') + '">' +
      '<rect width="' + size + '" height="' + size + '" fill="' + (opts.bg || '#F7F1E4') + '"/><path d="' + path + '" fill="' + (opts.fg || '#0E0D0B') + '"/></svg>';
  }

  let toastTimer;
  function toast(text, kind) {
    let el = $('#toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
    el.className = 'toast is-visible' + (kind ? ' toast--' + kind : '');
    el.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'reward' ? 6000 : 3200);
  }

  function dayOptions(sel) {
    let h = '<option value="">Dzień</option>';
    for (let d = 1; d <= 31; d++) h += '<option value="' + d + '"' + (sel === d ? ' selected' : '') + '>' + d + '</option>';
    return h;
  }
  function monthOptions(sel) {
    let h = '<option value="">Miesiąc</option>';
    MONTHS_NOM.forEach((m, i) => { h += '<option value="' + (i + 1) + '"' + (sel === i + 1 ? ' selected' : '') + '>' + m + '</option>'; });
    return h;
  }
  function validBday(day, month) {
    if (!day && !month) return true;
    if (!day || !month) return false;
    const max = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return day <= max;
  }

  // Potwierdzenie w oknie aplikacji (zamiast systemowego confirm)
  function ask(text, okLabel) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'ask';
      wrap.setAttribute('role', 'alertdialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.innerHTML = '<div class="ask__box"><p>' + esc(text) + '</p><div class="btn-row"><button class="btn btn--ghost" data-a="0">Anuluj</button><button class="btn btn--gold" data-a="1">' + esc(okLabel || 'Tak') + '</button></div></div>';
      document.body.appendChild(wrap);
      const done = (v) => { wrap.remove(); resolve(v); };
      wrap.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) done(b.dataset.a === '1'); else if (e.target === wrap) done(false); });
      wrap.querySelector('[data-a="1"]').focus();
    });
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 5 || h >= 18) return 'Dobry wieczór';
    return 'Dzień dobry';
  }

  function registerSW() {
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  window.UI = { esc, $, plural, fmtBday, fmtShort, fmtDate, initials, stampGrid, progressText, nextVisitInfo, qrSvg, toast, dayOptions, monthOptions, validBday, greeting, ask, registerSW, MONTHS };
})();
