// @ts-nocheck
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { GetObjectCommand, PutObjectCommand, S3Client } from "npm:@aws-sdk/client-s3";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, accept, x-client-info, prefer, x-supabase-api-version",
  "Access-Control-Max-Age": "86400",
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AI_PDF_BYTES = 50 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 900;

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

function bytesToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function looksLikePdf(bytes: Uint8Array) {
  return bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
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

function r2Env() {
  const accountId = (Deno.env.get("R2_ACCOUNT_ID") || "").trim();
  const accessKeyId = (Deno.env.get("R2_ACCESS_KEY_ID") || "").trim();
  const secretAccessKey = (Deno.env.get("R2_SECRET_ACCESS_KEY") || "").trim();
  const bucket = (Deno.env.get("R2_BUCKET") || "mvklass-exam-files").trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) throw new Error("R2_NOT_CONFIGURED");
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

async function putR2Object(objectKey: string, bytes: Uint8Array, contentType: string) {
  const { bucket } = r2Env();
  const client = r2Client();
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: bytes,
    ContentType: contentType,
  }));
}

async function streamToBytes(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      size += value.byteLength;
    }
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function r2BodyToBytes(body: any) {
  if (!body) throw new Error("EXAM_PDF_EMPTY");
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body.transformToByteArray === "function") return new Uint8Array(await body.transformToByteArray());
  if (typeof body.arrayBuffer === "function") return new Uint8Array(await body.arrayBuffer());
  if (typeof body.getReader === "function") return await streamToBytes(body);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    const bytes = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
    chunks.push(bytes);
    size += bytes.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function getR2ObjectBytes(objectKey: string) {
  const { bucket } = r2Env();
  const client = r2Client();
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
    return await r2BodyToBytes(result.Body);
  } catch (_err) {
    throw new Error("EXAM_PDF_FETCH_FAILED");
  }
}

function supabaseStorageLocation(pathValue: string) {
  const raw = String(pathValue || "").trim().replace(/^\/+/, "");
  const defaultBucket = (Deno.env.get("SUPABASE_EXAM_BUCKET") || "exam-files").trim();
  const parts = raw.split("/").filter(Boolean);
  if (parts.length > 1 && /^(exam-files|exam_files|mvklass-exam-files|documents|public)$/i.test(parts[0])) {
    return { bucket: parts[0], path: parts.slice(1).join("/") };
  }
  return { bucket: defaultBucket, path: raw };
}

async function getSupabaseStorageBytes(service: any, pathValue: string) {
  const { bucket, path } = supabaseStorageLocation(pathValue);
  if (!bucket || !path) throw new Error("EXAM_PDF_NOT_FOUND");
  const { data, error } = await service.storage.from(bucket).download(path);
  if (error || !data) throw new Error("EXAM_PDF_FETCH_FAILED");
  return new Uint8Array(await data.arrayBuffer());
}

function authToken(req: Request) {
  const auth = req.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

async function getActor(service: any, req: Request) {
  const token = authToken(req);
  if (!token) return { ok: false, response: json({ ok: false, error: "Unauthorized" }, 401) };
  const { data: userData, error: userErr } = await service.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return { ok: false, response: json({ ok: false, error: "UNAUTHORIZED_USER_TOKEN" }, 401) };
  }
  let { data: profile, error: profileErr } = await service
    .from("profiles")
    .select("role,email,display_name")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (!profile && userData.user.email) {
    const byEmail = await service
      .from("profiles")
      .select("role,email,display_name")
      .eq("email", userData.user.email)
      .maybeSingle();
    profile = byEmail.data;
    profileErr = byEmail.error;
  }
  if (profileErr || !profile) {
    return { ok: false, response: json({ ok: false, error: "PROFILE_NOT_FOUND" }, 403) };
  }
  return { ok: true, token, user: userData.user, profile, isAdmin: String(profile.role || "") === "admin" };
}

function assertAdmin(actor: any) {
  if (!actor?.isAdmin) throw new Error("ADMIN_REQUIRED");
}

function cleanUuid(value: unknown) {
  const s = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) {
    throw new Error("INVALID_EXAM_ID");
  }
  return s;
}

function cleanFileName(value: unknown) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim()
    .slice(0, 120);
}

function cleanSlotId(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80)
    || "image";
}

function extensionForType(type: string) {
  if (type === "image/png") return "png";
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "bin";
}

function matchesMagicBytes(type: string, bytes: Uint8Array) {
  if (type === "image/png") return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/gif") return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
  if (type === "image/webp") {
    return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  return false;
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/["'.!?;:()[\]{}]/g, "")
    .replace(/[“”"'.!?;:()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeQuestionId(value: unknown) {
  return String(value ?? "").trim();
}

function imageKeys(item: any) {
  return [item?.id, item?.image_id, item?.file_name, item?.filename, item?.name]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

function normalizeImageItem(item: any, fallback: string) {
  if (typeof item === "string") {
    const name = String(item || "").trim();
    return { id: name, file_name: name, alt: "Hinh anh trong de" };
  }
  if (typeof item === "string") {
    return { id: item, file_name: item, alt: "Hình ảnh trong đề" };
  }
  const img = item && typeof item === "object" ? { ...item } : {};
  const id = String(img.id || img.image_id || img.file_name || img.filename || img.name || fallback).trim();
  return {
    id,
    file_name: String(img.file_name || img.filename || img.name || id).trim(),
    alt: String(img.alt || img.caption || "Hình ảnh trong đề"),
    alt: String(img.alt || img.caption || "Hinh anh trong de"),
    caption: img.caption ? String(img.caption) : "",
  };
}

function normalizeImages(value: any) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((item, i) => normalizeImageItem(item, `image_${i + 1}`))
    .filter((item) => imageKeys(item).length > 0);
}

function validateExamJson(input: any) {
  const exam = typeof input === "string" ? JSON.parse(input) : input;
  if (!exam || typeof exam !== "object" || Array.isArray(exam)) throw new Error("EXAM_JSON_OBJECT_REQUIRED");
  if (!Array.isArray(exam.questions) || !exam.questions.length) throw new Error("QUESTIONS_REQUIRED");
  const seenIds = new Set<string>();
  const seenBlankIds = new Set<string>();
  const questions = exam.questions.map((raw: any, idx: number) => {
    if (!raw || typeof raw !== "object") throw new Error(`QUESTION_${idx + 1}_INVALID`);
    const type = String(raw.type || "").trim();
    if (!["multiple_choice", "fill_blank", "sentence_rewrite"].includes(type)) throw new Error(`QUESTION_TYPE_INVALID_${idx + 1}`);
    const id = safeQuestionId(raw.id);
    if (!id) throw new Error(`QUESTION_ID_REQUIRED_${idx + 1}`);
    if (seenIds.has(id)) throw new Error(`QUESTION_ID_DUPLICATE_${id}`);
    seenIds.add(id);
    if (!String(raw.question || "").trim()) throw new Error(`QUESTION_TEXT_REQUIRED_${id}`);
    if (raw.answer === undefined || raw.answer === null || !String(raw.answer).trim()) throw new Error(`ANSWER_REQUIRED_${id}`);
    if (type === "multiple_choice" && (!Array.isArray(raw.options) || raw.options.length < 2)) throw new Error(`OPTIONS_REQUIRED_${id}`);
    if (type === "fill_blank") {
      const blankId = String(raw.blank_id || "").trim();
      if (!blankId) throw new Error(`BLANK_ID_REQUIRED_${id}`);
      if (seenBlankIds.has(blankId)) throw new Error(`BLANK_ID_DUPLICATE_${blankId}`);
      seenBlankIds.add(blankId);
    }
    if (type === "sentence_rewrite" && !String(raw.prompt || "").trim()) throw new Error(`PROMPT_REQUIRED_${id}`);
    return {
      ...raw,
      type,
      id: raw.id,
      display_id: raw.display_id || raw.original_id || raw.original_label || String(raw.id),
      question: String(raw.question || ""),
      options: Array.isArray(raw.options) ? raw.options.map((x: any) => String(x ?? "")) : [],
      blank_id: raw.blank_id ? String(raw.blank_id) : "",
      prompt: raw.prompt ? String(raw.prompt) : "",
      answer: String(raw.answer ?? ""),
      answer_display: raw.answer_display ? String(raw.answer_display) : "",
      explanation: raw.explanation ? String(raw.explanation) : "",
      word_bank: Array.isArray(raw.word_bank) ? raw.word_bank.map((x: any) => String(x ?? "")) : [],
      images: normalizeImages(raw.images || raw.image),
    };
  });
  return {
    ...exam,
    title: String(exam.title || "Đề luyện thi online"),
    exam_id: String(exam.exam_id || exam.id || ""),
    title: String(exam.title || "De luyen thi online"),
    passage: exam.passage ? String(exam.passage) : "",
    fill_passage: exam.fill_passage ? String(exam.fill_passage) : "",
    images: normalizeImages(exam.images || exam.image),
    pages: Array.isArray(exam.pages) ? exam.pages : [],
    questions,
  };
}

function collectImageSlots(exam: any) {
  const slots: any[] = [];
  const seen = new Set<string>();
  const pushSlot = (img: any, context: string, questionId: unknown) => {
    const slotId = String(img.id || img.image_id || img.file_name || img.filename || img.name || "").trim();
    const fileName = String(img.file_name || img.filename || img.name || img.id || slotId || "").trim();
    if (!slotId && !fileName) return;
    const key = normalizeText(slotId || fileName);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    slots.push({
      slot_id: slotId || fileName,
      file_name: fileName || slotId,
      context,
      question_id: questionId || null,
      alt: String(img.alt || ""),
      caption: String(img.caption || ""),
    });
  };
  (exam.images || []).forEach((img: any) => pushSlot(img, "exam", null));
  (exam.questions || []).forEach((q: any) => (q.images || []).forEach((img: any) => pushSlot(img, "question", q.id)));
  return slots;
}

function answerForQuestion(q: any, answers: Record<string, unknown>) {
  if (q.type === "multiple_choice") return answers[`mcq_${q.id}`] ?? answers[String(q.id)] ?? "";
  if (q.type === "fill_blank") return answers[`fill_${q.blank_id}`] ?? answers[`fill_${q.id}`] ?? "";
  if (q.type === "sentence_rewrite") return answers[`rw_${q.id}`] ?? answers[`rewrite_${q.id}`] ?? "";
  return "";
}

function isQuestionCorrect(q: any, answers: Record<string, unknown>) {
  const user = answerForQuestion(q, answers);
  if (q.type === "multiple_choice" || q.type === "fill_blank") return normalizeText(user) === normalizeText(q.answer);
  if (q.type === "sentence_rewrite") {
    const raw = normalizeText(user);
    const expected = normalizeText(q.answer);
    if (!raw || !expected) return false;
    if (raw === expected) return true;
    const words = expected.split(" ").filter(Boolean);
    if (!words.length) return false;
    return words.filter((word) => raw.includes(word)).length / words.length > 0.85;
  }
  return false;
}

function scoreExam(exam: any, answers: Record<string, unknown>, durationSeconds: number) {
  const validated = validateExamJson(exam);
  const total = validated.questions.length;
  const score = validated.questions.reduce((sum: number, q: any) => sum + (isQuestionCorrect(q, answers || {}) ? 1 : 0), 0);
  return {
    score,
    total,
    percent: total ? Math.round((score / total) * 10000) / 100 : 0,
    duration_seconds: Math.max(0, Math.round(Number(durationSeconds || 0) || 0)),
  };
}

async function canAccessExam(supabaseUrl: string, anonKey: string, auth: string, examFileId: string) {
  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: auth } },
  });
  const { data, error } = await userClient.rpc("can_access_exam_file", { p_exam_id: examFileId });
  if (error) throw new Error("ACCESS_CHECK_FAILED");
  return data === true;
}

