// 효도비서 웹 푸시
//  - {action:"vapid"}            : 보호자 폰이 구독할 때 쓰는 공개 키
//  - {action:"test", token}      : 보호자 폰으로 테스트 알림 보내기
//  - {action:"cron"} + x-cron-secret : 5분마다 pg_cron 이 호출. 약 미응답 알림 발송
// VAPID 키와 cron 비밀값은 Supabase Vault 에만 있다. 처음 호출 때 VAPID 키를 만들어 Vault 에 저장한다.
import webpush from "npm:web-push@3.6.7";
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
const SUBJECT = "https://minkwan9999.github.io/hyodo-biseo/";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

let keys: { publicKey: string; privateKey: string } | null = null;
async function vapid() {
  if (keys) return keys;
  const rows = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'hyodo_vapid'`;
  if (rows.length) {
    keys = JSON.parse(rows[0].decrypted_secret);
  } else {
    keys = webpush.generateVAPIDKeys();
    await sql`select vault.create_secret(${JSON.stringify(keys)}, 'hyodo_vapid', '효도비서 웹 푸시 VAPID 키')`;
  }
  webpush.setVapidDetails(SUBJECT, keys!.publicKey, keys!.privateKey);
  return keys!;
}

type Payload = { title: string; body: string; tag?: string; url?: string };

async function sendTo(householdId: string, payload: Payload) {
  const subs = await sql`select id, endpoint, p256dh, auth from hyodo.push_subs where household_id = ${householdId}`;
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 3 * 3600, urgency: "high" },
      );
      sent++;
      await sql`update hyodo.push_subs set last_ok = now() where id = ${s.id}`;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // 404/410: 보호자가 알림을 끄거나 앱을 지움 → 등록 정보 정리
      if (code === 404 || code === 410) await sql`delete from hyodo.push_subs where id = ${s.id}`;
      else console.error("push failed", code, (e as Error).message);
    }
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: { action?: string; token?: string } = {};
  try { body = await req.json(); } catch { /* 빈 본문 */ }

  try {
    const k = await vapid();

    if (body.action === "vapid") return json({ publicKey: k.publicKey });

    if (body.action === "test") {
      const rows = await sql`select id from hyodo.households where guardian_token = ${body.token ?? ""}`;
      if (!rows.length) return json({ error: "invalid_token" }, 401);
      const sent = await sendTo(rows[0].id, { title: "효도비서", body: "알림이 잘 와요. 약을 안 드시면 이렇게 알려 드릴게요.", tag: "test" });
      return json({ sent });
    }

    if (body.action === "cron") {
      const [s] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'hyodo_cron_secret'`;
      if (!s || req.headers.get("x-cron-secret") !== s.decrypted_secret) return json({ error: "forbidden" }, 403);
      const alerts = await sql`select * from hyodo.claim_missed_alerts()`;
      let sent = 0;
      for (const a of alerts) {
        sent += await sendTo(a.household_id, {
          title: "약 안 드심 · " + a.elder_name + " 님",
          body: a.labels + "을 30분 넘게 안 드셨어요. 전화해 보시겠어요?",
          tag: "miss-" + a.med_time,
        });
      }
      return json({ alerts: alerts.length, sent });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
});
