// Sprzedaż vouchera z panelu studia. Pośredniczy między panelem a API sklepu (WooCommerce),
// żeby sekret X-TCTD-Key nigdy nie trafił do przeglądarki.
// Sklep tworzy opłacone zamówienie, a eparagony.pl + eDPS drukują paragon na Elzab Zeta Online.
// Wymaga zalogowanej osoby z tabeli staff (sprawdzane przez is_staff z jej tokenem).
// Wymaga sekretu: TCTD_WP_KEY.
//
// Body (POST):
//   { action: "list" }                                  → lista voucherów z cenami i pieczątkami
//   { action: "sell", client_ref, product_id, qty, payment, name?, email?, phone?, card_id? }
//   { action: "status", order_id }                      → status płatności i paragonu
//
// Płatność: gotowka i blik_telefon (BLIK na telefon) są opłacone od razu, paragon drukuje się zaraz.
// blik to kod BLIK przez PayU: sklep zwraca pay_url, a zamówienie jest opłacone dopiero
// po zaksięgowaniu. Wtedy drukuje się paragon i dopiero wtedy dodajemy pieczątki.

const WP = "https://twojecialotwojdobrostan.pl/wp-json/tctd/v1/sprzedaz";
const base = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const db = { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" };
const PAYMENTS = ["gotowka", "blik", "blik_telefon"];
const RECEIPTS = ["queued", "sent", "confirmed", "error"];
// Strona płatności: PayU albo (awaryjnie) strona zapłaty w sklepie.
const PAY_URL = /^https:\/\/(twojecialotwojdobrostan\.pl|([a-z0-9-]+\.)*payu\.(com|pl))\//;

// Regulamin §6b: pakiet Kobido START lub RYTUAŁ = 1 pieczątka, TRANSFORMACJA = 2.
// Pakiet rozpoznajemy po nazwie z liczbą wizyt („Kobido START — 3 wizyty”).
// Voucher na pojedynczy rytuał i voucher kwotowy nie dają pieczątki przy zakupie.
function stampsFor(name: string): number {
  const n = name.toLowerCase();
  if (!n.includes("kobido") || !/\d+\s*wizyt/.test(n)) return 0;
  if (n.includes("transformacja")) return 2;
  if (n.includes("start") || n.includes("rytuał") || n.includes("rytual")) return 1;
  return 0;
}

async function wp(path: string, init: RequestInit = {}) {
  const key = Deno.env.get("TCTD_WP_KEY");
  if (!key) throw new Error("Brak sekretu TCTD_WP_KEY w Supabase.");
  const res = await fetch(WP + path, {
    ...init,
    headers: { "X-TCTD-Key": key, "Content-Type": "application/json", Accept: "application/json" },
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = JSON.parse(text); } catch { /* nie JSON */ }
  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message || text.slice(0, 200) || res.statusText;
    throw new Error(`Sklep odpowiedział błędem ${res.status}: ${msg}`);
  }
  return data;
}

async function vouchers() {
  const list = await wp("/vouchery");
  if (!Array.isArray(list)) throw new Error("Sklep zwrócił nieoczekiwaną listę voucherów.");
  return list.map((v: { id: number; name: string; price: number | string }) => ({
    id: Number(v.id), name: String(v.name), price: Number(v.price), stamps: stampsFor(String(v.name)),
  }));
}

async function updateSale(filter: string, patch: Record<string, unknown>) {
  const r = await fetch(`${base}/rest/v1/voucher_sales?${filter}`, {
    method: "PATCH", headers: { ...db, Prefer: "return=representation" }, body: JSON.stringify(patch),
  });
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

// Pieczątki za zakup pakietu (istniejąca funkcja record_visit, ta sama co w panelu).
async function addStamps(auth: string, cardId: string, service: string, count: number) {
  let added = 0, stampError: string | null = null, card: unknown = null;
  for (let i = 0; i < count; i++) {
    const r = await fetch(`${base}/rest/v1/rpc/record_visit`, {
      method: "POST", headers: { apikey: anon, Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ p_id: cardId, p_mode: "package_buy", p_service: service }),
    });
    const out = await r.json();
    if (!r.ok) { stampError = String(out?.message || "Nie udało się dodać pieczątki.").replace(/^.*?:\s*/, ""); break; }
    card = out; added++;
  }
  return { added, stampError, card };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  const staffRes = await fetch(`${base}/rest/v1/rpc/is_staff`, {
    method: "POST", headers: { apikey: anon, Authorization: auth, "Content-Type": "application/json" }, body: "{}",
  });
  if ((await staffRes.json()) !== true) return json({ error: "Brak dostępu." }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Nieprawidłowe zapytanie." }, 400); }

  try {
    if (body.action === "list") return json({ vouchers: await vouchers() });

    if (body.action === "status") {
      const orderId = Number(body.order_id);
      if (!Number.isInteger(orderId) || orderId <= 0) return json({ error: "Brak numeru zamówienia." }, 400);
      const s = await wp(`/${orderId}`) as {
        order_number?: string; total?: number | string; paid?: boolean; failed?: boolean; receipt?: string;
      };
      if (!s) return json({ error: "Sklep nie zwrócił statusu." }, 502);
      if (s.failed) {
        await updateSale(`order_id=eq.${orderId}&receipt=neq.failed`, { receipt: "failed", error: "Płatność BLIK nieudana lub anulowana." });
        await updateSale(`order_id=eq.${orderId}&stamps_added=eq.-2`, { stamps_added: 0 });
        return json(s);
      }
      if (s.paid === false) return json(s);
      if (RECEIPTS.includes(String(s.receipt))) await updateSale(`order_id=eq.${orderId}`, { receipt: s.receipt });

      // BLIK kodem: pieczątki dopiero po opłaceniu. stamps_added = -2 znaczy „należą się po opłaceniu”.
      // Zmiana na -1 rezerwuje sprzedaż, żeby dwa równoległe sprawdzenia nie dodały pieczątek podwójnie.
      const [row] = await updateSale(`order_id=eq.${orderId}&stamps_added=eq.-2&card_id=not.is.null`, { stamps_added: -1 });
      const due = row ? stampsFor(row.product_name) * row.qty : 0;
      if (!row) return json(s);
      const st = await addStamps(auth, row.card_id, row.product_name, due);
      await updateSale(`id=eq.${row.id}`, { stamps_added: st.added, ...(st.stampError ? { error: "Pieczątki: " + st.stampError } : {}) });
      return json({ ...s, stamps_expected: due, stamps_added: st.added, stamp_error: st.stampError, card: st.card });
    }

    if (body.action === "sell") {
      const ref = String(body.client_ref || "");
      const productId = Number(body.product_id);
      const qty = Number(body.qty);
      const payment = String(body.payment || "");
      const cardId = body.card_id ? String(body.card_id) : null;
      if (!/^[0-9a-f-]{36}$/i.test(ref)) return json({ error: "Brak identyfikatora sprzedaży." }, 400);
      if (!Number.isInteger(productId) || productId <= 0) return json({ error: "Wybierz voucher." }, 400);
      if (!Number.isInteger(qty) || qty < 1 || qty > 10) return json({ error: "Ilość musi być od 1 do 10." }, 400);
      if (!PAYMENTS.includes(payment)) return json({ error: "Wybierz sposób płatności." }, 400);
      const clean = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
      const name = clean(body.name, 120), email = clean(body.email, 160), phone = clean(body.phone, 30);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Sprawdź adres e-mail." }, 400);

      // Ten sam client_ref = to samo kliknięcie wysłane drugi raz. Nie tworzymy drugiego zamówienia.
      const prev = await (await fetch(`${base}/rest/v1/voucher_sales?select=*&client_ref=eq.${ref}`, { headers: db })).json();
      if (Array.isArray(prev) && prev.length) return json({ duplicate: true, sale: prev[0] });

      const product = (await vouchers()).find((v) => v.id === productId);
      if (!product) return json({ error: "Tego vouchera nie ma już w sklepie. Odśwież listę." }, 400);

      const user = await (await fetch(`${base}/auth/v1/user`, { headers: { apikey: anon, Authorization: auth } })).json();
      const ins = await fetch(`${base}/rest/v1/voucher_sales`, {
        method: "POST", headers: { ...db, Prefer: "return=representation" },
        body: JSON.stringify({
          client_ref: ref, created_by: user?.id ?? null, card_id: cardId, product_id: productId, product_name: product.name,
          qty, unit_price: product.price, total: product.price * qty, payment,
          buyer_name: name ?? null, buyer_email: email ?? null, buyer_phone: phone ?? null,
        }),
      });
      const rows = await ins.json();
      if (!ins.ok || !Array.isArray(rows)) return json({ error: "Nie udało się zapisać sprzedaży.", detail: rows }, 500);
      const sale = rows[0];

      let order: { order_id: number; order_number: string; total: number | string; paid?: boolean; pay_url?: string };
      try {
        order = await wp("", {
          method: "POST",
          body: JSON.stringify({ product_id: productId, qty, payment, name, email, phone }),
        }) as typeof order;
        if (!order || !order.order_id) throw new Error("Sklep nie zwrócił numeru zamówienia.");
        if (order.paid === false && !PAY_URL.test(String(order.pay_url || ""))) throw new Error("Sklep nie zwrócił strony płatności BLIK.");
      } catch (e) {
        const msg = (e as Error).name === "TimeoutError"
          ? "Sklep nie odpowiedział na czas. Zanim sprzedasz ponownie, sprawdź zamówienia w WooCommerce."
          : (e as Error).message;
        await updateSale(`id=eq.${sale.id}`, { receipt: "failed", error: msg });
        return json({ error: msg }, 502);
      }
      const paid = order.paid !== false;
      await updateSale(`id=eq.${sale.id}`, {
        order_id: order.order_id, order_number: String(order.order_number), total: Number(order.total),
        receipt: paid ? "queued" : "pending",
        ...(!paid && cardId && product.stamps ? { stamps_added: -2 } : {}),
      });

      const expected = cardId ? product.stamps * qty : 0;
      const result = {
        sale_id: sale.id, order_id: order.order_id, order_number: String(order.order_number), total: Number(order.total),
        paid, pay_url: paid ? null : order.pay_url, stamps_expected: expected, stamps_added: 0,
        stamp_error: null as string | null, card: null as unknown,
      };
      if (paid && expected) {
        const st = await addStamps(auth, cardId!, product.name, expected);
        if (st.added) await updateSale(`id=eq.${sale.id}`, { stamps_added: st.added });
        Object.assign(result, { stamps_added: st.added, stamp_error: st.stampError, card: st.card });
      }
      return json(result);
    }

    return json({ error: "Nieznana akcja." }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
