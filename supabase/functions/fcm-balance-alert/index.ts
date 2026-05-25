// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SignJWT, importPKCS8 } from "npm:jose@5";
import webpush from "npm:web-push@3.6.7";

type AnyObj = Record<string, unknown>;

function ts(v: unknown): number {
  const n = Date.parse(String(v || ""));
  return Number.isFinite(n) ? n : 0;
}

function pickRecord(payload: AnyObj): AnyObj {
  const record = payload?.record;
  if (record && typeof record === "object") return record as AnyObj;
  const bodyRecord = payload?.new;
  if (bodyRecord && typeof bodyRecord === "object") return bodyRecord as AnyObj;
  const wrapperRecord = payload?.data && (payload.data as AnyObj)?.record;
  if (wrapperRecord && typeof wrapperRecord === "object") return wrapperRecord as AnyObj;
  return {};
}

function toInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.round(v));
  const n = parseInt(String(v ?? "0"), 10);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function formatVnd(amount: number): string {
  try {
    return new Intl.NumberFormat("en-US").format(amount);
  } catch {
    return `${amount}`;
  }
}

function normalizeNotificationText(v: unknown): string {
  return repairUtf8Mojibake(String(v == null ? "" : v))
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

function repairUtf8Mojibake(input: string): string {
  const s = String(input || "");
  if (!s) return s;
  // Heuristic: common mojibake markers when UTF-8 was decoded as latin-1/windows-1252.
  if (!/[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖÙÚÛÜÝÞß�]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from(Array.from(s).map((ch) => ch.charCodeAt(0) & 0xff));
    const fixed = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return fixed && fixed !== s ? fixed : s;
  } catch (_e) {
    return s;
  }
}

function decodePrivateKey(raw: string, b64: string): string {
  const keyB64 = String(b64 || "").trim();
  let key = "";
  if (keyB64) {
    try {
      key = atob(keyB64);
    } catch (_e) {
      key = "";
    }
  }
  if (!key) key = String(raw || "").trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
  if (!key.includes("-----BEGIN PRIVATE KEY-----") && key.includes("BEGIN PRIVATE KEY")) {
    key = key.replace(/BEGIN PRIVATE KEY/g, "-----BEGIN PRIVATE KEY-----")
      .replace(/END PRIVATE KEY/g, "-----END PRIVATE KEY-----");
  }
  return key;
}

async function getGoogleAccessToken(): Promise<string> {
  const clientEmail = Deno.env.get("FCM_CLIENT_EMAIL") || "";
  const privateKey = decodePrivateKey(
    Deno.env.get("FCM_PRIVATE_KEY") || "",
    Deno.env.get("FCM_PRIVATE_KEY_BASE64") || "",
  );
  if (!clientEmail || !privateKey) throw new Error("Missing FCM service account env");
  const scope = "https://www.googleapis.com/auth/firebase.messaging";

  const nowSec = Math.floor(Date.now() / 1000);
  const claim = {
    iss: clientEmail,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const key = await importPKCS8(privateKey, "RS256");
  const jwt = await new SignJWT(claim)
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .sign(key);

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(12000),
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!tokenResp.ok) {
    const t = await tokenResp.text();
    throw new Error(`OAuth token failed: ${tokenResp.status} ${t}`);
  }
  const j = await tokenResp.json();
  return String(j.access_token || "");
}

async function sendToFcmToken(
  projectId: string,
  accessToken: string,
  token: string,
  title: string,
  body: string,
): Promise<{ ok: boolean; invalidToken: boolean; detail: string }> {
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(12000),
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        data: {
          title,
          body,
          event: "balance_changed",
        },
        webpush: {
          headers: {
            Urgency: "high",
          },
          notification: {
            title,
            body,
            icon: "./assets/center-logo.png",
          },
        },
      },
    }),
  });

  if (resp.ok) return { ok: true, invalidToken: false, detail: "sent" };
  const t = await resp.text();
  const invalid =
    /UNREGISTERED|registration token is not a valid/i.test(t) || resp.status === 404 || resp.status === 400;
  return { ok: false, invalidToken: invalid, detail: `${resp.status} ${t}` };
}

