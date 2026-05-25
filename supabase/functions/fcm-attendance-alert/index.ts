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
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!tokenResp.ok) throw new Error(await tokenResp.text());
  const j = await tokenResp.json();
  return String(j.access_token || "");
}

async function sendToToken(projectId: string, accessToken: string, token: string, title: string, body: string) {
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        data: { title, body, event: "attendance_alert" },
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

async function sendWebPushToSubscription(sub: AnyObj, title: string, body: string) {
  try {
    await webpush.sendNotification(
      { endpoint: String(sub.endpoint || "").trim(), keys: { p256dh: sanitizeB64uKey(sub.p256dh), auth: sanitizeB64uKey(sub.auth) } },
      JSON.stringify({ title, body, event: "attendance_alert" }),
      { urgency: "high", TTL: 300 },
    );
    return { ok: true, detail: "sent" };
  } catch (e) {
    return { ok: false, detail: String(e || "") };
  }
}

function nowVn() {
  const now = new Date();
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Ho_Chi_Minh", weekday: "short" }).format(now);
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return { nowMin: h * 60 + m, weekday: ({ Mon: "Mon", Tue: "Tue", Wed: "Wed", Thu: "Thu", Fri: "Fri", Sat: "Sat", Sun: "Sun" } as AnyObj)[weekday] || "Mon", ymd };
}

function startMin(slot: AnyObj): number {
  const s = String(slot?.start || "");
  if (!/^\d{2}:\d{2}$/.test(s)) return -1;
  const [h, m] = s.split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

function hm(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
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
  const { nowMin, weekday, ymd } = nowVn();

  const [{ data: defs }, { data: tcRows }, { data: profiles }, { data: attendanceRows }] = await Promise.all([
    supabase.from("class_definitions").select("label,schedule,dashboard_hidden"),
    supabase.from("teacher_classes").select("teacher_id,class_name"),
    supabase.from("profiles").select("id,role"),
    supabase.from("attendance").select("class_name,students(class_name)").eq("date", ymd).limit(20000),
  ]);

  const attended = new Set<string>();
  (attendanceRows || []).forEach((r: AnyObj) => {
    const cls = String(r.class_name || r.students?.class_name || "").trim();
    if (cls) attended.add(cls);
  });

  const lateClasses: Array<{ className: string; startHm: string }> = [];
  (defs || []).forEach((d: AnyObj) => {
    if (isClassPaused(d)) return;
    const cls = String(d.label || "").trim();
    const sch = d.schedule && typeof d.schedule === "object" ? (d.schedule as AnyObj) : {};
    const slot = sch[weekday] as AnyObj;
    const sm = startMin(slot || {});
    if (!cls || sm < 0 || attended.has(cls)) return;
    const diff = nowMin - sm;
    if (diff >= 30 && diff <= 34) lateClasses.push({ className: cls, startHm: hm(sm) });
  });

  if (!lateClasses.length) return Response.json({ ok: true, sent: 0, reason: "NO_LATE_CLASS" });

  const adminIds = new Set((profiles || []).filter((p: AnyObj) => p.role === "admin").map((p: AnyObj) => String(p.id)));
  const profileIds = (profiles || []).map((p: AnyObj) => String(p.id || "")).filter(Boolean);
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
  const teacherByClass = new Map<string, string[]>();
  (tcRows || []).forEach((r: AnyObj) => {
    const cls = String(r.class_name || "").trim();
    const tid = String(r.teacher_id || "").trim();
    if (!cls || !tid) return;
    if (!teacherByClass.has(cls)) teacherByClass.set(cls, []);
    teacherByClass.get(cls)!.push(tid);
  });

  const accessToken = await getGoogleAccessToken();
  const canWebPush = setupWebPush();
  let sent = 0;
  const errors: string[] = [];
  for (const c of lateClasses) {
    const receivers = new Set<string>([...(teacherByClass.get(c.className) || []), ...Array.from(adminIds)]);
    for (const uid of receivers) {
      const title = "⚠️ CẢNH BÁO ĐIỂM DANH";
      const body = `Lớp ${c.className} đã bắt đầu được 30 phút nhưng chưa được điểm danh. Thầy/Cô vui lòng kiểm tra sĩ số và bổ sung điểm danh đầy đủ.`;
      const { error: logErr } = await supabase.from("notification_dispatch_log").insert({
        kind: "attendance_alert",
        target_user_id: uid,
        class_name: c.className,
        slot_date: ymd,
        slot_start: c.startHm,
        title,
        body,
      });
      if (logErr && String(logErr.code || "") === "23505") continue;
      if (logErr) {
        errors.push(`${uid}: log ${logErr.message}`);
        continue;
      }
      const webSubs = canWebPush ? (webByUser.get(uid) || []) : [];
      if (webSubs.length) {
        let webSent = 0;
        for (const web of webSubs) {
          const rs = await sendWebPushToSubscription(web, title, body);
          if (rs.ok) {
            sent += 1;
            webSent += 1;
          }
          else errors.push(`web:${uid}: ${rs.detail}`);
        }
        if (webSent > 0) continue; // Prefer web push when delivery works.
      }
      const tokens = tokenByUser.get(uid) || [];
      for (const token of tokens) {
        const rs = await sendToToken(projectId, accessToken, token, title, body);
        if (rs.ok) sent += 1;
        else errors.push(`${uid}: ${rs.detail}`);
      }
    }
  }

  return Response.json({ ok: true, classes: lateClasses.length, sent, errors });
});