async function fetchOnlineExam(service: any, examFileId: string, publishedOnly = true) {
  let query = service
    .from("exam_online_exams")
    .select("id,exam_file_id,status,title,exam_json,image_slots,question_count,updated_at,published_at")
    .eq("exam_file_id", examFileId);
  if (publishedOnly) query = query.eq("status", "published");
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message || "ONLINE_EXAM_LOOKUP_FAILED");
  return data;
}

async function signedAssets(service: any, onlineExamId: string) {
  const { data, error } = await service
    .from("exam_online_assets")
    .select("id,slot_id,file_name,object_key,content_type,byte_size,created_at")
    .eq("online_exam_id", onlineExamId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message || "ASSET_LOOKUP_FAILED");
  const rows = Array.isArray(data) ? data : [];
  return await Promise.all(rows.map(async (row: any) => ({
    id: row.id,
    slot_id: row.slot_id,
    file_name: row.file_name,
    content_type: row.content_type,
    byte_size: row.byte_size,
    url: await createR2SignedGetUrl(row.object_key),
  })));
}

function numericPercent(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function attemptExamMeta(row: any) {
  const embedded = row?.exam_files;
  const exam = Array.isArray(embedded) ? (embedded[0] || {}) : (embedded || {});
  return {
    title: String(exam.title || "Đề online").trim(),
    level: exam.level || null,
    year: exam.year || null,
    province: exam.province || null,
    exam_code: exam.exam_code || null,
  };
}

async function studentAttemptHistory(service: any, actor: any) {
  const { data, error } = await service
    .from("student_online_exam_attempts")
    .select("id,exam_file_id,score,total,percent,duration_seconds,submitted_at,exam_files(id,title,level,year,province,exam_code)")
    .eq("user_id", actor.user.id)
    .order("submitted_at", { ascending: false })
    .limit(300);
  if (error) throw new Error(error.message || "ATTEMPT_HISTORY_LOOKUP_FAILED");

  const rows = Array.isArray(data) ? data : [];
  const latestByExam = new Map<string, any>();
  rows.forEach((row: any) => {
    const examFileId = String(row?.exam_file_id || "").trim();
    if (!examFileId) return;
    const current = latestByExam.get(examFileId);
    const curTime = current?.submitted_at ? Date.parse(current.submitted_at) : 0;
    const rowTime = row?.submitted_at ? Date.parse(row.submitted_at) : 0;
    if (!current || rowTime >= curTime) latestByExam.set(examFileId, row);
  });

  const latestAttempts = Array.from(latestByExam.values());
  const averagePercent = latestAttempts.length
    ? Math.round((latestAttempts.reduce((sum, row: any) => sum + numericPercent(row.percent), 0) / latestAttempts.length) * 100) / 100
    : 0;

  const attempts = rows.map((row: any) => {
    const examFileId = String(row?.exam_file_id || "").trim();
    const latest = latestByExam.get(examFileId);
    return {
      attempt_id: row.id,
      exam_file_id: examFileId,
      ...attemptExamMeta(row),
      score: Math.max(0, Number(row.score || 0) || 0),
      total: Math.max(0, Number(row.total || 0) || 0),
      percent: numericPercent(row.percent),
      duration_seconds: Math.max(0, Number(row.duration_seconds || 0) || 0),
      submitted_at: row.submitted_at,
      is_latest_for_exam: !!latest && String(latest.id) === String(row.id),
    };
  });

  return {
    summary: {
      completed_exam_count: latestAttempts.length,
      average_percent: averagePercent,
      latest_attempt_count: latestAttempts.length,
      attempt_count: attempts.length,
      last_submitted_at: attempts[0]?.submitted_at || null,
    },
    attempts,
  };
}

function normalizePromptProvinceKey(value: unknown) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(tinh|tp|thanh pho|so|gd|dt|gddt)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PROMPT_SOURCE_CODE_ALIASES: Record<string, string> = {
  hn: "Hà Nội",
  th: "Thanh Hóa",
  nb: "Ninh Bình",
  hp: "Hải Phòng",
  ct: "Cần Thơ",
  tphcm: "TP Hồ Chí Minh",
  hcm: "TP Hồ Chí Minh",
  na: "Nghệ An",
  pt: "Phú Thọ",
};

function promptProvinceLabelFromCode(value: unknown) {
  const code = String(value || "").replace(/[^a-z]/gi, "").toLowerCase();
  if (!code) return "";
  if (PROMPT_SOURCE_CODE_ALIASES[code]) return PROMPT_SOURCE_CODE_ALIASES[code];
  if (code.startsWith("vmp")) return PROMPT_SOURCE_CODE_ALIASES[code.slice(3)] || "";
  return "";
}

function promptCodePrefixesForExam(row: any) {
  const values = [row?.exam_code, row?.title, row?.object_key, row?.storage_path]
    .map((x) => String(x || ""))
    .filter(Boolean);
  const out: string[] = [];
  values.forEach((value) => {
    const clean = value.replace(/[\\/_.-]+/g, " ").replace(/[()[\]{}.,;:]+/g, " ");
    const patterns = [
      /\b([A-Za-z]{2,10})\s*0*\d{1,4}\b/g,
      /\bde\s+([A-Za-z]{2,10})\s*0*\d{1,4}\b/g,
    ];
    patterns.forEach((pattern) => {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(clean))) {
        const code = String(match[1] || "").trim();
        if (code && !out.includes(code)) out.push(code);
      }
    });
  });
  return out;
}

