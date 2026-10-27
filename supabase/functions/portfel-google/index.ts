// Karta rytuałów w Portfelu Google (Android).
// Klientka stuka „Dodaj do Portfela Google” na karcie, a funkcja tworzy jej kartę w Google
// i zwraca link zapisu. Po każdej zmianie pieczątek baza woła tę funkcję (portfel-google.sql),
// a karta w Portfelu odświeża się sama.
// Ustawienia funkcji: Verify JWT wyłączone (klientka nie jest zalogowana, karta po tokenie).
// Wymaga sekretów: GOOGLE_WALLET_ISSUER_ID (numer wydawcy z Google Pay & Wallet Console),
// GOOGLE_WALLET_KEY (cały plik JSON klucza konta usługi z Google Cloud) i PUSH_SECRET (już ustawiony).
//
// Body (POST):
//   { action: "link", token }       → { url }   (klientka; zapisuje kartę w Google i daje link)
//   { action: "update", card_id }   → { ok }    (tylko baza, nagłówek x-push-secret)

const base = Deno.env.get("SUPABASE_URL")!;
const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const issuer = Deno.env.get("GOOGLE_WALLET_ISSUER_ID") ?? "";
const keyJson = Deno.env.get("GOOGLE_WALLET_KEY") ?? "";
const pushSecret = Deno.env.get("PUSH_SECRET") ?? "";

const APP_URL = "https://karta.twojecialotwojdobrostan.pl/";
const STUDIO = "Twoje Ciało Twój Dobrostan";
const BOOKSY_URL = "https://twojecialotwojdobrostan69.booksy.com/k";
const PHONE = "+48500694094";
const API = "https://walletobjects.googleapis.com/walletobjects/v1";
const CLASS_ID = `${issuer}.karta_rytualow`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const db = { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" };

type Card = { id: string; code: string; name: string; stamps: number; cards_completed: number };

async function loadCard(filter: string): Promise<Card | null> {
  const r = await fetch(`${base}/rest/v1/cards?select=id,code,name,stamps,cards_completed&${filter}`, { headers: db });
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// ---------- podpis Google (RS256) ----------
const b64url = (data: Uint8Array | string) =>
  btoa(typeof data === "string" ? unescape(encodeURIComponent(data)) : String.fromCharCode(...data))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let signKey: CryptoKey | null = null;
async function sign(payload: Record<string, unknown>): Promise<string> {
  const sa = JSON.parse(keyJson);
  if (!signKey) {
    const pem = sa.private_key.replace(/-----[^-]+-----|\s/g, "");
    const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
    signKey = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  }
  const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: sa.client_email, ...payload }))}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signKey, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

