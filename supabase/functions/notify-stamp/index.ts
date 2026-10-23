// Powiadomienie dla klientki po dodaniu pieczątki. Wywoływane z panelu właścicielki.
// Wymaga zalogowanej osoby z tabeli staff (sprawdzane przez is_staff z jej tokenem).
// Wymaga sekretów: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
import webpush from "npm:web-push@3.6.7";

const base = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const staffRes = await fetch(`${base}/rest/v1/rpc/is_staff`, {
    method: "POST",
    headers: { apikey: anon, Authorization: req.headers.get("Authorization") ?? "", "Content-Type": "application/json" },
    body: "{}",
  });
  if ((await staffRes.json()) !== true) return json({ error: "Forbidden" }, 403);

  const { card_id, stamps } = await req.json();
  if (!card_id || typeof stamps !== "number") return json({ error: "Bad request" }, 400);

  const title = "Dodano pieczątkę";
  const body = stamps >= 10
    ? "Karta pełna (10/10). Dziękuję za wizyty!"
    : stamps === 5
      ? "Masz 5/10 pieczątek. Piąty rytuał z rabatem −15%."
      : `Masz ${stamps}/10 pieczątek.`;

  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT")!, Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);

  const headers = { apikey: service, Authorization: `Bearer ${service}` };
  const res = await fetch(`${base}/rest/v1/push_subscriptions?select=id,endpoint,p256dh,auth&card_id=eq.${encodeURIComponent(card_id)}`, { headers });
  const subs = await res.json();
  if (!Array.isArray(subs)) return json({ error: subs }, 500);

  let sent = 0;
  let removed = 0;
  await Promise.all(subs.map(async (s: { id: number; endpoint: string; p256dh: string; auth: string }) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title, body, url: "https://karta.twojecialotwojdobrostan.pl/" }));
      sent++;
    } catch (e) {
      // 404 / 410 = przeglądarka cofnęła zgodę, usuwamy taką subskrypcję
      if (e.statusCode === 404 || e.statusCode === 410) {
        await fetch(`${base}/rest/v1/push_subscriptions?id=eq.${s.id}`, { method: "DELETE", headers });
        removed++;
      }
    }
  }));
  return json({ sent, removed });
});
