// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SignJWT, importPKCS8 } from "npm:jose@5";
import webpush from "npm:web-push@3.6.7";

type AnyObj = Record<string, unknown>;

function decodePrivateKey(raw: string, b64: string): string {
  const keyB64 = String(b64 || "").trim();
  let key = "";
  if (keyB64) {
    try {
      key = atob(keyB64);
    } catch {
      key = "";
    }
  }
  if (!key) key = String(raw || "").trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
  return key.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

function norm(v: unknown): string {
  return repairUtf8Mojibake(String(v == null ? "" : v))
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

function repairUtf8Mojibake(input: string): string {
  const s = String(input || "");
  if (!s) return s;
  if (!/[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖÙÚÛÜÝÞß�]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from(Array.from(s).map((ch) => ch.charCodeAt(0) & 0xff));
    const fixed = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return fixed && fixed !== s ? fixed : s;
  } catch {
    return s;
  }
}

function getTemplatePayload(tpl: string): { title: string; body: string } {
  const key = String(tpl || "").toLowerCase().trim();
  if (key === "daily") {
    return {
      title: "Lịch hôm nay - Thứ Hai, 27/04",
      body: "Chào buổi sáng Thầy Vũ, hôm nay Thầy/Cô có 3 ca dạy. Lớp sớm nhất: Toán 9A lúc 08:00. Chúc Thầy/Cô một ngày làm việc hiệu quả!",
    };
  }
  if (key === "reminder") {
    return {
      title: "🔔 NHẮC HẸN LỚP HỌC",
      body: "Lớp Toán 9A sẽ bắt đầu sau 20 phút nữa (lúc 18:30). Thầy/Cô vui lòng chuẩn bị vào lớp.",
    };
  }
  if (key === "attendance") {
    return {
      title: "⚠️ CẢNH BÁO ĐIỂM DANH",
      body: "Lớp Toán 9A đã bắt đầu được 30 phút nhưng chưa được điểm danh. Thầy/Cô vui lòng kiểm tra sĩ số và bổ sung điểm danh đầy đủ.",
    };
  }
  if (key === "balance") {
    return {
      title: "🟢 BIẾN ĐỘNG SỐ DƯ",
      body: "Học viên A đã hoàn thành học phí 300,000 VND cho 4 buổi của lớp Toán 9A.",
    };
  }
  return {
    title: "Thông báo mẫu",
    body: "Nội dung mẫu",
  };
}

async function getGoogleAccessToken(): Promise<string> {
  const clientEmail = Deno.env.get("FCM_CLIENT_EMAIL") || "";
  const privateKey = decodePrivateKey(
    Deno.env.get("FCM_PRIVATE_KEY") || "",
    Deno.env.get("FCM_PRIVATE_KEY_BASE64") || "",
  );
  if (!clientEmail || !privateKey) throw new Error("Missing FCM env");
  const nowSec = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(privateKey, "RS256");
  const jwt = await new SignJWT({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600,
  }).setProtectedHeader({ alg: "RS256", typ: "JWT" }).sign(key);

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(12000),
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!tokenResp.ok) throw new Error(await tokenResp.text());
  const j = await tokenResp.json();
  return String(j.access_token || "");
}

async function send(projectId: string, accessToken: string, token: string, title: string, body: string) {
  const titleB64 = btoa(String.fromCharCode(...new TextEncoder().encode(title)));
  const bodyB64 = btoa(String.fromCharCode(...new TextEncoder().encode(body)));
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(12000),
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        data: { title, body, title_b64: titleB64, body_b64: bodyB64, event: "preview_popup" },
        webpush: {
          headers: { Urgency: "high" },
          notification: {
            title,
            body,
            icon: "./assets/center-logo.png",
            badge: "./assets/center-logo.png",
            requireInteraction: false,
          },
        },
      },
    }),
  });
  if (!resp.ok) return { ok: false, detail: `${resp.status} ${await resp.text()}` };
  return { ok: true, detail: "sent" };
}

function setupWebPush() {
  const publicKey = String(Deno.env.get("WEB_PUSH_VAPID_PUBLIC_KEY") || "").trim();
  const privateKey = String(Deno.env.get("WEB_PUSH_VAPID_PRIVATE_KEY") || "").trim();
  const subject = String(Deno.env.get("WEB_PUSH_VAPID_SUBJECT") || "mailto:admin@mvklass.local").trim();
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return true;
}

