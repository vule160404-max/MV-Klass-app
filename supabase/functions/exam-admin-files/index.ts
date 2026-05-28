// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DeleteObjectCommand, S3Client } from "npm:@aws-sdk/client-s3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, accept, x-client-info, prefer, x-supabase-api-version",
  "Access-Control-Max-Age": "86400",
};

const SIGNED_URL_TTL_SECONDS = 900;
const EXAM_SELECT_FIELDS =
  "id,title,level,subject,year,province,exam_code,exam_sort_order,category,file_url,answer_url,audio_url,storage_provider,storage_path,answer_path,audio_path,object_key,answer_object_key,audio_object_key,access_tier,free_rank,free_group,group_free_rank,description,download_count,created_at,is_published";

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

function cleanObjectKey(value: unknown) {
  return String(value || "").replace(/^\/+/, "").trim();
}

function uniqueClean(values: unknown[]) {
  return Array.from(new Set(values.map(cleanObjectKey).filter(Boolean)));
}

function cleanStoragePath(value: unknown) {
  const cleaned = cleanObjectKey(value);
  return cleaned.startsWith("exam-files/") ? cleaned.slice("exam-files/".length) : cleaned;
}

function uniqueStoragePaths(values: unknown[]) {
  return Array.from(new Set(values.map(cleanStoragePath).filter(Boolean)));
}

function storagePathFromUrl(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const parts = url.pathname.split("/").filter(Boolean).map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
    const bucketIndex = parts.findIndex((part, idx) => {
      return part === "exam-files" && parts[idx - 1] && ["public", "sign", "authenticated"].includes(parts[idx - 1]);
    });
    if (bucketIndex >= 0) return cleanStoragePath(parts.slice(bucketIndex + 1).join("/"));
  } catch {
    return "";
  }
  return "";
}

function r2Env() {
  const accountId = (Deno.env.get("R2_ACCOUNT_ID") || "").trim();
  const accessKeyId = (Deno.env.get("R2_ACCESS_KEY_ID") || "").trim();
  const secretAccessKey = (Deno.env.get("R2_SECRET_ACCESS_KEY") || "").trim();
  const bucket = (Deno.env.get("R2_BUCKET") || "mvklass-exam-files").trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("R2_NOT_CONFIGURED");
  }
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

async function createR2SignedGetUrl(objectKey: string, expiresIn = SIGNED_URL_TTL_SECONDS) {
  const { accountId, accessKeyId, secretAccessKey, bucket } = r2Env();
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

function r2Client() {
  const { accountId, accessKeyId, secretAccessKey } = r2Env();
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function deleteR2Objects(keys: string[]) {
  if (!keys.length) return [];
  const { bucket } = r2Env();
  const client = r2Client();
  const deleted = [];
  for (const key of keys) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    deleted.push(key);
  }
  return deleted;
}

async function requireAdmin(service: any, req: Request) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return { ok: false, response: json({ ok: false, error: "Unauthorized" }, 401) };

  const { data: userData, error: userErr } = await service.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return { ok: false, response: json({ ok: false, error: "UNAUTHORIZED_USER_TOKEN" }, 401) };
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
    return { ok: false, response: json({ ok: false, error: `PROFILE_LOOKUP_FAILED: ${profileErr.message}` }, 403) };
  }
  const role = String(profile?.role || "").trim().toLowerCase();
  if (!profile) {
    return { ok: false, response: json({ ok: false, error: "PROFILE_NOT_FOUND" }, 403) };
  }
  if (role !== "admin") {
    return { ok: false, response: json({ ok: false, error: `ROLE_NOT_ADMIN: ${role || "empty"}` }, 403) };
  }
  return { ok: true, user: userData.user, profile };
}

