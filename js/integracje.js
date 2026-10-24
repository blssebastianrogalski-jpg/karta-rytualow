// Panel studia → Integracje: Booksy / Kalendarz Google.
// Synchronizację wykonuje skrypt Google na koncie studia (google/booksy-sync.gs), także przy zamkniętej aplikacji.
(function () {
  const { esc, toast, ask } = UI;
  const SCRIPT_URL = 'https://github.com/blssebastianrogalski-jpg/karta-rytualow/blob/main/google/booksy-sync.gs';
  const fail = (e) => toast(e.message || 'Coś poszło nie tak.', 'error');
  const when = (iso) => iso ? new Date(iso).toLocaleString('pl-PL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const ago = (iso) => {
    if (!iso) return 'jeszcze nie';
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    return m < 1 ? 'przed chwilą' : m < 60 ? m + ' min temu' : m < 1440 ? Math.round(m / 60) + ' godz. temu' : when(iso);
  };
  const okIcon = (v) => v === true ? '<span class="gold">połączony</span>' : v === false ? '<span class="error">brak dostępu</span>' : '<span class="small">czeka na skrypt</span>';
  const KIND = { new: 'nowa', change: 'zmiana', cancel: 'odwołanie', unknown: 'nierozpoznany' };
  const RESULT = { applied: 'do zapisania', past: 'minęła, pominięta', stale: 'starszy mail, pominięty', duplicate: 'już zapisana', ambiguous: 'niejednoznaczna', unrecognized: 'nierozpoznany' };

  let main, onBack, newKey = null;

  async function render(container, back) {
    main = container; onBack = back;
    main.innerHTML = `
      <button class="linkbtn" id="intBack" style="align-self:flex-start;text-decoration:none">‹ Wróć</button>
      <h1>Integracje</h1>
      <p class="small" style="margin:0">Booksy → Gmail studia → aplikacja → Kalendarz Google. Rezerwacje, zmiany i odwołania z Booksy same trafiają do planu dnia i kalendarza „Twoje Ciało Twój Dobrostan | Wizyty”.</p>
      <div id="intBody"><div class="spinner"></div></div>`;
    main.querySelector('#intBack').addEventListener('click', () => onBack());
    load();
  }

  async function load() {
    const box = main.querySelector('#intBody');
    if (!box) return;
    let s;
    try { s = await Api.booksyStatus(); } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; return; }
    const errorNow = s.last_error && (!s.last_ok_at || new Date(s.last_error_at) > new Date(s.last_ok_at));
    const silent = s.connected && s.script_last_seen && Date.now() - new Date(s.script_last_seen) > 20 * 60000;
    box.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:18px">
      ${newKey ? keyPanel() : ''}
      <section class="panel ${errorNow || silent ? '' : 'panel--gold'}" style="gap:8px">
        <span class="eyebrow ${errorNow || silent ? '' : 'eyebrow--gold'}">Booksy / Kalendarz Google</span>
        ${s.connected ? `
          <div class="row"><span>Gmail studia</span>${okIcon(s.gmail_ok)}</div>
          <div class="row"><span>Kalendarz Google</span>${okIcon(s.calendar_ok)}</div>
          <div class="row"><span>Ostatnia udana synchronizacja</span><span>${esc(ago(s.last_ok_at))}</span></div>
          <div class="row"><span>Przetworzone rezerwacje</span><span>${s.processed || 0}</span></div>
          ${errorNow ? `<p class="error" style="margin:0">Błąd: ${esc(s.last_error)} (${esc(ago(s.last_error_at))})</p>` : ''}
          ${silent ? '<p class="error" style="margin:0">Skrypt nie odezwał się od ponad 20 minut. Sprawdź, czy w skrypcie Google działa wyzwalacz.</p>' : ''}
          ${!s.script_last_seen ? '<p class="small" style="margin:0">Klucz jest gotowy i czeka na pierwsze połączenie skryptu Google.</p>' : ''}
          ${s.sync_requested_at ? '<p class="small gold" style="margin:0">Synchronizacja zlecona. Skrypt wykona ją w ciągu 5 minut.</p>' : ''}
          <div class="btn-row">
            <button class="btn btn--gold" id="intSync">Synchronizuj teraz</button>
            <button class="btn btn--ghost" id="intRefresh">Odśwież</button>
          </div>` : `
          <p class="small" style="margin:0">Integracja nie jest podłączona. Utwórz klucz, wklej go do skryptu Google na koncie studia i uruchom funkcję „ustaw”.</p>
          <button class="btn btn--gold" id="intKey">Utwórz klucz dla skryptu</button>`}
      </section>
      ${(s.unassigned || []).length ? `
      <section style="display:flex;flex-direction:column;gap:10px">
        <span class="eyebrow">Do przypisania · ${s.unassigned.length}</span>
        <p class="small" style="margin:0">Tych rezerwacji nie da się bezpiecznie połączyć z kartą (inne nazwisko albo telefon). Wybierz kartę albo załóż nową.</p>
        ${s.unassigned.map((u) => `<div class="panel" style="gap:8px">
          <span class="strong">${esc(u.name || 'Klientka Booksy')}</span>
          <span class="small">${esc(u.service || 'rytuał')} · ${esc(when(u.start))}</span>
          ${(u.candidates || []).map((c) => `<button class="btn btn--line" data-assign="${esc(u.id)}" data-card="${esc(c.id)}">To ${esc(c.name)}${c.phone ? ' · ' + esc(c.phone) : ''}</button>`).join('')}
          <button class="btn btn--ghost" data-assign="${esc(u.id)}" data-card="">Nowa karta dla tej klientki</button>
        </div>`).join('')}
      </section>` : ''}
      ${(s.errors || []).length ? `
      <section style="display:flex;flex-direction:column;gap:10px">
        <div class="row"><span class="eyebrow">Nieudany zapis w kalendarzu · ${s.errors.length}</span><button class="linkbtn" id="intRetryAll" style="min-height:0;padding:0">Ponów wszystkie</button></div>
        <div class="panel panel--tight">${s.errors.map((e) => `<div class="client">
          <span class="client__main" style="cursor:default"><span><span class="client__name">${esc(e.service || 'rytuał')} · ${esc(when(e.start))}</span>
          <span class="client__meta">${esc(e.error || '')} · próby: ${e.attempts}</span></span></span>
          <button class="plus" data-retry="${esc(e.id)}" aria-label="Ponów">↻</button></div>`).join('')}</div>
      </section>` : ''}
      ${s.connected ? `
      <section style="display:flex;flex-direction:column;gap:10px">
        <span class="eyebrow">Najbliższe wizyty z Booksy · 14 dni</span>
        ${(s.upcoming || []).length ? `<div class="panel panel--tight">${s.upcoming.map((b) => `<div class="client">
          <span class="client__main" style="cursor:default"><span class="avatar">${esc(new Date(b.start).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }))}</span>
          <span><span class="client__name">${esc(b.name || 'Klientka Booksy')}${b.conflict ? ' <span class="tag">kolizja</span>' : ''}${b.card ? '' : ' <span class="tag">bez karty</span>'}</span>
          <span class="client__meta">${esc(b.service || 'rytuał')} · ${esc(new Date(b.start).toLocaleDateString('pl-PL', { weekday: 'short', day: 'numeric', month: 'short' }))} · ${b.gcal === 'synced' ? 'w kalendarzu' : b.gcal === 'error' ? 'błąd kalendarza' : 'czeka na kalendarz'}</span></span></span>
        </div>`).join('')}</div>` : '<div class="panel" style="padding:16px"><span class="small">Brak wizyt z Booksy w najbliższych 14 dniach.</span></div>'}
      </section>
      <section class="panel" style="gap:10px">
        <span class="eyebrow">Wcześniejsze maile z Booksy</span>
        ${importHtml(s)}
      </section>
      <section class="panel" style="gap:10px">
        <span class="eyebrow">Odwołana wizyta w Kalendarzu Google</span>
        <label class="row" style="justify-content:flex-start;gap:10px"><input type="radio" name="gmode" value="delete" ${s.gcal_mode !== 'mark' ? 'checked' : ''}> Usuń wydarzenie</label>
        <label class="row" style="justify-content:flex-start;gap:10px"><input type="radio" name="gmode" value="mark" ${s.gcal_mode === 'mark' ? 'checked' : ''}> Zostaw z dopiskiem „ODWOŁANA”</label>
      </section>` : ''}
      ${(s.unrecognized || []).length ? `
      <section style="display:flex;flex-direction:column;gap:10px">
        <span class="eyebrow">Nierozpoznane maile Booksy</span>
        <div class="panel" style="gap:6px">${s.unrecognized.map((u) => `<span class="small">${esc(when(u.at))} · ${esc(RESULT[u.result] || u.result)}${u.subject ? ' · „' + esc(u.subject) + '”' : ''}</span>`).join('')}</div>
      </section>` : ''}
      ${(s.log || []).length ? `
      <details class="panel" style="gap:6px"><summary class="eyebrow" style="cursor:pointer">Historia synchronizacji</summary>
        ${s.log.map((l) => `<span class="small${l.level === 'error' ? ' error' : ''}">${esc(when(l.at))} · ${esc(l.message || '')}</span>`).join('')}
      </details>` : ''}
      <details class="panel" style="gap:8px"><summary class="eyebrow" style="cursor:pointer">Jak podłączyć skrypt Google</summary>
        <ol class="small" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px">
          <li>Na komputerze zaloguj się na jrtwojecialo@gmail.com i otwórz script.google.com → „Nowy projekt”.</li>
          <li>Skopiuj cały kod skryptu z <a class="gold" href="${SCRIPT_URL}" target="_blank" rel="noopener">tego pliku</a> (przycisk „Copy raw file”) i wklej w miejsce przykładowego kodu.</li>
          <li>W tym panelu kliknij „Utwórz klucz dla skryptu” i wklej klucz w miejsce WKLEJ_TUTAJ_KLUCZ_Z_PANELU.</li>
          <li>Zapisz, wybierz u góry funkcję „ustaw” i kliknij „Uruchom”. Zatwierdź uprawnienia do Gmaila i Kalendarza.</li>
          <li>Gotowe: skrypt działa co 5 minut na serwerach Google, także przy wyłączonym telefonie.</li>
        </ol>
      </details>
      ${s.connected ? `<div class="btn-row"><button class="btn btn--ghost" id="intNewKey">Nowy klucz</button><button class="btn btn--ghost" id="intDisconnect">Rozłącz integrację</button></div>` : ''}
      </div>`;
    bind(s);
  }

  function keyPanel() {
    return `<section class="panel panel--gold" style="gap:10px">
      <span class="eyebrow eyebrow--gold">Klucz dla skryptu Google</span>
      <p class="small" style="margin:0">Skopiuj go teraz i wklej do skryptu. Ze względów bezpieczeństwa nie będzie pokazany ponownie (zawsze można utworzyć nowy).</p>
      <input class="input" id="intKeyVal" readonly value="${esc(newKey)}" style="font-family:monospace;font-size:13px">
      <button class="btn btn--line" id="intCopy">Kopiuj klucz</button>
    </section>`;
  }

  function importHtml(s) {
    const p = s.import_preview;
    if (s.import_state === 'preview_requested') return '<p class="small" style="margin:0">Podgląd w przygotowaniu (do 5 minut). Odśwież za chwilę.</p>';
    if (s.import_state === 'apply_requested') return '<p class="small" style="margin:0">Import zlecony. Skrypt wykona go w ciągu 5 minut.</p>';
    if (s.import_state === 'preview_ready' && p) {
      const items = (p.items || []).filter((i) => i.kind !== 'unknown');
      const take = items.filter((i) => i.result === 'applied');
      return `<p class="small" style="margin:0">Podgląd z maili z ostatnich 90 dni: ${take.length} do zapisania, ${items.length - take.length} pominiętych (minęły, powtórzone albo już zapisane). Odwołania i zmiany są uwzględnione w kolejności maili.</p>
        <div style="display:flex;flex-direction:column;gap:4px;max-height:260px;overflow:auto">${items.map((i) => `<span class="small" style="${i.result === 'applied' ? 'color:var(--text)' : ''}">${esc(when(i.start))} · ${esc(i.name || '?')} · ${esc(i.service || '')} · ${esc(KIND[i.kind] || i.kind)} · ${esc(RESULT[i.result] || i.result)}</span>`).join('')}</div>
        <div class="btn-row"><button class="btn btn--ghost" id="intImpCancel">Anuluj</button><button class="btn btn--gold" id="intImpApply" ${take.length ? '' : 'disabled'}>Zatwierdź import</button></div>`;
    }
    return `<p class="small" style="margin:0">${s.import_state === 'done' ? 'Import wykonany. ' : ''}Przyszłe wizyty z maili sprzed podłączenia można dodać po sprawdzeniu podglądu. Wizyty, które już minęły, są pomijane.</p>
      <button class="btn btn--line" id="intImpPreview">Pokaż podgląd importu</button>`;
  }

  function bind(s) {
    const on = (id, fn) => { const el = main.querySelector('#' + id); if (el) el.addEventListener('click', fn); };
    const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); load(); } catch (e) { fail(e); } };
    on('intKey', () => act(async () => { newKey = await Api.booksyNewKey(); }));
    on('intNewKey', async () => {
      if (!(await ask('Utworzyć nowy klucz? Stary klucz przestanie działać i trzeba będzie wkleić nowy do skryptu Google.', 'Nowy klucz'))) return;
      act(async () => { newKey = await Api.booksyNewKey(); });
    });
    on('intCopy', async () => {
      const el = main.querySelector('#intKeyVal');
      try { await navigator.clipboard.writeText(el.value); toast('Klucz skopiowany.'); } catch (e) { el.select(); toast('Klucz zaznaczony. Skopiuj go ręcznie.'); }
    });
    on('intSync', () => act(() => Api.booksyRequestSync(), 'Synchronizacja zlecona.'));
    on('intRefresh', () => load());
    on('intRetryAll', () => act(() => Api.booksyRetry(null), 'Zapis w kalendarzu zostanie ponowiony.'));
    on('intDisconnect', async () => {
      if (!(await ask('Rozłączyć integrację? Skrypt przestanie zapisywać nowe rezerwacje. Wizyty w planie i w kalendarzu zostaną bez zmian.', 'Rozłącz'))) return;
      newKey = null;
      act(() => Api.booksyDisconnect(), 'Integracja rozłączona.');
    });
    on('intImpPreview', () => act(() => Api.booksyImport('preview'), 'Podgląd importu w przygotowaniu.'));
    on('intImpCancel', () => act(() => Api.booksyImport('cancel')));
    on('intImpApply', async () => {
      if (!(await ask('Zapisać wizyty z podglądu w planie dnia i w Kalendarzu Google?', 'Zatwierdź import'))) return;
      act(() => Api.booksyImport('apply'), 'Import zlecony.');
    });
    main.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', () => act(() => Api.booksyRetry(+b.dataset.retry), 'Zapis w kalendarzu zostanie ponowiony.')));
    main.querySelectorAll('[data-assign]').forEach((b) => b.addEventListener('click', () => act(() => Api.booksyAssign(+b.dataset.assign, b.dataset.card || null), b.dataset.card ? 'Rezerwacja przypisana do karty.' : 'Nowa karta założona, rezerwacja przypisana.')));
    main.querySelectorAll('input[name="gmode"]').forEach((r) => r.addEventListener('change', () => act(() => Api.booksySetMode(r.value), 'Zapisano.')));
  }

  window.Integracje = { render };
})();
