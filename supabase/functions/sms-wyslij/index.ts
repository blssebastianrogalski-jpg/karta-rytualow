// Wysyłka jednego SMS. Wywołuje ją tylko baza (urodziny, odwołania, wolne terminy, opinie, zadatek), nie aplikacja.
// Ustawienia funkcji: Verify JWT wyłączone; dostęp tylko z nagłówkiem x-push-secret (ten sam sekret co send-push).
//
// Dwie drogi wysyłki (sekret SMS_PROVIDER):
//  • „telefon” – z karty SIM telefonu studia (Android z aplikacją SMS Gateway for Android, tryb Cloud Server).
//    Sekrety SMSGATE_USER i SMSGATE_PASS = login i hasło z sekcji „Cloud Server” w tej aplikacji.
//    Gdy SMS_PROVIDER nie jest ustawiony, a te dwa sekrety są, też wysyłam z telefonu.
//  • „smsplanet” – bramka SMSPLANET jak dotąd (SMSPLANET_TOKEN, nadawca SMSPLANET_FROM albo TwojeCialo).
//
// Body (POST): { phone, msg, polish? } → { ok: true, messageId, via } albo { ok: false, error }
// polish (tylko SMSPLANET): true = z polskimi znakami, inaczej bez ogonków. Telefon zawsze wysyła z polskimi znakami.

const json = (body: unknown, status = 200) => Response.json(body, { status });

const MAX_PHONE = 1530;    // z karty SIM: do 10 części SMS
const MAX_SMSPLANET = 459; // SMSPLANET: najwyżej 3 części

// 9 cyfr = numer polski; z prefiksem kraju (+48…, 0044…) zostaje jak jest.
function normalize(phone: string): string | null {
  const raw = phone.trim();
  let d = raw.replace(/\D/g, "");
  if (raw.startsWith("00")) d = d.slice(2);
  if (d.length === 9) return "48" + d;
  if (d.length === 11 && d.startsWith("48")) return d;
  if ((raw.startsWith("+") || raw.startsWith("00")) && d.length >= 10 && d.length <= 15) return d;
  return null;
}

function provider(): "telefon" | "smsplanet" {
  const p = (Deno.env.get("SMS_PROVIDER") || "").trim().toLowerCase();
  if (p === "smsplanet") return "smsplanet";
  if (p === "telefon") return "telefon";
  return Deno.env.get("SMSGATE_USER") && Deno.env.get("SMSGATE_PASS") ? "telefon" : "smsplanet";
}

function sender(): string {
  const from = (Deno.env.get("SMSPLANET_FROM") || "").trim();
  return from && from.toUpperCase() !== "TEST" ? from : "TwojeCialo";
}

// SMS z telefonu studia. Wiadomość czeka w kolejce najwyżej 6 godzin (np. gdy telefon jest bez internetu),
// potem przepada, żeby stara oferta nie przyszła w środku nocy.
async function viaPhone(to: string, msg: string): Promise<string> {
  const user = Deno.env.get("SMSGATE_USER"), pass = Deno.env.get("SMSGATE_PASS");
  if (!user || !pass) throw new Error("Telefon studia: brak sekretów SMSGATE_USER i SMSGATE_PASS w Supabase.");
  const r = await fetch("https://api.sms-gate.app/3rdparty/v1/messages", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${user}:${pass}`), "Content-Type": "application/json" },
    body: JSON.stringify({ textMessage: { text: msg }, phoneNumbers: ["+" + to], ttl: 6 * 3600, withDeliveryReport: true }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || !data.id) {
    const why = r.status === 401 ? "zły login lub hasło bramki" : (data && (data.message || data.error)) || `błąd ${r.status}`;
    throw new Error(`Telefon studia: ${why}`);
  }
  return String(data.id);
}

async function viaSmsplanet(to: string, msg: string, polish: boolean): Promise<string> {
  const token = Deno.env.get("SMSPLANET_TOKEN");
  if (!token) throw new Error("SMSPLANET: brak sekretu SMSPLANET_TOKEN w Supabase.");
  const r = await fetch("https://api2.smsplanet.pl/sms", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ from: sender(), to, msg: msg.slice(0, MAX_SMSPLANET), clear_polish: polish ? "0" : "1" }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || !data.messageId) throw new Error(`SMSPLANET: ${(data && data.errorMsg) || r.status}`);
  return String(data.messageId);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Tylko POST." }, 405);
  if (req.headers.get("x-push-secret") !== Deno.env.get("PUSH_SECRET")) return json({ ok: false, error: "Brak dostępu." }, 403);
  try {
    const body = await req.json().catch(() => ({}));
    const to = normalize(String(body.phone || "").slice(0, 30));
    const msg = String(body.msg || "").trim().slice(0, MAX_PHONE);
    if (!to) return json({ ok: false, error: "Nieprawidłowy numer." }, 400);
    if (!msg) return json({ ok: false, error: "Pusta wiadomość." }, 400);

    const via = provider();
    const messageId = via === "telefon" ? await viaPhone(to, msg) : await viaSmsplanet(to, msg, body.polish === true);
    return json({ ok: true, messageId, via });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
