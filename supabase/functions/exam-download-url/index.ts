// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, accept, x-client-info, prefer, x-supabase-api-version",
  "Access-Control-Max-Age": "86400",
};

const SIGNED_URL_TTL_SECONDS = 300;

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

function pickFileField(kind: string) {
  if (kind === "answer") {
    return {
      objectKey: "answer_object_key",
      storagePath: "answer_path",
      legacyUrl: "answer_url",
    };
  }
  if (kind === "audio") {
    return {
      objectKey: "audio_object_key",
      storagePath: "audio_path",
      legacyUrl: "audio_url",
    };
  }
  return {
    objectKey: "object_key",
    storagePath: "storage_path",
    legacyUrl: "file_url",
  };
}

function safeHttpUrl(value: unknown) {
  const s = String(value || "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
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

function byteCompare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function contentDispositionAttachment(fileName: string) {
  const fallback = String(fileName || "tai-lieu")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .trim() || "tai-lieu";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc3986(fileName || fallback)}`;
}

function contentDispositionInline(fileName: string) {
  const fallback = String(fileName || "tai-lieu")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .trim() || "tai-lieu";
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeRfc3986(fileName || fallback)}`;
}

async function createR2SignedGetUrl(
  objectKey: string,
  fileName: string,
  disposition = "attachment",
  expiresIn = SIGNED_URL_TTL_SECONDS,
) {
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
  const credential = `${accessKeyId}/${scope}`;
  const path = `/${encodePath(bucket)}/${encodePath(objectKey)}`;
  const dispositionValue = disposition === "inline"
    ? contentDispositionInline(fileName || objectKey.split("/").pop() || "tai-lieu")
    : contentDispositionAttachment(fileName || objectKey.split("/").pop() || "tai-lieu");
  const params = [
    ["response-content-disposition", dispositionValue],
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", credential],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(Math.max(1, Math.min(604800, expiresIn)))],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = params
    .sort(([ak, av], [bk, bv]) => {
      const a = encodeRfc3986(ak);
      const b = encodeRfc3986(bk);
      return byteCompare(a, b) || byteCompare(encodeRfc3986(av), encodeRfc3986(bv));
    })
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join("&");
  const canonicalRequest = [
    "GET",
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anonKey || !serviceRole) {
    return json({ ok: false, error: "Missing Supabase env" }, 500);
  }

  const auth = req.headers.get("authorization") || "";
  if (!/^bearer\s+\S+/i.test(auth)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON payload" }, 400);
  }

  const examId = String(body.exam_id || body.examId || "").trim();
  const kind = String(body.kind || "file").trim().toLowerCase();
  const disposition = String(body.disposition || body.mode || "attachment").trim().toLowerCase() === "inline"
    ? "inline"
    : "attachment";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(examId)) {
    return json({ ok: false, error: "Invalid exam_id" }, 400);
  }
  if (!["file", "answer", "audio"].includes(kind)) {
    return json({ ok: false, error: "Invalid file kind" }, 400);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: auth } },
  });
  const { data: canAccess, error: accessErr } = await userClient.rpc("can_access_exam_file", {
    p_exam_id: examId,
  });
  if (accessErr) {
    return json({ ok: false, error: "Access check failed" }, 500);
  }
  if (canAccess !== true) {
    return json({ ok: false, error: "Forbidden" }, 403);
  }

  const serviceClient = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: row, error: rowErr } = await serviceClient
    .from("exam_files")
    .select(
      "id,is_published,storage_provider,storage_path,answer_path,audio_path,object_key,answer_object_key,audio_object_key,file_url,answer_url,audio_url,title",
    )
    .eq("id", examId)
    .maybeSingle();
  if (rowErr) return json({ ok: false, error: "Exam lookup failed" }, 500);
  if (!row || row.is_published !== true) return json({ ok: false, error: "Not found" }, 404);

  const field = pickFileField(kind);
  const provider = String(row.storage_provider || "supabase").toLowerCase();
  const objectKey = String(row[field.objectKey] || "").replace(/^\/+/, "").trim();
  const storagePath = String(row[field.storagePath] || "").replace(/^\/+/, "").trim();
  const legacyUrl = safeHttpUrl(row[field.legacyUrl]);
  let url = "";
  let source = provider;

  try {
    if (provider === "r2") {
      if (!objectKey) return json({ ok: false, error: "File key missing" }, 404);
      url = await createR2SignedGetUrl(
        objectKey,
        objectKey.split("/").pop() || String(row.title || "tai-lieu"),
        disposition,
        SIGNED_URL_TTL_SECONDS,
      );
    } else if (storagePath) {
      const { data, error } = await serviceClient.storage
        .from("exam-files")
        .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
      if (error) return json({ ok: false, error: "Supabase sign failed" }, 500);
      url = String(data?.signedUrl || data?.signedURL || "").trim();
      source = "supabase";
    } else if (legacyUrl) {
      url = legacyUrl;
      source = "external";
    }
  } catch (e) {
    const code = String(e?.message || "");
    if (code === "R2_NOT_CONFIGURED") return json({ ok: false, error: "R2 not configured" }, 500);
    return json({ ok: false, error: "Sign failed" }, 500);
  }

  if (!url) return json({ ok: false, error: "File not found" }, 404);
  const fileName = (objectKey || storagePath || String(row.title || "tai-lieu")).split("/").pop() || "tai-lieu";
  return json({
    ok: true,
    url,
    source,
    expires_in: SIGNED_URL_TTL_SECONDS,
    file_name: fileName,
  });
});