function promptSourceLabelsForExam(row: any) {
  const labels: string[] = [];
  const add = (value: unknown) => {
    const label = String(value || "").replace(/\s+/g, " ").trim();
    if (label && !labels.some((item) => normalizePromptProvinceKey(item) === normalizePromptProvinceKey(label))) {
      labels.push(label);
    }
  };
  const rawProvince = String(row?.province || "").trim();
  promptCodePrefixesForExam(row).forEach((prefix) => {
    const province = promptProvinceLabelFromCode(prefix);
    if (!province) return;
    if (/^vmp/i.test(prefix) || /\b(vu mai phuong|vmp)\b/.test(normalizePromptProvinceKey(rawProvince))) {
      add(`Vũ Mai Phương ${province}`);
      add("Vũ Mai Phương");
      return;
    }
    add(province === "TP Hồ Chí Minh" ? province : `Sở ${province}`);
    add(province);
  });
  if (rawProvince) {
    const key = normalizePromptProvinceKey(rawProvince);
    const codeProvince = promptCodePrefixesForExam(row).map(promptProvinceLabelFromCode).find(Boolean);
    if (/\b(vu mai phuong|vmp)\b/.test(key) && codeProvince) {
      add(`Vũ Mai Phương ${codeProvince}`);
    }
    add(rawProvince);
  }
  if (!labels.length) add("Tổng hợp");
  return labels;
}

function promptSourceKeysForExam(row: any) {
  return Array.from(new Set(promptSourceLabelsForExam(row).map(normalizePromptProvinceKey).filter(Boolean)));
}

function normalizePromptExamLevel(value: unknown) {
  const raw = String(value || "").trim().toLowerCase();
  const norm = normalizeText(value).toLowerCase();
  if (raw === "university" || /\b(thpt|qg|quoc gia|dai hoc)\b/.test(norm)) return "university";
  return "entrance_10";
}

function promptExamLevelKey(row: any) {
  const level = String(row?.level || "").trim().toLowerCase();
  if (level === "university") return "university";
  const hay = normalizeText([row?.title, row?.exam_code, row?.province, row?.object_key, row?.storage_path].filter(Boolean).join(" ")).toLowerCase();
  return /\b(thpt|qg|quoc gia|dai hoc)\b/.test(hay) ? "university" : "entrance_10";
}

function scopedPromptProvinceKey(provinceKey: string, examLevel: string) {
  const key = normalizePromptProvinceKey(provinceKey);
  const level = normalizePromptExamLevel(examLevel);
  return key ? `${level}|${key}` : "";
}

function promptExamLevelFromScopedProvinceKey(value: unknown) {
  const key = String(value || "").trim().toLowerCase();
  if (key.startsWith("university|")) return "university";
  if (key.startsWith("entrance_10|")) return "entrance_10";
  return "";
}

function unscopedPromptProvinceKey(value: unknown) {
  return String(value || "").replace(/^(entrance_10|university)\|/i, "");
}

function inferExamYear(row: any) {
  const explicit = Number(row?.year || 0);
  if (Number.isInteger(explicit) && explicit >= 2000 && explicit <= 2100) return explicit;
  const hay = [row?.title, row?.exam_code].map((x) => String(x || "")).join(" ");
  const m = hay.match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

function promptSourcePublic(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    province_key: row.province_key,
    province_label: row.province_label,
    exam_level: row.exam_level || promptExamLevelFromScopedProvinceKey(row.province_key) || "",
    year: row.year,
    is_active: row.is_active !== false,
    updated_at: row.updated_at || null,
  };
}

function promptSourceCandidate(row: any) {
  const provinceLabel = promptSourceLabelsForExam(row)[0] || String(row?.province || "").trim();
  const provinceKey = normalizePromptProvinceKey(provinceLabel);
  return {
    province_key: provinceKey,
    province_label: provinceLabel,
    exam_level: promptExamLevelKey(row),
    year: inferExamYear(row),
  };
}

function findPromptTemplateInRows(row: any, templates: any[]) {
  const year = inferExamYear(row);
  if (!year) return null;
  const active = (Array.isArray(templates) ? templates : []).filter((tpl) =>
    tpl?.is_active !== false && Number(tpl?.year) === year
  );
  if (!active.length) return null;
  const sourceKeys = promptSourceKeysForExam(row);
  const examLevel = promptExamLevelKey(row);
  const levelScopedKeys = promptSourceKeysForExam(row).map((key) => scopedPromptProvinceKey(key, examLevel));
  for (const sourceKey of levelScopedKeys) {
    const exact = active.find((tpl) => String(tpl.province_key || "") === sourceKey);
    if (exact) return exact;
  }
  for (const sourceKey of sourceKeys) {
    const exact = active.find((tpl) => String(tpl.province_key || "") === sourceKey);
    if (exact) return exact;
  }
  const hay = [
    ...sourceKeys,
    normalizePromptProvinceKey([row?.province, row?.title, row?.exam_code].join(" ")),
  ].filter(Boolean).join(" ");
  if (!hay) return null;
  return active
    .slice()
    .sort((a, b) => String(b.province_key || "").length - String(a.province_key || "").length)
    .find((tpl) => {
      if (promptExamLevelFromScopedProvinceKey(tpl.province_key)) return false;
      const key = unscopedPromptProvinceKey(tpl.province_key);
      return key && new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay);
    }) || null;
}

async function activePromptTemplates(service: any) {
  const { data, error } = await service
    .from("exam_online_prompt_templates")
    .select("id,province_key,province_label,year,template_text,is_active,updated_at")
    .eq("is_active", true)
    .order("year", { ascending: false })
    .order("province_label", { ascending: true });
  if (error) throw new Error(error.message || "PROMPT_SOURCE_LIST_FAILED");
  return Array.isArray(data) ? data.map((row: any) => ({
    ...row,
    exam_level: promptExamLevelFromScopedProvinceKey(row.province_key) || "",
  })) : [];
}

async function promptSourcesList(service: any) {
  const { data, error } = await service
    .from("exam_online_prompt_templates")
    .select("id,province_key,province_label,year,template_text,is_active,updated_at,created_at")
    .order("year", { ascending: false })
    .order("province_label", { ascending: true });
  if (error) throw new Error(error.message || "PROMPT_SOURCE_LIST_FAILED");
  return Array.isArray(data) ? data.map((row: any) => ({
    ...row,
    exam_level: promptExamLevelFromScopedProvinceKey(row.province_key) || "",
  })) : [];
}

async function findPromptTemplateForExam(service: any, row: any) {
  const templates = await activePromptTemplates(service);
  return findPromptTemplateInRows(row, templates);
}

function assertPromptTemplateText(value: unknown) {
  const text = String(value || "").trim();
  if (text.length < 20) throw new Error("PROMPT_TEMPLATE_REQUIRED");
  const hasExamId = /__EXAM_ID__|THAY_BANG_ID|\{\{\s*exam_id\s*\}\}/.test(text);
  const hasTitle = /__EXAM_TITLE__|THAY_BANG_TEN_DE|\{\{\s*title\s*\}\}/.test(text);
  if (!hasExamId || !hasTitle) throw new Error("PROMPT_TEMPLATE_PLACEHOLDER_REQUIRED");
  return text;
}

function renderPromptTemplate(template: any, row: any) {
  const text = assertPromptTemplateText(template?.template_text);
  const id = String(row?.id || "").trim();
  const title = String(row?.title || "Đề thi").trim();
  return text
    .replaceAll("__EXAM_ID__", id)
    .replaceAll("__EXAM_TITLE__", title)
    .replaceAll("THAY_BANG_ID", id)
    .replaceAll("THAY_BANG_TEN_DE", title)
    .replace(/\{\{\s*exam_id\s*\}\}/g, id)
    .replace(/\{\{\s*title\s*\}\}/g, title);
}