/** Cắt khoảng trắng / xuống dòng do copy SQL — lỗi mã hóa payload. */
function sanitizeB64uKey(s: unknown): string {
  return String(s ?? "")
    .replace(/[\r\n\u00a0]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

async function sendWebPush(sub: AnyObj, title: string, body: string): Promise<{ ok: boolean; invalid: boolean; detail: string }> {
  const titleB64 = btoa(String.fromCharCode(...new TextEncoder().encode(title)));
  const bodyB64 = btoa(String.fromCharCode(...new TextEncoder().encode(body)));
  const p256dh = sanitizeB64uKey(sub.p256dh);
  const auth = sanitizeB64uKey(sub.auth);
  const endpoint = String(sub.endpoint || "").trim();
  try {
    await webpush.sendNotification(
      { endpoint, keys: { p256dh, auth } },
      JSON.stringify({ title, body, title_b64: titleB64, body_b64: bodyB64, event: "preview_popup" }),
      { urgency: "high", TTL: 300 },
    );
    return { ok: true, invalid: false, detail: "sent" };
  } catch (e) {
    const err = e as { statusCode?: number; body?: string; message?: string };
    const statusCode = typeof err?.statusCode === "number" ? err.statusCode : null;
    const bodySnip = err?.body != null ? String(err.body).slice(0, 200) : "";
    const msg = String(err?.message ?? e ?? "");
    const detail =
      statusCode != null
        ? `HTTP ${statusCode}${bodySnip ? ` — ${bodySnip}` : ""} — ${msg}`
        : msg;
    // 404/410: subscription hết hạn. 403: thường là VAPID server ≠ public key trên app — không deactivate.
    const invalid = statusCode === 404 || statusCode === 410;
    return { ok: false, invalid, detail };
  }
}

function ts(v: unknown): number {
  const n = Date.parse(String(v || ""));
  return Number.isFinite(n) ? n : 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const projectId = Deno.env.get("FCM_PROJECT_ID") || "";
  if (!supabaseUrl || !serviceRole || !projectId) return new Response("Missing env", { status: 500 });

  let payload: AnyObj = {};
  try { payload = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const template = String(payload.template || "").trim();
  const templatePayload = getTemplatePayload(template);
  const title = norm(payload.title || templatePayload.title);
  const body = norm(payload.body || templatePayload.body);

  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: profRows } = await supabase.from("profiles").select("id,role");
  const adminIds = (profRows || [])
    .filter((p: AnyObj) => String(p.role || "").trim().toLowerCase() === "admin")
    .map((p: AnyObj) => String(p.id || ""))
    .filter(Boolean);
  if (!adminIds.length) return Response.json({ ok: true, sent: 0, reason: "NO_ADMIN_USER" });

  // PK: (user_id, endpoint) — không có cột id
  const { data: allWebRows, error: webSelErr } = await supabase
    .from("user_web_push_subscriptions")
    .select("user_id,endpoint,p256dh,auth,device_platform,device_user_agent,updated_at,last_seen_at,created_at")
    .eq("is_active", true);
  if (webSelErr) {
    return Response.json({ ok: false, sent: 0, reason: "WEB_SUB_SELECT_ERROR", detail: String(webSelErr.message || webSelErr) });
  }
  const adminSet = new Set((adminIds || []).map((x) => String(x || "").trim().toLowerCase()));
  const webRows = (allWebRows || []).filter((r: AnyObj) => adminSet.has(String(r.user_id || "").trim().toLowerCase()));

  const pushSub = (m: Map<string, AnyObj[]>, r: AnyObj) => {
    const uid = String(r.user_id || "").trim();
    const endpointRaw = String(r.endpoint || "").trim();
    const p256dh = String(r.p256dh || "").trim();
    const auth = String(r.auth || "").trim();
    if (!uid || !endpointRaw || !p256dh || !auth) return;
    const sub = { userId: uid, endpoint: endpointRaw, p256dh, auth };
    if (!m.has(uid)) m.set(uid, []);
    const arr = m.get(uid)!;
    if (!arr.some((x) => String(x.endpoint || "") === endpointRaw)) arr.push(sub);
  };

  const iosWebSubsByUser = new Map<string, AnyObj[]>();
  (webRows || []).forEach((r: AnyObj) => {
    const id = String(r.user_id || "").trim();
    const endpointRaw = String(r.endpoint || "").trim();
    const p256dh = String(r.p256dh || "").trim();
    const auth = String(r.auth || "").trim();
    if (!id || !endpointRaw || !p256dh || !auth) return;
    const platform = String(r.device_platform || "").toLowerCase();
    const ua = String(r.device_user_agent || "").toLowerCase();
    // iPad (desktop) UA có thể giống Mac; Web Push tới Safari dùng endpoint Apple.
    const isAppleWebPush = /web\.push\.apple\.com|push\.apple\.com/i.test(endpointRaw);
    const isIos =
      isAppleWebPush ||
      /iphone|ipad|ipod|ios/.test(platform) ||
      /iphone|ipad|ipod|ios|crios|fxios/.test(ua);
    if (!isIos) return;
    pushSub(iosWebSubsByUser, r);
  });

  // Nếu có bản ghi cho admin nhưng UA/endpoint lạ nên lọc iOS ra trống — vẫn gửi thử tất cả (preview).
  let targetSubsByUser = iosWebSubsByUser;
  let iosFilterFallback = false;
  if (!iosWebSubsByUser.size && (webRows || []).length) {
    const all = new Map<string, AnyObj[]>();
    (webRows || []).forEach((r) => pushSub(all, r));
    if (all.size) {
      targetSubsByUser = all;
      iosFilterFallback = true;
    }
  }

  if (!(webRows || []).length) {
    return Response.json({ ok: true, sent: 0, reason: "NO_WEB_PUSH_SUB_FOR_ADMIN" });
  }
  if (!targetSubsByUser.size) {
    return Response.json({ ok: true, sent: 0, reason: "NO_VALID_WEB_PUSH_FIELDS" });
  }

  const receiverIds = new Set<string>(Array.from(targetSubsByUser.keys()));
  const canWebPush = setupWebPush();
  if (!canWebPush) {
    return Response.json({
      ok: false,
      sent: 0,
      version: "preview-v14",
      reason: "MISSING_WEB_PUSH_VAPID",
      hint: "Cấu hình secrets: WEB_PUSH_VAPID_PUBLIC_KEY / PRIVATE_KEY / SUBJECT. Public key phải trùng vapidKey trong firebase-config.js.",
      receivers: receiverIds.size,
    });
  }
  let sent = 0;
  const errors: string[] = [];
  const invalidPairs: { userId: string; endpoint: string }[] = [];
  for (const uid of receiverIds) {
    const webSubs = targetSubsByUser.get(uid) || [];
    for (const web of webSubs) {
      const rs = await sendWebPush(web, title, body);
      if (rs.ok) sent += 1;
      else {
        errors.push(`web:${uid}: ${rs.detail}`);
        if (rs.invalid && web.userId && web.endpoint) {
          invalidPairs.push({ userId: String(web.userId), endpoint: String(web.endpoint) });
        }
      }
    }
  }
  const seen = new Set<string>();
  for (const p of invalidPairs) {
    const k = p.userId + "\0" + p.endpoint;
    if (seen.has(k)) continue;
    seen.add(k);
    await supabase
      .from("user_web_push_subscriptions")
      .update({ is_active: false })
      .eq("user_id", p.userId)
      .eq("endpoint", p.endpoint);
  }
  const hint403 = errors.some((s) => /HTTP 403\b/.test(String(s)));
  return Response.json({
    ok: true,
    version: "preview-v14",
    sent,
    receivers: receiverIds.size,
    title,
    body,
    errors,
    iosFilterFallback,
    ...(hint403
      ? {
        vapidHint:
          "HTTP 403 từ Apple thường do cặp VAPID trên Supabase không trùng public key trong firebase-config.js (hoặc subscription tạo bằng key cũ). Đồng bộ key, deploy lại web, rồi mở app iPhone để subscribe lại.",
      }
      : {}),
  });
});
