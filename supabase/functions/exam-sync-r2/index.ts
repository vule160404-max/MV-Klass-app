// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, accept, x-client-info, prefer, x-supabase-api-version",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    },
  });
}

function encodeRfc3986(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function encodePath(value: string) {
  return String(value || "")
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeRfc3986)
    .join("/");
}

function byteCompare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bytesToHex(buf: ArrayBuffer) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value: string) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, value: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
}

async function r2SigningKey(secret: string, date: string) {
  const kDate = await hmacSha256(new TextEncoder().encode("AWS4" + secret), date);
  const kRegion = await hmacSha256(kDate, "auto");
  const kService = await hmacSha256(kRegion, "s3");
  return await hmacSha256(kService, "aws4_request");
}

async function signR2Url(method: string, bucket: string, queryPairs: string[][] = []) {
  const accountId = (Deno.env.get("R2_ACCOUNT_ID") || "").trim();
  const accessKeyId = (Deno.env.get("R2_ACCESS_KEY_ID") || "").trim();
  const secretAccessKey = (Deno.env.get("R2_SECRET_ACCESS_KEY") || "").trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("R2_NOT_CONFIGURED");
  }
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const path = `/${encodePath(bucket)}`;
  const params = [
    ...queryPairs,
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", "300"],
    ["X-Amz-SignedHeaders", "host"],
  ].sort(([ak, av], [bk, bv]) => {
    const a = encodeRfc3986(ak);
    const b = encodeRfc3986(bk);
    return byteCompare(a, b) || byteCompare(encodeRfc3986(av), encodeRfc3986(bv));
  });
  const canonicalQuery = params.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join("&");
  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    `host:${host}`,
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = await r2SigningKey(secretAccessKey, dateStamp);
  const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function decodeXml(s: string) {
  return String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function xmlValues(xml: string, tag: string) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(decodeXml(m[1]));
  return out;
}

async function listR2Keys(prefix = "") {
  const bucket = (Deno.env.get("R2_BUCKET") || "mvklass-exam-files").trim();
  const keys: string[] = [];
  let token = "";
  do {
    const query = [["list-type", "2"]];
    if (prefix) query.push(["prefix", prefix]);
    if (token) query.push(["continuation-token", token]);
    const url = await signR2Url("GET", bucket, query);
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) throw new Error(`R2_LIST_FAILED_${res.status}`);
    keys.push(...xmlValues(text, "Key").filter((k) => k && !k.endsWith("/")));
    token = xmlValues(text, "NextContinuationToken")[0] || "";
  } while (token);
  return Array.from(new Set(keys)).sort((a, b) => a.localeCompare(b));
}

function normalizeText(value: string) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/Ä‘/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stem(key: string) {
  return String(key || "").split("/").pop()!.replace(/\.[^.]+$/, "");
}

function guessCategory(key: string) {
  const n = normalizeText(key);
  if (/\b(dap an|answer)\b/.test(n)) return "answer";
  if (/\b(audio|listening|nghe)\b/.test(n)) return "audio";
  if (/\b(chuyen de|topic)\b/.test(n)) return "topic";
  return "exam";
}

function guessLevel(key: string) {
  const n = normalizeText(key);
  if (/\bielts\b/.test(n)) return "ielts";
  return /\b(thpt|qg|dai hoc|university|12)\b/.test(n) ? "university" : "entrance_10";
}

function guessYear(key: string) {
  const m = String(key || "").match(/20\d{2}/);
  return m ? Number(m[0]) : null;
}

function guessCode(key: string) {
  const n = normalizeText(stem(key));
  if (/\b(chinh thuc|official)\b/.test(n)) return "CHINH_THUC";
  const series = n.match(/\bde\s+([a-z]{2,10})\s*0*(\d{1,4})\b/);
  if (series) return `${series[1].toUpperCase()}${String(Number(series[2])).padStart(3, "0")}`;
  const m = n.match(/\bde\s*([a-z]{1,10}\d{1,4}|\d{1,3})\b/);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? String(Number(m[1])).padStart(3, "0") : m[1].toUpperCase().replace(/([A-Z]+)0*(\d+)$/, (_, p, d) => `${p}${String(Number(d)).padStart(3, "0")}`);
}