async function savePromptSource(service: any, actor: any, body: any) {
  const provinceLabel = String(body?.province_label || body?.province || "").trim();
  const provinceKey = normalizePromptProvinceKey(body?.province_key || provinceLabel);
  const examLevel = normalizePromptExamLevel(body?.exam_level || body?.examLevel || "entrance_10");
  const year = Number(body?.year || 0);
  if (!provinceLabel || !provinceKey) throw new Error("PROMPT_SOURCE_PROVINCE_REQUIRED");
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error("PROMPT_SOURCE_YEAR_INVALID");
  const templateText = assertPromptTemplateText(body?.template_text || body?.templateText);
  const payload = {
    province_key: scopedPromptProvinceKey(provinceKey, examLevel),
    province_label: provinceLabel,
    year,
    template_text: templateText,
    is_active: true,
    updated_by: actor.user.id,
    created_by: actor.user.id,
  };
  const { data, error } = await service
    .from("exam_online_prompt_templates")
    .upsert(payload, { onConflict: "province_key,year" })
    .select("id,province_key,province_label,year,template_text,is_active,updated_at,created_at")
    .single();
  if (error) throw new Error(error.message || "PROMPT_SOURCE_SAVE_FAILED");
  return {
    ...data,
    exam_level: promptExamLevelFromScopedProvinceKey(data?.province_key) || examLevel,
  };
}

async function disablePromptSource(service: any, actor: any, body: any) {
  const id = cleanUuid(body?.id || body?.prompt_source_id || body?.promptSourceId);
  const { data, error } = await service
    .from("exam_online_prompt_templates")
    .update({ is_active: false, updated_by: actor.user.id })
    .eq("id", id)
    .select("id,province_key,province_label,year,template_text,is_active,updated_at,created_at")
    .single();
  if (error) throw new Error(error.message || "PROMPT_SOURCE_DISABLE_FAILED");
  return {
    ...data,
    exam_level: promptExamLevelFromScopedProvinceKey(data?.province_key) || "",
  };
}

async function saveGeneratedExamJsonDraft(service: any, actor: any, examFileId: string, examJson: any) {
  const validated = validateExamJson(examJson);
  validated.exam_id = examFileId;
  const imageSlots = collectImageSlots(validated);
  const payload = {
    exam_file_id: examFileId,
    status: "draft",
    title: validated.title,
    exam_json: validated,
    image_slots: imageSlots,
    question_count: validated.questions.length,
    updated_by: actor.user.id,
    created_by: actor.user.id,
  };
  const { data, error } = await service
    .from("exam_online_exams")
    .upsert(payload, { onConflict: "exam_file_id" })
    .select("id,exam_file_id,status,title,question_count,image_slots,updated_at")
    .single();
  if (error) throw new Error(error.message || "ONLINE_AI_SAVE_FAILED");
  const warnings: string[] = [];
  if (imageSlots.length) warnings.push("IMAGE_SLOTS_NEED_REVIEW");
  return { online_exam: data, warnings };
}

function examPdfObjectCandidates(row: any) {
  const values = [
    { key: row?.object_key, path: "", kind: "exam", source: "r2" },
    { key: "", path: row?.storage_path, kind: "exam", source: "supabase" },
    { key: row?.answer_object_key, path: "", kind: "answer", source: "r2" },
    { key: "", path: row?.answer_path, kind: "answer", source: "supabase" },
  ];
  const seen = new Set<string>();
  return values
    .map((item) => ({
      key: String(item.key || "").trim().replace(/^\/+/, ""),
      path: String(item.path || "").trim().replace(/^\/+/, ""),
      kind: item.kind,
      source: item.source,
    }))
    .filter((item) => {
      const ref = item.key || item.path;
      const identity = `${item.kind}:${item.source}:${ref}`;
      if (!ref || seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}

function aiPdfFileName(row: any, kind: string, index: number) {
  const title = cleanFileName(String(row?.title || row?.exam_code || row?.id || "exam"));
  const suffix = kind === "answer" ? "answer" : "exam";
  return `${title || "exam"}-${suffix}-${index + 1}.pdf`;
}

function pdfErrorCode(kind: string, suffix: string) {
  return `${kind === "answer" ? "ANSWER" : "EXAM"}_PDF_${suffix}`;
}

async function readAiPdfCandidate(service: any, item: any) {
  try {
    if (item.source === "supabase") return await getSupabaseStorageBytes(service, item.path);
    return await getR2ObjectBytes(item.key);
  } catch (_err) {
    throw new Error(pdfErrorCode(item.kind, "FETCH_FAILED"));
  }
}

async function fetchExamPdfForAi(service: any, row: any) {
  const candidates = examPdfObjectCandidates(row);
  const missingKinds = ["exam", "answer"].filter((kind) => !candidates.some((item) => item.kind === kind));
  if (missingKinds.length) throw new Error(pdfErrorCode(missingKinds[0], "NOT_FOUND"));
  const files: Array<{ filename: string; bytes: Uint8Array }> = [];
  let totalBytes = 0;
  for (const kind of ["exam", "answer"]) {
    const kindCandidates = candidates.filter((item) => item.kind === kind);
    let bytes: Uint8Array | null = null;
    let lastError = pdfErrorCode(kind, "FETCH_FAILED");
    for (const item of kindCandidates) {
      try {
        bytes = await readAiPdfCandidate(service, item);
        if (!bytes.length) throw new Error(pdfErrorCode(kind, "EMPTY"));
        if (!looksLikePdf(bytes)) throw new Error(pdfErrorCode(kind, "SIGNATURE_INVALID"));
        break;
      } catch (err) {
        lastError = String(err && err.message || err || pdfErrorCode(kind, "FETCH_FAILED"));
        bytes = null;
      }
    }
    if (!bytes) throw new Error(lastError);
    totalBytes += bytes.length;
    if (totalBytes > MAX_AI_PDF_BYTES) throw new Error("EXAM_PDF_TOO_LARGE");
    files.push({ filename: aiPdfFileName(row, kind, files.length), bytes });
  }
  return files;
}

function responseOutputText(data: any) {
  if (typeof data?.output_text === "string") return data.output_text;
  const parts: string[] = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      const text = typeof content?.text === "string" ? content.text : "";
      if (text) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function decodePdfLiteralText(value: string) {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = value[++i] || "";
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let j = 0; j < 2 && /[0-7]/.test(value[i + 1] || ""); j++) octal += value[++i];
      out += String.fromCharCode(parseInt(octal, 8));
    } else {
      out += next;
    }
  }
  return out;
}

function decodePdfHexText(value: string) {
  const clean = value.replace(/[^0-9a-f]/gi, "");
  if (clean.length < 2 || clean.length % 2) return "";
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
  const hasUtf16Be = bytes.length > 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
  if (hasUtf16Be) {
    let text = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) text += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return text;
  }
  return String.fromCharCode(...bytes);
}

function normalizeExtractedPdfText(text: string) {
  return String(text || "")
    .replace(/\u0000/g, "")
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function latin1FromBytes(bytes: Uint8Array) {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.slice(i, i + chunkSize)));
  }
  return chunks.join("");
}

