// Wysyłka jednego SMS przez SMSPLANET. Wywołuje ją tylko baza (życzenia urodzinowe), nie aplikacja.
// Ustawienia funkcji: Verify JWT wyłączone; dostęp tylko z nagłówkiem x-push-secret (ten sam sekret co send-push).
// Korzysta z sekretów, które już są: SMSPLANET_TOKEN, PUSH_SECRET. Nadawca: SMSPLANET_FROM, a gdy go nie ma
// albo jest jeszcze testowy „TEST”, zatwierdzona nazwa TwojeCialo.
//
// Body (POST): { phone, msg, polish? } → { ok: true, messageId } albo { ok: false, error }
// polish: true = z polskimi znakami (część SMS ma wtedy 70 znaków), inaczej litery bez ogonków (160 znaków).

const json = (body: unknown, status = 200) => Response.json(body, { status });

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

function sender(): string {
  const from = (Deno.env.get("SMSPLANET_FROM") || "").trim();
  return from && from.toUpperCase() !== "TEST" ? from : "TwojeCialo";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Tylko POST." }, 405);
  if (req.headers.get("x-push-secret") !== Deno.env.get("PUSH_SECRET")) return json({ ok: false, error: "Brak dostępu." }, 403);
  try {
    const body = await req.json().catch(() => ({}));
    const to = normalize(String(body.phone || "").slice(0, 30));
    const msg = String(body.msg || "").trim().slice(0, 459); // najwyżej 3 części SMS
    if (!to) return json({ ok: false, error: "Nieprawidłowy numer." }, 400);
    if (!msg) return json({ ok: false, error: "Pusta wiadomość." }, 400);

    const token = Deno.env.get("SMSPLANET_TOKEN");
    if (!token) throw new Error("Brak sekretu SMSPLANET_TOKEN w Supabase.");
    const r = await fetch("https://api2.smsplanet.pl/sms", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ from: sender(), to, msg, clear_polish: body.polish === true ? "0" : "1" }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.messageId) throw new Error(`SMSPLANET: ${(data && data.errorMsg) || r.status}`);
    return json({ ok: true, messageId: data.messageId });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
