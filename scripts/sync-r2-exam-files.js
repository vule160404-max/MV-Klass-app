#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.resolve(__dirname, '..', '.env.r2.local'));
loadEnvFile(path.resolve(__dirname, '..', '.env.local'));
loadEnvFile(path.resolve(process.cwd(), '.env.r2.local'));
loadEnvFile(path.resolve(process.cwd(), '.env.local'));

const env = process.env;
const SUPABASE_URL = (env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY || '';
const R2_ACCOUNT_ID = env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = env.R2_BUCKET || 'mvklass-exam-files';
const R2_PREFIX = (env.R2_PREFIX || '').replace(/^\/+/, '');
const DRY_RUN = /^(1|true|yes)$/i.test(String(env.MVKLASS_R2_SYNC_DRY_RUN || env.DRY_RUN || ''));
const PRUNE_MISSING = !/^(0|false|no)$/i.test(String(env.MVKLASS_R2_SYNC_PRUNE_MISSING || '1'));

function required(name, value) {
  if (!value) throw new Error(`Missing env ${name}`);
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function encodePath(value) {
  return String(value || '').replace(/^\/+/, '').split('/').map(encodeRfc3986).join('/');
}

function byteCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function hashHex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function signingKey(secret, date) {
  const kDate = hmac(Buffer.from('AWS4' + secret, 'utf8'), date);
  const kRegion = hmac(kDate, 'auto');
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function amzTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function signR2Url(method, path, queryPairs = []) {
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const amzDate = amzTimestamp();
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const pairs = [
    ...queryPairs,
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${R2_ACCESS_KEY_ID}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', '300'],
    ['X-Amz-SignedHeaders', 'host'],
  ].sort(([ak, av], [bk, bv]) => {
    const a = encodeRfc3986(ak);
    const b = encodeRfc3986(bk);
    return byteCompare(a, b) || byteCompare(encodeRfc3986(av), encodeRfc3986(bv));
  });
  const canonicalQuery = pairs.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join('&');
  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    `host:${host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    hashHex(canonicalRequest),
  ].join('\n');
  const signature = hmac(signingKey(R2_SECRET_ACCESS_KEY, dateStamp), stringToSign, 'hex');
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function decodeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function xmlValues(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(decodeXml(m[1]));
  return out;
}

async function listR2Keys() {
  const keys = [];
  let token = '';
  do {
    const query = [['list-type', '2']];
    if (R2_PREFIX) query.push(['prefix', R2_PREFIX]);
    if (token) query.push(['continuation-token', token]);
    const url = signR2Url('GET', `/${encodePath(R2_BUCKET)}`, query);
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) throw new Error(`R2 list failed ${res.status}: ${text.slice(0, 300)}`);
    keys.push(...xmlValues(text, 'Key').filter(k => k && !k.endsWith('/')));
    token = xmlValues(text, 'NextContinuationToken')[0] || '';
  } while (token);
  return Array.from(new Set(keys)).sort((a, b) => a.localeCompare(b));
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function baseName(key) {
  return String(key || '').split('/').pop() || '';
}

function stem(key) {
  return baseName(key).replace(/\.[^.]+$/, '');
}

function guessCategory(key) {
  const n = normalizeText(key);
  if (/\b(dap an|answer)\b/.test(n)) return 'answer';
  if (/\b(audio|listening|nghe)\b/.test(n)) return 'audio';
  if (/\b(chuyen de|topic)\b/.test(n)) return 'topic';
  return 'exam';
}

function guessLevel(key) {
  const n = normalizeText(key);
  if (/\bielts\b/.test(n)) return 'ielts';
  return /\b(thpt|qg|dai hoc|university|12)\b/.test(n) ? 'university' : 'entrance_10';
}

function guessYear(key) {
  const m = String(key || '').match(/20\d{2}/);
  return m ? Number(m[0]) : null;
}

function guessCode(key) {
  const n = normalizeText(stem(key));
  if (/\b(chinh thuc|official)\b/.test(n)) return 'CHINH_THUC';
  const series = n.match(/\bde\s+([a-z]{2,10})\s*0*(\d{1,4})\b/);
  if (series) return `${series[1].toUpperCase()}${String(Number(series[2])).padStart(3, '0')}`;
  const m = n.match(/\bde\s*([a-z]{1,10}\d{1,4}|\d{1,3})\b/);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? String(Number(m[1])).padStart(3, '0') : m[1].toUpperCase().replace(/([A-Z]+)0*(\d+)$/, (_, p, d) => `${p}${String(Number(d)).padStart(3, '0')}`);
}

function guessSortOrder(key) {
  const code = guessCode(key);
  const raw = String(code || '');
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/(\d{1,4})$/);
  return m ? Number(m[1]) : null;
}

function displayProvince(value) {
  const key = normalizeText(value);
  const map = {
    'ha noi': 'Hà Nội',
    'tp hcm': 'TP HCM',
    'ho chi minh': 'TP HCM',
    'thanh hoa': 'Thanh Hóa',
    'nghe an': 'Nghệ An',
    'ha tinh': 'Hà Tĩnh',
    'da nang': 'Đà Nẵng',
    'hai phong': 'Hải Phòng',
    'quang ninh': 'Quảng Ninh',
    'bac ninh': 'Bắc Ninh',
    'bac giang': 'Bắc Giang',
    'nam dinh': 'Nam Định',
    'thai binh': 'Thái Bình',
    'ninh binh': 'Ninh Bình',
    'hai duong': 'Hải Dương',
    'hung yen': 'Hưng Yên',
    'vinh phuc': 'Vĩnh Phúc',
    'phu tho': 'Phú Thọ',
    'nguon tong hop': 'Nguồn tổng hợp',
    'tong hop': 'Nguồn tổng hợp',
  };
  return map[key] || '';
}

function guessProvince(key) {
  const code = normalizeText(guessCode(key) || '');
  let n = normalizeText(stem(key))
    .replace(/\b(dap an|answer|audio|listening|nghe|de|chinh thuc|official|vao|10|thpt|qg|dai hoc|university)\b/g, ' ')
    .replace(/\b20\d{2}\b/g, ' ');
  if (code) n = n.replace(new RegExp(`\\b${code}\\b`, 'g'), ' ');
  n = n.replace(/\s+/g, ' ').trim();
  return displayProvince(n) || null;
}

function prettyTitle(key) {
  const category = guessCategory(key);
  const prefix = category === 'answer' ? 'Đáp án đề' : category === 'audio' ? 'Audio đề' : 'Đề';
  const code = guessCode(key);
  const level = guessLevel(key) === 'university' ? 'THPT' : 'Vào 10';
  const province = guessProvince(key);
  const year = guessYear(key);
  const parts = [prefix, code, level, province, year].filter(Boolean);
  if (parts.length > 2) return parts.join(' ');
  const title = stem(key).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return title || 'Tài liệu Tiếng Anh';
}

function guessSource(key) {
  const n = normalizeText(stem(key));
  if (/\b(vu mai phuong|vmp)\b/.test(n)) return 'Vũ Mai Phương';
  return null;
}

function titleCode(code) {
  const raw = String(code || '').trim();
  const m = raw.match(/^([A-Z]{2,10})0*(\d{1,4})$/);
  return m ? `${m[1]} ${String(Number(m[2])).padStart(3, '0')}` : raw;
}

function prettyTitleClean(key) {
  const category = guessCategory(key);
  const prefix = category === 'answer' ? 'Đáp án đề' : category === 'audio' ? 'Audio đề' : 'Đề';
  const code = guessCode(key);
  const levelKey = guessLevel(key);
  const level = levelKey === 'university' ? 'THPT' : (levelKey === 'ielts' ? 'IELTS' : 'Vào 10');
  const source = guessProvince(key) || guessSource(key);
  const year = guessYear(key);
  const parts = [prefix, titleCode(code), level, source, year].filter(Boolean);
  if (parts.length > 2) return parts.join(' ');
  const title = stem(key).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return title || 'Tài liệu Tiếng Anh';
}

function matchKey(key) {
  return normalizeText(stem(key))
    .replace(/\b(dap an|answer|audio|listening|nghe)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function accessTier(key, category) {
  const n = normalizeText(key);
  return n.includes('premium') || category === 'topic' ? 'premium' : 'free';
}

function description(level) {
  if (level === 'ielts') return 'De luyen thi IELTS mon Tieng Anh.';
  return level === 'university'
    ? 'De luyen thi THPT mon Tieng Anh.'
    : 'De luyen thi Vao 10 mon Tieng Anh.';
}

async function supabaseRequest(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`Supabase ${method} ${path} failed ${res.status}: ${text.slice(0, 500)}`);
  return data;
}

async function findExamByObjectKey(key) {
  if (DRY_RUN && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) return null;
  const rows = await supabaseRequest(
    'GET',
    `exam_files?select=id,object_key&object_key=eq.${encodeURIComponent(key)}&limit=1`,
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function insertOrUpdateMain(key, attachmentKeys) {
  const category = guessCategory(key);
  const level = guessLevel(key);
  const existing = await findExamByObjectKey(key);
  const payload = {
    title: prettyTitleClean(key),
    level,
    subject: 'english',
    year: guessYear(key),
    province: guessProvince(key) || guessSource(key),
    category,
    file_url: null,
    description: description(level),
    storage_provider: 'r2',
    object_key: key,
    answer_object_key: attachmentKeys.answer || null,
    audio_object_key: attachmentKeys.audio || null,
    access_tier: accessTier(key, category),
    exam_code: guessCode(key),
    exam_sort_order: guessSortOrder(key),
    is_published: true,
  };
  if (DRY_RUN) {
    console.log(existing ? 'UPDATE' : 'INSERT', key, payload);
    return;
  }
  if (existing) {
    await supabaseRequest('PATCH', `exam_files?id=eq.${encodeURIComponent(existing.id)}`, payload);
  } else {
    await supabaseRequest('POST', 'exam_files', payload);
  }
}

async function pruneMissingRows(currentKeys) {
  if (!PRUNE_MISSING) return 0;
  if (DRY_RUN && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
    console.log('SKIP prune missing rows: Supabase service role env is not available in dry-run.');
    return 0;
  }
  const filter = R2_PREFIX
    ? `&object_key=like.${encodeURIComponent(R2_PREFIX + '*')}`
    : '';
  const rows = await supabaseRequest(
    'GET',
    `exam_files?select=id,title,object_key&storage_provider=eq.r2&is_published=eq.true${filter}`,
  );
  const missing = (Array.isArray(rows) ? rows : []).filter(row => {
    const key = String(row.object_key || '').trim();
    return key && !currentKeys.has(key);
  });
  for (const row of missing) {
    if (DRY_RUN) {
      console.log('UNPUBLISH missing R2 object', row.object_key, { title: row.title, id: row.id });
    } else {
      await supabaseRequest('PATCH', `exam_files?id=eq.${encodeURIComponent(row.id)}`, {
        is_published: false,
      });
    }
  }
  return missing.length;
}

async function main() {
  if (!DRY_RUN) {
    required('SUPABASE_URL', SUPABASE_URL);
    required('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY);
  }
  required('R2_ACCOUNT_ID', R2_ACCOUNT_ID);
  required('R2_ACCESS_KEY_ID', R2_ACCESS_KEY_ID);
  required('R2_SECRET_ACCESS_KEY', R2_SECRET_ACCESS_KEY);
  required('R2_BUCKET', R2_BUCKET);

  const keys = await listR2Keys();
  const currentKeys = new Set(keys);
  const grouped = new Map();
  for (const key of keys) {
    const mk = matchKey(key);
    if (!grouped.has(mk)) grouped.set(mk, { main: [], answer: [], audio: [] });
    const g = grouped.get(mk);
    const category = guessCategory(key);
    if (category === 'answer') g.answer.push(key);
    else if (category === 'audio') g.audio.push(key);
    else g.main.push(key);
  }

  let count = 0;
  for (const g of grouped.values()) {
    for (const key of g.main) {
      await insertOrUpdateMain(key, {
        answer: g.answer[0] || '',
        audio: g.audio[0] || '',
      });
      count += 1;
    }
  }
  const pruned = await pruneMissingRows(currentKeys);
  console.log(`${DRY_RUN ? 'Dry-run checked' : 'Synced'} ${count} R2 exam rows from ${keys.length} objects. ${DRY_RUN ? 'Would unpublish' : 'Unpublished'} ${pruned} missing rows.`);
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