function extractPdfTextForAi(bytes: Uint8Array) {
  const source = latin1FromBytes(bytes);
  const parts: string[] = [];
  const literalRegex = /\((?:\\.|[^\\()]){2,}\)\s*(?:Tj|'|"|TJ)/g;
  let literalMatch: RegExpExecArray | null;
  while ((literalMatch = literalRegex.exec(source))) {
    const raw = literalMatch[0].replace(/\)\s*(?:Tj|'|"|TJ)\s*$/, "").slice(1);
    const decoded = decodePdfLiteralText(raw);
    if (/[A-Za-z0-9\u00c0-\u1ef9]/.test(decoded)) parts.push(decoded);
  }
  const hexRegex = /<([0-9a-fA-F\s]{6,})>\s*(?:Tj|'|"|TJ)/g;
  let hexMatch: RegExpExecArray | null;
  while ((hexMatch = hexRegex.exec(source))) {
    const decoded = decodePdfHexText(hexMatch[1]);
    if (/[A-Za-z0-9\u00c0-\u1ef9]/.test(decoded)) parts.push(decoded);
  }
  const extracted = normalizeExtractedPdfText(parts.join("\n"));
  if (extracted.length >= 80) return extracted.slice(0, 120000);
  return normalizeExtractedPdfText(source.replace(/[^\x20-\x7e\u00c0-\u1ef9\r\n]+/g, " ")).slice(0, 120000);
}

function parseOpenAiExamJson(text: string) {
  const raw = String(text || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!raw) throw new Error("OPENAI_RESPONSE_EMPTY");
  try {
    return JSON.parse(raw);
  } catch (_err) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("OPENAI_RESPONSE_INVALID_JSON");
  }
}

async function generateExamJsonWithNvidia(nvidiaKey: string, prompt: string, pdfFiles: Array<{ filename: string; bytes: Uint8Array }>) {
  const model = (Deno.env.get("NVIDIA_EXAM_JSON_MODEL") || "openai/gpt-oss-120b").trim();
  const maxTokens = Number(Deno.env.get("NVIDIA_EXAM_JSON_MAX_TOKENS") || "8192");
  const pdfText = pdfFiles.map((file) => {
    const text = extractPdfTextForAi(file.bytes);
    return `===== ${file.filename} =====\n${text || "[Khong trich xuat duoc chu tu PDF]"}`;
  }).join("\n\n");
  const schemaInstruction = [
    "Return exactly one valid JSON object.",
    "The root object MUST include a non-empty questions array.",
    "Each question MUST include: id, type, question, answer.",
    "Allowed type values: multiple_choice, fill_blank, sentence_rewrite.",
    "For multiple_choice, include at least 4 options when available.",
    "For fill_blank, include blank_id.",
    "For sentence_rewrite, include prompt.",
    "Do not return summaries, metadata-only JSON, markdown, or comments.",
  ].join("\n");
  let lastSchemaError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${nvidiaKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "You convert Vietnamese exam PDFs and answer keys into valid exam JSON. Return only JSON, no markdown.",
          },
          {
            role: "user",
            content: `${prompt}\n\n${schemaInstruction}\n\nNOI DUNG FILE DE VA DAP AN DA TRICH XUAT:\n${pdfText}\n\n${attempt > 1 ? `Lan truoc JSON khong hop le: ${lastSchemaError}. Hay tao lai day du mang questions tu noi dung de va dap an.` : "Hay tao day du mang questions tu noi dung de va dap an."}`,
          },
        ],
        temperature: 0.1,
        max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 8192,
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: AbortSignal.timeout(180000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = String(data?.error?.message || data?.error || `NVIDIA_HTTP_${response.status}`).slice(0, 240);
      throw new Error(`NVIDIA_REQUEST_FAILED: ${message}`);
    }
    const text = String(data?.choices?.[0]?.message?.content || "").trim();
    if (!text) throw new Error("NVIDIA_RESPONSE_EMPTY");
    let parsed: any;
    try {
      parsed = parseOpenAiExamJson(text);
      return validateExamJson(parsed);
    } catch (err) {
      lastSchemaError = String(err && err.message || err || "NVIDIA_SCHEMA_INVALID").slice(0, 120);
      if (attempt < 2 && /OPENAI_RESPONSE_INVALID_JSON|QUESTIONS_REQUIRED/i.test(lastSchemaError)) continue;
      if (/OPENAI_RESPONSE_INVALID_JSON/i.test(lastSchemaError)) {
        throw new Error(`NVIDIA_RESPONSE_INVALID_JSON: ${lastSchemaError}`);
      }
      throw new Error(`NVIDIA_RESPONSE_SCHEMA_INVALID: ${lastSchemaError}`);
    }
  }
  throw new Error(`NVIDIA_RESPONSE_SCHEMA_INVALID: ${lastSchemaError || "UNKNOWN"}`);
}

async function generateExamJsonWithOpenAi(openAiKey: string, prompt: string, pdfFiles: Array<{ filename: string; bytes: Uint8Array }>) {
  const model = (Deno.env.get("OPENAI_EXAM_JSON_MODEL") || "gpt-4o").trim();
  const content = [
    {
      type: "input_text",
      text: `${prompt}\n\nHãy đọc các file PDF đính kèm và trả về duy nhất JSON hợp lệ theo schema trong prompt.`,
    },
    ...pdfFiles.map((file) => ({
      type: "input_file",
      filename: file.filename,
      file_data: `data:application/pdf;base64,${bytesToBase64(file.bytes)}`,
    })),
  ];
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openAiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content }],
      text: { format: { type: "json_object" } },
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(180000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = String(data?.error?.message || data?.error || `OPENAI_HTTP_${response.status}`).slice(0, 240);
    throw new Error(`OPENAI_REQUEST_FAILED: ${message}`);
  }
  const text = responseOutputText(data);
  return parseOpenAiExamJson(text);
}

