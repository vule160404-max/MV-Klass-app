// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SignJWT, importPKCS8 } from "npm:jose@5";
import webpush from "npm:web-push@3.6.7";

type AnyObj = Record<string, unknown>;

function ts(v: unknown): number {
  const n = Date.parse(String(v || ""));
  return Number.isFinite(n) ? n : 0;
}

function decodePrivateKey(raw: string): string {
  let key = String(raw || "").trim();
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
  const privateKey = decodePrivateKey(Deno.env.get("FCM_PRIVATE_KEY") || "");
  if (!clientEmail || !privateKey) throw new Error("Missing FCM service account env");
  const nowSec = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(privateKey, "RS256");
  const jwt = await new SignJWT({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .sign(key);

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!tokenResp.ok) throw new Error(await tokenResp.text());
  const j = await tokenResp.json();
  return String(j.access_token || "");
}

async function sendToToken(projectId: string, accessToken: string, token: string, title: string, body: string, event: string) {
  const titleB64 = btoa(String.fromCharCode(...new TextEncoder().encode(title)));
  const bodyB64 = btoa(String.fromCharCode(...new TextEncoder().encode(body)));
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        data: { title, body, title_b64: titleB64, body_b64: bodyB64, event },
        webpush: {
          headers: { Urgency: "high" },
          notification: { title, body, icon: "./assets/center-logo.png" },
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

function sanitizeB64uKey(s: unknown): string {
  return String(s ?? "")
    .replace(/[\r\n\u00a0]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

async function sendWebPushToSubscription(sub: AnyObj, title: string, body: string, event: string) {
  const titleB64 = btoa(String.fromCharCode(...new TextEncoder().encode(title)));
  const bodyB64 = btoa(String.fromCharCode(...new TextEncoder().encode(body)));
  try {
    await webpush.sendNotification(
      { endpoint: String(sub.endpoint || "").trim(), keys: { p256dh: sanitizeB64uKey(sub.p256dh), auth: sanitizeB64uKey(sub.auth) } },
      JSON.stringify({ title, body, title_b64: titleB64, body_b64: bodyB64, event }),
      { urgency: "high", TTL: 300 },
    );
    return { ok: true, invalid: false, detail: "sent" };
  } catch (e) {
    const msg = String(e || "");
    return { ok: false, invalid: /410|404|expired|unsubscribed|invalid/i.test(msg), detail: msg };
  }
}

function nowInVn() {
  const now = new Date();
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Ho_Chi_Minh", weekday: "short" }).format(now);
  const dateLabel = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  }).format(now);
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return { weekdayMap: { Mon: "Mon", Tue: "Tue", Wed: "Wed", Thu: "Thu", Fri: "Fri", Sat: "Sat", Sun: "Sun" }[weekday] || "Mon", dateLabel, ymd };
}

function parseStartMin(slot: AnyObj): number {
  const start = String(slot?.start || "").trim();
  if (!/^\d{2}:\d{2}$/.test(start)) return -1;
  const [h, m] = start.split(":").map((x) => parseInt(x, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
  return h * 60 + m;
}

function hm(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function isClassPaused(row: AnyObj): boolean {
  return row?.dashboard_hidden === true || String(row?.dashboard_hidden || "").toLowerCase() === "true";
}

Deno.serve(async () => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const projectId = Deno.env.get("FCM_PROJECT_ID") || "";
  if (!supabaseUrl || !serviceRole || !projectId) return new Response("Missing env", { status: 500 });

  const supabase = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const { weekdayMap, dateLabel, ymd } = nowInVn();

  const [{ data: defs }, { data: tcRows }] = await Promise.all([
    supabase.from("class_definitions").select("label,schedule,dashboard_hidden"),
    supabase.from("teacher_classes").select("teacher_id,class_name"),
  ]);
  let profiles: AnyObj[] = [];
  let profRes = await supabase.from("profiles").select("id,role,display_name");
  if (profRes.error && /display_name/i.test(String(profRes.error.message || ""))) {
    profRes = await supabase.from("profiles").select("id,role");
  }
  profiles = Array.isArray(profRes.data) ? profRes.data : [];
  const profileIds = profiles.map((p: AnyObj) => String(p.id || "")).filter(Boolean);
  const { data: tokenRows } = await supabase
    .from("user_fcm_tokens")
    .select("user_id,fcm_token,is_active")
    .in("user_id", profileIds)
    .eq("is_active", true);
  const tokenByUser = new Map<string, string[]>();
  (tokenRows || []).forEach((r: AnyObj) => {
    const uid = String(r.user_id || "");
    const tk = String(r.fcm_token || "").trim();
    if (!uid || !tk) return;
    if (!tokenByUser.has(uid)) tokenByUser.set(uid, []);
    const arr = tokenByUser.get(uid)!;
    if (!arr.includes(tk)) arr.push(tk);
  });
  const { data: webRows } = await supabase
    .from("user_web_push_subscriptions")
    .select("user_id,endpoint,p256dh,auth,is_active")
    .in("user_id", profileIds)
    .eq("is_active", true);
  const webByUser = new Map<string, AnyObj[]>();
  (webRows || []).forEach((r: AnyObj) => {
    const uid = String(r.user_id || "");
    const endpoint = String(r.endpoint || "").trim();
    const p256dh = String(r.p256dh || "").trim();
    const auth = String(r.auth || "").trim();
    if (!uid || !endpoint || !p256dh || !auth) return;
    const sub = { user_id: uid, endpoint, p256dh, auth };
    if (!webByUser.has(uid)) webByUser.set(uid, []);
    const arr = webByUser.get(uid)!;
    if (!arr.some((x) => String(x.endpoint || "") === endpoint)) arr.push(sub);
  });

  const classSlot = new Map<string, number>();
  (defs || []).forEach((d: AnyObj) => {
    if (isClassPaused(d)) return;
    const cls = String(d.label || "").trim();
    const schedule = d.schedule && typeof d.schedule === "object" ? (d.schedule as AnyObj) : {};
    const slot = schedule[weekdayMap] as AnyObj;
    const startMin = parseStartMin(slot || {});
    if (cls && startMin >= 0) classSlot.set(cls, startMin);
  });

  const teacherClassMap = new Map<string, string[]>();
  (tcRows || []).forEach((r: AnyObj) => {
    const tid = String(r.teacher_id || "").trim();
    const cls = String(r.class_name || "").trim();
    if (!tid || !cls || !classSlot.has(cls)) return;
    if (!teacherClassMap.has(tid)) teacherClassMap.set(tid, []);
    teacherClassMap.get(tid)!.push(cls);
  });

  const admins = (profiles || []).filter((p: AnyObj) => String(p.role || "") === "admin");
  const teachers = (profiles || []).filter((p: AnyObj) => String(p.role || "") === "teacher");

  const notifications: Array<{ userId: string; title: string; body: string; className: string; startHm: string }> = [];

  teachers.forEach((t: AnyObj) => {
    const uid = String(t.id || "");
    const hasToken = (tokenByUser.get(uid) || []).length > 0;
    const hasWeb = (webByUser.get(uid) || []).length > 0;
    const classes = (teacherClassMap.get(uid) || []).slice().sort((a, b) => (classSlot.get(a)! - classSlot.get(b)!));
    if (!uid || (!hasToken && !hasWeb) || !classes.length) return;
    const firstCls = classes[0];
    const firstTime = hm(classSlot.get(firstCls)!);
    const displayName = String(t.display_name || "Thầy/Cô");
    notifications.push({
      userId: uid,
      title: `Lịch hôm nay - ${dateLabel}`,
      body: `Chào buổi sáng ${displayName}, hôm nay Thầy/Cô có ${classes.length} ca dạy. Lớp sớm nhất: ${firstCls} lúc ${firstTime}. Chúc Thầy/Cô một ngày làm việc hiệu quả!`,
      className: firstCls,
      startHm: firstTime,
    });
  });

  if (admins.length) {
    const allClasses = Array.from(classSlot.keys()).sort((a, b) => (classSlot.get(a)! - classSlot.get(b)!));
    if (allClasses.length) {
      const firstCls = allClasses[0];
      const firstTime = hm(classSlot.get(firstCls)!);
      admins.forEach((a: AnyObj) => {
        const uid = String(a.id || "");
        const hasToken = (tokenByUser.get(uid) || []).length > 0;
        const hasWeb = (webByUser.get(uid) || []).length > 0;
        const displayName = String(a.display_name || "Thầy/Cô");
        if (!uid || (!hasToken && !hasWeb)) return;
        notifications.push({
          userId: uid,
          title: `Lịch hôm nay - ${dateLabel}`,
          body: `Chào buổi sáng ${displayName}, hôm nay Thầy/Cô có ${allClasses.length} ca dạy. Lớp sớm nhất: ${firstCls} lúc ${firstTime}. Chúc Thầy/Cô một ngày làm việc hiệu quả!`,
          className: firstCls,
          startHm: firstTime,
        });
      });
    }
  }

  if (!notifications.length) return Response.json({ ok: true, sent: 0, reason: "NO_NOTIFICATION_TARGET" });

  const accessToken = await getGoogleAccessToken();
  const canWebPush = setupWebPush();
  let sent = 0;
  const errors: string[] = [];
  for (const n of notifications) {
    const logKey = {
      kind: "daily_summary",
      target_user_id: n.userId,
      class_name: n.className,
      slot_date: ymd,
      slot_start: n.startHm,
      title: n.title,
      body: n.body,
    };
    const { error: logErr } = await supabase.from("notification_dispatch_log").insert(logKey);
    if (logErr && String(logErr.code || "") === "23505") continue;
    if (logErr) {
      errors.push(`${n.userId}: log ${logErr.message}`);
      continue;
    }
    const webSubs = canWebPush ? (webByUser.get(n.userId) || []) : [];
    if (webSubs.length) {
      let webSent = 0;
      for (const web of webSubs) {
        const rs = await sendWebPushToSubscription(web, n.title, n.body, "daily_schedule");
        if (rs.ok) {
          sent += 1;
          webSent += 1;
        }
        else errors.push(`web:${n.userId}: ${rs.detail}`);
      }
      if (webSent > 0) continue; // Prefer web push when delivery works.
    }
    const tokens = tokenByUser.get(n.userId) || [];
    for (const token of tokens) {
      const rs = await sendToToken(projectId, accessToken, token, n.title, n.body, "daily_schedule");
      if (rs.ok) sent += 1;
      else errors.push(`${n.userId}: ${rs.detail}`);
    }
  }

  return Response.json({ ok: true, total: notifications.length, sent, errors });
});