function keyForKind(row: any, kind: string) {
  if (kind === "answer") return {
    objectKey: cleanObjectKey(row?.answer_object_key),
    storagePath: cleanStoragePath(row?.answer_path) || storagePathFromUrl(row?.answer_url),
    publicUrl: String(row?.answer_url || "").trim(),
  };
  if (kind === "audio") return {
    objectKey: cleanObjectKey(row?.audio_object_key),
    storagePath: cleanStoragePath(row?.audio_path) || storagePathFromUrl(row?.audio_url),
    publicUrl: String(row?.audio_url || "").trim(),
  };
  return {
    objectKey: cleanObjectKey(row?.object_key),
    storagePath: cleanStoragePath(row?.storage_path) || storagePathFromUrl(row?.file_url),
    publicUrl: String(row?.file_url || "").trim(),
  };
}

async function fetchExamRow(service: any, id: string) {
  const { data, error } = await service
    .from("exam_files")
    .select(EXAM_SELECT_FIELDS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message || "exam_fetch_failed");
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRole) return json({ ok: false, error: "Missing Supabase env" }, 500);

  const service = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = await requireAdmin(service, req);
  if (!admin.ok) return admin.response;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON payload" }, 400);
  }
  const action = String(body?.action || "list").trim().toLowerCase();

  try {
    if (action === "list") {
      const { data, error } = await service
        .from("exam_files")
        .select(EXAM_SELECT_FIELDS)
        .order("is_published", { ascending: false })
        .order("storage_provider", { ascending: true })
        .order("level", { ascending: true })
        .order("year", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(3000);
      if (error) throw new Error(error.message || "exam_list_failed");
      return json({ ok: true, rows: data || [] });
    }

    const id = String(body?.id || body?.exam_id || "").trim();
    if (!id) return json({ ok: false, error: "Missing exam id" }, 400);
    const row = await fetchExamRow(service, id);
    if (!row) return json({ ok: false, error: "Not found" }, 404);

    if (action === "sign") {
      const kind = ["file", "answer", "audio"].includes(String(body?.kind || "")) ? String(body.kind) : "file";
      const { objectKey, storagePath, publicUrl } = keyForKind(row, kind);
      if (objectKey) {
        return json({ ok: true, provider: "r2", kind, url: await createR2SignedGetUrl(objectKey) });
      }
      if (storagePath) {
        const { data, error } = await service.storage.from("exam-files").createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
        if (error || !data?.signedUrl) throw new Error(error?.message || "supabase_sign_failed");
        return json({ ok: true, provider: "supabase", kind, url: data.signedUrl });
      }
      if (publicUrl) {
        return json({ ok: true, provider: "url", kind, url: publicUrl });
      }
      return json({ ok: false, error: "File not found" }, 404);
    }

    if (action === "delete") {
      const r2Keys = uniqueClean([row.object_key, row.answer_object_key, row.audio_object_key]);
      const storagePaths = uniqueStoragePaths([
        row.storage_path,
        row.answer_path,
        row.audio_path,
        storagePathFromUrl(row.file_url),
        storagePathFromUrl(row.answer_url),
        storagePathFromUrl(row.audio_url),
      ]);
      const deletedR2 = await deleteR2Objects(r2Keys);
      let deletedStorage: string[] = [];
      if (storagePaths.length) {
        const { data, error } = await service.storage.from("exam-files").remove(storagePaths);
        if (error) throw new Error(error.message || "supabase_storage_delete_failed");
        deletedStorage = Array.isArray(data) ? data.map((x: any) => String(x?.name || "")).filter(Boolean) : storagePaths;
      }
      const { error: deleteErr } = await service.from("exam_files").delete().eq("id", id);
      if (deleteErr) throw new Error(deleteErr.message || "exam_row_delete_failed");
      return json({ ok: true, deleted: { r2: deletedR2, supabase: deletedStorage }, id });
    }

    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    const msg = String(e?.message || e || "exam_admin_files_failed");
    const status = /not found/i.test(msg) ? 404 : (/R2_NOT_CONFIGURED/i.test(msg) ? 500 : 400);
    return json({ ok: false, error: msg }, status);
  }
});
