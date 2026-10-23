// Wysyłka powiadomień push do klientek. Wdrażana w Supabase (Edge Functions).
// Wymaga sekretów: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_SECRET.
import webpush from "npm:web-push@3.6.7";

const base = Deno.env.get("SUPABASE_URL")!;
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const headers = { apikey: key, Authorization: `Bearer ${key}` };

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (req.headers.get("x-push-secret") !== Deno.env.get("PUSH_SECRET")) return new Response("Forbidden", { status: 403 });

  const { card_id, title, body, url } = await req.json();
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT")!, Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);

  const filter = card_id ? `&card_id=eq.${card_id}` : "";
  const res = await fetch(`${base}/rest/v1/push_subscriptions?select=id,endpoint,p256dh,auth${filter}`, { headers });
  const subs = await res.json();
  if (!Array.isArray(subs)) return Response.json({ error: subs }, { status: 500 });

  let sent = 0;
  let removed = 0;
  await Promise.all(subs.map(async (s: { id: number; endpoint: string; p256dh: string; auth: string }) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title, body, url }));
      sent++;
    } catch (e) {
      // 404 / 410 = przeglądarka cofnęła zgodę, usuwamy taką subskrypcję
      if (e.statusCode === 404 || e.statusCode === 410) {
        await fetch(`${base}/rest/v1/push_subscriptions?id=eq.${s.id}`, { method: "DELETE", headers });
        removed++;
      }
    }
  }));
  return Response.json({ sent, removed });
});