function guessSortOrder(key: string) {
  const code = guessCode(key);
  const raw = String(code || "");
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/(\d{1,4})$/);
  return m ? Number(m[1]) : null;
}

function displayProvince(value: string) {
  const key = normalizeText(value);
  const map: Record<string, string> = {
    "ha noi": "HÃ  Ná»™i",
    "tp hcm": "TP HCM",
    "ho chi minh": "TP HCM",
    "thanh hoa": "Thanh HÃ³a",
    "nghe an": "Nghá»‡ An",
    "ha tinh": "HÃ  TÄ©nh",
    "da nang": "ÄÃ  Náºµng",
    "hai phong": "Háº£i PhÃ²ng",
    "quang ninh": "Quáº£ng Ninh",
    "bac ninh": "Báº¯c Ninh",
    "bac giang": "Báº¯c Giang",
    "nam dinh": "Nam Äá»‹nh",
    "thai binh": "ThÃ¡i BÃ¬nh",
    "ninh binh": "Ninh BÃ¬nh",
    "hai duong": "Háº£i DÆ°Æ¡ng",
    "hung yen": "HÆ°ng YÃªn",
    "vinh phuc": "VÄ©nh PhÃºc",
    "phu tho": "PhÃº Thá»",
    "nguon tong hop": "Nguá»“n tá»•ng há»£p",
    "tong hop": "Nguá»“n tá»•ng há»£p",
  };
  return map[key] || "";
}

function guessProvince(key: string) {
  const code = normalizeText(guessCode(key) || "");
  let n = normalizeText(stem(key))
    .replace(/\b(dap an|answer|audio|listening|nghe|de|chinh thuc|official|vao|10|thpt|qg|dai hoc|university)\b/g, " ")
    .replace(/\b20\d{2}\b/g, " ");
  if (code) n = n.replace(new RegExp(`\\b${code}\\b`, "g"), " ");
  n = n.replace(/\s+/g, " ").trim();
  return displayProvince(n) || null;
}

function prettyTitle(key: string) {
  const category = guessCategory(key);
  const prefix = category === "answer" ? "ÄÃ¡p Ã¡n Ä‘á»" : category === "audio" ? "Audio Ä‘á»" : "Äá»";
  const code = guessCode(key);
  const level = guessLevel(key) === "university" ? "THPT" : "VÃ o 10";
  const province = guessProvince(key);
  const year = guessYear(key);
  const parts = [prefix, code, level, province, year].filter(Boolean);
  return parts.length > 2 ? parts.join(" ") : stem(key) || "TÃ i liá»‡u Tiáº¿ng Anh";
}

function guessSource(key: string) {
  const n = normalizeText(stem(key));
  if (/\b(vu mai phuong|vmp)\b/.test(n)) return "VÅ© Mai PhÆ°Æ¡ng";
  return null;
}

function titleCode(code: string | null) {
  const raw = String(code || "").trim();
  const m = raw.match(/^([A-Z]{2,10})0*(\d{1,4})$/);
  return m ? `${m[1]} ${String(Number(m[2])).padStart(3, "0")}` : raw;
}

function prettyTitleClean(key: string) {
  const category = guessCategory(key);
  const prefix = category === "answer" ? "ÄÃ¡p Ã¡n Ä‘á»" : category === "audio" ? "Audio Ä‘á»" : "Äá»";
  const code = guessCode(key);
  const levelKey = guessLevel(key);
  const level = levelKey === "university" ? "THPT" : (levelKey === "ielts" ? "IELTS" : "VÃ o 10");
  const source = guessProvince(key) || guessSource(key);
  const year = guessYear(key);
  const parts = [prefix, titleCode(code), level, source, year].filter(Boolean);
  return parts.length > 2 ? parts.join(" ") : stem(key) || "TÃ i liá»‡u Tiáº¿ng Anh";
}

