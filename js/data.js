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
    // dzień w Polsce jako 'RRRR-MM-DD' (0 = dziś, 1 = jutro)
    dayPL(offset) {
      const t = Rules.todayPL();
      return new Date(Date.UTC(t.y, t.m - 1, t.d + (offset || 0))).toISOString().slice(0, 10);
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

  // Regulamin §6b: pakiet Kobido START lub RYTUAŁ = 1 pieczątka, TRANSFORMACJA = 2.
  // Ta sama reguła jest w funkcji sprzedaz-vouchera (tam decyduje ostatecznie).
  function stampsFor(name) {
    const n = String(name).toLowerCase();
    if (!n.includes('kobido') || !/\d+\s*wizyt/.test(n)) return 0;
    if (n.includes('transformacja')) return 2;
    if (n.includes('start') || n.includes('rytuał') || n.includes('rytual')) return 1;
    return 0;
  }
  const DEMO_VOUCHERS = [
    { id: 101, name: 'Kobido START — 3 wizyty', price: 540 },
    { id: 102, name: 'Kobido RYTUAŁ — 5 wizyt', price: 800 },
    { id: 103, name: 'Kobido TRANSFORMACJA — 10 wizyt', price: 1500 },
    { id: 104, name: 'Voucher Head SPA Premium', price: 250 },
    { id: 105, name: 'Voucher kwotowy 100 zł', price: 100 },
    { id: 106, name: 'Voucher kwotowy 200 zł', price: 200 }
  ];

  // ---------- TRYB DEMO ----------
  // Sprawdzanie wolnych godzin w trybie pokazowym (w bazie robi to prosby-konflikty.sql)
  const Slots = {
    hours: { 1: ['09:00', '19:00'], 2: ['09:00', '19:00'], 3: ['09:00', '19:00'], 4: ['09:00', '18:00'], 5: ['09:00', '18:00'] },
    brk: 30,
    dur: { 'Kobido UP®': 90, 'Master Kobido UP®': 120, 'Head SPA Premium': 90, 'Access Bars®': 75, 'Refleksologia Stóp Premium': 45,
      'Masaż relaksacyjny 60 min': 60, 'Masaż relaksacyjny 90 min': 90, 'Masaż aromaterapeutyczny 60 min': 60, 'Masaż aromaterapeutyczny 90 min': 90,
      'Masaż gorącą świecą': 60, 'Masaż głowy, karku i obręczy barkowej': 45, 'Ukojenie Dla Żuchwy i Twarzy': 60 },
    minutes(s) { return s ? Slots.dur[s] || 60 : Math.max(...Object.values(Slots.dur)); },
    ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
    hm(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); },
    at(day, hm) { return new Date(day + 'T' + hm + ':00'); },
    check(db, start, min) {
      const day = Slots.ymd(start), h = Slots.hours[start.getDay() || 7];
      if (!h) return 'Studio nieczynne tego dnia';
      if (start < Date.now() + 2 * 36e5) return 'Za krótko przed wizytą';
      const end = new Date(+start + min * 6e4);
      if (start < Slots.at(day, h[0]) || end > Slots.at(day, h[1])) return 'Poza godzinami pracy (' + h[0] + '–' + h[1] + ')';
      const hit = (db.plan || []).filter((p) => p.day === day && p.status === 'planned' && p.start_at).filter((p) => {
        const s = new Date(p.start_at), e = new Date(+s + (Slots.minutes(p.service) + Slots.brk) * 6e4);
        return s < new Date(+end + Slots.brk * 6e4) && start < e;
      });
      if (!hit.length) return 'ok';
      return 'Nakłada się na: ' + hit.map((p) => { const c = db.cards.find((x) => x.id === p.card_id); return (c ? c.name : 'Klientka') + ' ' + Slots.hm(new Date(p.start_at)) + (p.service ? ' (' + p.service + ')' : ''); }).join(', ');
    },
    conflict(db, day, part, time, service) {
      const min = Slots.minutes(service);
      if (time) { const r = Slots.check(db, Slots.at(day, time), min); return r === 'ok' ? null : r; }
      const h = Slots.hours[new Date(day + 'T12:00:00').getDay() || 7];
      if (!h) return 'Studio nieczynne tego dnia';
      const from = { midday: '12:00', evening: '16:00' }[part] || h[0], to = { morning: '11:59', midday: '15:59' }[part] || h[1];
      for (let t = Slots.at(day, from > h[0] ? from : h[0]); Slots.hm(t) <= to; t = new Date(+t + 18e5)) if (Slots.check(db, t, min) === 'ok') return null;
      return 'Brak wolnej godziny ' + ({ morning: 'rano (do 12:00)', midday: 'w południe (12–16)', evening: 'po 16:00' }[part] || 'tego dnia') + ' tego dnia';
    },
    // wolne godziny najbliższe godzinie target
    free(db, target, min, n) {
      const found = [];
      const base = new Date(Math.max(+target, Date.now())); base.setHours(0, 0, 0, 0);
      for (let i = 0; i <= 21 && found.length < (n || 3) * 4; i++) {
        const d = new Date(+base); d.setDate(d.getDate() + i);
        const h = Slots.hours[d.getDay() || 7]; if (!h) continue;
        const day = Slots.ymd(d);
        for (let t = Slots.at(day, h[0]); +t + min * 6e4 <= +Slots.at(day, h[1]); t = new Date(+t + 18e5)) if (Slots.check(db, t, min) === 'ok') found.push(t);
      }
      return found.sort((x, y) => Math.abs(x - target) - Math.abs(y - target)).slice(0, n || 3).sort((x, y) => x - y).map((t) => t.toISOString());
    }
  };

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
      db.cards[0].email = 'anna.kowalska@example.com';
      const day = Rules.dayPL(0);
      db.plan = [
        { id: 1, card_id: db.cards[3].id, day, service: 'Masaż gorącą świecą', status: 'planned' },
        { id: 2, card_id: db.cards[1].id, day, service: 'Head SPA Premium', status: 'planned' },
        { id: 3, card_id: db.cards[2].id, day, service: 'Kobido UP®', status: 'planned' }
      ];
      db.requests = [
        { id: 1, card_id: db.cards[0].id, service: 'Head SPA Premium', pref_day: Rules.dayPL(3), pref_part: 'midday', pref_time: null, phone: '600 100 200',
          message: 'Mogę też w sobotę rano.', status: 'new', confirmed_at: null, reply: null, handled_at: null, created_at: daysAgo(0.05) }
      ];
      db.promotions = [
        { id: 1, title: 'Head SPA Premium −20% w listopadzie', body: 'Rytuał oczyszczania i masażu skóry głowy w niższej cenie. Zarezerwuj termin w Booksy albo poproś o termin w aplikacji.',
          valid_until: Rules.dayPL(30), pushed: 12, created_at: daysAgo(1) }
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
      const all = load().cards;
      const ref = all.find((x) => x.id === c.referred_by);
      Object.assign(out, { ref_welcome: !!c.ref_welcome, bonus_stamps: c.bonus_stamps || 0, referred_by_name: ref ? ref.name : null,
        ref_count: all.filter((x) => x.referred_by === c.id).length, ref_rewarded: all.filter((x) => x.referred_by === c.id && x.ref_rewarded_at).length });
      out.upcoming = (load().plan || []).filter((p) => p.card_id === c.id && p.status === 'planned' && p.day >= Rules.dayPL(0))
        .sort((x, y) => (x.day + (x.start_at || '~')).localeCompare(y.day + (y.start_at || '~'))).slice(0, 3)
        .map((p) => ({ id: p.id, day: p.day, start_at: p.start_at || null, service: p.service, own: !p.booking_id,
          moving: (load().requests || []).some((r) => r.move_of === p.id && ['new', 'suggested'].includes(r.status)) }));
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
    // jak wyzwalacze w bazie (program-polecen.sql): −10% na pierwszy rytuał z polecenia, pieczątka dla polecającej
    function bonus(c) {
      while ((c.bonus_stamps || 0) > 0 && c.stamps < 10 && c.stamps !== 4 && c.stamps !== 9) {
        c.stamps += 1; c.bonus_stamps -= 1;
        c.visits.unshift({ kind: 'referral', service: null, discount: 0, created_at: new Date().toISOString() });
      }
    }
    function addVisit(db, c, v) {
      if (v.kind === 'stamp' && !v.discount && c.ref_welcome) { v.discount = 10; c.ref_welcome = false; }
      c.visits.unshift(v);
      if (c.referred_by && !c.ref_rewarded_at) {
        c.ref_rewarded_at = v.created_at;
        const r = db.cards.find((x) => x.id === c.referred_by);
        if (r) { r.bonus_stamps = (r.bonus_stamps || 0) + 1; bonus(r); }
      }
      bonus(c);
    }
    const isStaff = () => { try { return !!localStorage.getItem(SESSION); } catch (e) { return false; } };
    const guard = () => { if (!isStaff()) throw new Error('Brak dostępu.'); };
    const wait = (v) => new Promise((res) => setTimeout(() => res(v), 120));
    const run = (fn) => wait().then(fn);

    return {
      demo: true,
      registerCard: ({ name, phone, day, month, ref }) => run(() => {
        if (!name || name.trim().length < 2) throw new Error('Podaj imię i nazwisko.');
        const db = load();
        const r = ref ? db.cards.find((x) => x.code === String(ref).toUpperCase().trim()) : null;
        const p9 = (phone || '').replace(/\D/g, '').slice(-9);
        if (r && p9.length < 9) throw new Error('Podaj numer telefonu, aby dostać rabat −10% z polecenia.');
        if (r && db.cards.some((x) => (x.phone || '').replace(/\D/g, '').slice(-9) === p9)) throw new Error('Ten numer ma już kartę rytuałów. Rabat z polecenia jest dla nowych klientek. Zaloguj się kodem SMS, aby wrócić do swojej karty.');
        const c = { id: uid(), code: rnd(6, alphabet), token: rnd(36, '0123456789abcdef'), name: name.trim(), phone: phone || null,
          bday_day: day || null, bday_month: month || null, stamps: 0, cards_completed: 0, birthday_used_year: null,
          source: 'app', note: null, created_at: new Date().toISOString(), visits: [],
          referred_by: r ? r.id : null, ref_welcome: !!r, bonus_stamps: 0 };
        db.cards.push(c); save(db);
        return view(c);
      }),
      savePushSubscription: async () => null,
      myConsent: (token) => run(() => { const c = load().cards.find((x) => x.token === token); return !!(c && c.sms_ok); }),
      setMyConsent: (token, ok) => run(() => { const db = load(); const c = db.cards.find((x) => x.token === token); if (c) { c.sms_ok = !!ok; save(db); } return !!ok; }),
      notifyStamp: async () => null,
      googleWalletLink: async () => { throw new Error('W trybie demo Portfel Google nie działa.'); },
      saveStaffPush: async () => null,
      getMyCard: (token) => run(() => {
        const c = load().cards.find((x) => x.token === token);
        return c ? view(c) : null;
      }),
      referralInfo: (code) => run(() => { const c = load().cards.find((x) => x.code === String(code || '').toUpperCase().trim()); return c ? { name: c.name.split(/\s+/)[0] } : null; }),
      cardByLink: (code) => run(() => { const c = load().cards.find((x) => x.link_code === code); return c ? c.token : null; }),
      markAppOpen: (token) => run(() => {
        const db = load(); const c = db.cards.find((x) => x.token === token);
        if (c) { const now = new Date().toISOString(); c.app_opened_at = c.app_opened_at || now; c.app_seen_at = now; save(db); }
      }),
      appStatus: () => run(() => {
        guard(); const m = {}; load().cards.forEach((c) => { if (c.app_opened_at) m[c.id] = { first: c.app_opened_at, last: c.app_seen_at }; }); return m;
      }),
      // pokaz logowania kodem SMS: kod to zawsze 123456
      smsLoginSend: (phone) => run(() => {
        if ((phone || '').replace(/\D/g, '').length < 9) throw new Error('Wpisz numer komórki, np. 600 000 000.');
        return { ok: true, demoCode: '123456' };
      }),
      smsLoginVerify: (phone, code) => run(() => {
        if (code !== '123456') throw new Error('Nieprawidłowy kod. W trybie pokazowym kod to 123456.');
        const p9 = (phone || '').replace(/\D/g, '').slice(-9);
        return load().cards.filter((c) => (c.phone || '').replace(/\D/g, '').slice(-9) === p9)
          .map((c) => ({ name: c.name, stamps: c.stamps, token: c.token }));
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
      referralsList: () => run(() => {
        guard();
        const all = load().cards;
        return all.filter((f) => f.referred_by).map((f) => {
          const r = all.find((x) => x.id === f.referred_by) || {};
          return { id: f.id, name: f.name, created_at: f.created_at, ref_welcome: !!f.ref_welcome, ref_rewarded_at: f.ref_rewarded_at || null,
            referrer_id: r.id, referrer_name: r.name, referrer_stamps: r.stamps, referrer_bonus: r.bonus_stamps || 0 };
        }).sort((a, b) => b.created_at.localeCompare(a.created_at));
      }),
      getCard: (id) => run(() => { guard(); const c = load().cards.find((x) => x.id === id); return c ? view(c) : null; }),
      listCards: (q) => run(() => {
        guard();
        q = (q || '').trim().toLowerCase();
        const qd = q.replace(/\s/g, '');
        return load().cards
          .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.phone || '').replace(/\s/g, '').includes(qd) || c.code.toLowerCase() === q || (c.email || '').toLowerCase().includes(q))
          .map((c) => ({ ...view(c), visits: undefined }))
          .sort((a, b) => (b.bday_today - a.bday_today) || a.name.localeCompare(b.name, 'pl'));
      }),
      createStudioCard: ({ name, phone, email, day, month, stamps }) => run(() => {
        guard();
        if (!name || name.trim().length < 2) throw new Error('Podaj imię i nazwisko.');
        const db = load();
        const c = { id: uid(), code: rnd(6, alphabet), token: rnd(36, '0123456789abcdef'), name: name.trim(), phone: phone || null, email: email || null,
          bday_day: day || null, bday_month: month || null, stamps: Math.max(0, Math.min(9, stamps || 0)), cards_completed: 0,
          birthday_used_year: null, source: 'studio', note: null, created_at: new Date().toISOString(), visits: [] };
        db.cards.push(c); save(db);
        return view(c);
      }),
      updateCard: (id, f) => run(() => { guard(); return mutate(id, (c) => {
        if (!f.name || f.name.trim().length < 2) throw new Error('Podaj imię i nazwisko.');
        Object.assign(c, { name: f.name.trim(), phone: f.phone || null, email: f.email || null, bday_day: f.day || null, bday_month: f.month || null, note: f.note || null });
      }); }),
      recordVisit: (id, mode, service, planId) => run(() => { guard(); return mutate(id, (c, db) => {
        if (!['stamp', 'package_buy', 'package_visit'].includes(mode)) throw new Error('Nieznany rodzaj wizyty.');
        let d = 0;
        if (mode !== 'package_visit') {
          if (c.stamps >= 10) throw new Error('Karta jest pełna. Rozpocznij nową kartę.');
          c.stamps += 1;
          d = Rules.discountFor(c.stamps);
        }
        addVisit(db, c, { kind: mode, service: service || null, discount: d, created_at: new Date().toISOString() });
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
        addVisit(db, c, { kind: 'birthday', service: service || null, discount: 20, created_at: new Date().toISOString() });
        if (planId) { const p = (db.plan || []).find((x) => x.id === planId); if (p) p.status = 'birthday'; }
      }); }),
      planList: (day) => run(() => {
        guard();
        const db = load();
        day = day || Rules.dayPL(0);
        return (db.plan || []).filter((p) => p.day === day).map((p) => {
          const c = db.cards.find((x) => x.id === p.card_id);
          return c ? { ...p, name: c.name, stamps: c.stamps, source: c.source, phone: c.phone, bday_today: Rules.isBdayToday(c.bday_day, c.bday_month), birthday_used_year: c.birthday_used_year } : null;
        }).filter(Boolean);
      }),
      planRange: (from, to) => run(() => {
        guard();
        const db = load();
        return (db.plan || []).filter((p) => p.day >= from && p.day <= to).map((p) => {
          const c = db.cards.find((x) => x.id === p.card_id);
          return c ? { ...p, name: c.name, stamps: c.stamps, source: c.source, phone: c.phone } : null;
        }).filter(Boolean).sort((x, y) => (x.day + (x.start_at || '~')).localeCompare(y.day + (y.start_at || '~')));
      }),
      planAdd: (cardId, service, day) => run(() => {
        guard();
        const db = load();
        day = day || Rules.dayPL(0);
        db.plan = db.plan || [];
        if (db.plan.some((p) => p.card_id === cardId && p.day === day && p.status === 'planned')) throw new Error('Ta klientka jest już w planie na ten dzień.');
        db.plan.push({ id: Date.now(), card_id: cardId, day, service: service || null, status: 'planned' });
        save(db);
      }),
      planSet: (planId, status) => run(() => { guard(); const db = load(); const p = (db.plan || []).find((x) => x.id === planId); if (p) p.status = status; save(db); }),
      planRemove: (planId) => run(() => { guard(); const db = load(); db.plan = (db.plan || []).filter((x) => x.id !== planId); save(db); }),
      // prośby o termin (jak prosby-o-termin.sql i prosby-konflikty.sql)
      requestCreate: (token, f) => run(() => {
        const db = load(); const c = db.cards.find((x) => x.token === token);
        if (!c) throw new Error('Nie znaleziono karty.');
        if (String(f.phone || '').replace(/\D/g, '').length < 9) throw new Error('Podaj numer telefonu, żebym mogła oddzwonić.');
        if (!f.day || f.day < Rules.dayPL(0)) throw new Error('Wybierz dzień od dziś.');
        if (f.day > Rules.dayPL(60)) throw new Error('Termin możesz wybrać najwyżej 60 dni naprzód.');
        db.requests = db.requests || [];
        let attempt = 1;
        const prev = f.retryOf && db.requests.find((x) => x.id === f.retryOf && x.card_id === c.id && x.status === 'suggested');
        if (prev) { prev.status = 'cancelled'; prev.handled_at = new Date().toISOString(); attempt = 2; }
        const moveOf = f.moveOf || (prev && prev.move_of) || null;
        if (moveOf) {
          if (!(db.plan || []).some((p) => p.id === moveOf && p.card_id === c.id && p.status === 'planned' && !p.booking_id)) throw new Error('Tej wizyty nie można już przełożyć w aplikacji. Zadzwoń do studia.');
          db.requests.filter((x) => x.move_of === moveOf && ['new', 'suggested'].includes(x.status)).forEach((x) => { x.status = 'cancelled'; x.handled_at = new Date().toISOString(); });
        }
        if (db.requests.filter((r) => r.card_id === c.id && ['new', 'suggested'].includes(r.status)).length >= 3) throw new Error('Masz już 3 prośby czekające na odpowiedź. Odezwę się wkrótce.');
        const conflict = Slots.conflict(db, f.day, f.part || 'any', f.time || null, f.service || null);
        let status = 'new', suggestions = null;
        if (conflict && attempt === 1) {
          const s = Slots.free(db, new Date(f.day + 'T' + (f.time || { morning: '09:00', midday: '12:00', evening: '16:00' }[f.part] || '12:00')), Slots.minutes(f.service || null));
          if (s.length) { status = 'suggested'; suggestions = s; }
        }
        const r = { id: Date.now(), card_id: c.id, service: f.service || null, pref_day: f.day, pref_part: f.part || 'any', pref_time: f.time || null, phone: f.phone.trim(),
          message: (f.message || '').trim() || null, status, attempt, conflict, suggestions, move_of: moveOf, confirmed_at: null, reply: null, handled_at: null, created_at: new Date().toISOString() };
        db.requests.unshift(r); save(db); return r;
      }),
      requestPick: (token, id, start) => run(() => {
        const db = load(); const c = db.cards.find((x) => x.token === token);
        const r = c && (db.requests || []).find((x) => x.id === id && x.card_id === c.id && x.status === 'suggested');
        if (!r) throw new Error('Ta propozycja jest już nieaktualna. Poproś o termin jeszcze raz.');
        const d = new Date(start);
        const res = Slots.check(db, d, Slots.minutes(r.service));
        Object.assign(r, { pref_day: Slots.ymd(d), pref_time: Slots.hm(d), pref_part: 'any', status: 'new', attempt: 2, suggestions: null,
          conflict: res === 'ok' ? null : 'Wybrana godzina zajęła się w międzyczasie. ' + res });
        save(db); return r;
      }),
      myRequests: (token) => run(() => {
        const db = load(); const c = db.cards.find((x) => x.token === token);
        if (!c) return [];
        const now = Date.now();
        return (db.requests || []).filter((r) => r.card_id === c.id && (['new', 'suggested'].includes(r.status)
          || (r.status === 'confirmed' && new Date(r.confirmed_at) > now - 36e5)
          || (r.status === 'declined' && new Date(r.handled_at) > now - 7 * 864e5))).slice(0, 5);
      }),
      requestCancel: (token, id) => run(() => {
        const db = load(); const c = db.cards.find((x) => x.token === token);
        const r = c && (db.requests || []).find((x) => x.id === id && x.card_id === c.id && ['new', 'suggested'].includes(x.status));
        if (!r) throw new Error('Tej prośby nie można już anulować. Zadzwoń do studia.');
        r.status = 'cancelled'; r.handled_at = new Date().toISOString(); save(db);
      }),
      visitCancel: (token, planId) => run(() => {
        const db = load(); const c = db.cards.find((x) => x.token === token);
        const p = c && (db.plan || []).find((x) => x.id === planId && x.card_id === c.id && x.status === 'planned');
        if (!p) throw new Error('Tej wizyty już nie ma w planie. Odśwież kartę.');
        if (p.booking_id) throw new Error('Tę wizytę zmienisz w Booksy.');
        const now = new Date().toISOString();
        (db.requests || []).forEach((r) => {
          if (r.plan_id === p.id && r.status === 'confirmed') Object.assign(r, { status: 'cancelled', reply: 'Odwołana przez klientkę w aplikacji', handled_at: now });
          if (r.move_of === p.id && ['new', 'suggested'].includes(r.status)) Object.assign(r, { status: 'cancelled', handled_at: now });
        });
        db.plan = db.plan.filter((x) => x !== p); save(db);
      }),
      promotionsActive: () => run(() => (load().promotions || []).filter((p) => !p.valid_until || p.valid_until >= Rules.dayPL(0))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)).map(({ id, title, body, valid_until }) => ({ id, title, body, valid_until }))),
      promotionsList: () => run(() => {
        guard();
        return (load().promotions || []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map((p) => Object.assign({}, p, { ended: !!p.valid_until && p.valid_until < Rules.dayPL(0) }));
      }),
      promotionAdd: ({ title, body, until, notify }) => run(() => {
        guard();
        if (!title || title.trim().length < 2) throw new Error('Wpisz nazwę promocji.');
        if (until && until < Rules.dayPL(0)) throw new Error('Data „ważna do” już minęła.');
        const db = load(); db.promotions = db.promotions || [];
        const pushed = notify ? db.cards.filter((c) => c.sms_ok).length : null;
        const p = { id: Date.now(), title: title.trim(), body: (body || '').trim() || null, valid_until: until || null, pushed, created_at: new Date().toISOString() };
        db.promotions.push(p); save(db);
        return { id: p.id, pushed };
      }),
      promotionRemove: (id) => run(() => { guard(); const db = load(); db.promotions = (db.promotions || []).filter((p) => p.id !== id); save(db); }),
      requestsList: () => run(() => {
        guard(); const db = load(); const from = Date.now() - 14 * 864e5;
        const open = (r) => ['new', 'suggested'].includes(r.status);
        return (db.requests || []).filter((r) => open(r) || (r.handled_at && new Date(r.handled_at) > from))
          .sort((a, b) => open(a) !== open(b) ? (open(a) ? -1 : 1) : open(a) ? (a.status === 'suggested') - (b.status === 'suggested') || a.created_at.localeCompare(b.created_at) : b.handled_at.localeCompare(a.handled_at))
          .map((r) => {
            const c = db.cards.find((x) => x.id === r.card_id) || {};
            const m = r.move_of && (db.plan || []).find((x) => x.id === r.move_of);
            return Object.assign({}, r, { name: c.name, stamps: c.stamps, card_phone: c.phone, move_from: m ? { day: m.day, start_at: m.start_at || null } : null });
          });
      }),
      requestConfirm: (id, day, time, service) => run(() => {
        guard(); const db = load(); const r = (db.requests || []).find((x) => x.id === id);
        if (!r || !['new', 'suggested', 'declined'].includes(r.status)) throw new Error('Ta prośba jest już załatwiona.');
        if (!day || day < Rules.dayPL(0)) throw new Error('Wybierz dzień od dziś.');
        if (!time) throw new Error('Podaj godzinę wizyty.');
        const start = new Date(day + 'T' + time + ':00').toISOString();
        db.plan = db.plan || [];
        const same = db.plan.filter((x) => x.card_id === r.card_id && x.day === day && x.status === 'planned' && !x.booking_id);
        let p = same.find((x) => x.id === r.move_of) || same[0];
        if (p) { p.start_at = start; p.service = service || r.service || p.service; }
        else { p = { id: Date.now(), card_id: r.card_id, day, service: service || r.service, start_at: start, status: 'planned' }; db.plan.push(p); }
        Object.assign(r, { status: 'confirmed', confirmed_at: start, plan_id: p.id, service: service || r.service, reply: null, suggestions: null, handled_at: new Date().toISOString() });
        if (r.move_of && r.move_of !== p.id) {
          (db.requests || []).forEach((x) => { if (x.plan_id === r.move_of && x.status === 'confirmed') Object.assign(x, { status: 'cancelled', reply: 'Przełożona na nowy termin', handled_at: r.handled_at }); });
          db.plan = db.plan.filter((x) => !(x.id === r.move_of && x.status === 'planned' && !x.booking_id));
        }
        save(db); return r;
      }),
      requestDecline: (id, reply) => run(() => {
        guard(); const db = load(); const r = (db.requests || []).find((x) => x.id === id && ['new', 'suggested'].includes(x.status));
        if (!r) throw new Error('Ta prośba jest już załatwiona.');
        Object.assign(r, { status: 'declined', reply: (reply || '').trim() || null, suggestions: null, handled_at: new Date().toISOString() }); save(db);
      }),
      slotConflict: (day, time, service) => run(() => {
        guard(); const res = Slots.check(load(), new Date(day + 'T' + time), Slots.minutes(service || null));
        return res === 'ok' || res === 'Za krótko przed wizytą' ? null : res;
      }),
      deleteCard: (id) => run(() => { guard(); const db = load(); db.cards = db.cards.filter((x) => x.id !== id); save(db); }),
      resetToken: (id) => run(() => { guard(); return mutate(id, (c) => { c.token = rnd(36, '0123456789abcdef'); }); }),
      transferStamps: (id, n) => run(() => { guard(); return mutate(id, (c) => {
        if (c.cards_completed || (c.visits || []).length) throw new Error('Pieczątki z papierowej karty można przenieść tylko przed pierwszą wizytą zapisaną w aplikacji.');
        c.stamps = Math.max(0, Math.min(9, n || 0));
      }); }),
      smsConsent: (id) => run(() => { guard(); const c = load().cards.find((x) => x.id === id); return !!(c && c.sms_ok); }),
      setSmsConsent: (id, ok) => run(() => { guard(); mutate(id, (c) => { c.sms_ok = !!ok; }); return !!ok; }),
      // sprzedaż vouchera (pokaz: bez sklepu i bez drukarki)
      vouchersList: () => run(() => { guard(); return DEMO_VOUCHERS.map((v) => ({ ...v, stamps: stampsFor(v.name) })); }),
      sellVoucher: (p) => run(() => {
        guard();
        const v = DEMO_VOUCHERS.find((x) => x.id === p.product_id);
        if (!v) throw new Error('Wybierz voucher.');
        const db = load();
        db.sales = db.sales || [];
        const orderId = 1000 + db.sales.length + 1;
        const expected = p.card_id ? stampsFor(v.name) * p.qty : 0;
        const paid = p.payment !== 'blik';
        let added = 0, stampError = null, card = null;
        const c = p.card_id ? db.cards.find((x) => x.id === p.card_id) : null;
        for (let i = 0; i < expected && c && paid; i++) {
          if (c.stamps >= 10) { stampError = 'Karta jest pełna. Rozpocznij nową kartę.'; break; }
          c.stamps += 1;
          c.visits.unshift({ kind: 'package_buy', service: v.name, discount: Rules.discountFor(c.stamps), created_at: new Date().toISOString() });
          added++;
        }
        if (c) card = view(c);
        db.sales.unshift({ id: orderId, created_at: new Date().toISOString(), card_id: p.card_id || null, product_name: v.name, qty: p.qty, total: v.price * p.qty,
          payment: p.payment, buyer_name: p.name || null, order_id: orderId, order_number: String(orderId), receipt: paid ? 'queued' : 'pending', stamps_added: added });
        save(db);
        return { order_id: orderId, order_number: String(orderId), total: v.price * p.qty, paid,
          pay_url: paid ? null : 'https://twojecialotwojdobrostan.pl/zamowienie/zaplac/' + orderId + '/?pokaz=1',
          stamps_expected: expected, stamps_added: added, stamp_error: stampError, card };
      }),
      receiptStatus: (orderId) => run(() => {
        guard();
        const db = load();
        const s = (db.sales || []).find((x) => x.order_id === orderId);
        if (!s) throw new Error('Nie znaleziono zamówienia.');
        // pokaz: płatność BLIK „przychodzi” po 8 s
        const wait = s.payment === 'blik' ? 8 : 0;
        const age = (Date.now() - new Date(s.created_at)) / 1000 - wait;
        if (age < 0) return { order_number: s.order_number, total: s.total, paid: false, failed: false, receipt: 'waiting_payment' };
        s.receipt = age > 7 ? 'confirmed' : age > 3 ? 'sent' : 'queued';
        save(db);
        return { order_number: s.order_number, total: s.total, paid: true, failed: false, receipt: s.receipt };
      }),
      voucherSales: () => run(() => { guard(); return (load().sales || []).slice(0, 20); }),
      // integracja Booksy (pokaz: przykładowy stan po podłączeniu skryptu)
      booksyStatus: () => run(() => {
        guard();
        const db = load();
        const b = db.booksy || { connected: false, gcal_mode: 'delete', import_state: 'none' };
        if (!b.connected) return { connected: false, gcal_mode: b.gcal_mode, import_state: 'none', processed: 0, errors: [], unrecognized: [], unassigned: [], upcoming: [], log: [] };
        const at = (d, h) => { const x = new Date(Rules.dayPL(d) + 'T00:00:00'); x.setHours(h); return x.toISOString(); };
        return Object.assign({
          connected: true, connected_at: b.connected_at, script_last_seen: new Date(Date.now() - 120000).toISOString(), gmail_ok: true, calendar_ok: true,
          last_ok_at: new Date(Date.now() - 120000).toISOString(), last_error: null, calendar_name: 'Twoje Ciało Twój Dobrostan | Wizyty',
          processed: 3, bookings: 3,
          errors: b.retried ? [] : [{ id: 3, service: 'Access Bars®', start: at(3, 12), error: 'Service unavailable', attempts: 2 }],
          unrecognized: [{ at: new Date(Date.now() - 86400000).toISOString(), kind: 'unknown', subject: 'Podsumowanie tygodnia w Booksy', result: 'unrecognized' }],
          unassigned: b.assigned ? [] : [{ id: 2, name: 'Maria Zielińska', service: 'Masaż gorącą świecą', start: at(1, 15), candidates: [] }],
          upcoming: [
            { id: 1, name: db.cards[0].name, service: 'Kobido UP®', start: at(1, 10), end: at(1, 11), gcal: 'synced', conflict: false, card: true },
            { id: 2, name: 'Maria Zielińska', service: 'Masaż gorącą świecą', start: at(1, 15), end: at(1, 16), gcal: 'synced', conflict: false, card: !!b.assigned },
            { id: 3, name: db.cards[1].name, service: 'Access Bars®', start: at(3, 12), end: at(3, 13), gcal: b.retried ? 'synced' : 'error', conflict: false, card: true }
          ],
          log: [{ at: new Date(Date.now() - 120000).toISOString(), level: 'info', message: 'Nowa rezerwacja zapisana.' }]
        }, b);
      }),
      booksyNewKey: () => run(() => { guard(); const db = load(); db.booksy = Object.assign(db.booksy || {}, { connected: true, connected_at: new Date().toISOString(), gcal_mode: (db.booksy || {}).gcal_mode || 'delete', import_state: 'none' }); save(db); return 'tctd_demo_' + Math.random().toString(16).slice(2, 18); }),
      booksyDisconnect: () => run(() => { guard(); const db = load(); db.booksy = Object.assign(db.booksy || {}, { connected: false }); save(db); }),
      booksyRequestSync: () => run(() => { guard(); }),
      booksyRetry: () => run(() => { guard(); const db = load(); db.booksy.retried = true; save(db); }),
      booksySetMode: (mode) => run(() => { guard(); const db = load(); db.booksy.gcal_mode = mode; save(db); }),
      booksyImport: (action) => run(() => {
        guard(); const db = load();
        db.booksy.import_state = action === 'preview' ? 'preview_ready' : action === 'apply' ? 'done' : 'none';
        db.booksy.import_preview = action === 'preview' ? { at: new Date().toISOString(), items: [
          { kind: 'new', name: 'Halina Mazur', service: 'Masaż gorącą świecą', start: new Date(Date.now() + 9 * 864e5).toISOString(), result: 'applied' },
          { kind: 'cancel', name: 'Ewa Zielińska', service: 'Kobido UP®', start: new Date(Date.now() + 4 * 864e5).toISOString(), result: 'applied' },
          { kind: 'new', name: 'Anna Kowalska', service: 'Kobido UP®', start: new Date(Date.now() - 5 * 864e5).toISOString(), result: 'past' }] } : null;
        save(db);
      }),
      booksyAssign: () => run(() => { guard(); const db = load(); db.booksy.assigned = true; save(db); }),
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
    const invoke = async (fn, body) => {
      const { data, error } = await sb.functions.invoke(fn, { body });
      if (error) {
        let msg = error.message;
        try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) { /* bez treści */ }
        if (/fetch|network/i.test(msg)) msg = 'Brak połączenia z internetem. Spróbuj ponownie.';
        throw new Error(msg);
      }
      return data;
    };
    const sale = (body) => invoke('sprzedaz-vouchera', body);
    return {
      demo: false,
      registerCard: ({ name, phone, day, month, ref }) => rpc('register_card', { p_name: name, p_phone: phone || null, p_day: day || null, p_month: month || null, p_ref: ref || null }),
      referralInfo: (code) => rpc('referral_info', { p_code: code }),
      getMyCard: (token) => rpc('get_my_card', { p_token: token }),
      markAppOpen: (token) => rpc('mark_app_open', { p_token: token }),
      cardByLink: (code) => rpc('card_by_link', { p_code: code }),
      // logowanie do karty kodem SMS (funkcja kod-sms)
      smsLoginSend: (phone) => invoke('kod-sms', { action: 'send', phone }),
      smsLoginVerify: async (phone, code) => {
        const r = await invoke('kod-sms', { action: 'verify', phone, code });
        if (!r.ok) throw new Error(r.error || 'Nieprawidłowy kod.');
        return r.cards;
      },
      myConsent: (token) => rpc('my_consent', { p_token: token }),
      setMyConsent: (token, ok) => rpc('set_my_consent', { p_token: token, p_ok: !!ok }),
      savePushSubscription: (token, sub) => rpc('save_push_subscription', { p_token: token, p_endpoint: sub.endpoint, p_p256dh: sub.keys.p256dh, p_auth: sub.keys.auth }),
      saveStaffPush: (sub) => rpc('save_staff_push_subscription', { p_endpoint: sub.endpoint, p_p256dh: sub.keys.p256dh, p_auth: sub.keys.auth }),
      googleWalletLink: async (token) => (await invoke('portfel-google', { action: 'link', token })).url,
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
      referralsList: () => rpc('referrals_list', {}),
      listCards: (q) => rpc('list_cards', { p_query: q || '' }),
      appStatus: () => rpc('cards_app_status', {}),
      createStudioCard: ({ name, phone, email, day, month, stamps }) => rpc('create_studio_card', { p_name: name, p_phone: phone || null, p_day: day || null, p_month: month || null, p_stamps: stamps || 0, p_email: email || null }),
      updateCard: (id, f) => rpc('update_card', { p_id: id, p_name: f.name, p_phone: f.phone || null, p_day: f.day || null, p_month: f.month || null, p_note: f.note || null, p_email: f.email || '' }),
      recordVisit: (id, mode, service, planId) => rpc('record_visit', { p_id: id, p_mode: mode, p_service: service || null, p_plan_id: planId || null }),
      removeStamp: (id) => rpc('remove_stamp', { p_id: id }),
      startNewCard: (id) => rpc('start_new_card', { p_id: id }),
      useBirthday: (id, service, planId) => rpc('use_birthday', { p_id: id, p_service: service || null, p_plan_id: planId || null }),
      planList: (day) => rpc('plan_list', day ? { p_day: day } : {}),
      planRange: (from, to) => rpc('plan_range', { p_from: from, p_to: to }),
      planAdd: (cardId, service, day) => rpc('plan_add', { p_card: cardId, p_service: service || null, p_day: day || null }),
      planSet: (planId, status) => rpc('plan_set', { p_plan_id: planId, p_status: status }),
      planRemove: (planId) => rpc('plan_remove', { p_plan_id: planId }),
      requestCreate: (token, f) => rpc('request_create', Object.assign({ p_token: token, p_service: f.service || null, p_day: f.day, p_part: f.part || 'any', p_time: f.time || null, p_phone: f.phone, p_message: f.message || null }, f.retryOf ? { p_retry_of: f.retryOf } : {}, f.moveOf ? { p_move_of: f.moveOf } : {})),
      visitCancel: (token, planId) => rpc('visit_cancel', { p_token: token, p_plan_id: planId }),
      requestPick: (token, id, start) => rpc('request_pick', { p_token: token, p_id: id, p_start: start }),
      slotConflict: (day, time, service) => rpc('slot_conflict', { p_day: day, p_time: time, p_service: service || null }),
      myRequests: (token) => rpc('my_requests', { p_token: token }),
      requestCancel: (token, id) => rpc('request_cancel', { p_token: token, p_id: id }),
      promotionsActive: () => rpc('promotions_active', {}),
      promotionsList: () => rpc('promotions_list', {}),
      promotionAdd: ({ title, body, until, notify }) => rpc('promotion_add', { p_title: title, p_body: body || null, p_until: until || null, p_notify: !!notify }),
      promotionRemove: (id) => rpc('promotion_remove', { p_id: id }),
      requestsList: () => rpc('requests_list', {}),
      requestConfirm: (id, day, time, service) => rpc('request_confirm', { p_id: id, p_day: day, p_time: time, p_service: service || null }),
      requestDecline: (id, reply) => rpc('request_decline', { p_id: id, p_reply: reply || null }),
      deleteCard: (id) => rpc('delete_card', { p_id: id }),
      resetToken: (id) => rpc('reset_token', { p_id: id }),
      transferStamps: (id, n) => rpc('transfer_paper_stamps', { p_id: id, p_stamps: n }),
      smsConsent: (id) => rpc('sms_consent_get', { p_id: id }),
      setSmsConsent: (id, ok) => rpc('sms_consent_set', { p_id: id, p_ok: !!ok }),
      // sprzedaż vouchera: przez funkcję sprzedaz-vouchera (sekret sklepu zostaje na serwerze)
      vouchersList: () => sale({ action: 'list' }).then((d) => d.vouchers),
      sellVoucher: (p) => sale({ action: 'sell', ...p }),
      receiptStatus: (orderId) => sale({ action: 'status', order_id: orderId }),
      booksyStatus: () => rpc('booksy_status', {}),
      booksyNewKey: () => rpc('booksy_new_key', {}),
      booksyDisconnect: () => rpc('booksy_disconnect', {}),
      booksyRequestSync: () => rpc('booksy_request_sync', {}),
      booksyRetry: (id) => rpc('booksy_retry', { p_id: id || null }),
      booksySetMode: (mode) => rpc('booksy_set_mode', { p_mode: mode }),
      booksyImport: (action) => rpc('booksy_import', { p_action: action }),
      booksyAssign: (bookingId, cardId) => rpc('booksy_assign', { p_booking: bookingId, p_card: cardId || null }),
      voucherSales: async () => {
        const { data, error } = await sb.from('voucher_sales').select('*').order('created_at', { ascending: false }).limit(20);
        if (error) throw new Error(error.message);
        return data;
      }
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
