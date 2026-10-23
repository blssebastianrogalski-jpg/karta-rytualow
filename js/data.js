// Warstwa danych: Supabase (prawdziwa baza) albo tryb demo (localStorage).
(function () {
  const CFG = window.APP_CONFIG || {};
  const DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
  const TOKEN_KEY = 'tctd.cardToken';

  // ---------- wspólne zasady nagród ----------
  const Rules = {
    discountFor(n) { return n === 5 ? 15 : n === 10 ? 30 : 0; },
    todayPL() {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const get = (t) => +parts.find((p) => p.type === t).value;
      return { y: get('year'), m: get('month'), d: get('day') };
    },
    isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; },
    isBdayToday(day, month) {
      if (!day || !month) return false;
      const t = Rules.todayPL();
      if (month === 2 && day === 29 && !Rules.isLeap(t.y)) return t.m === 2 && t.d === 28;
      return t.m === month && t.d === day;
    },
    daysToBday(day, month) {
      if (!day || !month) return null;
      const t = Rules.todayPL();
      const today = Date.UTC(t.y, t.m - 1, t.d);
      let y = t.y;
      const at = (yy) => {
        const dd = month === 2 && day === 29 && !Rules.isLeap(yy) ? 28 : day;
        return Date.UTC(yy, month - 1, dd);
      };
      let next = at(y);
      if (next < today) next = at(++y);
      return { days: Math.round((next - today) / 86400000), year: y };
    }
  };

  // ---------- TRYB DEMO ----------
  function demoApi() {
    const KEY = 'tctd.demoDb';
    const SESSION = 'tctd.demoSession';
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const rnd = (n, abc) => Array.from({ length: n }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
    const uid = () => 'id' + Date.now().toString(36) + rnd(6, 'abcdefghijklmnopqrstuvwxyz0123456789');

    function seed() {
      const t = Rules.todayPL();
      const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
      const mk = (name, phone, d, m, stamps, source, services) => ({
        id: uid(), code: rnd(6, alphabet), token: rnd(36, '0123456789abcdef'), name, phone,
        bday_day: d, bday_month: m, stamps, cards_completed: 0, birthday_used_year: null, source, note: null,
        created_at: daysAgo(120),
        visits: services.map((s, i) => ({ kind: 'stamp', service: s, discount: Rules.discountFor(stamps - i), created_at: daysAgo(14 + i * 21) }))
      });
      const db = {
        cards: [
          mk('Anna Kowalska', '600 100 200', 14, 11, 3, 'app', ['Masaż relaksacyjny', 'Kobido UP®', 'Masaż relaksacyjny']),
          mk('Marta Wiśniewska', '601 222 333', t.d, t.m, 9, 'app', ['Head SPA Premium', 'Access Bars®', 'Head SPA Premium']),
          mk('Karolina Nowak', null, 3, 5, 4, 'app', ['Kobido UP®', 'Kobido UP®']),
          mk('Halina Mazur', '602 444 555', 8, 3, 7, 'studio', ['Masaż gorącą świecą', 'Refleksologia Stóp Premium']),
          mk('Ewa Zielińska', null, 21, 7, 10, 'app', ['Master Kobido UP®'])
        ]
      };
      const day = t.y + '-' + t.m + '-' + t.d;
      db.plan = [
        { id: 1, card_id: db.cards[3].id, day, service: 'Masaż gorącą świecą', status: 'planned' },
        { id: 2, card_id: db.cards[1].id, day, service: 'Head SPA Premium', status: 'planned' },
        { id: 3, card_id: db.cards[2].id, day, service: 'Kobido UP®', status: 'planned' }
      ];
      return db;
    }
    function load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) return JSON.parse(raw);
      } catch (e) { /* brak dostępu do pamięci */ }
      const db = seed();
      save(db);
      return db;
    }
    function save(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ } }
    function view(c) {
      const out = JSON.parse(JSON.stringify(c));
      out.visits = (out.visits || []).slice(0, 12);
      out.bday_today = Rules.isBdayToday(c.bday_day, c.bday_month);
      return out;
    }
    function mutate(id, fn) {
      const db = load();
      const c = db.cards.find((x) => x.id === id);
      if (!c) throw new Error('Nie znaleziono karty.');
      fn(c, db);
      save(db);
      return view(c);
    }
    const isStaff = () => { try { return !!localStorage.getItem(SESSION); } catch (e) { return false; } };
    const guard = () => { if (!isStaff()) throw new Error('Brak dostępu.'); };
    const wait = (v) => new Promise((res) => setTimeout(() => res(v), 120));
    const run = (fn) => wait().then(fn);

    return {
      demo: true,
      registerCard: ({ name, phone, day, month }) => run(() => {
        if (!name || name.trim().length < 2) throw new Error('Podaj imię i nazwisko.');
        const db = load();
        const c = { id: uid(), code: rnd(6, alphabet), token: rnd(36, '0123456789abcdef'), name: name.trim(), phone: phone || null,
          bday_day: day || null, bday_month: month || null, stamps: 0, cards_completed: 0, birthday_used_year: null,
          source: 'app', note: null, created_at: new Date().toISOString(), visits: [] };
        db.cards.push(c); save(db);
        return view(c);
      }),
      savePushSubscription: async () => null,
      notifyStamp: async () => null,
      saveStaffPush: async () => null,
      getMyCard: (token) => run(() => {
        const c = load().cards.find((x) => x.token === token);
        return c ? view(c) : null;
      }),
      // studio
      session: () => Promise.resolve(isStaff() ? { email: localStorage.getItem(SESSION) } : null),
      login: (email, password) => run(() => {
        if (password !== 'demo') throw new Error('W trybie demo hasło to: demo');
        localStorage.setItem(SESSION, email || 'studio@demo');
        return { email };
      }),
      logout: () => { try { localStorage.removeItem(SESSION); } catch (e) { /* ignore */ } return Promise.resolve(); },
      findCard: (code) => run(() => { guard(); const c = load().cards.find((x) => x.code === String(code).toUpperCase().trim()); return c ? view(c) : null; }),
      getCard: (id) => run(() => { guard(); const c = load().cards.find((x) => x.id === id); return c ? view(c) : null; }),
      listCards: (q) => run(() => {
        guard();
        q = (q || '').trim().toLowerCase();
        const qd = q.replace(/\s/g, '');
        return load().cards
          .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.phone || '').replace(/\s/g, '').includes(qd) || c.code.toLowerCase() === q)
          .map((c) => ({ ...view(c), visits: undefined }))
          .sort((a, b) => (b.bday_today - a.bday_today) || a.name.localeCompare(b.name, 'pl'));
      }),
      createStudioCard: ({ name, phone, day, month, stamps }) => run(() => {
        guard();
        if (!name || name.trim().length < 2) throw new Error('Podaj imię i nazwisko.');
        const db = load();
        const c = { id: uid(), code: rnd(6, alphabet), token: rnd(36, '0123456789abcdef'), name: name.trim(), phone: phone || null,
          bday_day: day || null, bday_month: month || null, stamps: Math.max(0, Math.min(9, stamps || 0)), cards_completed: 0,
          birthday_used_year: null, source: 'studio', note: null, created_at: new Date().toISOString(), visits: [] };
        db.cards.push(c); save(db);
        return view(c);
      }),
      updateCard: (id, f) => run(() => { guard(); return mutate(id, (c) => {
        if (!f.name || f.name.trim().length < 2) throw new Error('Podaj imię i nazwisko.');
        Object.assign(c, { name: f.name.trim(), phone: f.phone || null, bday_day: f.day || null, bday_month: f.month || null, note: f.note || null });
      }); }),
      recordVisit: (id, mode, service, planId) => run(() => { guard(); return mutate(id, (c, db) => {
        if (!['stamp', 'package_buy', 'package_visit'].includes(mode)) throw new Error('Nieznany rodzaj wizyty.');
        let d = 0;
        if (mode !== 'package_visit') {
          if (c.stamps >= 10) throw new Error('Karta jest pełna. Rozpocznij nową kartę.');
          c.stamps += 1;
          d = Rules.discountFor(c.stamps);
        }
        c.visits.unshift({ kind: mode, service: service || null, discount: d, created_at: new Date().toISOString() });
        if (planId) { const p = (db.plan || []).find((x) => x.id === planId); if (p) { p.status = mode; if (service) p.service = service; } }
      }); }),
      removeStamp: (id) => run(() => { guard(); return mutate(id, (c) => {
        if (c.stamps <= 0) throw new Error('Na karcie nie ma pieczątek.');
        c.stamps -= 1;
        const i = c.visits.findIndex((v) => v.kind === 'stamp' || v.kind === 'package_buy');
        if (i >= 0) c.visits.splice(i, 1);
      }); }),
      startNewCard: (id) => run(() => { guard(); return mutate(id, (c) => {
        if (c.stamps < 10) throw new Error('Nową kartę można rozpocząć dopiero po 10 pieczątkach.');
        c.stamps = 0; c.cards_completed += 1;
      }); }),
      useBirthday: (id, service, planId) => run(() => { guard(); return mutate(id, (c, db) => {
        const y = Rules.todayPL().y;
        if (!Rules.isBdayToday(c.bday_day, c.bday_month)) throw new Error('Rabat urodzinowy działa tylko w dniu urodzin.');
        if (c.birthday_used_year === y) throw new Error('Rabat urodzinowy został już wykorzystany w tym roku.');
        c.birthday_used_year = y;
        c.visits.unshift({ kind: 'birthday', service: service || null, discount: 20, created_at: new Date().toISOString() });
        if (planId) { const p = (db.plan || []).find((x) => x.id === planId); if (p) p.status = 'birthday'; }
      }); }),
      planList: () => run(() => {
        guard();
        const db = load();
        const t = Rules.todayPL();
        const day = t.y + '-' + t.m + '-' + t.d;
        return (db.plan || []).filter((p) => p.day === day).map((p) => {
          const c = db.cards.find((x) => x.id === p.card_id);
          return c ? { ...p, name: c.name, stamps: c.stamps, source: c.source, phone: c.phone, bday_today: Rules.isBdayToday(c.bday_day, c.bday_month), birthday_used_year: c.birthday_used_year } : null;
        }).filter(Boolean);
      }),
      planAdd: (cardId, service) => run(() => {
        guard();
        const db = load();
        const t = Rules.todayPL();
        db.plan = db.plan || [];
        db.plan.push({ id: Date.now(), card_id: cardId, day: t.y + '-' + t.m + '-' + t.d, service: service || null, status: 'planned' });
        save(db);
      }),
      planSet: (planId, status) => run(() => { guard(); const db = load(); const p = (db.plan || []).find((x) => x.id === planId); if (p) p.status = status; save(db); }),
      planRemove: (planId) => run(() => { guard(); const db = load(); db.plan = (db.plan || []).filter((x) => x.id !== planId); save(db); }),
      deleteCard: (id) => run(() => { guard(); const db = load(); db.cards = db.cards.filter((x) => x.id !== id); save(db); }),
      resetToken: (id) => run(() => { guard(); return mutate(id, (c) => { c.token = rnd(36, '0123456789abcdef'); }); }),
      resetDemo: () => { try { localStorage.removeItem(KEY); localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } }
    };
  }

  // ---------- SUPABASE ----------
  function supabaseApi() {
    const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'tctd.auth' }
    });
    const rpc = async (fn, args) => {
      const { data, error } = await sb.rpc(fn, args || {});
      if (error) {
        const msg = error.message || '';
        if (/fetch|network/i.test(msg)) throw new Error('Brak połączenia z internetem. Spróbuj ponownie.');
        throw new Error(msg.replace(/^.*?:\s*/, '') || 'Coś poszło nie tak.');
      }
      return data;
    };
    return {
      demo: false,
      registerCard: ({ name, phone, day, month }) => rpc('register_card', { p_name: name, p_phone: phone || null, p_day: day || null, p_month: month || null }),
      getMyCard: (token) => rpc('get_my_card', { p_token: token }),
      savePushSubscription: (token, sub) => rpc('save_push_subscription', { p_token: token, p_endpoint: sub.endpoint, p_p256dh: sub.keys.p256dh, p_auth: sub.keys.auth }),
      saveStaffPush: (sub) => rpc('save_staff_push_subscription', { p_endpoint: sub.endpoint, p_p256dh: sub.keys.p256dh, p_auth: sub.keys.auth }),
      notifyStamp: async (cardId, stamps) => {
        const { error } = await sb.functions.invoke('notify-stamp', { body: { card_id: cardId, stamps } });
        if (error) throw new Error(error.message);
      },
      session: async () => {
        const { data } = await sb.auth.getSession();
        if (!data.session) return null;
        const { data: ok } = await sb.rpc('is_staff');
        if (!ok) return { email: data.session.user.email, notStaff: true };
        return { email: data.session.user.email };
      },
      login: async (email, password) => {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw new Error('Nieprawidłowy e-mail lub hasło.');
        return { email };
      },
      logout: () => sb.auth.signOut(),
      findCard: (code) => rpc('find_card', { p_code: code }),
      getCard: (id) => rpc('get_card', { p_id: id }),
      listCards: (q) => rpc('list_cards', { p_query: q || '' }),
      createStudioCard: ({ name, phone, day, month, stamps }) => rpc('create_studio_card', { p_name: name, p_phone: phone || null, p_day: day || null, p_month: month || null, p_stamps: stamps || 0 }),
      updateCard: (id, f) => rpc('update_card', { p_id: id, p_name: f.name, p_phone: f.phone || null, p_day: f.day || null, p_month: f.month || null, p_note: f.note || null }),
      recordVisit: (id, mode, service, planId) => rpc('record_visit', { p_id: id, p_mode: mode, p_service: service || null, p_plan_id: planId || null }),
      removeStamp: (id) => rpc('remove_stamp', { p_id: id }),
      startNewCard: (id) => rpc('start_new_card', { p_id: id }),
      useBirthday: (id, service, planId) => rpc('use_birthday', { p_id: id, p_service: service || null, p_plan_id: planId || null }),
      planList: () => rpc('plan_list', {}),
      planAdd: (cardId, service) => rpc('plan_add', { p_card: cardId, p_service: service || null }),
      planSet: (planId, status) => rpc('plan_set', { p_plan_id: planId, p_status: status }),
      planRemove: (planId) => rpc('plan_remove', { p_plan_id: planId }),
      deleteCard: (id) => rpc('delete_card', { p_id: id }),
      resetToken: (id) => rpc('reset_token', { p_id: id })
    };
  }

  window.Rules = Rules;
  window.Api = DEMO ? demoApi() : supabaseApi();
  window.CardStore = {
    get() { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } },
    set(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* ignore */ } },
    clear() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } }
  };
})();
