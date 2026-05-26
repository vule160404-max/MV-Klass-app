// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, accept, x-client-info, prefer, x-supabase-api-version",
  "Access-Control-Max-Age": "86400",
};

const SIGNED_URL_TTL_SECONDS = 900;
const MAX_FILES = 50;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

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

function cleanPrefix(value: unknown) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

function cleanFileName(value: unknown) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim();
}

function normalizeText(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPdfFile(name: string, contentType: unknown) {
  const fileName = String(name || "").trim().toLowerCase();
  const mime = String(contentType || "").trim().toLowerCase();
  return fileName.endsWith(".pdf") && (!mime || mime === "application/pdf");
}

function autoFolderForFile(name: string) {
  const n = normalizeText(name);
  const compact = n.replace(/\s+/g, "");
  if (/\bielts\b/.test(n)) return "ielts";
  if (/\bthpt\b/.test(n)) return "thpt";
  if (/\bvao\s*10\b/.test(n) || compact.includes("vao10")) return "vao 10";
  return "";
}

function objectKeyFor(prefix: string, name: string) {
  const fileName = cleanFileName(name);
  if (!fileName || fileName === "." || fileName === "..") return "";
  const folder = prefix || autoFolderForFile(fileName);
  return [folder, fileName].filter(Boolean).join("/");
}

async function createR2SignedPutUrl(objectKey: string, expiresIn = SIGNED_URL_TTL_SECONDS) {
  const accountId = (Deno.env.get("R2_ACCOUNT_ID") || "").trim();
  const accessKeyId = (Deno.env.get("R2_ACCESS_KEY_ID") || "").trim();
  const secretAccessKey = (Deno.env.get("R2_SECRET_ACCESS_KEY") || "").trim();
  const bucket = (Deno.env.get("R2_BUCKET") || "mvklass-exam-files").trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("R2_NOT_CONFIGURED");
  }

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const path = `/${encodePath(bucket)}/${encodePath(objectKey)}`;
  const params = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(Math.max(1, Math.min(604800, expiresIn)))],
    ["X-Amz-SignedHeaders", "host"],
  ].sort(([ak, av], [bk, bv]) => {
    const a = encodeRfc3986(ak);
    const b = encodeRfc3986(bk);
    return byteCompare(a, b) || byteCompare(encodeRfc3986(av), encodeRfc3986(bv));
  });
  const canonicalQuery = params.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join("&");
  const canonicalRequest = [
    "PUT",
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

async function putR2Object(objectKey: string, file: File) {
  const uploadUrl = await createR2SignedPutUrl(objectKey);
  const res = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`R2_PUT_FAILED_${res.status}${text ? `: ${text.slice(0, 180)}` : ""}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRole) return json({ ok: false, error: "Missing Supabase env" }, 500);

  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return json({ ok: false, error: "Unauthorized" }, 401);

  const service = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await service.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return json({ ok: false, error: "UNAUTHORIZED_USER_TOKEN" }, 401);
  }
  let { data: profile, error: profileErr } = await service
    .from("profiles")
    .select("role,email")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (!profile && userData.user.email) {
    const byEmail = await service
      .from("profiles")
      .select("role,email")
      .eq("email", userData.user.email)
      .maybeSingle();
    profile = byEmail.data;
    profileErr = byEmail.error;
  }
  if (profileErr) {
    return json({ ok: false, error: `PROFILE_LOOKUP_FAILED: ${profileErr.message}` }, 403);
  }
  const role = String(profile?.role || "").trim().toLowerCase();
  if (!profile) {
    return json({ ok: false, error: `PROFILE_NOT_FOUND: ${userData.user.email || userData.user.id}` }, 403);
  }
  if (role !== "admin") {
    return json({ ok: false, error: `ROLE_NOT_ADMIN: ${role || "empty"}` }, 403);
  }

  const url = new URL(req.url);
  const mode = String(url.searchParams.get("mode") || "").trim().toLowerCase();
  if (mode === "proxy-upload") {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ ok: false, error: "Invalid upload form" }, 400);
    }
    const file = form.get("file");
    const prefix = cleanPrefix(form.get("prefix"));
    if (!(file instanceof File)) return json({ ok: false, error: "No file" }, 400);
    const name = cleanFileName(file.name);
    if (!name) return json({ ok: false, error: "Invalid file name" }, 400);
    if (!isPdfFile(name, file.type)) return json({ ok: false, error: `Only PDF files are allowed: ${name}` }, 400);
    if (file.size > MAX_FILE_BYTES) return json({ ok: false, error: `File too large: ${name}` }, 400);
    const objectKey = objectKeyFor(prefix, name);
    if (!objectKey) return json({ ok: false, error: "Invalid object key" }, 400);
    try {
      await putR2Object(objectKey, file);
      return json({ ok: true, name, object_key: objectKey, uploaded_via: "edge_proxy" });
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e || "R2 upload failed") }, 502);
    }
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON payload" }, 400);
  }

  const prefix = cleanPrefix(body?.prefix);
  const files = Array.isArray(body?.files) ? body.files.slice(0, MAX_FILES) : [];
  if (!files.length) return json({ ok: false, error: "No files" }, 400);

  try {
    const uploads = [];
    const seen = new Set<string>();
    for (const item of files) {
      const name = cleanFileName(item?.name);
      const size = Number(item?.size || 0);
      if (!name) return json({ ok: false, error: "Invalid file name" }, 400);
      if (!isPdfFile(name, item?.content_type || item?.contentType)) {
        return json({ ok: false, error: `Only PDF files are allowed: ${name}` }, 400);
      }
      if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) {
        return json({ ok: false, error: `File too large: ${name}` }, 400);
      }
      const objectKey = objectKeyFor(prefix, name);
      if (!objectKey) return json({ ok: false, error: "Invalid object key" }, 400);
      if (seen.has(objectKey)) return json({ ok: false, error: `Duplicate file name: ${name}` }, 400);
      seen.add(objectKey);
      uploads.push({
        name,
        object_key: objectKey,
        upload_url: await createR2SignedPutUrl(objectKey),
        expires_in: SIGNED_URL_TTL_SECONDS,
      });
    }
    return json({ ok: true, uploads });
  } catch (e) {
    const code = String(e?.message || "");
    if (code === "R2_NOT_CONFIGURED") return json({ ok: false, error: "R2 not configured" }, 500);
    return json({ ok: false, error: "Sign failed" }, 500);
  }
});