function setupWebPush() {
  const publicKey = String(Deno.env.get("WEB_PUSH_VAPID_PUBLIC_KEY") || "").trim();
  const privateKey = String(Deno.env.get("WEB_PUSH_VAPID_PRIVATE_KEY") || "").trim();
  const subject = String(Deno.env.get("WEB_PUSH_VAPID_SUBJECT") || "mailto:admin@mvklass.local").trim();
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return true;
}

function sanitizeB64uKey(s: unknown): string {
  return String(s ?? "")
    .replace(/[\r\n\u00a0]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

async function sendWebPushToSubscription(sub: AnyObj, title: string, body: string): Promise<{ ok: boolean; invalid: boolean; detail: string }> {
  try {
    const result = await webpush.sendNotification(
      {
        endpoint: String(sub.endpoint || "").trim(),
        keys: {
          p256dh: sanitizeB64uKey(sub.p256dh),
          auth: sanitizeB64uKey(sub.auth),
        },
      },
      JSON.stringify({ title, body, event: "balance_changed" }),
      { urgency: "high", TTL: 300 },
    );
    return { ok: true, invalid: false, detail: String(result?.statusCode || "sent") };
  } catch (e) {
    const msg = String(e || "");
    const invalid = /410|404|expired|unsubscribed|invalid/i.test(msg);
    return { ok: false, invalid, detail: msg };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const projectId = Deno.env.get("FCM_PROJECT_ID") || "";
  if (!supabaseUrl || !serviceRole || !projectId) {
    return new Response("Missing env", { status: 500 });
  }

  let payload: AnyObj = {};
  try {
    payload = (await req.json()) as AnyObj;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const record = pickRecord(payload);
  const studentId = String(record.student_id || "").trim();
  const amountVnd = toInt(record.amount_vnd);
  const prepaidTopupVnd = toInt(record.prepaid_topup_vnd);
  const tuitionAmountVnd = Math.max(0, amountVnd - prepaidTopupVnd);
  const sessionsPaid = toInt(record.sessions_paid);
  if (!studentId) return Response.json({ ok: true, skipped: true, reason: "NO_STUDENT_ID" });

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: studentRows } = await supabase
    .from("students")
    .select("id,name,class_name")
    .eq("id", studentId)
    .limit(1);
  const studentName = normalizeNotificationText(studentRows?.[0]?.name || "Học sinh");
  const className = normalizeNotificationText(
    String(record.class_name || "").trim() || String(studentRows?.[0]?.class_name || "").trim() || "Chưa rõ lớp",
  );
  const title = normalizeNotificationText("🟢 BIẾN ĐỘNG SỐ DƯ");
  const body = normalizeNotificationText(
    `${studentName} đã hoàn thành học phí ${formatVnd(tuitionAmountVnd)} VND cho ${sessionsPaid} buổi của lớp ${className}.` +
      (prepaidTopupVnd > 0 ? ` Dư học phí ${formatVnd(prepaidTopupVnd)} VND đã lưu trả trước.` : ""),
  );

  const { data: adminRows, error: adminErr } = await supabase
    .from("profiles")
    .select("id")
    .eq("role", "admin");
  if (adminErr) return new Response(`Fetch admin profile failed: ${adminErr.message}`, { status: 500 });
  const adminIds = (adminRows || []).map((r: AnyObj) => String(r.id || "")).filter(Boolean);
  if (!adminIds.length) return Response.json({ ok: true, sent: 0, skipped: true, reason: "NO_ADMIN_USER" });

  const { data: tokenRows, error: tokenErr } = await supabase
    .from("user_fcm_tokens")
    .select("user_id,fcm_token,is_active")
    .in("user_id", adminIds)
    .eq("is_active", true);
  if (tokenErr) return new Response(`Fetch FCM token rows failed: ${tokenErr.message}`, { status: 500 });
  const tokenByUser = new Map<string, string[]>();
  (tokenRows || []).forEach((r: AnyObj) => {
    const id = String(r.user_id || "").trim();
    const token = String(r.fcm_token || "").trim();
    if (!id || !token) return;
    if (!tokenByUser.has(id)) tokenByUser.set(id, []);
    const arr = tokenByUser.get(id)!;
    if (!arr.includes(token)) arr.push(token);
  });
  const { data: webRows, error: webErr } = await supabase
    .from("user_web_push_subscriptions")
    .select("user_id,endpoint,p256dh,auth,is_active")
    .in("user_id", adminIds)
    .eq("is_active", true);
  if (webErr) return new Response(`Fetch web push rows failed: ${webErr.message}`, { status: 500 });
  const webByUser = new Map<string, AnyObj[]>();
  (webRows || []).forEach((r: AnyObj) => {
    const id = String(r.user_id || "").trim();
    const endpoint = String(r.endpoint || "").trim();
    const p256dh = String(r.p256dh || "").trim();
    const auth = String(r.auth || "").trim();
    if (!id || !endpoint || !p256dh || !auth) return;
    const sub = { id, endpoint, p256dh, auth };
    if (!webByUser.has(id)) webByUser.set(id, []);
    const arr = webByUser.get(id)!;
    if (!arr.some((x) => String(x.endpoint || "") === endpoint)) arr.push(sub);
  });
  if (!tokenByUser.size && !webByUser.size) {
    return Response.json({ ok: true, sent: 0, skipped: true, reason: "NO_RECEIVER_TOKEN" });
  }

  let accessToken = "";
  try {
    accessToken = await getGoogleAccessToken();
  } catch (e) {
    return new Response(`Cannot get Google access token: ${String(e)}`, { status: 500 });
  }

  let sent = 0;
  const invalidProfileIds: string[] = [];
  const invalidWebEndpoints: string[] = [];
  const errors: string[] = [];
  const canWebPush = setupWebPush();
  const receiverIds = new Set<string>([
    ...Array.from(tokenByUser.keys()),
    ...Array.from(webByUser.keys()),
  ]);
  for (const uid of receiverIds) {
    const webSubs = canWebPush ? (webByUser.get(uid) || []) : [];
    if (webSubs.length) {
      let webSent = 0;
      for (const web of webSubs) {
        try {
          const rs = await sendWebPushToSubscription(web, title, body);
          if (rs.ok) {
            sent += 1;
            webSent += 1;
          }
          else {
            errors.push(`web:${uid}: ${rs.detail}`);
            if (rs.invalid) invalidWebEndpoints.push(String(web.endpoint || ""));
          }
        } catch (e) {
          errors.push(`web:${uid}: ${String(e)}`);
        }
      }
      if (webSent > 0) continue; // Prefer web push when delivery works.
    }
    const tokens = tokenByUser.get(uid) || [];
    for (const token of tokens) {
      try {
        const result = await sendToFcmToken(projectId, accessToken, token, title, body);
        if (result.ok) sent += 1;
        else {
          errors.push(`${uid}: ${result.detail}`);
          if (result.invalidToken) invalidProfileIds.push(uid);
        }
      } catch (e) {
        errors.push(`${uid}: ${String(e)}`);
      }
    }
  }

  if (invalidProfileIds.length) {
    await supabase
      .from("user_fcm_tokens")
      .update({ is_active: false })
      .in("user_id", invalidProfileIds);
  }
  if (invalidWebEndpoints.length) {
    await supabase
      .from("user_web_push_subscriptions")
      .update({ is_active: false })
      .in("endpoint", invalidWebEndpoints);
  }

  return Response.json({
    ok: true,
    title,
    body,
    receivers: receiverIds.size,
    sent,
    invalid_cleared: invalidProfileIds.length,
    errors,
  });
});