async function adminList(service: any) {
  const { data: exams, error: examErr } = await service
    .from("exam_files")
    .select("id,title,level,subject,year,province,exam_code,exam_sort_order,category,access_tier,free_group,group_free_rank,storage_provider,object_key,storage_path,answer_object_key,answer_path,audio_object_key,audio_path,download_count,created_at,is_published")
    .eq("subject", "english")
    .eq("is_published", true)
    .neq("category", "answer")
    .order("is_published", { ascending: false })
    .order("level", { ascending: true })
    .order("year", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(3000);
  if (examErr) throw new Error(examErr.message || "EXAM_LIST_FAILED");
  const { data: online, error: onlineErr } = await service
    .from("exam_online_exams")
    .select("id,exam_file_id,status,title,question_count,image_slots,updated_at,published_at");
  if (onlineErr) throw new Error(onlineErr.message || "ONLINE_LIST_FAILED");
  const onlineRows = Array.isArray(online) ? online : [];
  const onlineIds = onlineRows.map((row: any) => String(row.id || "")).filter(Boolean);
  let assetRows: any[] = [];
  if (onlineIds.length) {
    const { data: assets, error: assetErr } = await service
      .from("exam_online_assets")
      .select("id,online_exam_id,slot_id,file_name,object_key,content_type,byte_size,created_at")
      .in("online_exam_id", onlineIds);
    if (assetErr) throw new Error(assetErr.message || "ONLINE_ASSET_LIST_FAILED");
    assetRows = Array.isArray(assets) ? assets : [];
  }
  const assetsByOnline = new Map<string, any[]>();
  assetRows.forEach((asset: any) => {
    const key = String(asset.online_exam_id || "");
    const list = assetsByOnline.get(key) || [];
    list.push(asset);
    assetsByOnline.set(key, list);
  });
  const byExam = new Map(onlineRows.map((row: any) => [
    String(row.exam_file_id),
    { ...row, assets: assetsByOnline.get(String(row.id || "")) || [] },
  ]));
  const promptTemplates = await activePromptTemplates(service);
  return (exams || []).map((row: any) => ({
    ...row,
    online_exam: byExam.get(String(row.id)) || null,
    source_prompt: promptSourcePublic(findPromptTemplateInRows(row, promptTemplates)),
    source_prompt_candidate: promptSourceCandidate(row),
  }));
}

function deprecatedSharedPromptForReference(row: any) {
  const title = String(row?.title || "Đề thi").trim();
  const id = String(row?.id || "").trim();
  const template = String.raw`Bạn là trợ lý chuyên xử lý đề thi Tiếng Anh Việt Nam (vào lớp 10 và THPT Quốc Gia).
Nhiệm vụ: Chuyển đề thi và đáp án tôi cung cấp thành định dạng JSON chuẩn theo đúng schema bên dưới.

━━━━━━━━━━━━━━━━━━━━━━━━━━
THÔNG TIN BẮT BUỘC CỦA ĐỀ NÀY
━━━━━━━━━━━━━━━━━━━━━━━━━━

- exam_id: "__EXAM_ID__"
- title: "__EXAM_TITLE__"
- Không tự ý đổi exam_id, không dùng id đề trong PDF để thay exam_id.

Chỉ dùng đúng exam_id và title ở trên cho JSON cuối cùng. Không lấy mã đề, số báo danh, hoặc id xuất hiện trong PDF để thay exam_id.

━━━━━━━━━━━━━━━━━━━━━━━━━━
NGỮ CẢNH RẤT QUAN TRỌNG: ĐỀ ĐẦY ĐỦ
━━━━━━━━━━━━━━━━━━━━━━━━━━

Đề tôi đưa lên thường là MỘT ĐỀ THI ĐẦY ĐỦ, không phải một bài đọc đơn lẻ.
Ví dụ có thể gồm:
• A. PHẦN TRẮC NGHIỆM: câu 1-28
• Các nhóm câu độc lập: ngữ pháp, giao tiếp, sắp xếp câu, biển báo/thông báo có ảnh
• Một đoạn announcement/cloze có blank đánh số 16-20 nhưng mỗi blank vẫn có lựa chọn A/B/C/D
• Một bài đọc dài dùng cho câu 23-28
• B. PHẦN TỰ LUẬN: câu 1-12, đánh số lại từ 1 nhưng vẫn thuộc cùng một đề
• Bảng đáp án ở cuối đề

Vì vậy:
• KHÔNG đưa toàn bộ đề vào "passage".
• "passage" chỉ chứa bài đọc dài thật sự dùng cho cụm câu đọc hiểu, ví dụ câu 23-28.
• "fill_passage" chỉ chứa đoạn announcement/cloze có blank được đánh số, ví dụ câu 16-20.
• Các câu ngữ pháp/giao tiếp/sắp xếp câu/biển báo/câu tự luận độc lập phải nằm trong từng object của "questions", không nhét vào "passage".
• Nếu câu có lựa chọn A/B/C/D thì type LUÔN là "multiple_choice", kể cả câu điền vào blank trong announcement/cloze.
• "fill_blank" chỉ dùng cho câu học sinh phải tự gõ đáp án, ví dụ Word Forms trong phần tự luận, không có A/B/C/D.

━━━━━━━━━━━━━━━━━━━━━━━━━━
QUY TẮC XỬ LÝ
━━━━━━━━━━━━━━━━━━━━━━━━━━

1. PHÂN LOẠI CÂU HỎI – mỗi câu phải thuộc 1 trong 3 loại:
   • "multiple_choice" → trắc nghiệm A/B/C/D
   • "fill_blank"      → điền từ vào chỗ trống (có word bank)
   • "sentence_rewrite" → viết lại câu / hoàn thành câu
   • Nếu câu có A/B/C/D thì vẫn là "multiple_choice", kể cả câu hỏi kiểu "correct option that best fits blank (16)".
   • Nếu phần tự luận đánh số lại từ câu 1, vẫn đưa vào cùng mảng "questions" nhưng dùng id nội bộ duy nhất theo thứ tự toàn đề.

2. ID, ĐÁNH SỐ VÀ NHÃN HIỂN THỊ – BẮT BUỘC KHÔNG TRÙNG:
   • "id" là số nội bộ dùng cho app, phải duy nhất trong toàn bộ JSON, không được trùng.
   • Nếu đề có "Trắc nghiệm câu 1-28" và "Tự luận câu 1-12", phần tự luận KHÔNG được dùng lại id 1-12.
   • Với ví dụ trên: trắc nghiệm giữ id 1-28; tự luận dùng id 29-40.
   • Dùng "display_id" để giữ số câu gốc học sinh nhìn thấy, ví dụ "1", "23", "Tự luận 1", "Tự luận 12".
   • "display_id" chỉ là nhãn hiển thị; "id" vẫn phải là số duy nhất.
   • "blank_id" cũng phải duy nhất trong toàn bộ JSON. Nếu phần tự luận dùng id 29 thì dùng "blank_id": "blank_29" hoặc tên duy nhất tương tự, không dùng lại "blank_1" nếu dễ gây nhầm.

3. GIỮ ĐÚNG ĐỊNH DẠNG ĐỀ GỐC:
   • Nếu trong đề gốc có từ/cụm từ được IN ĐẬM, giữ lại bằng tag <strong>...</strong> trong đúng trường JSON hiển thị từ/cụm từ đó.
   • Nếu trong đề gốc có từ/cụm từ được GẠCH CHÂN, giữ lại bằng tag <u>...</u> trong đúng trường JSON hiển thị từ/cụm từ đó.
   • Câu phát âm/stress: phần chữ cái/âm tiết được gạch chân trong từng đáp án phải đặt bằng <u>...</u>. Nếu đề gốc vừa in đậm vừa gạch chân thì dùng <strong><u>...</u></strong> đúng đoạn đó, không bỏ mất định dạng.
   • Chỉ dùng đúng 2 tag này: <strong> và <u>. Không dùng markdown (**text**), không dùng HTML khác, không thêm class/style/attribute.
   • Các phần không được in đậm/gạch chân trong đề gốc thì giữ văn bản thường, không tự thêm định dạng.
   • Nếu đề gốc có ô trống/dòng gạch chân để học sinh chọn đáp án, giữ bằng chuỗi gạch dưới "_______". TUYỆT ĐỐI không dùng "***" để thay ô trống.
   • Nếu nội dung đề gốc có dấu ngoặc kép thẳng "..." nằm bên trong một chuỗi JSON, phải escape thành \"...\" để JSON hợp lệ. Có thể đổi trích dẫn nội bộ sang dấu nháy đơn '...' nếu không làm sai nội dung đề.
   • ĐẶC BIỆT trong "explanation", "question", "options", "alt", "caption": không viết "allow", "were", "The more" bằng dấu ngoặc kép thẳng nếu chưa escape. Ưu tiên dùng dấu nháy đơn 'allow' hoặc viết \"allow\".

4. TRƯỜNG "answer":
   • multiple_choice: chỉ ghi chữ cái đáp án, ví dụ "B"
   • fill_blank: ghi từ cần điền, ví dụ "stressful"
   • sentence_rewrite: ghi câu hoàn chỉnh (viết thường), ví dụ "although he worked hard, he didn't pass the exam"

5. TRƯỜNG "answer_display" (chỉ với sentence_rewrite):
   Ghi câu viết hoa đúng chính tả để hiển thị cho học sinh sau khi nộp bài.

6. TRƯỜNG "explanation" – BẮT BUỘC với mọi câu:
   • Nếu đáp án CÓ sẵn giải thích → dùng và bổ sung thêm nếu cần
   • Nếu chỉ có đáp án, KHÔNG có giải thích → TỰ VIẾT giải thích chi tiết bằng Tiếng Việt:
     - Với multiple_choice: giải thích tại sao đáp án đúng + tại sao các đáp án kia sai (dẫn từ khóa/câu trong bài đọc nếu có)
     - Với fill_blank: giải thích nghĩa của từ, tại sao từ đó phù hợp ngữ cảnh, tại sao các từ khác không đúng
     - Với sentence_rewrite: giải thích cấu trúc ngữ pháp sử dụng, cách chuyển đổi, lưu ý thường gặp

7. TRƯỜNG "word_bank" (chỉ với fill_blank) – BẮT BUỘC CHỈ DÙNG TỪ ĐỀ CHO SẴN:
   • Chỉ copy các từ/cụm từ nằm trong danh sách lựa chọn/word bank có sẵn của đề gốc.
   • KHÔNG được tự nghĩ thêm từ nhiễu, KHÔNG được tự tạo từ mới, KHÔNG lấy từ ngoài đề để làm phong phú bài tập.
   • Giữ nguyên chính tả, thứ tự xuất hiện và cách viết hoa/thường như đề gốc.
   • Nếu đề gốc lặp lại đúng cùng một từ/cụm từ nhiều lần thì chỉ giữ một lần trong word_bank.
   • Nếu đề gốc không có danh sách từ cho sẵn thì đặt "word_bank": [] để học sinh gõ đáp án; không tự tạo word_bank.

8. TRƯỜNG "images" – BẮT BUỘC GIỮ ẢNH TRONG ĐỀ:
   • Nếu đề gốc có hình ảnh, biểu đồ, tranh minh họa, biển báo, thông báo dạng ảnh, hoặc câu hỏi dựa vào ảnh → BẮT BUỘC giữ lại ảnh trong JSON.
   • Với ảnh thuộc toàn đề/đoạn đọc, đặt ở top-level "images".
   • Với ảnh thuộc riêng một câu hỏi, đặt trong object câu hỏi đó bằng trường "images".
   • Vì ảnh trong file đề thường KHÔNG có URL, mỗi ảnh phải tạo một slot để giáo viên đính kèm file sau: {"id": "q14_notice", "file_name": "q14_notice.png", "alt": "mô tả ngắn", "caption": ""}.
   • "id" và "file_name" phải ngắn, dễ hiểu, gắn với số câu/vị trí ảnh. Ví dụ: q14_notice.png, q15_sign.png, passage_chart_1.png.
   • Nếu Gemini có thể xuất trực tiếp ảnh dạng data URL thì có thể thêm "src": "data:image/png;base64,..."; nếu không thì BẮT BUỘC có "id" và "file_name".
   • "caption" chỉ dùng khi đề gốc có chú thích hiển thị thật dưới/trên ảnh. Nếu đề gốc không có chú thích thật thì bỏ trường caption hoặc đặt "caption": "".
   • Không tự tạo caption mô tả ảnh như "Biển thông báo...", "Hình ảnh..." hoặc dòng giải thích nội dung ảnh. Mô tả ảnh chỉ đặt trong "alt", không hiện ra dưới ảnh cho học sinh.
   • Không thay ảnh bằng mô tả chữ nếu đề gốc có ảnh. App sẽ có nút "Đính kèm ảnh" để giáo viên chọn file ảnh đúng tên.

9. TRƯỜNG "fill_passage" (nếu có phần điền từ vào đoạn văn):
   Copy nguyên đoạn văn, đánh dấu vị trí cần điền bằng ___16___, ___17___, ___18___... theo đúng số câu/blank gốc; không dùng [BLANK_1] trong văn bản hiển thị.
   Đảm bảo blank_id trong từng câu fill_blank khớp với số blank trong fill_passage, ví dụ blank_id "blank_16" tương ứng với ___16___.
   Nếu đoạn này là dạng trắc nghiệm A/B/C/D cho từng blank, các câu tương ứng vẫn phải là "multiple_choice", không phải "fill_blank".
   Với câu trắc nghiệm chọn đáp án cho blank, viết "question" ngắn theo nội dung đề hoặc "Chọn đáp án đúng cho chỗ trống ___16___." Không viết câu máy móc kiểu "Vị trí tương ứng với số [BLANK_16] trong đoạn văn điền từ."

10. TRƯỜNG "passage":
   Copy toàn bộ đoạn đọc/bài đọc gốc. Giữ nguyên xuống dòng (dùng \n).
   Chỉ copy bài đọc dài dùng cho cụm câu đọc hiểu; không copy phần trắc nghiệm độc lập, phần tự luận hoặc bảng đáp án vào "passage".

11. TRƯỜNG "passage_range" VÀ "fill_passage_range":
   • Nếu "passage" dùng cho một dải câu đọc hiểu, bắt buộc ghi "passage_range": {"from": 23, "to": 28} theo đúng số câu trong đề gốc.
   • Nếu "fill_passage" dùng cho một dải câu điền từ, bắt buộc ghi "fill_passage_range": {"from": 16, "to": 20} theo đúng số câu trong đề gốc.
   • Không tự đoán lại thứ tự câu; lấy đúng số câu hiển thị trong đề. Ví dụ bài đọc ghi câu 23-28 thì dùng from 23, to 28.
   • Nếu không có bài đọc hoặc không có đoạn điền từ thì bỏ trường range tương ứng.

12. TRƯỜNG "pages" – CHIA MỖI BÀI/PHẦN THÀNH MỘT TRANG RIÊNG:
   • Bắt buộc tạo "pages" để app biết mỗi bài nằm ở một trang khác nhau.
   • Mỗi page có "id", "title", "source_key" nếu cần, và "question_ids".
   • "source_key": "fill_passage" dùng cho page có đoạn cloze/announcement ở đầu trang.
   • "source_key": "passage" dùng cho page có bài đọc dài ở đầu trang.
   • Page câu độc lập không cần source_key; đề từng câu sẽ nằm trong từng object question.
   • Ví dụ: {"id":"announcement_16_20","title":"Read the announcement","source_key":"fill_passage","question_ids":[16,17,18,19,20]}
   • Ví dụ: {"id":"reading_23_28","title":"Reading passage","source_key":"passage","question_ids":[23,24,25,26,27,28]}
   • Với phần tự luận đã đổi id nội bộ 29-40, "question_ids" phải dùng id nội bộ này, không dùng lại 1-12.

13. OUTPUT: Trả về DUY NHẤT JSON hợp lệ, không kèm giải thích ngoài JSON, không dùng markdown code block.

━━━━━━━━━━━━━━━━━━━━━━━━━━
JSON SCHEMA
━━━━━━━━━━━━━━━━━━━━━━━━━━

{
  "exam_id": "de_001",
  "title": "Tên đề thi",
  "passage": "Nội dung đoạn đọc...",
  "passage_range": {"from": 23, "to": 28},
  "fill_passage": "Đoạn điền từ với ___16___, ___17___... (nếu có, nếu không thì bỏ trường này)",
  "fill_passage_range": {"from": 16, "to": 20},
  "pages": [
    {"id": "grammar_1_9", "title": "Grammar and vocabulary", "question_ids": [1,2,3,4,5,6,7,8,9]},
    {"id": "announcement_16_20", "title": "Read the announcement", "source_key": "fill_passage", "question_ids": [16,17,18,19,20]},
    {"id": "reading_23_28", "title": "Reading passage", "source_key": "passage", "question_ids": [23,24,25,26,27,28]},
    {"id": "written_29_40", "title": "Phần tự luận", "question_ids": [29,30,31,32,33,34,35,36,37,38,39,40]}
  ],
  "images": [
    {"id": "passage_chart_1", "file_name": "passage_chart_1.png", "alt": "Ảnh/biểu đồ trong đề", "caption": ""}
  ],
  "questions": [
    {
      "id": 1,
      "display_id": "1",
      "type": "multiple_choice",
      "question": "Nội dung câu hỏi?",
      "images": [
        {"id": "q1_image_1", "file_name": "q1_image_1.png", "alt": "Hình ảnh của câu hỏi", "caption": ""}
      ],
      "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "answer": "B",
      "explanation": "Giải thích chi tiết tại sao B đúng, tại sao A/C/D sai..."
    },
    {
      "id": 2,
      "display_id": "2",
      "type": "fill_blank",
      "blank_id": "blank_1",
      "question": "Mô tả câu cần điền (Blank 1 – ...)",
      "word_bank": ["từ_cho_sẵn_1", "từ_cho_sẵn_2", "từ_cho_sẵn_3", "từ_cho_sẵn_4"],
      "answer": "từ_đúng",
      "explanation": "Giải thích tại sao từ này đúng, nghĩa của từ, cấu trúc câu..."
    },
    {
      "id": 3,
      "display_id": "Tự luận 5",
      "type": "sentence_rewrite",
      "question": "Viết lại câu dùng từ gợi ý: [TỪ GỢI Ý]. Câu gốc: ...",
      "prompt": "Câu gợi ý bắt đầu: ... ___",
      "answer": "câu hoàn chỉnh viết thường",
      "answer_display": "Câu hoàn chỉnh viết hoa đúng chính tả.",
      "explanation": "Giải thích cấu trúc ngữ pháp, cách chuyển đổi câu..."
    }
  ]
}

━━━━━━━━━━━━━━━━━━━━━━━━━━
ĐÂY LÀ ĐỀ THI VÀ ĐÁP ÁN:
━━━━━━━━━━━━━━━━━━━━━━━━━━

[PASTE NỘI DUNG ĐỀ VÀ ĐÁP ÁN VÀO ĐÂY]`;
  return template
    .replaceAll("__EXAM_ID__", id)
    .replaceAll("__EXAM_TITLE__", title);
}
async function handleAssetUpload(req: Request, service: any, actor: any) {
  assertAdmin(actor);
  const form = await req.formData();
  const examFileId = cleanUuid(form.get("exam_file_id"));
  const slotId = cleanSlotId(form.get("slot_id"));
  const file = form.get("file");
  if (!(file instanceof File)) return json({ ok: false, error: "NO_FILE" }, 400);
  const contentType = String(file.type || "").trim().toLowerCase();
  if (!IMAGE_TYPES.has(contentType)) return json({ ok: false, error: "IMAGE_TYPE_NOT_ALLOWED" }, 400);
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) return json({ ok: false, error: "IMAGE_SIZE_NOT_ALLOWED" }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!matchesMagicBytes(contentType, bytes)) return json({ ok: false, error: "IMAGE_SIGNATURE_INVALID" }, 400);

  const online = await fetchOnlineExam(service, examFileId, false);
  if (!online?.id) return json({ ok: false, error: "ONLINE_EXAM_NOT_FOUND" }, 404);
  const ext = extensionForType(contentType);
  const originalName = cleanFileName(file.name) || `${slotId}.${ext}`;
  const safeFileName = originalName.toLowerCase().endsWith(`.${ext}`) ? originalName : `${originalName}.${ext}`;
  const objectKey = `online/${examFileId}/images/${slotId}-${crypto.randomUUID()}.${ext}`;
  await putR2Object(objectKey, bytes, contentType);

  await service
    .from("exam_online_assets")
    .delete()
    .eq("online_exam_id", online.id)
    .ilike("slot_id", slotId);
  const { data, error } = await service
    .from("exam_online_assets")
    .insert({
      online_exam_id: online.id,
      exam_file_id: examFileId,
      slot_id: slotId,
      file_name: safeFileName,
      object_key: objectKey,
      content_type: contentType,
      byte_size: file.size,
      uploaded_by: actor.user.id,
    })
    .select("id,slot_id,file_name,content_type,byte_size,created_at")
    .single();
  if (error) throw new Error(error.message || "ASSET_INSERT_FAILED");
  return json({ ok: true, asset: data });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anonKey || !serviceRole) return json({ ok: false, error: "Missing Supabase env" }, 500);

  const service = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const actor = await getActor(service, req);
  if (!actor.ok) return actor.response;

  try {
    const url = new URL(req.url);
    if (url.searchParams.get("mode") === "asset-upload") {
      return await handleAssetUpload(req, service, actor);
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON payload" }, 400);
    }
    const action = String(body?.action || "").trim().toLowerCase();

    if (action === "admin_list") {
      assertAdmin(actor);
      return json({ ok: true, rows: await adminList(service) });
    }

    if (action === "prompt_sources_list") {
      assertAdmin(actor);
      return json({ ok: true, rows: await promptSourcesList(service) });
    }

    if (action === "save_prompt_source") {
      assertAdmin(actor);
      return json({ ok: true, prompt_source: await savePromptSource(service, actor, body) });
    }

    if (action === "disable_prompt_source") {
      assertAdmin(actor);
      return json({ ok: true, prompt_source: await disablePromptSource(service, actor, body) });
    }

    if (action === "prompt") {
      assertAdmin(actor);
      const examFileId = cleanUuid(body.exam_file_id || body.examFileId);
      const { data: row, error } = await service
        .from("exam_files")
        .select("id,title,level,year,province,exam_code,object_key,storage_path")
        .eq("id", examFileId)
        .maybeSingle();
      if (error) throw new Error(error.message || "EXAM_LOOKUP_FAILED");
      if (!row) return json({ ok: false, error: "EXAM_NOT_FOUND" }, 404);
      const template = await findPromptTemplateForExam(service, row);
      if (!template) {
        return json({
          ok: false,
          error: "PROMPT_SOURCE_NOT_FOUND",
          prompt_source_candidate: promptSourceCandidate(row),
        }, 404);
      }
      return json({
        ok: true,
        prompt: renderPromptTemplate(template, row),
        prompt_source: promptSourcePublic(template),
      });
    }

    if (action === "generate_json_ai") {
      assertAdmin(actor);
      const examFileId = cleanUuid(body.exam_file_id || body.examFileId);
      const { data: row, error } = await service
        .from("exam_files")
        .select("id,title,level,year,province,exam_code,object_key,storage_path,answer_object_key,answer_path,storage_provider")
        .eq("id", examFileId)
        .maybeSingle();
      if (error) throw new Error(error.message || "EXAM_LOOKUP_FAILED");
      if (!row) return json({ ok: false, error: "EXAM_NOT_FOUND" }, 404);
      const template = await findPromptTemplateForExam(service, row);
      if (!template) {
        return json({
          ok: false,
          error: "PROMPT_SOURCE_NOT_FOUND",
          prompt_source_candidate: promptSourceCandidate(row),
        }, 404);
      }
      const prompt = renderPromptTemplate(template, row);
      const nvidiaKey = Deno.env.get("NVIDIA_API_KEY") || "";
      const openAiKey = Deno.env.get("OPENAI_API_KEY") || "";
      if (!nvidiaKey && !openAiKey) return json({ ok: false, error: "AI_API_KEY_NOT_CONFIGURED" }, 500);
      const pdfFiles = await fetchExamPdfForAi(service, row);
      const examJson = nvidiaKey
        ? await generateExamJsonWithNvidia(nvidiaKey, prompt, pdfFiles)
        : await generateExamJsonWithOpenAi(openAiKey, prompt, pdfFiles);
      return json({
        ok: true,
        ...(await saveGeneratedExamJsonDraft(service, actor, examFileId, examJson)),
      });
    }

    if (action === "save_json") {
      assertAdmin(actor);
      const examFileId = cleanUuid(body.exam_file_id || body.examFileId);
      const validated = validateExamJson(body.exam_json || body.examJson);
      validated.exam_id = examFileId;
      const imageSlots = collectImageSlots(validated);
      const payload = {
        exam_file_id: examFileId,
        status: "draft",
        title: validated.title,
        exam_json: validated,
        image_slots: imageSlots,
        question_count: validated.questions.length,
        updated_by: actor.user.id,
        created_by: actor.user.id,
      };
      const { data, error } = await service
        .from("exam_online_exams")
        .upsert(payload, { onConflict: "exam_file_id" })
        .select("id,exam_file_id,status,title,question_count,image_slots,updated_at")
        .single();
      if (error) throw new Error(error.message || "ONLINE_SAVE_FAILED");
      return json({ ok: true, online_exam: data });
    }

    if (action === "publish" || action === "unpublish") {
      assertAdmin(actor);
      const examFileId = cleanUuid(body.exam_file_id || body.examFileId);
      const online = await fetchOnlineExam(service, examFileId, false);
      if (!online?.id) return json({ ok: false, error: "ONLINE_EXAM_NOT_FOUND" }, 404);
      if (action === "publish" && (!online.question_count || online.question_count < 1)) {
        return json({ ok: false, error: "ONLINE_EXAM_EMPTY" }, 400);
      }
      const patch = action === "publish"
        ? { status: "published", published_at: new Date().toISOString(), updated_by: actor.user.id }
        : { status: "draft", published_at: null, updated_by: actor.user.id };
      const { data, error } = await service
        .from("exam_online_exams")
        .update(patch)
        .eq("id", online.id)
        .select("id,exam_file_id,status,title,question_count,image_slots,updated_at,published_at")
        .single();
      if (error) throw new Error(error.message || "ONLINE_PUBLISH_FAILED");
      return json({ ok: true, online_exam: data });
    }

    if (action === "get") {
      const examFileId = cleanUuid(body.exam_file_id || body.examFileId);
      const access = actor.isAdmin || await canAccessExam(supabaseUrl, anonKey, req.headers.get("authorization") || "", examFileId);
      if (!access) return json({ ok: false, error: "Forbidden" }, 403);
      const online = await fetchOnlineExam(service, examFileId, true);
      if (!online?.id) return json({ ok: false, error: "ONLINE_EXAM_NOT_FOUND" }, 404);
      return json({
        ok: true,
        online_exam: {
          id: online.id,
          exam_file_id: online.exam_file_id,
          title: online.title,
          updated_at: online.updated_at,
        },
        exam_json: online.exam_json,
        assets: await signedAssets(service, online.id),
      });
    }

    if (action === "history") {
      const history = await studentAttemptHistory(service, actor);
      return json({ ok: true, ...history });
    }

    if (action === "submit") {
      const examFileId = cleanUuid(body.exam_file_id || body.examFileId);
      const access = await canAccessExam(supabaseUrl, anonKey, req.headers.get("authorization") || "", examFileId);
      if (!access) return json({ ok: false, error: "Forbidden" }, 403);
      const online = await fetchOnlineExam(service, examFileId, true);
      if (!online?.id) return json({ ok: false, error: "ONLINE_EXAM_NOT_FOUND" }, 404);
      const result = scoreExam(online.exam_json, body.answers || {}, body.duration_seconds || body.durationSeconds || 0);
      const { data, error } = await service
        .from("student_online_exam_attempts")
        .insert({
          user_id: actor.user.id,
          exam_file_id: examFileId,
          online_exam_id: online.id,
          score: result.score,
          total: result.total,
          percent: result.percent,
          duration_seconds: result.duration_seconds,
        })
        .select("id,score,total,percent,duration_seconds,submitted_at")
        .single();
      if (error) throw new Error(error.message || "ATTEMPT_INSERT_FAILED");
      return json({ ok: true, result: { ...result, attempt_id: data.id, submitted_at: data.submitted_at } });
    }

    return json({ ok: false, error: "Unknown action" }, 400);
  } catch (e) {
    const msg = String(e?.message || e || "exam_online_failed");
    const status =
      /ADMIN_REQUIRED/i.test(msg) ? 403 :
      /INVALID_EXAM_ID|REQUIRED|INVALID|DUPLICATE|EMPTY/i.test(msg) ? 400 :
      /NOT_FOUND/i.test(msg) ? 404 :
      /R2_NOT_CONFIGURED/i.test(msg) ? 500 :
      400;
    return json({ ok: false, error: msg }, status);
  }
});