function matchKey(key: string) {
  return normalizeText(stem(key))
    .replace(/\b(dap an|answer|audio|listening|nghe)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function accessTier(key: string, category: string) {
  const n = normalizeText(key);
  return n.includes("free") && category !== "topic" ? "free" : "premium";
}

function description(level: string) {
  if (level === "ielts") return "De luyen thi IELTS mon Tieng Anh.";
  return level === "university"
    ? "De luyen thi THPT mon Tieng Anh."
    : "De luyen thi Vao 10 mon Tieng Anh.";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anonKey || !serviceRole) return json({ ok: false, error: "Missing Supabase env" }, 500);

  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return json({ ok: false, error: "Unauthorized" }, 401);

  const service = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await service.auth.getUser(token);
  if (userErr || !userData?.user?.id) return json({ ok: false, error: "Unauthorized" }, 401);
  const { data: profile, error: profileErr } = await service
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileErr || String(profile?.role || "") !== "admin") {
    return json({ ok: false, error: "Admin required" }, 403);
  }

  let body: any = {};
  try { body = await req.json(); } catch {}
  const dryRun = body?.dry_run === true;
  const pruneMissing = body?.prune_missing !== false;
  const prefix = String(body?.prefix || "").replace(/^\/+/, "");

  const keys = await listR2Keys(prefix);
  const currentKeys = new Set(keys);
  const grouped = new Map<string, any>();
  for (const key of keys) {
    const mk = matchKey(key);
    if (!grouped.has(mk)) grouped.set(mk, { main: [], answer: [], audio: [] });
    const g = grouped.get(mk);
    const category = guessCategory(key);
    if (category === "answer") g.answer.push(key);
    else if (category === "audio") g.audio.push(key);
    else g.main.push(key);
  }

  let synced = 0;
  const previews: any[] = [];
  for (const g of grouped.values()) {
    for (const key of g.main) {
      const category = guessCategory(key);
      const level = guessLevel(key);
      const payload = {
        title: prettyTitleClean(key),
        level,
        subject: "english",
        year: guessYear(key),
        province: guessProvince(key) || guessSource(key),
        category,
        file_url: null,
        description: description(level),
        storage_provider: "r2",
        object_key: key,
        answer_object_key: g.answer[0] || null,
        audio_object_key: g.audio[0] || null,
        access_tier: accessTier(key, category),
        exam_code: guessCode(key),
        exam_sort_order: guessSortOrder(key),
        is_published: true,
      };
      previews.push({ action: "upsert", object_key: key, title: payload.title });
      if (!dryRun) {
        const { data: existing, error: findErr } = await service
          .from("exam_files")
          .select("id")
          .eq("object_key", key)
          .maybeSingle();
        if (findErr) return json({ ok: false, error: findErr.message }, 500);
        const res = existing?.id
          ? await service.from("exam_files").update(payload).eq("id", existing.id)
          : await service.from("exam_files").insert(payload);
        if (res.error) return json({ ok: false, error: res.error.message }, 500);
      }
      synced += 1;
    }
  }

  let unpublished = 0;
  if (pruneMissing) {
    let query = service
      .from("exam_files")
      .select("id,title,object_key")
      .eq("storage_provider", "r2")
      .eq("is_published", true);
    if (prefix) query = query.like("object_key", `${prefix}%`);
    const { data: rows, error } = await query;
    if (error) return json({ ok: false, error: error.message }, 500);
    for (const row of rows || []) {
      const key = String(row.object_key || "");
      if (key && !currentKeys.has(key)) {
        previews.push({ action: "unpublish", object_key: key, title: row.title });
        if (!dryRun) {
          const { error: updErr } = await service
            .from("exam_files")
            .update({ is_published: false })
            .eq("id", row.id);
          if (updErr) return json({ ok: false, error: updErr.message }, 500);
        }
        unpublished += 1;
      }
    }
  }

  return json({
    ok: true,
    dry_run: dryRun,
    object_count: keys.length,
    synced,
    unpublished,
    preview: previews.slice(0, 30),
  });
});