let token: { value: string; until: number } | null = null;
async function accessToken(): Promise<string> {
  if (token && token.until > Date.now()) return token.value;
  const now = Math.floor(Date.now() / 1000);
  const assertion = await sign({
    scope: "https://www.googleapis.com/auth/wallet_object.issuer",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error("Google nie przyjął klucza: " + (data.error_description || data.error || r.status));
  token = { value: data.access_token, until: Date.now() + 50 * 60 * 1000 };
  return token.value;
}

async function google(method: string, path: string, body?: unknown) {
  const r = await fetch(`${API}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}

// Wstaw, a jeśli już jest, zaktualizuj.
async function upsert(kind: "loyaltyClass" | "loyaltyObject", obj: { id: string }) {
  const ins = await google("POST", kind, obj);
  if (ins.status === 409) {
    const upd = await google("PATCH", `${kind}/${encodeURIComponent(obj.id)}`, obj);
    if (upd.status >= 300) throw new Error(`Google ${kind} ${upd.status}: ${JSON.stringify(upd.data)}`);
  } else if (ins.status >= 300) throw new Error(`Google ${kind} ${ins.status}: ${JSON.stringify(ins.data)}`);
}

// ---------- wygląd karty ----------
function walletClass() {
  return {
    id: CLASS_ID,
    issuerName: STUDIO,
    programName: "Karta rytuałów",
    programLogo: { sourceUri: { uri: `${APP_URL}img/icon-512.png` }, contentDescription: { defaultValue: { language: "pl", value: STUDIO } } },
    hexBackgroundColor: "#0e0d0b",
    countryCode: "PL",
    reviewStatus: "UNDER_REVIEW",
    homepageUri: { uri: APP_URL, description: "Otwórz kartę" },
    textModulesData: [{ id: "zasady", header: "Nagrody", body: "Każdy rytuał to jedna pieczątka. 5. rytuał −15%, 10. rytuał −30%. W dniu urodzin −20% na dowolny rytuał." }],
    linksModuleData: { uris: [
      { id: "booksy", uri: BOOKSY_URL, description: "Umów wizytę w Booksy" },
      { id: "karta", uri: APP_URL, description: "Otwórz kartę w aplikacji" },
      { id: "tel", uri: `tel:${PHONE}`, description: "Zadzwoń: 500 694 094" },
    ] },
  };
}

function nextReward(stamps: number): string {
  if (stamps >= 10) return "Karta pełna. Dziękuję!";
  if (stamps === 4) return "Następny rytuał −15%";
  if (stamps === 9) return "Następny rytuał −30%";
  const n = stamps < 4 ? 4 - stamps : 9 - stamps;
  const word = n === 1 ? "wizyta" : n < 5 ? "wizyty" : "wizyt";
  return `Jeszcze ${n} ${word} do ${stamps < 4 ? "−15%" : "−30%"}`;
}

function walletObject(c: Card) {
  const text = [{ id: "nagroda", header: "Do nagrody", body: nextReward(c.stamps) }];
  if (c.cards_completed) text.push({ id: "ukonczone", header: "Ukończone karty", body: String(c.cards_completed) });
  return {
    id: `${issuer}.${c.id}`,
    classId: CLASS_ID,
    state: "ACTIVE",
    accountId: c.code,
    accountName: c.name,
    loyaltyPoints: { label: "Pieczątki", balance: { string: `${c.stamps} / 10` } },
    barcode: { type: "QR_CODE", value: `TCTD:${c.code}`, alternateText: `KARTA ${c.code}` },
    textModulesData: text,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!issuer || !keyJson) return json({ error: "Portfel Google nie jest jeszcze skonfigurowany." }, 503);

  try {
    const body = await req.json();

    if (body.action === "link") {
      if (typeof body.token !== "string" || body.token.length < 10) return json({ error: "Bad request" }, 400);
      const card = await loadCard(`token=eq.${encodeURIComponent(body.token)}`);
      if (!card) return json({ error: "Nie znaleziono karty." }, 404);
      await upsert("loyaltyClass", walletClass());
      await upsert("loyaltyObject", walletObject(card));
      await fetch(`${base}/rest/v1/cards?id=eq.${card.id}`, { method: "PATCH", headers: db, body: JSON.stringify({ google_wallet_at: new Date().toISOString() }) });
      const jwt = await sign({
        aud: "google", typ: "savetowallet", iat: Math.floor(Date.now() / 1000),
        origins: [APP_URL.replace(/\/$/, "")],
        payload: { loyaltyObjects: [{ id: `${issuer}.${card.id}` }] },
      });
      return json({ url: `https://pay.google.com/gp/v/save/${jwt}` });
    }

    if (body.action === "update") {
      if (!pushSecret || req.headers.get("x-push-secret") !== pushSecret) return json({ error: "Forbidden" }, 403);
      const card = await loadCard(`id=eq.${encodeURIComponent(body.card_id ?? "")}`);
      if (!card) return json({ ok: false, error: "Nie znaleziono karty." }, 404);
      const obj = walletObject(card);
      const r = await google("PATCH", `loyaltyObject/${encodeURIComponent(obj.id)}`, obj);
      // 404 = klientka nigdy nie dodała karty do Portfela, nic do zrobienia
      return json({ ok: r.status < 300 || r.status === 404 });
    }

    return json({ error: "Bad request" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Nie udało się połączyć z Portfelem Google. Spróbuj za chwilę." }, 500);
  }
});
