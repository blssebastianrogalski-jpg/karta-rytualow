// Logowanie klientki do karty kodem SMS. Klientka wpisuje numer telefonu z karty,
// dostaje SMS z kodem, a po wpisaniu kodu aplikacja zapamiętuje jej kartę.
// Wysyłka przez SMSPLANET (api2.smsplanet.pl). Limity i kody pilnuje baza (logowanie-sms.sql).
// Ustawienia funkcji: Verify JWT wyłączone (klientka nie jest zalogowana).
// Wymaga sekretów: SMSPLANET_TOKEN (token API z panelu SMSPLANET) i SMSPLANET_FROM (zaakceptowana nazwa nadawcy).
//
// Body (POST):
//   { action: "send", phone }          → { ok: true }  (ta sama odpowiedź, gdy numeru nie ma na żadnej karcie)
//   { action: "verify", phone, code }  → { ok: true, cards: [{ name, stamps, token }] } albo { ok: false, error }
//   { action: "wizyta", phone, msg }   → SMS z potwierdzeniem wizyty; wysyła tylko baza (nagłówek x-push-secret = sekret PUSH_SECRET,
//                                        ten sam co dla powiadomień push), zob. wizyty-sms-odwolanie.sql

const base = Deno.env.get("SUPABASE_URL")!;
const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const db = { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" };

async function rpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${base}/rest/v1/rpc/${fn}`, { method: "POST", headers: db, body: JSON.stringify(args) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error((data && data.message) || `Błąd bazy (${r.status}).`);
  return data;
}

function newCode(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1000000).padStart(6, "0");
}

async function sendSms(phone9: string, msg: string) {
  const token = Deno.env.get("SMSPLANET_TOKEN");
  if (!token) throw new Error("Brak sekretu SMSPLANET_TOKEN w Supabase.");
  const form = new URLSearchParams({
    from: Deno.env.get("SMSPLANET_FROM") || "TEST",
    to: "48" + phone9,
    msg,
    clear_polish: "1", // bez polskich znaków: SMS mieści się w jednej wiadomości
  });
  const r = await fetch("https://api2.smsplanet.pl/sms", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || !data.messageId) throw new Error(`SMSPLANET: ${(data && data.errorMsg) || r.status}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Tylko POST." }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const phone = String(body.phone || "").slice(0, 30);
    if (body.action === "send") {
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
      const code = newCode();
      const res = await rpc("login_sms_request", { p_phone: phone, p_code: code, p_ip: ip });
      if (res.reason === "phone") return json({ ok: false, error: "Wpisz numer komórki, np. 600 000 000." }, 400);
      if (res.reason === "limit") return json({ ok: false, error: "Za dużo prób. Spróbuj ponownie za godzinę." }, 429);
      if (res.reason === "global") return json({ ok: false, error: "Logowanie kodem jest chwilowo niedostępne. Poproś w studiu o link do karty." }, 429);
      if (res.send) await sendSms(res.phone9, `Twój kod do karty rytuałów: ${code}. Kod jest ważny 10 minut. Twoje Ciało Twój Dobrostan`);
      return json({ ok: true }); // numer bez karty: ta sama odpowiedź, żeby nie zdradzać, kto ma kartę
    }
    if (body.action === "verify") {
      const code = String(body.code || "").replace(/\D/g, "").slice(0, 6);
      const res = await rpc("login_sms_verify", { p_phone: phone, p_code: code });
      if (res.ok) return json({ ok: true, cards: res.cards });
      const error = res.reason === "code" && res.left > 0
        ? `Nieprawidłowy kod. Zostały ${res.left} ${res.left === 1 ? "próba" : "próby"}.`
        : "Kod wygasł albo wykorzystano wszystkie próby. Wyślij nowy kod.";
      return json({ ok: false, error });
    }
    if (body.action === "wizyta") {
      const secret = Deno.env.get("PUSH_SECRET");
      if (!secret || req.headers.get("x-push-secret") !== secret) return json({ ok: false, error: "Brak dostępu." }, 403);
      const phone9 = phone.replace(/\D/g, "").replace(/^(00)?48(?=\d{9}$)/, "");
      if (!/^\d{9}$/.test(phone9)) return json({ ok: false, error: "Zły numer telefonu." }, 400);
      await sendSms(phone9, String(body.msg || "").slice(0, 300));
      return json({ ok: true });
    }
    return json({ ok: false, error: "Nieznana akcja." }, 400);
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "Nie udało się wysłać kodu. Spróbuj za chwilę albo poproś w studiu o link do karty." }, 500);
  }
});
