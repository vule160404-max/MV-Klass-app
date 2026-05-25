const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const OPENAI_API_KEY = 'THAY_OPENAI_KEY';
const APP_SECRET = 'THAY_APP_SECRET';
const SUPABASE_URL = 'THAY_SUPABASE_URL';
const SUPABASE_KEY = 'THAY_SUPABASE_KEY';
const PORT = 4000;
/** Đổi chuỗi này mỗi lần deploy để đối chiếu nhanh bản đang chạy (JSON + HTTP header). */
const SERVER_BUILD = 'mv-ai-chat-v2-20260207s';

const STORE_FILE = path.join(__dirname, '.ai-chat-memory.json');
const MAX_TAB_MESSAGES = 200;
const RECENT_WINDOW = 8;
const RELEVANT_K = 6;
const PAGE_SIZE = 500;
const MAX_ROWS_PER_TABLE = 2000;
const CONTEXT_CHAR_BUDGET = 14000;
const PLANNER_CONTEXT_CHAR_BUDGET = 5200;
const HISTORY_LINE_CHAR_CAP = 160;
const LOW_CONFIDENCE_THRESHOLD = 0.56;
const QUALITY_REWRITE_THRESHOLD = 0.45;

function loadLocalEnvFile() {
  const files = [path.join(process.cwd(), '.env.local'), path.join(__dirname, '..', '.env.local')];
  const out = {};
  files.forEach((file) => {
    try {
      if (!fs.existsSync(file)) return;
      const raw = fs.readFileSync(file, 'utf8');
      raw.split(/\r?\n/).forEach((line) => {
        const s = String(line || '').trim();
        if (!s || s.startsWith('#')) return;
        const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) return;
        let v = String(m[2] || '').trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (m[1] && out[m[1]] == null) out[m[1]] = v;
      });
    } catch (_) {}
  });
  return out;
}

const LOCAL_ENV = loadLocalEnvFile();

function getConfigValue(hardcoded, key) {
  const raw = String(hardcoded || '').trim();
  const isPlaceholder = !raw || /^THAY_/i.test(raw) || /^your[_\s-]?/i.test(raw) || /^paste[_\s-]?/i.test(raw);
  if (!isPlaceholder) return raw;
  return String((process.env && process.env[key]) || LOCAL_ENV[key] || '').trim();
}

/**
 * Key copy từ web/mail hay dính BOM, zero‑width space, hoặc bị bọc trong dấu ngoặc — trim đơn thuần là chưa đủ.
 */
function normalizeApiSecret(raw) {
  let s = String(raw || '').replace(/^\ufeff/, '');
  s = s.replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\s+/g, '');
  return s;
}

function isOpenAiKeyPlaceholder(k) {
  const x = String(k || '').trim();
  if (!x) return true;
  if (/THAY_OPENAI_KEY/i.test(x)) return true;
  if (/^your[_\s]?openai/i.test(x)) return true;
  if (/^paste[_\s]?key/i.test(x)) return true;
  return false;
}

function getResolvedOpenAiKey() {
  return normalizeApiSecret(getConfigValue(OPENAI_API_KEY, 'OPENAI_API_KEY'));
}

function hasConfiguredOpenAIKey() {
  const k = getResolvedOpenAiKey();
  if (!k) return false;
  if (!k.startsWith('sk-')) return false;
  if (k.length < 20) return false;
  return true;
}

function hasConfiguredSupabase() {
  const url = getResolvedSupabaseUrl();
  const key = getResolvedSupabaseKey();
  if (!url || !key) return false;
  return /^https?:\/\//i.test(url);
}

function getResolvedSupabaseUrl() {
  return getConfigValue(SUPABASE_URL, 'SUPABASE_URL');
}

function getResolvedSupabaseKey() {
  return normalizeApiSecret(getConfigValue(SUPABASE_KEY, 'SUPABASE_KEY'));
}

function getResolvedAppSecret() {
  return normalizeApiSecret(getConfigValue(APP_SECRET, 'APP_SECRET')) || normalizeApiSecret(APP_SECRET);
}

function enrichAiChatResultPayload(payload) {
  const o = payload && typeof payload === 'object' ? Object.assign({}, payload) : {};
  o.server_build = SERVER_BUILD;
  o.openai_ready = hasConfiguredOpenAIKey();
  return o;
}

const USER_DISPLAY_NAME_CHAR_CAP = 80;

function sanitizeUserDisplayName(raw) {
  let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) return '';
  s = s.replace(/\s+/g, ' ');
  if (s.length > USER_DISPLAY_NAME_CHAR_CAP) s = s.slice(0, USER_DISPLAY_NAME_CHAR_CAP).trim();
  return s;
}

function stripLeadingTeacherTitle(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  return s
    .replace(/^(thay|thầy)\s+/i, '')
    .replace(/^(co|cô)\s+/i, '')
    .replace(/^(mr|mrs|ms)\.?\s+/i, '')
    .trim();
}

/** Suy ra cách xưng hô ưu tiên từ tên hiển thị: thầy | cô | thầy/cô. */
function inferAdminHonorific(displayName) {
  const raw = sanitizeUserDisplayName(displayName);
  const n = normalizeText(raw);
  if (/\b(thay|thay giao|thay\.?)\b/.test(n)) return 'thầy';
  if (/\b(co|co giao|co\.?)\b/.test(n)) return 'cô';
  if (/\b(mr|sir)\b/.test(n)) return 'thầy';
  if (/\b(ms|mrs|madam)\b/.test(n)) return 'cô';
  return 'thầy/cô';
}

/** Xưng hô quản trị viên trong câu (lower-case). */
function peerAdminAddress(displayName) {
  const raw = sanitizeUserDisplayName(displayName);
  const honor = inferAdminHonorific(raw);
  const bare = stripLeadingTeacherTitle(raw);
  if (!bare) return honor;
  if (honor === 'thầy') return 'thầy ' + bare;
  if (honor === 'cô') return 'cô ' + bare;
  return 'thầy/cô ' + bare;
}

function peerAdminAddressSentence(displayName) {
  const n = peerAdminAddress(displayName);
  if (!n) return '';
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** Tiền tố "Thầy/Cô ..., " hoặc rỗng — dùng cho câu có gọi đích danh. */
function peerNameVocativePrefix(displayName) {
  const n = peerAdminAddressSentence(displayName);
  return n ? n + ', ' : '';
}

function normalizeAdminAddressingText(text, displayName) {
  let s = String(text || '').trim();
  if (!s) return s;
  const lower = peerAdminAddress(displayName) || 'thầy/cô';
  const upper = peerAdminAddressSentence(displayName) || 'Thầy/cô';
  s = s.replace(/\b[Aa]nh\/\s*chị\b/g, (m) => (m[0] === 'A' ? upper : lower));
  s = s.replace(/\b[Aa]nh\s+chị\b/g, (m) => (m[0] === 'A' ? upper : lower));
  s = s.replace(/\b[Aa]nh\b/g, (m) => (m[0] === 'A' ? upper : lower));
  s = s.replace(/\b[Cc]hị\b/g, (m) => (m[0] === 'C' ? upper : lower));
  return s;
}

function enforceAdminAddressingInResult(result, displayName) {
  if (!result || typeof result !== 'object') return result;
  result.summary = normalizeAdminAddressingText(result.summary, displayName);
  if (result.insight) result.insight = normalizeAdminAddressingText(result.insight, displayName);
  if (result.next_question) result.next_question = normalizeAdminAddressingText(result.next_question, displayName);
  if (Array.isArray(result.targets)) {
    result.targets = result.targets.map((t) => {
      if (!t || typeof t !== 'object') return t;
      const out = Object.assign({}, t);
      if (out.message) out.message = normalizeAdminAddressingText(out.message, displayName);
      if (out.note) out.note = normalizeAdminAddressingText(out.note, displayName);
      return out;
    });
  }
  if (Array.isArray(result.actions)) {
    result.actions = result.actions.map((a) => normalizeAdminAddressingText(a, displayName));
  }
  return result;
}

function buildAdminAddressingStyleLine(displayName) {
  const n = sanitizeUserDisplayName(displayName);
  const honor = inferAdminHonorific(displayName);
  if (!n) {
    return '- Khi nói trực tiếp với quản trị viên đang chat: luôn xưng hô «thầy/cô», tuyệt đối không dùng «anh/chị».';
  }
  return (
    '- ADMIN_DISPLAY_NAME="' +
    n +
    '". Khi nhắn tới quản trị viên đang chat (không phải học viên/phụ huynh trong dữ liệu), xưng hô theo tên hiển thị với chuẩn «' +
    (honor === 'thầy/cô' ? 'thầy/cô ' + stripLeadingTeacherTitle(n) : honor + ' ' + stripLeadingTeacherTitle(n)) +
    '», không dùng «anh/chị».'
  );
}

const EXTRA_TABLES = [
  { name: 'student_tuition', select: '*', order: null },
  { name: 'student_tuition_by_class', select: '*', order: null },
  { name: 'bank_transactions', select: '*', order: null },
  { name: 'bank_webhook_events', select: 'id,provider,received_at,processed,process_note', order: 'received_at.desc' },
  { name: 'consultation_leads', select: '*', order: null },
  { name: 'leaderboard_manual_scores', select: '*', order: null },
  { name: 'leaderboard_performance_history', select: '*', order: 'event_at.desc' },
  { name: 'teacher_check_ins', select: '*', order: 'created_at.desc' },
  { name: 'teacher_schedules', select: '*', order: null },
  { name: 'teacher_classes', select: '*', order: null },
  { name: 'teacher_pay_rates', select: '*', order: null },
  { name: 'teacher_substitutions', select: '*', order: 'date.desc' },
  { name: 'profiles', select: 'id,email,role,display_name', order: null },
  { name: 'payment_links', select: 'id,student_id,parent_phone,ref_code,status,expires_at,last_opened_at,created_at,updated_at', order: 'created_at.desc' },
  { name: 'class_payment_links', select: 'id,class_name,status,expires_at,last_opened_at,created_at,updated_at', order: 'created_at.desc' },
  { name: 'parent_payment_refs', select: 'id,class_link_id,student_id,parent_phone,ref_code,status,expires_at,used_at,created_at,updated_at', order: 'created_at.desc' },
  { name: 'dashboard', select: 'id,title,content,tag,is_active,start_at,end_at,created_at,updated_at', order: 'created_at.desc' },
  { name: 'notification_dispatch_log', select: 'id,kind,target_user_id,class_name,slot_date,slot_start,title,body,created_at', order: 'created_at.desc' },
  { name: 'classes', select: '*', order: null },
  { name: 'class_definitions', select: 'label,display_name,days,schedule,dashboard_hidden', order: null },
  { name: 'class_fees', select: '*', order: null }
];

function readStore() {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : { tabs: {}, feedback: {} };
  } catch (_) {
    return { tabs: {}, feedback: {} };
  }
}

function writeStore(store) {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (_) {}
}

function keyForTab(userId, tabId) {
  const u = String(userId || 'anonymous');
  const t = String(tabId || 'default');
  return u + '::' + t;
}

function getTabMessages(store, userId, tabId) {
  const key = keyForTab(userId, tabId);
  const msgs = (store.tabs && store.tabs[key] && store.tabs[key].messages) || [];
  return Array.isArray(msgs) ? msgs : [];
}

function appendTabMessage(store, userId, tabId, role, content) {
  const key = keyForTab(userId, tabId);
  if (!store.tabs) store.tabs = {};
  if (!store.tabs[key]) store.tabs[key] = { messages: [] };
  const arr = store.tabs[key].messages;
  arr.push({
    role: role === 'assistant' ? 'assistant' : 'user',
    content: String(content || '').trim(),
    ts: Date.now()
  });
  if (arr.length > MAX_TAB_MESSAGES) store.tabs[key].messages = arr.slice(-MAX_TAB_MESSAGES);
}

function keyForFeedback(userId, tabId) {
  return String(userId || 'admin') + '::' + String(tabId || 'default');
}

function getFeedbackProfile(store, userId, tabId) {
  const key = keyForFeedback(userId, tabId);
  if (!store.feedback) store.feedback = {};
  const p = store.feedback[key];
  if (p && typeof p === 'object') return p;
  const init = {
    positive: 0,
    negative: 0,
    clarityNeed: 0,
    detailNeed: 0,
    preferredStyle: 'balanced',
    lastSignals: []
  };
  store.feedback[key] = init;
  return init;
}

function detectFeedbackSignals(text) {
  const t = normalizeText(text);
  const has = (arr) => arr.some((k) => t.includes(k));
  const signals = [];
  if (has(['tot', 'rat tot', 'ok', 'on roi', 'chuan', 'hay'])) signals.push('positive');
  if (has(['kem', 'te', 'chua dung', 'sai roi', 'khong on', 'chan', 'may moc', 'nao ngan'])) signals.push('negative');
  if (has(['ngan gon', 'de hieu', 'ro rang', 'chuyen nghiep'])) signals.push('clarity_need');
  if (has(['chi tiet hon', 'day du hon', 'phan tich sau', 'sau hon', 'toan bo thong tin'])) signals.push('detail_need');
  if (has(['ngan gon']) && !has(['chi tiet hon', 'day du hon'])) signals.push('prefer_brief');
  if (has(['chi tiet hon', 'day du hon', 'sau hon'])) signals.push('prefer_detailed');
  return Array.from(new Set(signals));
}

function updateFeedbackProfile(store, userId, tabId, userText) {
  const p = getFeedbackProfile(store, userId, tabId);
  const signals = detectFeedbackSignals(userText);
  if (!signals.length) return p;
  signals.forEach((s) => {
    if (s === 'positive') p.positive += 1;
    if (s === 'negative') p.negative += 1;
    if (s === 'clarity_need') p.clarityNeed += 1;
    if (s === 'detail_need') p.detailNeed += 1;
    if (s === 'prefer_brief') p.preferredStyle = 'brief';
    if (s === 'prefer_detailed') p.preferredStyle = 'detailed';
  });
  p.lastSignals = p.lastSignals.concat(signals).slice(-12);
  if (p.preferredStyle === 'balanced') {
    if (p.detailNeed - p.clarityNeed >= 2) p.preferredStyle = 'detailed';
    if (p.clarityNeed - p.detailNeed >= 2) p.preferredStyle = 'brief';
  }
  return p;
}

function buildFeedbackStyleGuide(profile) {
  const p = profile || {};
  const style = String(p.preferredStyle || 'balanced');
  const qualityPressure = Number((p.negative || 0) - (p.positive || 0));
  const wantsDetail = Number(p.detailNeed || 0) > Number(p.clarityNeed || 0);
  const base = [
    'USER_FEEDBACK_PROFILE:',
    '- preferred_style=' + style,
    '- negative_minus_positive=' + qualityPressure,
    '- clarity_need=' + Number(p.clarityNeed || 0),
    '- detail_need=' + Number(p.detailNeed || 0),
    '- recent_signals=' + ((p.lastSignals || []).join(',') || 'none')
  ];
  if (qualityPressure >= 2) {
    base.push('- bắt buộc trả lời chặt chẽ, không giọng máy, kết luận rõ và có hành động tiếp theo.');
  }
  if (style === 'brief') {
    base.push('- ưu tiên 1–2 câu summary + 2–4 ý chính.');
  } else if (style === 'detailed' || wantsDetail) {
    base.push('- ưu tiên đầy đủ bối cảnh + số liệu then chốt + đề xuất hành động.');
  } else {
    base.push('- cân bằng giữa ngắn gọn và đầy đủ.');
  }
  return base.join('\n');
}

function applyExplicitFeedback(store, userId, tabId, payload) {
  const p = getFeedbackProfile(store, userId, tabId);
  const vote = String((payload && payload.vote) || '').toLowerCase().trim();
  const prefer = String((payload && payload.preferred_style) || '').toLowerCase().trim();
  const noteSignals = detectFeedbackSignals(String((payload && payload.note) || ''));

  if (vote === 'up' || vote === 'like' || vote === 'positive') p.positive += 2;
  if (vote === 'down' || vote === 'dislike' || vote === 'negative') p.negative += 2;
  if (prefer === 'brief' || prefer === 'balanced' || prefer === 'detailed') p.preferredStyle = prefer;

  noteSignals.forEach((s) => {
    if (s === 'positive') p.positive += 1;
    if (s === 'negative') p.negative += 1;
    if (s === 'clarity_need') p.clarityNeed += 1;
    if (s === 'detail_need') p.detailNeed += 1;
    if (s === 'prefer_brief') p.preferredStyle = 'brief';
    if (s === 'prefer_detailed') p.preferredStyle = 'detailed';
  });
  p.lastSignals = p.lastSignals.concat(['explicit_feedback']).slice(-12);

  if (p.preferredStyle === 'balanced') {
    if (p.detailNeed - p.clarityNeed >= 2) p.preferredStyle = 'detailed';
    if (p.clarityNeed - p.detailNeed >= 2) p.preferredStyle = 'brief';
  }
  return p;
}

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function overlapScore(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  sa.forEach((w) => {
    if (sb.has(w)) inter++;
  });
  return inter / Math.max(sa.size, 1);
}

function recencyScore(idx, total) {
  if (total <= 1) return 1;
  return Math.max(0, Math.min(1, idx / (total - 1)));
}

function intentHintFromText(text) {
  const t = normalizeText(text);
  if (!t) return 'general';
  if (/doanh thu|revenue|thang nay|thang truoc|so voi|tang|giam|chenh lech/.test(t)) return 'revenue_compare';
  if (/diem danh|vang|di hoc|co mat|attendance|present|absent/.test(t)) return 'attendance_ops';
  if (/hoc sinh|hoc vien|ho so|lop nao|chi tiet hoc vien/.test(t)) return 'student_360';
  if (/cong no|no hoc phi|chua dong|no buoi|debt/.test(t)) return 'debt_ops';
  if (/giao dich|chuyen khoan|doi soat|ngan hang|pending/.test(t)) return 'bank_ops';
  if (/lead|tu van|phu huynh moi/.test(t)) return 'lead_ops';
  return 'general';
}

function pickRelevantMessages(tabMessages, query, k, intentName) {
  const q = String(query || '');
  if (!tabMessages.length || !q.trim()) return [];
  const intent = String(intentName || 'general');
  const total = tabMessages.length;
  const scored = tabMessages
    .map((m, idx) => {
      const lexical = overlapScore(m.content, q);
      const recency = recencyScore(idx, total);
      const hint = intentHintFromText(m.content);
      const intentMatch = hint === intent ? 1 : hint === 'general' ? 0.45 : 0;
      const score = lexical * 0.55 + recency * 0.3 + intentMatch * 0.15;
      return { idx, msg: m, score, lexical };
    })
    .filter((x) => x.lexical > 0 || x.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .sort((a, b) => a.idx - b.idx);
  return scored.map((x) => x.msg);
}

function supabaseFetch(table, query) {
  return new Promise((resolve) => {
    let urlObj = null;
    const supabaseUrl = getResolvedSupabaseUrl();
    const supabaseKey = getResolvedSupabaseKey();
    try {
      urlObj = new URL(String(supabaseUrl || '').trim());
    } catch (_) {
      resolve([]);
      return;
    }
    if (!urlObj || !urlObj.hostname || !String(supabaseKey || '').trim()) {
      resolve([]);
      return;
    }
    const options = {
      hostname: urlObj.hostname,
      path: '/rest/v1/' + table + '?' + (query || 'limit=500'),
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        Authorization: 'Bearer ' + supabaseKey
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

function supabaseHttpRequest(pathname, headers) {
  return new Promise((resolve) => {
    let urlObj = null;
    const supabaseUrl = getResolvedSupabaseUrl();
    try {
      urlObj = new URL(String(supabaseUrl || '').trim());
    } catch (_) {
      resolve({ status: 0, body: '' });
      return;
    }
    if (!urlObj || !urlObj.hostname) {
      resolve({ status: 0, body: '' });
      return;
    }
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: pathname,
        method: 'GET',
        headers: headers || {}
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      }
    );
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

function parseJsonSafe(raw, fallback) {
  try {
    return JSON.parse(String(raw || ''));
  } catch (_) {
    return fallback;
  }
}

function getBearerToken(req) {
  const h = String((req && req.headers && req.headers.authorization) || '').trim();
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? normalizeApiSecret(m[1]) : '';
}

async function verifySupabaseAdminRequest(req) {
  const token = getBearerToken(req);
  const supabaseKey = getResolvedSupabaseKey();
  if (!token || !hasConfiguredSupabase()) return null;
  const authHeaders = {
    apikey: supabaseKey,
    Authorization: 'Bearer ' + token
  };
  const userRes = await supabaseHttpRequest('/auth/v1/user', authHeaders);
  if (userRes.status < 200 || userRes.status >= 300) return null;
  const user = parseJsonSafe(userRes.body, null);
  const userId = user && user.id ? String(user.id) : '';
  if (!userId) return null;
  const profilePath =
    '/rest/v1/profiles?select=role&id=eq.' + encodeURIComponent(userId) + '&limit=1';
  const profileRes = await supabaseHttpRequest(profilePath, authHeaders);
  if (profileRes.status < 200 || profileRes.status >= 300) return null;
  const profiles = parseJsonSafe(profileRes.body, []);
  const role = Array.isArray(profiles) && profiles[0] ? String(profiles[0].role || '') : '';
  if (role !== 'admin') return null;
  return { id: userId, email: user.email || '', role };
}

function toArraySafe(v) {
  return Array.isArray(v) ? v : [];
}

async function supabaseFetchAllPages(table, select, order) {
  let all = [];
  let offset = 0;
  while (all.length < MAX_ROWS_PER_TABLE) {
    const remain = Math.max(1, Math.min(PAGE_SIZE, MAX_ROWS_PER_TABLE - all.length));
    let q = 'select=' + encodeURIComponent(select || '*') + '&limit=' + remain + '&offset=' + offset;
    if (order) q += '&order=' + encodeURIComponent(order);
    const rows = toArraySafe(await supabaseFetch(table, q));
    if (!rows.length) break;
    all = all.concat(rows);
    if (rows.length < remain) break;
    offset += remain;
  }
  return all;
}

async function layDuLieuFallback() {
  if (!hasConfiguredSupabase()) {
    return { students: [], attendance: [], payment: [], extra: {} };
  }
  const students = await supabaseFetchAllPages('students', 'id,name,phone,class_name,class_names,parent_name,birth_year,learning_note', 'name.asc');
  const attendance = await supabaseFetchAllPages('attendance', 'student_id,date,status,class_name', 'date.desc');
  const payments = await supabaseFetchAllPages(
    'payment_history',
    'id,student_id,sessions_paid,amount_vnd,paid_at,created_at,payment_channel,class_name,reconcile_note,bank_transaction_id,sessions_applied_to_charged,prepaid_topup_vnd,attendance_lesson_date',
    'paid_at.desc'
  );
  const extra = {};
  for (const t of EXTRA_TABLES) {
    try {
      extra[t.name] = await supabaseFetchAllPages(t.name, t.select || '*', t.order || null);
    } catch (_) {
      extra[t.name] = [];
    }
  }
  return { students, attendance, payment: payments, extra };
}

function compactJson(obj, maxLen) {
  try {
    const s = JSON.stringify(obj || {});
    const n = maxLen || 260;
    return s.length > n ? s.slice(0, n) + 'â€¦' : s;
  } catch (_) {
    return '';
  }
}

function fitTextBudget(s, maxLen) {
  const t = String(s || '');
  const n = Number(maxLen || 0) || 0;
  if (!n || t.length <= n) return t;
  return t.slice(0, Math.max(0, n - 1)) + 'â€¦';
}


function trimLinesToBudget(text, maxChars) {
  const lines = String(text || '').split('\n');
  const out = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const take = fitTextBudget(line, 180);
    if (used + take.length + 1 > maxChars) break;
    out.push(take);
    used += take.length + 1;
  }
  return out.join('\n');
}

function buildKnowledgeDigest(extra) {
  const e = extra && typeof extra === 'object' ? extra : {};
  const lines = [];
  Object.keys(e).forEach((k) => {
    const arr = toArraySafe(e[k]);
    lines.push('- ' + k + ': ' + arr.length + ' dòng');
    const sample = arr.slice(0, 4).map((r, i) => '  [' + (i + 1) + '] ' + compactJson(r, 240));
    if (sample.length) lines.push(sample.join('\n'));
  });
  return lines.join('\n');
}

function distinctNonEmpty(arr) {
  const s = new Set();
  (arr || []).forEach((x) => {
    const v = String(x == null ? '' : x).trim();
    if (v) s.add(v);
  });
  return Array.from(s);
}

function buildExtendedOpsContext(students, attendance, payments, extra) {
  const stu = toArraySafe(students);
  const att = toArraySafe(attendance);
  const pay = toArraySafe(payments);
  const bank = toArraySafe(extra && extra.bank_transactions);
  const leads = toArraySafe(extra && extra.consultation_leads);
  const lbs = toArraySafe(extra && extra.leaderboard_manual_scores);
  const schedules = toArraySafe(extra && extra.teacher_schedules);

  const classes = distinctNonEmpty(stu.map((x) => x.class_name)).sort();
  const teacherByClass = {};
  schedules.forEach((r) => {
    const c = String((r && (r.class_name || r.class || r.classCode)) || '').trim();
    const t = String((r && (r.teacher_name || r.teacher || r.teacher_id || '')) || '').trim();
    if (c && t && !teacherByClass[c]) teacherByClass[c] = t;
  });

  const byStudentPaid = {};
  pay.forEach((p) => {
    const sid = String(p && p.student_id);
    if (!sid) return;
    byStudentPaid[sid] = (byStudentPaid[sid] || 0) + Number(p.amount_vnd || 0);
  });
  const unpaid = stu.filter((s) => !byStudentPaid[String(s.id)]);

  const now = new Date();
  const windows = [7, 14, 30];
  const absentByWindow = {};
  windows.forEach((w) => (absentByWindow[w] = {}));
  att.forEach((a) => {
    if (!a || a.status !== 'absent' || !a.date) return;
    const d = new Date(a.date);
    if (isNaN(d.getTime())) return;
    windows.forEach((w) => {
      const m = new Date(now);
      m.setDate(m.getDate() - w);
      if (d >= m) {
        const sid = String(a.student_id || '');
        if (sid) absentByWindow[w][sid] = (absentByWindow[w][sid] || 0) + 1;
      }
    });
  });

  const overdueLeads = leads.filter((l) => {
    const st = String((l && l.status) || '').toLowerCase();
    return st === 'new' || st === 'pending' || st === 'open';
  });
  const bankPending = bank.filter((b) => {
    const st = String((b && (b.status || b.tx_status)) || '').toLowerCase();
    return st === 'pending' || st === 'needs_review' || st === 'review';
  });

  const lbTop = lbs
    .slice()
    .sort(
      (a, b) =>
        Number((b && (b.performance_pts || b.performance_score || b.performance || 0)) || 0) -
        Number((a && (a.performance_pts || a.performance_score || a.performance || 0)) || 0)
    )
    .slice(0, 10)
    .map((r) => {
      const name = String((r && (r.student_name || r.name || r.student_id || '')) || '').trim();
      const perf = Number((r && (r.performance_pts || r.performance_score || r.performance || 0)) || 0);
      const cont = Number((r && (r.contribution_pts || r.contribution_score || r.contribution || 0)) || 0);
      const mini = Number((r && (r.minigame_pts || r.minigame_score || r.minigame || 0)) || 0);
      return '- ' + name + ' | performance=' + perf + ' | contribution=' + cont + ' | minigame=' + mini;
    });

  const risky = stu
    .map((s) => {
      const sid = String(s.id);
      return {
        name: s.name || '',
        phone: s.phone || '',
        class_name: s.class_name || '',
        a14: absentByWindow[14][sid] || 0,
        a30: absentByWindow[30][sid] || 0,
        paid: byStudentPaid[sid] || 0
      };
    })
    .filter((x) => x.a14 >= 3 || (x.a30 >= 5 && x.paid <= 0))
    .slice(0, 80)
    .map(
      (x) =>
        '- ' +
          x.name +
          ' | Lớp: ' +
          x.class_name +
          ' | SĐT: ' +
          (x.phone || '') +
          ' | vắng14=' +
          x.a14 +
          ' | vắng30=' +
          x.a30 +
          ' | paid=' +
          x.paid
    );

  const byClassUnpaid = {};
  unpaid.forEach((s) => {
    const c = String(s.class_name || 'Không rõ lớp');
    byClassUnpaid[c] = (byClassUnpaid[c] || 0) + 1;
  });
  const unpaidByClassLines = Object.keys(byClassUnpaid)
    .sort((a, b) => byClassUnpaid[b] - byClassUnpaid[a])
    .slice(0, 30)
    .map((c) => '- ' + c + ': ' + byClassUnpaid[c]);

  const studentsIndex = stu.slice(0, 250).map((s) => {
    const c = String(s.class_name || '').trim();
    return '- id=' + s.id + ' | ' + (s.name || '') + ' | SĐT=' + (s.phone || '') + ' | Lớp=' + c + (teacherByClass[c] ? ' | GV=' + teacherByClass[c] : '');
  });

  return (
    '=== OPERATIONS CONTEXT ===\n' +
    'SỐ LỚP ĐANG HOẠT ĐỘNG: ' +
    classes.length +
    '\n' +
    'UNPAID BY CLASS (TOP):\n' +
    (unpaidByClassLines.join('\n') || 'Không có') +
    '\n\n' +
    'HỌC VIÊN RỦI RO (vắng nhiều / chưa đóng):\n' +
    (risky.join('\n') || 'Không có') +
    '\n\n' +
    'GIAO DỊCH NGÂN HÀNG CẦN XỬ LÝ: ' +
    bankPending.length +
    '\n' +
    'CONSULT LEADS CẦN FOLLOW-UP: ' +
    overdueLeads.length +
    '\n\n' +
    'LEADERBOARD TOP:\n' +
    (lbTop.join('\n') || 'Không có') +
    '\n\n' +
    'STUDENTS INDEX (mẫu):\n' +
    (studentsIndex.join('\n') || 'Không có') +
    '\n'
  );
}

function toDateSafe(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const raw = String(v || '').trim();
  if (!raw) return null;
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function toMonthKey(d) {
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return y + '-' + m;
}

function normalizeText(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trích tháng (YYYY-MM) từ câu hỏi: "tháng 4", "thang 4/2025", "t4" */
function parseRevenueMonthKeyFromMessage(message, refDate) {
  const raw = String(message || '');
  const mNorm = normalizeText(raw);
  const ref = refDate && !isNaN(new Date(refDate).getTime()) ? new Date(refDate) : new Date();
  const yExplicit = raw.match(/(?:năm|nam)\s*(\d{4})/i) || mNorm.match(/\bnam\s*(\d{4})\b/);
  const yearFromMsg = yExplicit ? parseInt(yExplicit[1], 10) : null;
  let monthNum = null;
  const th = mNorm.match(/\bthang\s*(\d{1,2})\b/);
  if (th) monthNum = parseInt(th[1], 10);
  if (monthNum == null) {
    const tshort = mNorm.match(/\bt\s*(\d{1,2})\b/);
    if (tshort) monthNum = parseInt(tshort[1], 10);
  }
  if (monthNum == null || monthNum < 1 || monthNum > 12) return null;
  let y = yearFromMsg;
  if (!y) {
    y = ref.getFullYear();
    const cm = ref.getMonth() + 1;
    if (monthNum > cm) y -= 1;
  }
  const mm = String(monthNum).padStart(2, '0');
  return y + '-' + mm;
}

function formatVndAmount(n) {
  const x = Math.round(Number(n) || 0);
  try {
    return x.toLocaleString('vi-VN') + ' đ';
  } catch (_) {
    return String(x) + ' đ';
  }
}

function monthKeyLabelVi(mk) {
  const p = String(mk || '').split('-');
  if (p.length !== 2) return mk;
  return parseInt(p[1], 10) + '/' + p[0];
}

function paymentRowAmount(p) {
  return Number((p && (p.amount_vnd ?? p.amount ?? p.total ?? p.paid_amount ?? p.value)) || 0);
}

function paymentRowDate(p) {
  return toDateSafe(p && (p.paid_at || p.created_at || p.payment_date || p.date));
}

function normalizeDateToYmd(v) {
  if (!v) return '';
  const d = toDateSafe(v);
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + dd;
}

function sumRevenueForMonthKey(payments, monthKey) {
  const mkTarget = String(monthKey || '');
  let sum = 0;
  let n = 0;
  toArraySafe(payments).forEach((p) => {
    const d = paymentRowDate(p);
    if (!d) return;
    if (toMonthKey(d) !== mkTarget) return;
    sum += paymentRowAmount(p);
    n += 1;
  });
  return { sum, count: n };
}

function buildAnalyticsContext(students, attendance, payments, extra, userMessage) {
  const stu = toArraySafe(students);
  const att = toArraySafe(attendance);
  const pay = toArraySafe(payments);
  const tuitionByClass = toArraySafe(extra && extra.student_tuition_by_class);

  const now = new Date();
  const thisMonth = toMonthKey(now);
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonth = toMonthKey(lastMonthDate);

  const requestedMonthKey = userMessage ? parseRevenueMonthKeyFromMessage(userMessage, now) : null;

  let revThis = 0;
  let revLast = 0;
  pay.forEach((p) => {
    const d = paymentRowDate(p);
    if (!d) return;
    const mk = toMonthKey(d);
    const amount = paymentRowAmount(p);
    if (mk === thisMonth) revThis += amount;
    if (mk === lastMonth) revLast += amount;
  });
  const revDiff = revThis - revLast;
  const revGrowthPct = revLast > 0 ? ((revThis - revLast) / revLast) * 100 : null;

  let singleMonthBlock = '';
  if (requestedMonthKey) {
    const { sum, count } = sumRevenueForMonthKey(pay, requestedMonthKey);
    singleMonthBlock =
      'REVENUE_MONTH(' +
      requestedMonthKey +
      '): ' +
      sum +
      '\n' +
      'REVENUE_MONTH_PAYMENT_COUNT(' +
      requestedMonthKey +
      '): ' +
      count +
      '\n' +
      'REVENUE_MONTH_LABEL: ' +
      monthKeyLabelVi(requestedMonthKey) +
      '\n';
  }

  const attendanceByMonth = {};
  att.forEach((a) => {
    const d = toDateSafe(a && (a.date || a.created_at || a.updated_at));
    if (!d) return;
    const mk = toMonthKey(d);
    if (!attendanceByMonth[mk]) attendanceByMonth[mk] = { present: 0, absent: 0 };
    const st = String((a && a.status) || '').toLowerCase();
    if (st === 'present') attendanceByMonth[mk].present += 1;
    if (st === 'absent') attendanceByMonth[mk].absent += 1;
  });
  const attThis = attendanceByMonth[thisMonth] || { present: 0, absent: 0 };
  const attLast = attendanceByMonth[lastMonth] || { present: 0, absent: 0 };

  const debtTop = tuitionByClass
    .map((r) => ({
      student_id: String((r && r.student_id) || ''),
      name: String((r && (r.student_name || r.name)) || '').trim(),
      class_name: String((r && r.class_name) || '').trim(),
      due_sessions: Number((r && (r.sessions_due || r.debt_sessions || r.remaining_sessions || 0)) || 0),
      due_amount: Number((r && (r.amount_due || r.debt_amount || r.remaining_amount || 0)) || 0)
    }))
    .filter((x) => x.name && (x.due_sessions > 0 || x.due_amount > 0))
    .sort((a, b) => (b.due_amount || 0) - (a.due_amount || 0))
    .slice(0, 30)
    .map((x) => '- ' + x.name + ' | Lớp: ' + x.class_name + ' | no_buoi=' + x.due_sessions + ' | no_tien=' + x.due_amount);

  return (
    '=== ANALYTICS CONTEXT ===\n' +
    singleMonthBlock +
    'REVENUE_THIS_MONTH(' +
    thisMonth +
    '): ' +
    revThis +
    '\n' +
    'REVENUE_LAST_MONTH(' +
    lastMonth +
    '): ' +
    revLast +
    '\n' +
    'REVENUE_DIFF: ' +
    revDiff +
    '\n' +
    'REVENUE_GROWTH_PCT: ' +
    (revGrowthPct == null ? 'N/A' : revGrowthPct.toFixed(2)) +
    '\n' +
    'ATTENDANCE_THIS_MONTH: present=' +
    attThis.present +
    ', absent=' +
    attThis.absent +
    '\n' +
    'ATTENDANCE_LAST_MONTH: present=' +
    attLast.present +
    ', absent=' +
    attLast.absent +
    '\n' +
    'DEBT_TOP_SAMPLE:\n' +
    (debtTop.join('\n') || 'Không có') +
    '\n' +
    'TOTAL_STUDENTS=' +
    stu.length +
    '\n'
  );
}

/**
 * Khớp tên học viên với câu hỏi — không dùng query.includes(name):
 * "chao" (Chào) chứa substring "hao" → trước đây khớp nhầm học viên "Hào".
 */
function scoreStudentNameAgainstQuery(message, studentName) {
  const qNorm = normalizeText(message);
  const nNorm = normalizeText(studentName);
  if (!qNorm || !nNorm) return 0;
  let score = 0;
  const qWords = qNorm.split(/\s+/).filter((x) => x.length >= 2);
  const qTokens = new Set(qWords);
  const nTokens = nNorm.split(/\s+/).filter((x) => x.length >= 2);
  nTokens.forEach((t) => {
    if (qTokens.has(t)) score += 1;
  });
  if (qNorm === nNorm) score += 8;
  else {
    const esc = qNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const asWholePhrase = new RegExp('(^|\\s)' + esc + '(\\s|$)').test(nNorm);
    if (
      asWholePhrase &&
      (qNorm.length >= 3 || qWords.length >= 2)
    ) {
      score += 5;
    }
  }
  return score;
}

function findStudentCandidates(message, students) {
  const qNorm = normalizeText(message);
  if (!qNorm) return [];
  const list = toArraySafe(students)
    .map((s) => {
      const name = String((s && s.name) || '').trim();
      const score = scoreStudentNameAgainstQuery(message, name);
      return score > 0
        ? {
            student: s,
            score
          }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return list.slice(0, 3).map((x) => x.student);
}

function findStudentCandidatesWithScore(message, students) {
  const qNorm = normalizeText(message);
  if (!qNorm) return [];
  return toArraySafe(students)
    .map((s) => {
      const name = String((s && s.name) || '').trim();
      const score = scoreStudentNameAgainstQuery(message, name);
      return score > 0 ? { student: s, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

function detectIntent(message) {
  if (isSmallTalk(message)) {
    return {
      name: 'general',
      confidence: 0.9,
      wantsCompare: false,
      wantsRevenue: false,
      wantsDebt: false,
      wantsAttendance: false,
      wantsStudent360: false,
      wantsClass: false,
      wantsBank: false,
      wantsLead: false
    };
  }
  const m = normalizeText(message);
  const has = (arr) => arr.some((k) => m.includes(k));
  const wantsCompare = has(['thang nay', 'thang truoc', 'so voi', 'tang', 'giam', 'chenh lech']);
  /** Ví dụ: "doanh thu tháng 4" — cố định phải vào luồng revenue (không chỉ so 2 tháng). */
  const wantsRevenueByMonth = /\bthang\s*\d{1,2}\b/.test(m);
  const wantsRevenue = has(['doanh thu', 'revenue', 'thu hoc phi', 'thu tien']);
  const wantsDebt = has([
    'cong no',
    'con no',
    'dang no',
    'no hoc phi',
    'hoc phi no',
    'hoc phi con no',
    'con no hoc phi',
    'no buoi',
    'chua dong',
    'debt',
    'hoc vien no',
    'hoc sinh no',
    'no nhieu',
    'no cao'
  ]);
  const wantsAttendance = has(['diem danh', 'vang', 'di hoc', 'co mat', 'attendance', 'present', 'absent']);
  const hasOpsMetricWords = has(['doanh thu', 'cong no', 'hoc phi', 'diem danh', 'giao dich', 'ngan hang', 'lead']);
  const asksStudentByLoosePhrase = !hasOpsMetricWords && /\b(thong tin|ho so|chi tiet)\s+[a-z0-9]/.test(m);
  // Khớp "be/em" có thể là xưng học sinh nhỏ; **không** khớp từ "bạn" (vd "không phải bạn" → tránh nhầm student_360).
  const wantsStudent360 =
    has(['hoc sinh', 'thong tin hoc sinh', 'ho so hoc vien', 'chi tiet hoc vien']) ||
    /\b(hoc sinh|hoc vien)\s+[a-z0-9]/.test(m) ||
    asksStudentByLoosePhrase ||
    !!m.match(/\b(be|em)\b/);
  const wantsClass = has(['lop nao', 'lich hoc', 'ca hoc', 'class']);
  const wantsBank = has(['giao dich', 'chuyen khoan', 'doi soat', 'ngan hang', 'pending']);
  const wantsLead = has(['lead', 'tu van', 'phu huynh moi']);

  let intent = 'general';
  let confidence = 0.52;
  if ((wantsCompare && wantsRevenue) || (wantsRevenue && wantsRevenueByMonth)) intent = 'revenue_compare';
  else if (has(['doanh thu', 'revenue'])) intent = 'revenue_compare';
  else if (wantsAttendance) intent = 'attendance_ops';
  else if (wantsDebt) intent = 'debt_ops';
  else if (wantsStudent360 || wantsClass) intent = 'student_360';
  else if (wantsBank) intent = 'bank_ops';
  else if (wantsLead) intent = 'lead_ops';

  const voteCount =
    (wantsCompare ? 1 : 0) +
    (wantsRevenue ? 1 : 0) +
    (wantsDebt ? 1 : 0) +
    (wantsAttendance ? 1 : 0) +
    (wantsStudent360 ? 1 : 0) +
    (wantsClass ? 1 : 0) +
    (wantsBank ? 1 : 0) +
    (wantsLead ? 1 : 0);
  if (intent !== 'general') confidence = 0.66 + Math.min(0.26, voteCount * 0.04);
  if (voteCount >= 3) confidence -= 0.08;
  confidence = Math.max(0.35, Math.min(0.95, confidence));

  return {
    name: intent,
    confidence: Number(confidence.toFixed(2)),
    wantsCompare,
    wantsRevenue,
    wantsDebt,
    wantsAttendance,
    wantsStudent360,
    wantsClass,
    wantsBank,
    wantsLead
  };
}

/** Đồng bộ cờ wants* theo intent.name (sau khi LLM hoặc refine đổi nhánh). */
function syncIntentFlagsFromName(intent) {
  const out = intent && typeof intent === 'object' ? Object.assign({}, intent) : detectIntent('');
  const n = String(out.name || 'general');
  out.wantsRevenue = n === 'revenue_compare';
  out.wantsDebt = n === 'debt_ops';
  out.wantsAttendance = n === 'attendance_ops';
  out.wantsStudent360 = n === 'student_360';
  out.wantsBank = n === 'bank_ops';
  out.wantsLead = n === 'lead_ops';
  if (n !== 'revenue_compare') out.wantsCompare = false;
  if (n !== 'student_360') out.wantsClass = false;
  return out;
}

/**
 * "Dương" / họ tên ngắn → coi là tra hồ sơ học viên để vào STUDENT 360 + debt_total.
 * (detectIntent chỉ không bắt được nếu thiếu từ "học sinh".)
 */
/**
 * Câu kiểu "tổng quan / báo cáo / thống kê" — token "quan" trong "tổng quan" dễ khớp nhầm học viên tên "Quân".
 */
function isOperationalOverviewMessage(message) {
  const n = normalizeText(message || '');
  if (!n) return false;
  if (/tong quan|bao cao|thong ke|tom tat|kpi|overview|dash board|dashboard|snap shot|tinh hinh trung tam/.test(n)) {
    return true;
  }
  if (/(hom nay|hom qua|tuan nay|tuan truoc)/.test(n) && /(diem danh|hoc phi|lich day|lich hoc|giao vien|ca hoc|doanh thu|cong no)/.test(n)) {
    return true;
  }
  return false;
}

function refineIntentWithLikelyStudentName(userMessage, students, detected) {
  const d = detected && typeof detected === 'object' ? detected : null;
  if (!d) return detected;
  const name = String(d.name || 'general');
  if (name !== 'general') return d;
  if (isSmallTalk(userMessage)) return d;
  if (isOperationalOverviewMessage(userMessage)) return d;
  const list = toArraySafe(students);
  if (!list.length) return d;

  const mNorm = normalizeText(userMessage || '');
  if (!mNorm || mNorm.length < 2) return d;
  if (mNorm.split(/\s+/).filter(Boolean).length > 10) return d;

  const scored = findStudentCandidatesWithScore(userMessage || '', list);
  if (!scored.length) return d;
  const top = scored[0];
  const close = scored.filter((x) => x.score >= Math.max(1, top.score - 1)).slice(0, 8);
  // Chỉ điểm 1 từ trùng token (vd "quan" trong "tổng quan") — không đủ để coi là hỏi hồ sơ 1 học viên.
  if (close.length !== 1 || top.score < 2) return d;

  return Object.assign({}, d, {
    name: 'student_360',
    confidence: Math.max(Number(d.confidence || 0.52), 0.76),
    wantsStudent360: true
  });
}

function buildIntentGuidance(intent) {
  const name = (intent && intent.name) || 'general';
  const map = {
    revenue_compare:
      'INTENT_GUIDE: So sánh doanh thu. Bắt buộc: nếu REVENUE_THIS_MONTH/REVENUE_LAST_MONTH có dữ liệu thì phải tính chênh lệch và % tăng/giảm, kết luận rõ ràng.',
    student_360:
      'INTENT_GUIDE: Truy vấn 1 học viên. Mặc định: 3–8 câu hoặc 1 đoạn ngắn (họ tên, lớp, có mặt/vắng, nợ buổi+tiền nếu có, SĐT khi có) — không UUID/ID, không nhãn kỹ thuật (sessions_due...), không câu "xem phía trên" thay cho số liệu. Chỉ trả báo dài (chi tiết/liệt kê buổi…) khi user yêu cầu đầy đủ/liệt kê chi tiết. Snapshot tuition_ui → bắt buộc bám pending_buoi/owed_vnd khi trả về nợ.',
    debt_ops:
      'INTENT_GUIDE: Công nợ học phí. Ưu tiên danh sách cần xử lý + mức độ ưu tiên.',
    attendance_ops:
      'INTENT_GUIDE: Điểm danh/vắng học. Ưu tiên xu hướng vắng và cảnh báo học viên rủi ro.',
    bank_ops:
      'INTENT_GUIDE: Đối soát giao dịch. Ưu tiên các giao dịch pending/needs_review.',
    lead_ops:
      'INTENT_GUIDE: Quản lý lead tư vấn. Ưu tiên lead quá hạn follow-up.',
    general: 'INTENT_GUIDE: Trả lời theo mục tiêu vận hành, kết luận trước, chi tiết sau.'
  };
  return map[name] || map.general;
}

function buildIntentToneGuide(intent) {
  const name = (intent && intent.name) || 'general';
  const tone = {
    revenue_compare:
      'TONE: analyst-like but friendly. Start with trend conclusion (tang/giam), then 1-2 key numbers, then practical recommendation.',
    student_360:
      'TONE: gọn và đầy đủ thông tin cần làm việc. Tránh dàn ý máy/meeting minutes; không lặp dữ liệu rỗng (không có thì không liệt kê dòng "—"); không một câu chung chung thay cho số.',
    debt_ops:
      'TONE: operations-focused. Prioritize urgency, mention who/what should be handled first, keep concise.',
    attendance_ops:
      'TONE: teacher-supportive. Highlight risk signals and concrete follow-up actions.',
    bank_ops:
      'TONE: precise and audit-friendly. State pending issues and exact next checks.',
    lead_ops:
      'TONE: sales-ops friendly. Focus on conversion priority and overdue follow-up.',
    general:
      'TONE: helpful assistant. Natural, concise, clear, human-like.'
  };
  return tone[name] || tone.general;
}

/** Gom số liệu 1 học viên (tái dùng cho context model + bản tóm tắt tiếng Việt đầy đủ). */
function computeStudent360Metrics(s, att, pay, tuitionByClass, tuitionRaw, cls, classFees, tuitionUi) {
  const normalizeClassKey = (v) => normalizeText(String(v || ''));
  const feeByClassKey = {};
  toArraySafe(classFees).forEach((r) => {
    const key = normalizeClassKey(r && (r.class_name || r.class || r.name));
    if (!key) return;
    const fee = Number(
      (r && (r.fee_per_session || r.fee || r.amount_vnd || r.tuition_fee || r.amount)) || 0
    );
    if (!Number.isFinite(fee) || fee <= 0) return;
    if (!feeByClassKey[key]) feeByClassKey[key] = fee;
  });

  const sid = String((s && s.id) || '');
  const name = String((s && s.name) || '');
  const phone = String((s && s.phone) || '');
  const className = String((s && s.class_name) || '');
  const parentName = String((s && s.parent_name) || '');
  const dob = String((s && (s.dob || s.date_of_birth || s.birthday)) || '');
  const noteStu = String((s && (s.note || s.notes || s.comment)) || '').trim();

  const attRowsAll = toArraySafe(att).filter((a) => String((a && a.student_id) || '') === sid);
  const present = attRowsAll.filter((a) => a.status === 'present').length;
  const absent = attRowsAll.filter((a) => a.status === 'absent').length;
  const attRowsSorted = attRowsAll.slice().sort((a, b) => {
    const da = String((a && a.date) || (a && a.created_at) || '');
    const db = String((b && b.date) || (b && b.created_at) || '');
    return db.localeCompare(da);
  });
  const latestAtt = attRowsSorted[0];

  const payRows = toArraySafe(pay).filter((p) => String((p && p.student_id) || '') === sid);
  const paidSessions = payRows.reduce((n, p) => n + Number((p && p.sessions_paid) || 0), 0);
  const paidAmount = payRows.reduce((n, p) => n + Number((p && p.amount_vnd) || 0), 0);

  const debtRows = toArraySafe(tuitionByClass).filter((r) => String((r && r.student_id) || '') === sid);
  const debtSessionsExplicit = debtRows.reduce(
    (n, r) => n + Number((r && (r.sessions_due || r.debt_sessions || r.remaining_sessions || 0)) || 0),
    0
  );
  const debtAmountExplicit = debtRows.reduce(
    (n, r) => n + Number((r && (r.amount_due || r.debt_amount || r.remaining_amount || 0)) || 0),
    0
  );
  const presentByClass = {};
  attRowsAll.forEach((a) => {
    if (String((a && a.status) || '').toLowerCase() !== 'present') return;
    const key = normalizeClassKey((a && a.class_name) || className);
    if (!key) return;
    presentByClass[key] = (presentByClass[key] || 0) + 1;
  });
  const chargedByClass = {};
  debtRows.forEach((r) => {
    const key = normalizeClassKey(r && r.class_name);
    if (!key) return;
    chargedByClass[key] = Number((r && r.charged_sessions) || 0);
  });
  const allClassKeys = Array.from(
    new Set(Object.keys(presentByClass).concat(Object.keys(chargedByClass)))
  );
  let debtSessionsDerived = 0;
  let debtAmountDerived = 0;
  const debtClassLines = allClassKeys.slice(0, 12).map((k) => {
    const p = Number(presentByClass[k] || 0);
    const c = Number(chargedByClass[k] || 0);
    const pending = Math.max(0, p - c);
    const fee = Number(feeByClassKey[k] || 0);
    const owed = pending * fee;
    debtSessionsDerived += pending;
    debtAmountDerived += owed;
    return (
      '- Lớp=' +
      k +
      ' | da_hoc=' +
      p +
      ' | da_thu=' +
      c +
      ' | no_buoi=' +
      pending +
      ' | hoc_phi_buoi=' +
      fee +
      ' | no_uoc_tinh=' +
      owed
    );
  });
  const debtSessions = Math.max(debtSessionsExplicit, debtSessionsDerived);
  const debtAmount = debtAmountExplicit > 0 ? debtAmountExplicit : debtAmountDerived;

  const uiForStudent = toArraySafe(tuitionUi).filter((row) => {
    const rid = String((row && (row.id || row.student_id || row.studentId)) || '');
    if (sid && rid && rid === sid) return true;
    const rn = normalizeText((row && row.name) || '');
    const nn = normalizeText(name || '');
    return nn && rn && (rn === nn || rn.includes(nn) || nn.includes(rn));
  });
  const uiDebtLines = uiForStudent.slice(0, 12).map((row) => {
    const pb = row.classBreakdown;
    const breakdown =
      Array.isArray(pb) && pb.length
        ? ' | chi_tiet_lop=' + compactJson(pb, 400)
        : '';
    return (
      '- UI_HOC_PHI: pending_buoi=' +
      String(row.pending != null ? row.pending : '') +
      ' | owed_vnd=' +
      String(row.owed != null ? row.owed : '') +
      ' | lop=' +
      String(row.className || row.class_name || '') +
      breakdown
    );
  });

  const tuitionRows = toArraySafe(tuitionRaw)
    .filter((r) => String((r && r.student_id) || '') === sid)
    .slice(0, 8);
  const classRows = toArraySafe(cls)
    .filter((r) => {
      const rn = normalizeText(r && (r.name || r.class_name || r.class || ''));
      return className && rn && rn.includes(normalizeText(className));
    })
    .slice(0, 5)
    .map((r) => '- ' + compactJson(r, 260));

  const paySample = payRows
    .slice()
    .sort((a, b) => {
      const pa = String((a && (a.paid_at || a.created_at || a.payment_date || a.date)) || '');
      const pb = String((b && (b.paid_at || b.created_at || b.payment_date || b.date)) || '');
      return pb.localeCompare(pa);
    })
    .slice(0, 8);

  return {
    sid,
    name,
    phone,
    parentName,
    className,
    dob,
    noteStu,
    present,
    absent,
    latestAtt,
    attRowsSorted,
    paidSessions,
    paidAmount,
    payRows: paySample,
    debtSessions,
    debtAmount,
    debtClassLines,
    uiDebtLines,
    tuitionRows,
    classRows,
    feeByClassKey,
    presentByClass,
    chargedByClass,
    allClassKeys
  };
}

function formatMachineStudent360Block(m, idx) {
  return (
    'CANDIDATE_' +
      (idx + 1) +
      ':\n' +
      'id=' +
      m.sid +
      ' | name=' +
      m.name +
      ' | phone=' +
      m.phone +
      ' | parent=' +
      m.parentName +
      ' | class=' +
      m.className +
      '\n' +
      'attendance: present=' +
      m.present +
      ', absent=' +
      m.absent +
      ', latest=' +
      compactJson(m.latestAtt || {}, 180) +
      '\n' +
      'payments: sessions_paid=' +
      m.paidSessions +
      ', amount_paid=' +
      m.paidAmount +
      '\n' +
      'debt_total: sessions_due=' +
      m.debtSessions +
      ', amount_due=' +
      m.debtAmount +
      '\n' +
      'debt_by_class:\n' +
      (m.debtClassLines.join('\n') || '- Không có') +
      '\n' +
      'tuition_ui_snapshot (tính từ app / điểm danh, ưu tiên khi trả lời nợ học phí):\n' +
      (m.uiDebtLines.join('\n') || '- Không có dữ liệu tab Học phí trong snapshot') +
      '\n' +
      'student_tuition_sample:\n' +
      (m.tuitionRows.map((r) => '- ' + compactJson(r, 220)).join('\n') || '- Không có') +
      '\n' +
      'class_meta_sample:\n' +
      (m.classRows.join('\n') || '- Không có')
  );
}

function shortDateVi(raw) {
  const s = String(raw || '').slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return m[3] + '/' + m[2] + '/' + m[1];
  return s || '—';
}

function attendanceStatusVi(a) {
  const st = String((a && a.status) || '').toLowerCase();
  if (st === 'present') return 'có mặt';
  if (st === 'absent') return 'vắng';
  return st || '—';
}

/** Chỉ khi người dùng yêu cầu chi tiết / đầy đủ — mặc định dùng bản ngắn (không dùng normalizeText vì có thể làm hỏng tiếng Việt). */
function wantsStudentFullOperationalDump(message) {
  const s = String(message || '')
    .normalize('NFC')
    .toLowerCase()
    .trim();
  if (!s) return false;
  return (
    /\b(day\s+du|tat\s+ca\s+thong\s+tinh)\b/i.test(s) ||
    /đầy đủ|tất cả\s+thông tin|bao cáo\s+chi\s+tiết|chi\s+tiết\s+đầy đủ|đầy đủ\s+thông\s+tin/.test(s) ||
    /liệt kê(\s+tất cả)?\s+các\s+buổi|liệt kê\s+buổi|tat\s+ca\s+dòng\s+điểm danh/i.test(s) ||
    /lịch sử\s+đầy đủ/i.test(s) ||
    /xuất\s+bảng\s+chi\s+tiết/i.test(s)
  );
}

function wantsStudentUltraBriefCue(message) {
  const s = String(message || '')
    .normalize('NFC')
    .toLowerCase()
    .trim();
  return /ngắn gọn(\s+thôi)?|rút\s+gọn|tóm\s+tắt|xúc\s+tích|vài\s+dòng|chỉ\s+vài\s+điều|một\s+đoạn\s+ngắn|thông tin\s+ngắn/i.test(s);
}

/** Một đoạn xúc tích — mặc định khi chỉ có tên học viên hoặc hỏi chung “thông tin”. */
function formatDeterministicViStudentProfileBrief(m) {
  const debtS = Math.round(Number(m.debtSessions || 0));
  const debtAmt = Number(m.debtAmount || 0);
  let t =
    (m.name || 'Học viên') +
    ' · lớp ' +
    (m.className || '—') +
    ' · ' +
    m.present +
    ' buổi có mặt, ' +
    m.absent +
    ' buổi vắng';
  if (m.phone && String(m.phone).trim()) t += ' · SĐT ' + String(m.phone).trim();
  if (m.parentName && String(m.parentName).trim()) t += ' · phụ huynh: ' + String(m.parentName).trim();
  if (debtS > 0) {
    t += ' · đang nợ ~' + debtS + ' buổi';
    if (debtAmt > 0) t += ' (ước tính ' + formatVndAmount(debtAmt) + ')';
  } else {
    t += ' · không thấy nợ buổi trong dữ liệu đồng bộ hiện tại';
  }
  if (m.latestAtt && (m.latestAtt.date || m.latestAtt.created_at)) {
    t +=
      ' · buổi gần nhất ' +
      shortDateVi(m.latestAtt.date || m.latestAtt.created_at) +
      ': ' +
      attendanceStatusVi(m.latestAtt);
  }
  const note = String(m.noteStu || '').trim();
  if (note) {
    const short = note.length > 140 ? note.slice(0, 137) + '…' : note;
    t += '\nGhi chú: ' + short;
  }
  return t.trim();
}

/** Dòng trong thẻ Zalo/target — không dùng câu chuyển “xem phía trên”. */
function formatDeterministicStudentTargetBlurb(m) {
  return formatDeterministicViStudentProfileBrief(m).replace(/\n/g, ' ').slice(0, 320);
}

/** Bản chi tiết hơn cho admin — vẫn không UUID / không JSON thô trong chat. */
function formatDeterministicViStudentProfileFull(m) {
  const lines = [];
  lines.push('Hồ sơ học viên (chi tiết theo dữ liệu hệ thống):');
  lines.push('');
  lines.push('— Thông tin hồ sơ');
  lines.push('- Họ tên: ' + (m.name || '—'));
  lines.push('- SĐT phụ huynh: ' + (m.phone || '—'));
  lines.push('- Phụ huynh: ' + (m.parentName || '—'));
  lines.push('- Lớp đang gắn (trên hồ sơ): ' + (m.className || '—'));
  if (m.dob) lines.push('- Ngày sinh: ' + m.dob);
  if (m.noteStu) lines.push('- Ghi chú hồ sơ: ' + m.noteStu);
  lines.push('');
  lines.push('— Điểm danh (tổng hợp theo điểm danh)');
  lines.push('- Tổng buổi có mặt: ' + m.present);
  lines.push('- Tổng buổi vắng: ' + m.absent);
  if (m.latestAtt && Object.keys(m.latestAtt).length) {
    const la = m.latestAtt;
    lines.push(
      '- Buổi gần nhất: ' +
        shortDateVi(la.date || la.created_at) +
        ' · lớp ' +
        String((la.class_name || la.class) || '') +
        ' · ' +
        attendanceStatusVi(la)
    );
  }
  lines.push('');
  lines.push('— Các buổi học gần đây (tối đa ' + Math.min(m.attRowsSorted.length, 10) + ')');
  if (!m.attRowsSorted.length) {
    lines.push('- Chưa có bản ghi điểm danh trong dữ liệu đọc được.');
  } else {
    m.attRowsSorted.slice(0, 10).forEach((a, i) => {
      lines.push(
        (i + 1) +
          '. ' +
          shortDateVi(a.date || a.created_at) +
          ' · ' +
          String((a.class_name || a.class) || m.className || '—') +
          ' · ' +
          attendanceStatusVi(a)
      );
    });
  }
  lines.push('');
  lines.push('— Thanh toán / học phí đã ghi nhận');
  lines.push('- Tổng buổi đã thanh toán: ' + m.paidSessions);
  lines.push('- Tổng tiền đã thu: ' + (m.paidAmount > 0 ? formatVndAmount(m.paidAmount) : '0 đ'));
  if (m.payRows.length) {
    lines.push('- Một số giao dịch gần đây:');
    m.payRows.forEach((p, i) => {
      const amt = Number((p && p.amount_vnd) || 0);
      const sess = Number((p && p.sessions_paid) || 0);
      const when = shortDateVi(p.paid_at || p.created_at || p.payment_date || p.date);
      lines.push(
        '  ' +
          (i + 1) +
          '. ' +
          when +
          ' · ' +
          (amt > 0 ? formatVndAmount(amt) : '0 đ') +
          (sess ? ' · ' + sess + ' buổi' : '')
      );
    });
  } else {
    lines.push('- Chưa thấy dòng payment_history gắn học viên này trong dữ liệu hiện tại.');
  }
  lines.push('');
  lines.push('— Công nợ học phí (ước tính từ điểm danh + đã thu theo lớp)');
  lines.push('- Tổng nợ buổi (max explicit / derived): ' + Math.round(Number(m.debtSessions || 0)));
  lines.push('- Ước tính số tiền còn nợ: ' + (m.debtAmount > 0 ? formatVndAmount(m.debtAmount) : 'Chưa xác định hoặc 0'));
  lines.push('- Chi tiết theo lớp:');
  if (!m.allClassKeys.length) {
    lines.push('  (Chưa gom được theo lớp — kiểm tra điểm danh và bảng học viên–theo–lớp.)');
  } else {
    m.allClassKeys.slice(0, 12).forEach((k) => {
      const p = Number((m.presentByClass && m.presentByClass[k]) || 0);
      const c = Number((m.chargedByClass && m.chargedByClass[k]) || 0);
      const pending = Math.max(0, p - c);
      const fee = Number((m.feeByClassKey && m.feeByClassKey[k]) || 0);
      const owed = pending * fee;
      lines.push(
        '  · Lớp ' +
          k +
          ': đã học ' +
          p +
          ' buổi, đã thu ' +
          c +
          ' buổi, còn nợ ~' +
          pending +
          ' buổi' +
          (fee > 0 ? ', học phí/buổi ' + formatVndAmount(fee) : '') +
          (owed > 0 ? ', ước tính ' + formatVndAmount(owed) : '')
      );
    });
  }
  lines.push('');
  lines.push('— Snapshot tab Học phí (từ app, nếu có)');
  if (!m.uiDebtLines.length) {
    lines.push('- Không có tuition_rows trong request (thử mở tab Học phí rồi hỏi lại để đồng bộ snapshot).');
  } else {
    m.uiDebtLines.forEach((u) => lines.push('- ' + String(u || '').replace(/^\-\s*/, '')));
  }
  if (m.tuitionRows.length) {
    lines.push('');
    lines.push('— Tab học phí trong snapshot có ' + m.tuitionRows.length + ' dòng liên quan (không liệt kê raw).');
  }
  return lines.join('\n');
}

/**
 * Khớp 1 học viên → tóm tắt chắc chắn từ dữ liệu.
 * Mặc định bản ngắn (1 đoạn); bản chi tiết khi câu hỏi yêu cầu đầy đủ/liệt kê…
 */
function tryDeterministicStudentSummary(userMessage, merged) {
  if (!merged || !userMessage) return null;
  if (isOperationalOverviewMessage(userMessage)) return null;
  const hoSoResolved = resolveStudentFromHoSoLopPhrase(userMessage, merged.students);
  const scored = hoSoResolved ? [] : findStudentCandidatesWithScore(userMessage, merged.students);
  const anchored = hoSoResolved || pickSingleStudentByNameHint(userMessage, merged.students);
  if (!anchored && !scored.length) return null;
  const top = anchored ? { student: anchored, score: 99 } : scored[0];
  if (!anchored && top.score < 2) return null;
  const close = anchored ? [top] : scored.filter((x) => x.score >= Math.max(1, top.score - 1)).slice(0, 5);
  if (!anchored && close.length > 1) return null;

  const s = top.student;
  const extra = merged.extra || {};
  const m = computeStudent360Metrics(
    s,
    merged.attendance,
    merged.payment,
    extra.student_tuition_by_class,
    extra.student_tuition,
    extra.classes,
    extra.class_fees,
    merged.tuition_rows
  );
  if (isLatestPaymentQuestion(userMessage)) {
    const latestPay = toArraySafe(m.payRows)[0] || null;
    if (!latestPay) {
      return {
        summary: 'Chưa thấy giao dịch học phí nào của phụ huynh học viên ' + (m.name || 'này') + ' trong dữ liệu hiện tại.',
        metrics: m,
        targetBlurb: formatDeterministicStudentTargetBlurb(m)
      };
    }
    const d = normalizeDateToYmd((latestPay && (latestPay.paid_at || latestPay.created_at || latestPay.payment_date || latestPay.date)) || '');
    const amount = Number((latestPay && (latestPay.amount_vnd || latestPay.amount || latestPay.total || 0)) || 0);
    const sess = Number((latestPay && latestPay.sessions_paid) || 0);
    const when = d ? shortDateVi(d) : 'không rõ ngày';
    return {
      summary:
        'Phụ huynh của ' +
        (m.name || 'học viên này') +
        ' đóng gần nhất vào ' +
        when +
        (amount > 0 ? ', số tiền ' + formatVndAmount(amount) : '') +
        (sess > 0 ? ' (' + sess + ' buổi)' : '') +
        '.',
      metrics: m,
      targetBlurb: formatDeterministicStudentTargetBlurb(m)
    };
  }
  let useFull = wantsStudentFullOperationalDump(userMessage);
  if (wantsStudentUltraBriefCue(userMessage)) useFull = false;
  const summary = useFull ? formatDeterministicViStudentProfileFull(m) : formatDeterministicViStudentProfileBrief(m);
  return {
    summary,
    metrics: m,
    targetBlurb: formatDeterministicStudentTargetBlurb(m)
  };
}

function extractStudentNameHint(message) {
  const raw = String(message || '').trim();
  if (!raw) return '';
  const m =
    raw.match(/(?:phu huynh cua|học viên|hoc vien|be|em)\s+(.+?)\s+(?:da|đã|co|có|con|còn|khi nao|luc nao|\?)/i) ||
    raw.match(/(?:thong tin|ho so|chi tiet)\s+(.+?)\s*$/i) ||
    raw.match(/(?:hoc phi|học phí|nhac hoc phi|nhắc học phí)\s+(?:hoc vien|học viên|hoc sinh|học sinh|be|bé|em)\s+(.+?)\s*$/i) ||
    raw.match(/(?:hoc vien|học viên|hoc sinh|học sinh|be|bé|em)\s+(.+?)\s*$/i);
  return m ? normalizeText(String(m[1] || '').trim()) : '';
}

function pickSingleStudentByNameHint(message, students) {
  const hint = extractStudentNameHint(message);
  if (!hint || hint.split(/\s+/).length < 2) return null;
  const hits = toArraySafe(students).filter((s) => {
    const nn = normalizeText((s && s.name) || '');
    return nn && (nn.includes(hint) || hint.includes(nn));
  });
  return hits.length === 1 ? hits[0] : null;
}

function wantsTuitionReminderDraft(message) {
  const n = normalizeText(message || '');
  if (!n) return false;
  return /(soan|viet|tao|draft|nhac|gui).*(tin nhan|zalo|phu huynh|hoc phi|dong phi|no phi)/i.test(n);
}

function buildParentTuitionReminderMessage(opts) {
  const name = String((opts && opts.name) || 'học viên').trim() || 'học viên';
  const cls = String((opts && opts.className) || '').trim();
  const sessions = Math.max(0, Math.round(Number((opts && opts.sessions) || 0)));
  const amount = Math.max(0, Math.round(Number((opts && opts.amount) || 0)));
  const amountText = amount > 0 ? formatVndAmount(amount) : '';
  const debtParts = [];
  if (sessions > 0) debtParts.push(sessions + ' buổi học phí');
  if (amountText) debtParts.push(amountText);
  const debtText = debtParts.length ? debtParts.join(' (') + (debtParts.length > 1 ? ')' : '') : '';
  if (!debtText) {
    return (
      'Chào phụ huynh, thầy Vũ xin gửi thông tin học phí của em ' +
      name +
      '. Hiện hệ thống chưa ghi nhận khoản học phí còn nợ trong dữ liệu đang tải. Nếu phụ huynh cần đối chiếu thêm, vui lòng phản hồi để trung tâm kiểm tra lại. Cảm ơn phụ huynh.'
    );
  }
  return (
    'Chào phụ huynh, thầy Vũ xin phép nhắc học phí của em ' +
    name +
    '. Hiện em còn ' +
    debtText +
    ' chưa thanh toán' +
    (cls ? ' ở lớp ' + cls : '') +
    '. Khi thuận tiện, phụ huynh vui lòng kiểm tra và chuyển khoản giúp thầy. Nếu phụ huynh đã thanh toán, vui lòng phản hồi để thầy Vũ đối chiếu lại. Cảm ơn phụ huynh.'
  );
}

function buildStudentTuitionReminderDraftResult(merged, userMessage, userDisplayName) {
  if (!merged || !wantsTuitionReminderDraft(userMessage)) return null;
  const anchored = pickSingleStudentByNameHint(userMessage, merged.students);
  const scored = anchored ? [] : findStudentCandidatesWithScore(userMessage, merged.students);
  const top = anchored ? { student: anchored, score: 99 } : scored[0];
  if (!top || !top.student || (!anchored && top.score < 2)) return null;
  const close = anchored ? [top] : scored.filter((x) => x.score >= Math.max(1, top.score - 1)).slice(0, 5);
  if (!anchored && close.length > 1) {
    return {
      type: 'warning',
      summary:
        'Em thấy nhiều học viên có tên gần giống nhau, chưa đủ chắc để soạn tin nhắn. Thầy/cô vui lòng ghi rõ họ tên đầy đủ hoặc lớp của học viên.',
      targets: [],
      requires_confirmation: true,
      insight: '',
      next_question: 'Thầy/cô muốn nhắc học phí học viên nào? ' + close.map((x) => x.student.name || 'Không rõ').join(', '),
      actions: []
    };
  }

  const s = top.student;
  const extra = merged.extra || {};
  const m = computeStudent360Metrics(
    s,
    merged.attendance,
    merged.payment,
    extra.student_tuition_by_class,
    extra.student_tuition,
    extra.classes,
    extra.class_fees,
    merged.tuition_rows
  );
  const sessions = Math.max(0, Math.round(Number(m.debtSessions || 0)));
  const amount = Math.max(0, Math.round(Number(m.debtAmount || 0)));
  const cls = String((m.className || (s && s.class_name) || '')).trim() || 'lớp đang học';
  const phone = String((m.phone || (s && s.phone) || '')).trim();
  const phoneDigits = phone.replace(/\D/g, '');
  const name = String(m.name || (s && s.name) || 'học viên').trim();
  const amountText = amount > 0 ? formatVndAmount(amount) : '';
  const debtText =
    sessions > 0
      ? sessions + ' buổi' + (amountText ? ', ' + amountText : '')
      : amountText
        ? amountText
        : '';
  const msg = buildParentTuitionReminderMessage({
    name,
    className: cls,
    sessions,
    amount
  });

  return {
    type: sessions > 0 || amount > 0 ? 'warning' : 'info',
    summary:
      'Em đã soạn sẵn tin nhắn nhắc học phí cho ' +
      name +
      (debtText ? ' (' + debtText + ')' : '') +
      '.',
    targets: [
      {
        name,
        phone,
        zalo_link: phoneDigits ? 'https://zalo.me/' + phoneDigits : '',
        message: msg,
        note: phone ? '' : 'Thiếu SĐT'
      }
    ],
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: phone ? ['Bấm Copy + Zalo để mở cuộc trò chuyện'] : ['Bổ sung SĐT phụ huynh cho học viên này']
  };
}

function isLatestPaymentQuestion(message) {
  const n = normalizeText(message || '');
  if (!n) return false;
  return (
    /(dong|nop|thanh toan).*(gan nhat|moi nhat|khi nao|luc nao)/.test(n) ||
    /(phu huynh.*dong).*(gan nhat|khi nao|luc nao)/.test(n)
  );
}

function buildStudent360Context(message, students, attendance, payments, extra, tuitionRowsFromClient) {
  const candidates = findStudentCandidates(message, students);
  if (!candidates.length) return 'STUDENT_360: không xác định học viên cụ thể từ câu hỏi.';

  const att = toArraySafe(attendance);
  const pay = toArraySafe(payments);
  const tuitionByClass = toArraySafe(extra && extra.student_tuition_by_class);
  const tuitionRaw = toArraySafe(extra && extra.student_tuition);
  const cls = toArraySafe(extra && extra.classes);
  const classFees = toArraySafe(extra && extra.class_fees);
  const tuitionUi = toArraySafe(tuitionRowsFromClient);

  const lines = candidates.map((s, idx) =>
    formatMachineStudent360Block(
      computeStudent360Metrics(s, att, pay, tuitionByClass, tuitionRaw, cls, classFees, tuitionUi),
      idx
    )
  );
  return '=== STUDENT 360 CONTEXT ===\n' + lines.join('\n\n') + '\n';
}

function buildStudentResolutionContext(message, students) {
  const scored = findStudentCandidatesWithScore(message, students);
  if (!scored.length) return 'STUDENT_RESOLUTION: không tìm thấy học viên phù hợp với câu hỏi.';
  const top = scored[0];
  const close = scored.filter((x) => x.score >= Math.max(1, top.score - 1)).slice(0, 5);
  if (close.length <= 1) {
    return (
      'STUDENT_RESOLUTION: unique_match\n' +
      '- id=' +
      (top.student && top.student.id) +
      ' | name=' +
      (top.student && top.student.name) +
      ' | class=' +
      (top.student && top.student.class_name)
    );
  }
  const opts = close.map((x) => '- id=' + x.student.id + ' | name=' + (x.student.name || '') + ' | class=' + (x.student.class_name || '') + ' | phone=' + (x.student.phone || '')).join('\n');
  return (
    'STUDENT_RESOLUTION: ambiguous_match\n' +
    'CÓ NHIỀU HỌC VIÊN TRÙNG/KHÁ GẦN TÊN. KHÔNG ĐƯỢC CHỐT ĐẠI. PHẢI HỎI USER CHỌN ĐÚNG HỌC VIÊN.\n' +
    'CANDIDATES:\n' +
    opts
  );
}

/**
 * Nếu user đã nêu rõ tên học viên trong câu hiện tại thì không trộn lịch sử chat vào bước phân giải tên,
 * tránh kéo nhầm candidate cũ và tạo ambiguous giả.
 */
function shouldAttachStudentChatAnchor(message, students) {
  const current = String(message || '').trim();
  if (!current) return true;
  const scored = findStudentCandidatesWithScore(current, students);
  if (!scored.length) return true;
  const top = Number((scored[0] && scored[0].score) || 0);
  return top < 1;
}

function xayContext(students, attendance, payments, extra) {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const buoi = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][today.getDay()];

  const tongDaDong = {};
  (payments || []).forEach((p) => {
    const sid = p.student_id;
    if (!tongDaDong[sid]) tongDaDong[sid] = { sessions: 0, amount: 0 };
    tongDaDong[sid].sessions += p.sessions_paid || 0;
    tongDaDong[sid].amount += p.amount_vnd || 0;
  });

  const chuaDong = (students || [])
    .filter((s) => !tongDaDong[s.id])
    .map((s) => '- ' + s.name + ' | Lớp: ' + s.class_name + ' | SĐT: ' + (s.phone || ''));

  const moc14 = new Date(today);
  moc14.setDate(moc14.getDate() - 14);
  const demVang = {};
  (attendance || [])
    .filter((a) => a.status === 'absent' && new Date(a.date) >= moc14)
    .forEach((a) => (demVang[a.student_id] = (demVang[a.student_id] || 0) + 1));

  const vangNhieu = [];
  Object.keys(demVang).forEach((id) => {
    if (demVang[id] >= 3) {
      const s = (students || []).find((x) => String(x.id) === String(id));
      if (s) vangNhieu.push('- ' + s.name + ' | Vắng ' + demVang[id] + ' lần | SĐT: ' + (s.phone || ''));
    }
  });

  const vangHomNay = (attendance || [])
    .filter((a) => a.date === todayStr && a.status === 'absent')
    .map((a) => {
      const s = (students || []).find((x) => String(x.id) === String(a.student_id));
      return s ? '- ' + s.name + ' | Lớp: ' + (a.class_name || '') : null;
    })
    .filter(Boolean);

  const diHocHomNay = (attendance || [])
    .filter((a) => a.date === todayStr && a.status === 'present')
    .map((a) => {
      const s = (students || []).find((x) => String(x.id) === String(a.student_id));
      return s ? '- ' + s.name + ' | Lớp: ' + (a.class_name || '') : null;
    })
    .filter(Boolean);

  const diemDanhHomNayCount = (attendance || []).filter((a) => a.date === todayStr).length;
  const diemDanhHomNayNote =
    diemDanhHomNayCount > 0
      ? 'Đã có dữ liệu điểm danh hôm nay.'
      : 'CHƯA CÓ DỮ LIỆU ĐIỂM DANH HÔM NAY (không được kết luận là không có học viên đi học).';

  return (
    '=== DỮ LIỆU TRUNG TÂM (' +
    todayStr +
    ' - ' +
    buoi +
    ') ===\n\n' +
    'CHƯA ĐÓNG HỌC PHÍ (' +
    chuaDong.length +
    '):\n' +
    (chuaDong.join('\n') || 'Không có') +
    '\n\n' +
    'VẮNG NHIỀU 14 NGÀY (' +
    vangNhieu.length +
    '):\n' +
    (vangNhieu.join('\n') || 'Không có') +
    '\n\n' +
    'VẮNG HÔM NAY (' +
    vangHomNay.length +
    '):\n' +
    (vangHomNay.join('\n') || 'Không có') +
    '\n\n' +
    'ĐI HỌC HÔM NAY (' +
    diHocHomNay.length +
    '):\n' +
    (diHocHomNay.join('\n') || 'Không có') +
    '\n\n' +
    'TRẠNG THÁI DỮ LIỆU ĐIỂM DANH HÔM NAY:\n' +
    diemDanhHomNayNote +
    '\n\n' +
    'DỮ LIỆU MỞ RỘNG (để trả lời câu hỏi bất kỳ nếu có trong hệ thống):\n' +
    (buildKnowledgeDigest(extra) || 'Không có') +
    '\n\n' +
    buildExtendedOpsContext(students, attendance, payments, extra) +
    '\n' +
    buildAnalyticsContext(students, attendance, payments, extra, '') +
    '\n' +
    'TỔNG HỌC VIÊN: ' +
    (students || []).length
  );
}

function buildSystemPrompt(userDisplayName) {
  return [
    'ROLE & OBJECTIVE',
    '- You are the internal MV Klass operations assistant (trợ lý vận hành nội bộ).',
    '- GROUNDING_DATA = only factual anchor (names, sessions, money, dates, status, class).',
    '- User-facing text is always natural Vietnamese (như nói chuyện), never a machine printout of the DATA block.',
    '- Every factual claim MUST match GROUNDING_DATA; never invent, never contradict, do not omit on purpose what the question needs.',
    '',
    'MANDATORY WORKFLOW (3 steps — every admin question)',
    'Bước 1 TIẾP NHẬN: Read all of GROUNDING_DATA. Internalize students, buổi, amounts, dates, trạng thái. This is real data.',
    'Bước 2 ĐỌC HIỂU & KHỚP: From the admin question, decide: one student | aggregate | compare | alert. Pull ONLY rows/metrics that match. If nothing matches, say clearly what is missing + ask exactly ONE specific clarifying question. Never answer with unrelated data.',
    'Bước 3 TRÌNH BÀY: Conclusion first, details after. Use ONLY numbers/facts you matched in step 2 — do not add new metrics. Do NOT copy DB/API labels into summary (no sessions_due, amount_due, student_id, UUID, raw keys).',
    '',
    'DECISION POLICY',
    '- Resolve intent: revenue_compare | student_360 | debt_ops | attendance_ops | bank_ops | lead_ops | general.',
    '- If STUDENT_RESOLUTION is ambiguous_match, do not finalize details; ask user to confirm.',
    '- For month-over-month comparison, compute using ANALYTICS CONTEXT metrics.',
    '- Never fabricate student, phone, amount, attendance, or links.',
    '- If DATA says no attendance data today, never conclude nobody attended.',
    '- Never refuse with generic fallback only. Always give the best possible answer from context, then clarify if needed.',
    '- Never stop at "không đủ dữ liệu" alone — always add what IS known + one concrete next step or question.',
    '',
    'PRESENTATION RULES',
    '- Simple question (one student, one number) → summary 1-2 sentences.',
    '- Aggregate (lists, comparisons) → structured summary; most important first.',
    '- Missing data → name the gap + one specific follow-up question.',
    '- actions[]: max 3 items, imperative verbs (động từ chỉ hướng), Vietnamese.',
    '- If the admin asks to "soạn tin nhắn", "nhắc học phí", "gửi Zalo", or contact a parent: return targets[] with a ready-to-send Vietnamese parent message in target.message. The message must be polite, concrete, use "thầy Vũ" as sender, call the student "em" (not "bé"), include student name, unpaid sessions, exact amount if known (do not write "ước tính"), and class if known. Do not merely describe the debt.',
    '- For Zalo/contact targets: include phone from DATA when available; set zalo_link to "https://zalo.me/<digits>" when phone exists, otherwise empty and note "Thiếu SĐT".',
    '',
    'OUTPUT CONTRACT',
    '- Return ONLY valid JSON. No markdown fences. No text before or after the JSON.',
    '- Field "summary" is what ADMIN SEES — human Vietnamese prose only; never paste JSON/objects/field names inside it.',
    '- targets: omit or use []; when used, each "message" = 1-2 concrete Vietnamese sentences for that person/case.',
    'Schema:',
    '{"type":"info|warning|success|error","summary":"string","targets":[{"name":"string","phone":"string","zalo_link":"string","message":"string","note":"string"}],"requires_confirmation":boolean,"insight":"string","next_question":"string","actions":["string"]}',
    '- insight / next_question: empty string "" if unused.',
    '',
    'STYLE',
    '- Professional, concise, warm, non-robotic.',
    buildAdminAddressingStyleLine(userDisplayName),
    '- Paraphrase grounding; never transcribe DATA layout.',
    '- Prefer decisions and clarity over dumping tables.',
    '- One-student profiles (intent student_360): default short operative summary unless the user asks for đầy đủ/chi tiết/liệt kê buổi — never filler like "already listed above"; never paste UUID/system IDs.',
    '- Never add meta disclaimers like "ưu tiên phương án an toàn chỉ vì có dữ liệu".',
    '',
    'EXCLUDED CAPABILITIES (if asked, reply not supported):',
    '- Gợi ý đổi ca/bù khi có học viên vắng nhiều.',
    '- Tóm tắt tại đây giáo viên theo tuần/tháng.',
    '- Nhắc các lớp sắp bắt đầu trong X phút.',
    '- Ấn buổi trả trước / trừ nợ lớp ưu tiên.',
    '- Chốt điểm danh + sinh ghi chú lớp.',
    '- Đề xuất phân bổ 1 giao dịch cho nhiều học viên.',
    '- Truy vấn ad-hoc: lớp nợ cao nhất nhưng tỉ lệ đi học cao.',
    '- Báo cáo 17h hôm nay.',
    '- So sánh tuần này vs tuần trước.'
  ].join('\n');
}

function buildUserPrompt(contextText, historyRecent, historyRelevant, message, intentGuide, feedbackGuide, userDisplayName) {
  const recentBlock = historyRecent.length
    ? historyRecent.map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + fitTextBudget(String(m.content || ''), HISTORY_LINE_CHAR_CAP)).join('\n')
    : 'Không có';
  const relevantBlock = historyRelevant.length
    ? historyRelevant.map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + fitTextBudget(String(m.content || ''), HISTORY_LINE_CHAR_CAP)).join('\n')
    : 'Không có';
  const context = fitTextBudget(contextText, CONTEXT_CHAR_BUDGET);
  const intentBlock = fitTextBudget(String(intentGuide || ''), 1000);
  const feedbackBlock = fitTextBudget(String(feedbackGuide || ''), 700);
  const dn = sanitizeUserDisplayName(userDisplayName);
  const adminLine =
    'NGƯỜI HỎI (tên hiển thị của quản trị viên, không phải học viên — xưng hô theo «thầy/cô + tên», không dùng «anh/chị»): ' +
    (dn || '—') +
    '\n\n';
  return (
    adminLine +
    'GROUNDING_DATA (nội bộ — chỉ bám sự kiện; trả lời cho admin phải tự diễn đạt lại, không sao chép khối này):\n' +
    context +
    '\n\n' +
    'INTENT & HƯỚNG DẪN:\n' +
    intentBlock +
    '\n\n' +
    feedbackBlock +
    '\n\n' +
    'LỊCH SỬ GẦN ĐÂY CỦA TAB:\n' +
    recentBlock +
    '\n\n' +
    'LỊCH SỬ LIÊN QUAN CỦA TAB:\n' +
    relevantBlock +
    '\n\n' +
    'YÊU CẦU MỚI:\n' +
    String(message || '')
  );
}

function buildPlannerPrompt(contextText, message, intentGuide, userDisplayName) {
  const slimContext = trimLinesToBudget(contextText, PLANNER_CONTEXT_CHAR_BUDGET);
  const dn = sanitizeUserDisplayName(userDisplayName);
  return [
    'Bạn là bộ lập kế hoạch nội bộ cho trợ lý vận hành MV Klass.',
    'Bắt buộc 3 bước với GROUNDING_DATA: (1) tiếp nhận đủ tên/buổi/tiền/ngày/trạng thái có trong khối, (2) khớp đúng câu admin (học viên cụ thể / tổng hợp / so sánh / cảnh báo) — không lấy nhánh không liên quan, (3) nếu thiếu chỗ khớp thì ghi missing_data và 1 gợ ý cụ thể.',
    'Phần trả lời admin (summary) không tóm máy và không collage nguyên layout DATA.',
    'Chỉ trả về JSON hợp lệ, không markdown.',
    'Schema:',
    '{"intent":"string","answer_style":"brief|normal","must_use_metrics":["string"],"student_resolution":"none|unique|ambiguous","missing_data":["string"],"reasoning_steps":["string"]}',
    '',
    'INTENT GUIDE:',
    fitTextBudget(String(intentGuide || ''), 900),
    '',
    'QUẢN TRỊ VIÊN ĐANG CHAT (tên hiển thị — xưng hô «thầy/cô + tên», không «anh/chị»): ' + (dn || '—'),
    '',
    'GROUNDING_DATA:',
    slimContext,
    '',
    'YÊU CẦU:',
    String(message || '')
  ].join('\n');
}

function buildQualityRewritePrompt(originalResult, userMessage, intentName, userDisplayName) {
  const dn = sanitizeUserDisplayName(userDisplayName);
  return [
    'Hãy cải thiện JSON trả lời để tự nhiên, rõ hành động, vẫn đúng schema.',
    '"summary": tiếng Việt như người nói — kết luận trước; không nhãn DB như sessions_due, student_id...; không dán JSON/shape vào trong summary.',
    'Không thêm số/fact mới ngoài kết quả cũ + grounding đã được phản ánh trong bản này.',
    'Giữ đúng format JSON thuần.',
    'INTENT=' + String(intentName || 'general'),
    dn
      ? 'ADMIN_DISPLAY_NAME_FOR_ADDRESSING=' + dn + ' (tiếng Việt luôn xưng «thầy/cô + tên hiển thị», không dùng «anh/chị»)'
      : 'ADMIN_DISPLAY_NAME_FOR_ADDRESSING=(none — mặc định xưng «thầy/cô», không dùng «anh/chị»)',
    'USER=' + fitTextBudget(String(userMessage || ''), 160),
    'ORIGINAL_RESULT_JSON=',
    JSON.stringify(originalResult || {})
  ].join('\n');
}

function parsePlannerOutput(rawText) {
  const p = tryParseJsonLoose(String(rawText || ''));
  if (!p || typeof p !== 'object') {
    return {
      intent: 'general',
      answer_style: 'normal',
      must_use_metrics: [],
      student_resolution: 'none',
      missing_data: [],
      reasoning_steps: []
    };
  }
  return {
    intent: String(p.intent || 'general'),
    answer_style: p.answer_style === 'brief' ? 'brief' : 'normal',
    must_use_metrics: Array.isArray(p.must_use_metrics) ? p.must_use_metrics.map((x) => String(x || '')).filter(Boolean).slice(0, 12) : [],
    student_resolution:
      p.student_resolution === 'ambiguous' || p.student_resolution === 'unique' ? p.student_resolution : 'none',
    missing_data: Array.isArray(p.missing_data) ? p.missing_data.map((x) => String(x || '')).filter(Boolean).slice(0, 8) : [],
    reasoning_steps: Array.isArray(p.reasoning_steps) ? p.reasoning_steps.map((x) => String(x || '')).filter(Boolean).slice(0, 10) : []
  };
}

function computeConfidence(plan, intent, result, contextText) {
  const p = plan || {};
  const r = result || {};
  const i = intent || { name: 'general' };
  let score = 0.58;

  if (Array.isArray(p.reasoning_steps) && p.reasoning_steps.length >= 2) score += 0.08;
  if (Array.isArray(p.missing_data) && p.missing_data.length > 0) score -= 0.18;
  if (
    i.name === 'revenue_compare' &&
    /REVENUE_THIS_MONTH|REVENUE_LAST_MONTH|REVENUE_MONTH\(/.test(String(contextText || ''))
  ) {
    score += 0.1;
  }
  if (i.name === 'student_360' && p.student_resolution === 'unique') score += 0.12;
  if (i.name === 'student_360' && p.student_resolution === 'ambiguous') score -= 0.25;
  if (Array.isArray(r.targets) && r.targets.length > 0) score += 0.05;
  if (String(r.summary || '').length < 12) score -= 0.08;
  if (
    String(r.summary || '').match(
      /khong du du lieu|chua co du lieu|khong tim thay|không đủ dữ liệu|chưa có dữ liệu|không tìm thấy/i
    )
  ) {
    score -= 0.08;
  }
  if (typeof i.confidence === 'number') score = score * 0.75 + i.confidence * 0.25;
  return Math.max(0.05, Math.min(0.98, score));
}

function buildFollowupQuestion(intent, plan, message, userDisplayName) {
  const i = intent || { name: 'general' };
  const p = plan || {};
  const missing = Array.isArray(p.missing_data) ? p.missing_data : [];
  const voc = peerNameVocativePrefix(userDisplayName);
  if (i.name === 'student_360' && p.student_resolution === 'ambiguous') {
    return (
      'Để chốt đúng hồ sơ, ' +
      voc +
      'cho em thêm số điện thoại hoặc tên lớp của học viên nhé?'
    );
  }
  if (i.name === 'revenue_compare' && missing.length) {
    return voc + 'muốn em so sánh theo tháng dương lịch hay theo kỳ học phí để sát vận hành hơn?';
  }
  if (missing.length) {
    return '';
  }
  if (String(message || '').trim().split(/\s+/).length <= 3) {
    return voc + 'có muốn em đi sâu hơn và kèm danh sách hành động ưu tiên không?';
  }
  return '';
}

function buildPlannerGuidanceBlock(plan) {
  const p = plan || {};
  return [
    'PLANNER OUTPUT (bắt buộc tuân thủ):',
    '- intent=' + String(p.intent || 'general'),
    '- answer_style=' + String(p.answer_style || 'normal'),
    '- student_resolution=' + String(p.student_resolution || 'none'),
    '- must_use_metrics=' + ((p.must_use_metrics || []).join(', ') || 'none'),
    '- missing_data=' + ((p.missing_data || []).join(', ') || 'none'),
    '- reasoning_steps=' + ((p.reasoning_steps || []).join(' | ') || 'none')
  ].join('\n');
}

function buildIntentScopedContext(intent, userMessage, merged) {
  const i = intent && intent.name ? intent.name : 'general';
  if (i === 'revenue_compare') {
    return [
      'INTENT=' + i,
      buildAnalyticsContext(
        merged.students,
        merged.attendance,
        merged.payment,
        merged.extra,
        userMessage
      ),
      'PAYMENT_SAMPLE:\n' +
        toArraySafe(merged.payment)
          .slice(0, 45)
          .map((p) => '- ' + compactJson(p, 170))
          .join('\n')
    ].join('\n\n');
  }
  if (i === 'student_360') {
    return [
      'INTENT=' + i,
      buildStudentResolutionContext(userMessage, merged.students),
      buildStudent360Context(
        userMessage,
        merged.students,
        merged.attendance,
        merged.payment,
        merged.extra,
        merged.tuition_rows
      )
    ].join('\n\n');
  }
  if (i === 'debt_ops') {
    return [
      'INTENT=' + i,
      buildStudentResolutionContext(userMessage, merged.students),
      buildStudent360Context(
        userMessage,
        merged.students,
        merged.attendance,
        merged.payment,
        merged.extra,
        merged.tuition_rows
      ),
      'DEBT_BLOCK:\n' +
        toArraySafe(merged.extra && merged.extra.student_tuition_by_class)
          .slice(0, 120)
          .map((r) => '- ' + compactJson(r, 170))
          .join('\n'),
      buildAnalyticsContext(
        merged.students,
        merged.attendance,
        merged.payment,
        merged.extra,
        userMessage
      )
    ].join('\n\n');
  }
  if (i === 'attendance_ops') {
    return [
      'INTENT=' + i,
      'ATTENDANCE_BLOCK:\n' + toArraySafe(merged.attendance).slice(0, 180).map((a) => '- ' + compactJson(a, 150)).join('\n'),
      xayContext(merged.students, merged.attendance, merged.payment, {
        student_tuition_by_class: [],
        student_tuition: [],
        bank_transactions: [],
        consultation_leads: [],
        leaderboard_manual_scores: [],
        teacher_schedules: [],
        classes: [],
        class_definitions: [],
        class_fees: []
      })
    ].join('\n\n');
  }
  if (i === 'bank_ops') {
    return [
      'INTENT=' + i,
      'BANK_BLOCK:\n' + toArraySafe(merged.extra && merged.extra.bank_transactions).slice(0, 120).map((r) => '- ' + compactJson(r, 170)).join('\n')
    ].join('\n\n');
  }
  if (i === 'lead_ops') {
    return [
      'INTENT=' + i,
      'LEAD_BLOCK:\n' + toArraySafe(merged.extra && merged.extra.consultation_leads).slice(0, 100).map((r) => '- ' + compactJson(r, 170)).join('\n')
    ].join('\n\n');
  }
  return xayContext(merged.students, merged.attendance, merged.payment, merged.extra);
}

function buildSmartContext(userMessage, merged, intent) {
  if (isSmallTalk(userMessage)) {
    return 'GROUNDING_DATA:\nCâu hỏi xã giao. Không cần trích xuất danh sách học viên.';
  }
  const i = intent && intent.name ? intent : detectIntent(userMessage);
  return buildIntentScopedContext(i, userMessage, merged);
}

function isoDate(d) {
  return normalizeDateToYmd(d);
}

function parseIsoDateFromText(message) {
  const raw = String(message || '');
  const m1 = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m1) return m1[1] + '-' + m1[2] + '-' + m1[3];
  const m2 = raw.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
  if (m2) {
    const dd = String(Math.max(1, Math.min(31, Number(m2[1] || 1)))).padStart(2, '0');
    const mm = String(Math.max(1, Math.min(12, Number(m2[2] || 1)))).padStart(2, '0');
    return String(m2[3]) + '-' + mm + '-' + dd;
  }
  return '';
}

function parseTimeWindowFromMessage(message) {
  const raw = String(message || '');
  const n = normalizeText(raw);
  const now = new Date();
  const today = isoDate(now);
  const mk = (start, end) => ({ start, end });

  if (/\bhom\s*nay\b/.test(n)) return mk(today, today);
  if (/\b(chieu\s+nay|chieu\s*nay)\b/.test(n)) return mk(today, today);
  if (/\bhom\s*qua\b/.test(n)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    const x = isoDate(d);
    return mk(x, x);
  }
  let m = n.match(/\b(\d{1,3})\s*ngay\b/);
  if (m) {
    const days = Math.max(1, Math.min(365, Number(m[1] || 0)));
    const s = new Date(now);
    s.setDate(s.getDate() - (days - 1));
    return mk(isoDate(s), today);
  }
  if (/\btuan\s*nay\b/.test(n)) {
    const s = new Date(now);
    s.setDate(s.getDate() - 6);
    return mk(isoDate(s), today);
  }
  if (/\bthang\s*nay\b/.test(n)) {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    return mk(isoDate(s), today);
  }
  m = n.match(/\btu\s+ngay\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}-\d{2}-\d{2})\s+den\s+ngay\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}-\d{2}-\d{2})\b/);
  if (m) {
    const a = parseIsoDateFromText(m[1]);
    const b = parseIsoDateFromText(m[2]);
    if (a && b) return mk(a <= b ? a : b, a <= b ? b : a);
  }
  return mk('', '');
}

function listKnownClasses(merged) {
  const students = toArraySafe(merged && merged.students);
  const defs = toArraySafe(merged && merged.extra && merged.extra.class_definitions);
  const classes = [];
  students.forEach((s) => {
    if (s && s.class_name) classes.push(s.class_name);
    if (s && Array.isArray(s.class_names)) s.class_names.forEach((c) => classes.push(c));
  });
  defs.forEach((d) => {
    if (d && d.label) classes.push(d.label);
    if (d && d.display_name) classes.push(d.display_name);
  });
  toArraySafe(merged && merged.extra && merged.extra.class_fees).forEach((f) => {
    if (f && f.class_name) classes.push(f.class_name);
  });
  return distinctNonEmpty(classes).sort();
}

function guessClassFilterFromMessage(message, classes) {
  const raw = String(message || '');
  const n = normalizeText(raw);
  const arr = Array.isArray(classes) ? classes : [];
  let best = '';
  let bestLen = 0;
  arr.forEach((c) => {
    const cc = String(c || '').trim();
    if (!cc) return;
    const cn = normalizeText(cc);
    if (!cn) return;
    if (n.includes(cn) && cn.length > bestLen) {
      best = cc;
      bestLen = cn.length;
    }
  });
  return best;
}

function parseDebtSessionsRuleFromMessage(message) {
  const raw = String(message || '');
  if (!raw.trim()) return null;
  const n = normalizeText(raw);
  const hasNumberedDebtTopSignal =
    /(?:\d{1,3}|mot|hai|ba|bon|tu|nam|sau|bay|tam|chin|muoi)\s*(?:hoc sinh|hoc vien|ban|em)\s+(?:dang\s+)?no\s+(?:hoc phi\s+)?(?:nhieu|cao|nhieu nhat|cao nhat)/i.test(n);
  const hasTuitionDebtSignal = /(hoc phi|dong phi|nop phi|thanh toan|cong no|no hoc phi|no phi|chua dong|chua nop|sessions_due|debt)/i.test(n);
  if (!hasTuitionDebtSignal && !hasNumberedDebtTopSignal) return null;
  const mk = (v, mode, extra) =>
    Object.assign({ threshold: Math.max(0, Math.round(Number(v) || 0)), mode }, extra || {});
  const hasListIntent =
    /(danh sach|liet ke|nhung ai|hoc vien nao|hoc vien no|cac hoc vien|top\s*\d*|ai dang no|ai no)/i.test(n);

  const wordToNum = (w) => {
    const m = {
      mot: 1,
      hai: 2,
      ba: 3,
      bon: 4,
      tu: 4,
      nam: 5,
      sau: 6,
      bay: 7,
      tam: 8,
      chin: 9,
      muoi: 10
    };
    return m[String(w || '').trim()] || null;
  };

  const parseNumberToken = (tok) => {
    if (/^\d+$/.test(tok)) return Number(tok);
    const x = wordToNum(tok);
    return Number.isFinite(x) ? x : null;
  };

  let m = n.match(/(?:tren|hon)\s*(\d+|[a-z]+)\s*buoi/);
  if (m) {
    const v = parseNumberToken(m[1]);
    if (v != null) return mk(v, 'gt');
  }
  m = n.match(/(?:duoi|it hon)\s*(\d+|[a-z]+)\s*buoi/);
  if (m) {
    const v = parseNumberToken(m[1]);
    if (v != null) return mk(v, 'lt');
  }
  m = n.match(/(?:khong qua|toi da)\s*(\d+|[a-z]+)\s*buoi/);
  if (m) {
    const v = parseNumberToken(m[1]);
    if (v != null) return mk(v, 'lte');
  }
  m = n.match(/(?:bang|dung)\s*(\d+|[a-z]+)\s*buoi/);
  if (m) {
    const v = parseNumberToken(m[1]);
    if (v != null) return mk(v, 'eq');
  }
  m = n.match(/(?:tu|it nhat|toi thieu)\s*(\d+|[a-z]+)\s*buoi/);
  if (m) {
    const v = parseNumberToken(m[1]);
    if (v != null) return mk(v, 'gte');
  }
  m = n.match(/tu\s*(\d+|[a-z]+)\s*den\s*(\d+|[a-z]+)\s*buoi/);
  if (m) {
    const v1 = parseNumberToken(m[1]);
    const v2 = parseNumberToken(m[2]);
    if (v1 != null && v2 != null) {
      const lo = Math.min(v1, v2);
      const hi = Math.max(v1, v2);
      return mk(lo, 'between', { upper: hi });
    }
  }
  m = n.match(/(\d+|[a-z]+)\s*buoi\s*(?:tro len|hoac hon)/);
  if (m) {
    const v = parseNumberToken(m[1]);
    if (v != null) return mk(v, 'gte');
  }
  m = raw.match(/>\s*(\d+)/);
  if (m) return mk(m[1], 'gt');
  m = raw.match(/>=\s*(\d+)/);
  if (m) return mk(m[1], 'gte');
  m = raw.match(/<\s*(\d+)/);
  if (m) return mk(m[1], 'lt');
  m = raw.match(/<=\s*(\d+)/);
  if (m) return mk(m[1], 'lte');
  m = raw.match(/=\s*(\d+)/);
  if (m) return mk(m[1], 'eq');

  // Top N theo nợ buổi / nợ tiền
  m = n.match(/top\s*(\d{1,3})/);
  if (m) {
    if (!/(hoc phi|dong phi|nop phi|thanh toan|cong no|no hoc phi|no phi|chua dong|chua nop)/i.test(n)) return null;
    if (!/(nhieu nhat|cao nhat|no nhieu|no cao|uu tien|sap xep|top\s*\d{1,3})/i.test(n)) return null;
    const limit = Math.max(1, Math.min(120, Number(m[1] || 0)));
    const sortKey = /(no tien|so tien|amount|vnd)/i.test(n) ? 'amount' : 'sessions';
    if (limit > 0) return mk(0, 'top', { limit, sortKey });
  }
  m = n.match(/(?:lay|cho|tra|liet ke|danh sach)?\s*(\d{1,3}|mot|hai|ba|bon|tu|nam|sau|bay|tam|chin|muoi)\s*(?:hoc sinh|hoc vien|ban|em)\s+(?:dang\s+)?no\s+(?:hoc phi\s+)?(?:nhieu|cao|nhieu nhat|cao nhat)/i);
  if (m) {
    const parsedLimit = parseNumberToken(m[1]);
    const limit = Math.max(1, Math.min(120, Number(parsedLimit || 0)));
    const sortKey = /(no tien|so tien|amount|vnd|cao)/i.test(n) ? 'amount' : 'sessions';
    if (limit > 0) return mk(0, 'top', { limit, sortKey });
  }
  if (hasListIntent && /(cao nhat|nhieu nhat|uu tien|sap xep)/i.test(n)) {
    if (!/(hoc phi|dong phi|nop phi|thanh toan|cong no|no hoc phi|no phi|chua dong|chua nop)/i.test(n)) return null;
    const sortKey = /(no tien|so tien|amount|vnd)/i.test(n) ? 'amount' : 'sessions';
    return mk(0, 'top', { limit: 20, sortKey });
  }

  // Câu hỏi tự nhiên: "nợ nhiều/nợ cao/nợ sâu/cần ưu tiên" => ngưỡng mặc định > 5 buổi.
  if (
    hasListIntent &&
    /(no nhieu|no cao|no sau|cong no cao|can uu tien|uu tien thu no|nhieu buoi no)/i.test(n)
  ) {
    return mk(5, 'gt');
  }
  return null;
}

/**
 * Câu về **nợ học phí theo buổi** (sessions_due) — không phải điểm danh vắng.
 * Dùng để: (1) ưu tiên intent debt_ops, (2) chặn parser điểm danh khi GPT gắn nhầm "điểm danh|vắng".
 */
function looksLikeTuitionDebtBySessionsQuery(message) {
  const n = normalizeText(message || '');
  if (!n) return false;
  if (/\b(vang|(iem|diem)\s+danh|co\s+mat|di\s+hoc|absent|present|attendance)\b/.test(n)) return false;
  return !!parseDebtSessionsRuleFromMessage(message);
}

function buildDebtThresholdDeterministicResult(merged, rule) {
  const tuitionByClass = toArraySafe(merged && merged.extra && merged.extra.student_tuition_by_class);
  const tuitionRows = toArraySafe(merged && merged.tuition_rows);
  const students = toArraySafe(merged && merged.students);
  const classDefs = toArraySafe(merged && merged.extra && merged.extra.class_definitions);
  const byId = {};
  const byPhone = {};
  const studentById = {};
  const studentByPhone = {};
  const normalizeClassKey = (v) => normalizeText(String(v || ''));
  const classDisplayByKey = {};
  classDefs.forEach((d) => {
    const display = toShortClassLabel(String((d && (d.display_name || d.name || d.label)) || '').trim());
    const key = normalizeClassKey(display);
    if (key && display && !classDisplayByKey[key]) classDisplayByKey[key] = display;
  });
  students.forEach((s) => {
    const sid = String((s && s.id) || '').trim();
    const phone = String((s && s.phone) || '').trim();
    if (sid) studentById[sid] = s;
    if (phone) studentByPhone[phone] = s;
  });
  const ensureBucket = (sidRaw, rowName, rowPhone) => {
    const sid = String(sidRaw || '').trim();
    const phone = String(rowPhone || '').trim();
    let key = sid;
    if (!key && phone && byPhone[phone]) key = byPhone[phone];
    if (!key) key = 'tmp_' + normalizeText(String(rowName || 'khong_ro')) + '_' + phone;
    if (!byId[key]) {
      byId[key] = {
        student_id: sid || '',
        name: String(rowName || '').trim(),
        phone,
        sessions_due: 0,
        amount_due: 0,
        classes: []
      };
      if (phone) byPhone[phone] = key;
    }
    return byId[key];
  };
  const getRowClassDisplay = (r) => {
    const raw = String(
      (r &&
        (r.class_display_name ||
          r.class_label ||
          r.className ||
          r.class_name ||
          r.class ||
          r.class_code ||
          r.classCode ||
          r.label ||
          r.name)) ||
        ''
    ).trim();
    const cleanedRaw = toShortClassLabel(raw);
    /** Rút gọn "MVK_C2_N2 • Wed 14:00-16:00 • Sun ..." -> "MVK_C2_N2" để card nợ dễ đọc. */
    const cleaned = cleanedRaw
      .split('•')[0]
      .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Thứ\s*[2-7]|CN)\b[\s\S]*$/i, '')
      .trim();
    const k = normalizeClassKey(cleaned || raw);
    return classDisplayByKey[k] || cleaned || '';
  };
  const pushClassLabel = (bucket, label) => {
    if (!bucket) return;
    const cls = String(label || '').trim();
    if (!cls) return;
    if (!bucket.classes.includes(cls)) bucket.classes.push(cls);
  };
  const parseLooseNumber = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'string') {
      const m = v.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
      return m ? Number(m[0]) : 0;
    }
    return Number(v || 0) || 0;
  };
  tuitionByClass.forEach((r) => {
    const sid = String((r && r.student_id) || '').trim();
    const rowName = String((r && (r.student_name || r.name)) || '').trim();
    const rowPhone = String((r && (r.phone || r.student_phone)) || '').trim();
    const sess = parseLooseNumber(
      r && (r.sessions_due || r.debt_sessions || r.remaining_sessions || r.pending_buoi || r.pending_sessions || r.pending || 0)
    );
    const amt = parseLooseNumber(
      r && (r.amount_due || r.debt_amount || r.remaining_amount || r.owed_vnd || r.owed || r.pending_amount || 0)
    );
    if (!Number.isFinite(sess) || sess <= 0) return;
    const b = ensureBucket(sid, rowName, rowPhone);
    b.sessions_due += sess;
    if (Number.isFinite(amt) && amt > 0) b.amount_due += amt;
    pushClassLabel(b, getRowClassDisplay(r));
  });
  tuitionRows.forEach((r) => {
    const sid = String((r && (r.student_id || r.id)) || '').trim();
    const rowName = String((r && (r.student_name || r.name)) || '').trim();
    const rowPhone = String((r && (r.phone || r.student_phone)) || '').trim();
    const sess = parseLooseNumber(
      r && (r.pending_buoi || r.pending_sessions || r.pending || r.sessions_due || r.remaining_sessions || r.debt_sessions || 0)
    );
    const amt = parseLooseNumber(
      r && (r.owed_vnd || r.owed || r.amount_due || r.remaining_amount || r.debt_amount || r.pending_amount || 0)
    );
    if ((!Number.isFinite(sess) || sess <= 0) && (!Number.isFinite(amt) || amt <= 0)) return;
    const b = ensureBucket(sid, rowName, rowPhone);
    if (Number.isFinite(sess) && sess > 0) b.sessions_due += sess;
    if (Number.isFinite(amt) && amt > 0) b.amount_due += amt;
    pushClassLabel(b, getRowClassDisplay(r));
  });

  Object.keys(byId).forEach((sid) => {
    const row = byId[sid] || {};
    const s =
      (row.student_id && studentById[row.student_id]) ||
      (row.phone && studentByPhone[row.phone]) ||
      studentById[sid] ||
      null;
    if (!s) return;
    if (!row.name) row.name = String((s && s.name) || '').trim();
    if (!row.phone) row.phone = String((s && s.phone) || '').trim();
    if (!row.classes.length) {
      const fromStudent = toShortClassLabel(String((s && (s.class_name || s.class)) || '').trim());
      const k = normalizeClassKey(fromStudent);
      pushClassLabel(row, classDisplayByKey[k] || fromStudent);
    }
  });

  const threshold = Number((rule && rule.threshold) || 0);
  const mode = String((rule && rule.mode) || 'gt');
  const upper = Number((rule && rule.upper) || threshold);
  const limit = Math.max(1, Math.min(120, Number((rule && rule.limit) || 120)));
  const sortKey = String((rule && rule.sortKey) || 'sessions');
  const pass = (x) => {
    if (mode === 'gte') return x >= threshold;
    if (mode === 'gt') return x > threshold;
    if (mode === 'lt') return x < threshold;
    if (mode === 'lte') return x <= threshold;
    if (mode === 'eq') return x === threshold;
    if (mode === 'between') return x >= threshold && x <= upper;
    if (mode === 'top') return true;
    return x > threshold;
  };

  const sorted = Object.values(byId).sort((a, b) => {
    const sa = Number(a.sessions_due || 0);
    const sb = Number(b.sessions_due || 0);
    const aa = Number(a.amount_due || 0);
    const ab = Number(b.amount_due || 0);
    if (sortKey === 'amount') return ab - aa || sb - sa;
    return sb - sa || ab - aa;
  });
  const picked = sorted.filter((x) => pass(Number(x.sessions_due || 0))).slice(0, limit);

  const ngLabel =
    mode === 'gte'
      ? 'từ'
      : mode === 'gt'
        ? 'trên'
        : mode === 'lt'
          ? 'dưới'
          : mode === 'lte'
            ? 'không quá'
            : mode === 'eq'
              ? 'bằng'
              : mode === 'between'
                ? 'từ'
                : 'top';
  const condLabel =
    mode === 'between'
      ? ngLabel + ' ' + threshold + ' đến ' + upper + ' buổi'
      : mode === 'top'
        ? ngLabel +
          ' ' +
          limit +
          ' học viên nợ ' +
          (sortKey === 'amount' ? 'cao nhất theo số tiền' : 'cao nhất theo số buổi')
        : ngLabel + ' ' + threshold + ' buổi';
  const targets = picked.slice(0, 120).map((x) => {
    const sessions = Math.round(Number(x.sessions_due || 0));
    const amount = Number(x.amount_due || 0);
    const cls = x.classes.length ? x.classes.slice(0, 2).join(', ') : 'chưa rõ lớp';
    const phoneDigits = String(x.phone || '').replace(/\D/g, '');
    return {
      name: x.name || 'Không rõ',
      phone: x.phone || '',
      zalo_link: phoneDigits ? 'https://zalo.me/' + phoneDigits : '',
      message: buildParentTuitionReminderMessage({
        name: x.name || '',
        className: cls,
        sessions,
        amount
      }),
      note: x.phone ? '' : 'Thiếu SĐT'
    };
  });

  const topNames = picked
    .slice(0, limit)
    .map((x) => {
      const sess = Math.round(Number(x.sessions_due || 0));
      const amt = Number(x.amount_due || 0);
      return (x.name || 'Không rõ') + ': ' + sess + ' buổi' + (amt > 0 ? ' - ' + formatVndAmount(amt) : '');
    });

  return {
    type: picked.length ? 'warning' : 'info',
    summary: picked.length
      ? mode === 'top'
        ? 'Học viên nợ học phí cao nhất:\n' + topNames.map((x, i) => i + 1 + '. ' + x).join('\n')
        : 'Có ' + picked.length + ' học viên nợ học phí ' + condLabel + '.\n' + topNames.map((x, i) => i + 1 + '. ' + x).join('\n')
      : 'Không có học viên nào nợ học phí ' + condLabel + ' trong dữ liệu hiện tại.',
    targets,
    requires_confirmation: false,
    insight: picked.length
      ? 'Danh sách đã lọc theo ngưỡng nợ buổi từ dữ liệu grounding, không suy diễn từ model.'
      : '',
    next_question: '',
    actions: picked.length ? ['Ưu tiên nhắc phụ huynh theo thứ tự nợ buổi cao xuống thấp'] : []
  };
}

function messageMentionsAttendanceRollcall(message) {
  const raw = String(message || '')
    .normalize('NFC')
    .toLowerCase();
  const n = normalizeText(message || '');
  return /điểm\s*danh/i.test(raw) || /\b(iem|diem)\s+danh\b/i.test(n) || /\battendance\b/i.test(raw);
}

/** Hủy/sửa/xóa điểm danh — ngoài phạm vi trợ lý (chỉ đọc dữ liệu). */
function looksLikeAttendanceWriteCancelMessage(message) {
  const raw = String(message || '')
    .normalize('NFC')
    .toLowerCase();
  const n = normalizeText(message || '');
  if (!messageMentionsAttendanceRollcall(message)) return false;
  return (
    /hủy|huỷ|xóa|xoá|sửa|ghi\s+đè|ghi\s+lại|điều\s+chỉnh|thu\s+hồi|khôi\s+phục|chấm\s+lại|cập\s+nhật\s+lại/i.test(raw) ||
    /\b(huy|xoa|cancel|overwrite)\b/i.test(raw) ||
    /\b(huy|xoa|sua|ghi\s+de|cham\s+lai|cap\s+nhap\s+lai)\b/.test(n)
  );
}

function buildAttendanceMutationUnsupportedResult(userDisplayName) {
  const n = peerAdminAddressSentence(userDisplayName);
  const head = n ? n + ' — ' : '';
  return {
    type: 'info',
    summary:
      head +
      'Trợ lý trong chat chỉ đọc và tóm tắt điểm danh đã có, không hủy/xóa/sửa hay chấm lại buổi học được. Để hủy hoặc chỉnh buổi chiều hôm nay, làm trực tiếp trong tab Điểm danh của MV Klass.',
    targets: [],
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: ['Vào tab Điểm danh, chọn lớp và buổi tương ứng để chỉnh']
  };
}

function parseAttendanceRuleFromMessage(message, merged) {
  const raw = String(message || '');
  if (!raw.trim()) return null;
  if (looksLikeAttendanceWriteCancelMessage(stripNormalizedQueryHint(raw))) return null;
  if (looksLikeTuitionDebtBySessionsQuery(stripNormalizedQueryHint(raw))) return null;
  const n = normalizeText(raw);
  if (!/(vang|di hoc|co mat|iem\s+danh|diem\s+danh|attendance)/i.test(n)) return null;

  let mode = 'present';
  if (/\b(vang|absent)\b/i.test(n)) mode = 'absent';
  else if (/\bco\s*mat\b|\bdi\s*hoc\b|\bpresent\b/i.test(n)) mode = 'present';
  else if (/(thong\s+ke|bao\s+cao|tom\s+tat|phan\s+tich)/.test(n) && /(iem|diem)\s+danh/.test(n)) mode = 'present';

  const window = parseTimeWindowFromMessage(raw);
  const classes = listKnownClasses(merged);
  const classFilter = guessClassFilterFromMessage(raw, classes);

  const aggregateByClass =
    /\b(by|per)\s*class\b/i.test(raw) ||
    /theo\s+tung\s*lop/.test(n) ||
    /theo\s+(cac\s*)?lop\b/.test(n) ||
    /tat\s+ca\s+(cac\s*)?lop/.test(n) ||
    /\bgop\s+(theo\s+)?lop\b/.test(n) ||
    (/thong\s+ke/.test(n) && /lop/.test(n) && /(iem|diem)\s+danh/.test(n));

  // Ngưỡng vắng: "vắng >= 3 buổi", "vắng nhiều", "top 10 vắng"
  let rule = null;
  if (/top\s*\d{1,3}/i.test(n) || /(nhieu nhat|cao nhat|uu tien|sap xep)/i.test(n)) {
    const m = n.match(/top\s*(\d{1,3})/);
    const limit = m ? Math.max(1, Math.min(120, Number(m[1] || 0))) : 20;
    rule = { mode: 'top', limit };
  }
  const m2 = n.match(/(?:tu|it nhat|toi thieu)\s*(\d+|[a-z]+)\s*buoi/);
  if (!rule && m2 && mode === 'absent') {
    const v = /^\d+$/.test(m2[1]) ? Number(m2[1]) : null;
    if (v != null) rule = { mode: 'gte', threshold: v };
  }
  if (!rule && mode === 'absent' && /(vang nhieu|vang lien tuc|vang qua nhieu)/i.test(n)) {
    rule = { mode: 'gte', threshold: 3 };
  }
  return { mode, window, classFilter, rule, aggregateByClass };
}

function buildAttendanceAggregateByClassResult(merged, parsed) {
  const attendance = toArraySafe(merged && merged.attendance);
  const mode = parsed && parsed.mode === 'present' ? 'present' : 'absent';
  const clsFilter = String((parsed && parsed.classFilter) || '').trim();
  const normFilter = clsFilter ? normalizeText(clsFilter) : '';
  const win = parsed && parsed.window ? parsed.window : { start: '', end: '' };
  let start = String(win.start || '').trim();
  let end = String(win.end || '').trim();
  const now = new Date();
  const today = isoDate(now);
  if (!start || !end) {
    const s = new Date(now);
    s.setDate(s.getDate() - 6);
    start = isoDate(s);
    end = today;
  }

  const inRange = (d) => {
    const x = String(d || '').slice(0, 10);
    if (!x) return false;
    if (start && x < start) return false;
    if (end && x > end) return false;
    return true;
  };

  const byClass = {};
  attendance.forEach((a) => {
    if (!a) return;
    const stRaw = normalizeText(String(a.status || ''));
    const st = stRaw === 'present' || /co mat|di hoc/.test(stRaw) ? 'present' : stRaw === 'absent' || /vang/.test(stRaw) ? 'absent' : '';
    if (st !== mode) return;
    const date = normalizeDateToYmd(a.date);
    if (!inRange(date)) return;
    const className = toShortClassLabel(String(a.class_name || '').trim());
    if (!className) return;
    const nk = normalizeText(className);
    if (normFilter && nk !== normFilter) return;
    const sid = String(a.student_id || '').trim();
    if (!byClass[nk]) byClass[nk] = { label: className, marks: 0, sids: new Set() };
    byClass[nk].label = className;
    byClass[nk].marks += 1;
    if (sid) byClass[nk].sids.add(sid);
  });

  const labelMode = mode === 'present' ? 'có mặt' : 'vắng';
  const labelRange =
    start && end && start === end ? 'ngày ' + shortDateVi(start) : 'từ ' + shortDateVi(start) + ' đến ' + shortDateVi(end);
  const ordered = Object.keys(byClass).sort((a, b) => byClass[b].marks - byClass[a].marks);
  const lines = [];
  lines.push(
    'Thống kê điểm danh (' +
      labelMode +
      ') ' +
      labelRange +
      ', theo lớp' +
      (clsFilter ? ' (lớp ' + clsFilter + ')' : '') +
      ':'
  );
  if (!ordered.length) {
    lines.push('- Chưa có dữ liệu trong khoảng này.');
  } else {
    ordered.forEach((nk) => {
      const r = byClass[nk];
      lines.push('- ' + r.label + ': ' + r.marks + ' buổi ghi nhận · ' + r.sids.size + ' học viên');
    });
  }

  return {
    type: ordered.length ? 'info' : 'warning',
    summary: lines.join('\n'),
    targets: [],
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: ordered.length ? [] : ['Kiểm tra điểm danh đã nhập đủ trong khoảng ngày trên']
  };
}

function buildAttendanceDeterministicResult(merged, parsed) {
  if (parsed && parsed.aggregateByClass) {
    return buildAttendanceAggregateByClassResult(merged, parsed);
  }
  const students = toArraySafe(merged && merged.students);
  const attendance = toArraySafe(merged && merged.attendance);
  const mode = parsed && parsed.mode === 'present' ? 'present' : 'absent';
  const cls = String((parsed && parsed.classFilter) || '').trim();
  const win = parsed && parsed.window ? parsed.window : { start: '', end: '' };
  const start = win.start || '';
  const end = win.end || '';

  const inRange = (d) => {
    const x = String(d || '').slice(0, 10);
    if (!x) return false;
    if (start && x < start) return false;
    if (end && x > end) return false;
    return true;
  };

  const byStudent = {};
  attendance.forEach((a) => {
    if (!a) return;
    const stRaw = normalizeText(String(a.status || ''));
    const st = stRaw === 'present' || /co mat|di hoc/.test(stRaw) ? 'present' : stRaw === 'absent' || /vang/.test(stRaw) ? 'absent' : '';
    if (st !== mode) return;
    const date = normalizeDateToYmd(a.date);
    if (!inRange(date)) return;
    const className = toShortClassLabel(String(a.class_name || '').trim());
    if (cls && normalizeText(className) !== normalizeText(cls)) return;
    const sid = String(a.student_id || '').trim();
    if (!sid) return;
    if (!byStudent[sid]) byStudent[sid] = { sid, count: 0, classes: new Set(), lastDate: '' };
    byStudent[sid].count += 1;
    if (className) byStudent[sid].classes.add(className);
    if (!byStudent[sid].lastDate || date > byStudent[sid].lastDate) byStudent[sid].lastDate = date;
  });

  const rows = Object.values(byStudent).map((r) => {
    const stu = students.find((s) => String((s && s.id) || '') === String(r.sid));
    return {
      sid: r.sid,
      name: String((stu && stu.name) || '').trim(),
      phone: String((stu && stu.phone) || '').trim(),
      count: r.count,
      classes: Array.from(r.classes),
      lastDate: r.lastDate
    };
  });

  const rule = parsed && parsed.rule ? parsed.rule : null;
  let picked = rows.slice();
  if (rule && rule.mode === 'gte') {
    const thr = Math.max(0, Number(rule.threshold || 0));
    picked = picked.filter((x) => Number(x.count || 0) >= thr);
  }
  picked.sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
  if (rule && rule.mode === 'top') {
    picked = picked.slice(0, Math.max(1, Math.min(120, Number(rule.limit || 20))));
  }

  const labelMode = mode === 'present' ? 'có mặt' : 'vắng';
  const labelRange = start && end ? start === end ? 'ngày ' + shortDateVi(start) : 'từ ' + shortDateVi(start) + ' đến ' + shortDateVi(end) : 'khoảng thời gian yêu cầu';
  const labelClass = cls ? (' · lớp ' + cls) : '';
  const targets = picked.slice(0, 120).map((x) => ({
    name: x.name || 'Không rõ',
    phone: x.phone || '',
    zalo_link: '',
    message:
      'Trong ' +
      labelRange +
      (cls ? '' : x.classes.length ? ' (lớp: ' + x.classes.join(', ') + ')' : '') +
      ': ' +
      labelMode +
      ' ' +
      x.count +
      ' buổi.' +
      (x.lastDate ? ' Gần nhất: ' + shortDateVi(x.lastDate) + '.' : ''),
    note: x.phone ? '' : 'Thiếu SĐT'
  }));

  return {
    type: picked.length ? 'info' : 'warning',
    summary: picked.length
      ? 'Danh sách học viên ' + labelMode + ' ' + labelRange + labelClass + ': ' + picked.length + ' học viên.'
      : 'Chưa tìm thấy dữ liệu ' + labelMode + ' ' + labelRange + labelClass + ' trong dữ liệu hiện tại.',
    targets,
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: picked.length && mode === 'absent' ? ['Ưu tiên liên hệ học viên vắng nhiều nhất'] : []
  };
}

/** Học phí/buổi theo `class_name` (chuẩn hoá không dấu) — có thêm fee_amount của bảng class_fees trong DB MV Klass. */
function getNormalizedClassFeeMapFromMerged(merged) {
  const feeByClass = {};
  const classFees = toArraySafe(merged && merged.extra && merged.extra.class_fees);
  classFees.forEach((r) => {
    const k = normalizeText((r && (r.class_name || r.class || r.name)) || '');
    if (!k) return;
    const fee = Number(
      (r && (r.fee_per_session || r.fee || r.amount_vnd || r.tuition_fee || r.amount || r.fee_amount)) || 0
    );
    if (!Number.isFinite(fee) || fee <= 0) return;
    if (!feeByClass[k]) feeByClass[k] = fee;
  });
  return feeByClass;
}

function parseRevenueRuleFromMessage(message, merged) {
  const raw = String(message || '');
  if (!raw.trim()) return null;
  const n = normalizeText(raw);
  if (!/(doanh thu|revenue|thu hoc phi|thu tien|tien thu)/i.test(n)) return null;
  const dayWindow = parseTimeWindowFromMessage(raw);
  const hasDayScope = !!(dayWindow && dayWindow.start && dayWindow.end);
  const wantsToday = /\bhom nay\b/.test(n);
  const wantsYesterday = /\bhom qua\b/.test(n);
  const wantsLastWeekDay = /\btuan truoc\b/.test(n);
  const asksHealth = /(dao nay|on khong|ok khong|tot khong|the nao|sao roi|co on)/i.test(n);
  const mode =
    /(so sanh|vs|voi|tang|giam|chenh lech|thang nay|thang truoc)/i.test(n) ||
    (wantsToday && (wantsYesterday || wantsLastWeekDay)) ||
    asksHealth
      ? 'compare'
      : 'single';
  const monthKey = parseRevenueMonthKeyFromMessage(raw, new Date());
  const classes = listKnownClasses(merged);
  const classFilter = guessClassFilterFromMessage(raw, classes);
  const byChannel = /(kenh|chuyen khoan|tien mat|payment_channel|channel)/i.test(n);
  const askAttendanceBased =
    // "doanh thu dựa trên/theo ... điểm danh/có mặt"
    /((dua|theo|tinh).{0,40}(diem danh|co mat))|((diem danh|co mat).{0,40}(doanh thu|revenue|thu hoc phi|thu tien))/i.test(
      n
    ) ||
    /(hoc sinh.*diem danh|diem danh.*hoc sinh)/i.test(n);
  return {
    mode,
    monthKey,
    classFilter,
    byChannel,
    dayWindow,
    hasDayScope,
    wantsToday,
    wantsYesterday,
    wantsLastWeekDay,
    asksHealth,
    askAttendanceBased
  };
}

function buildRevenueDeterministicResult(merged, parsed) {
  const pay = toArraySafe(merged && merged.payment);
  const now = new Date();
  const thisMonth = toMonthKey(now);
  const lastMonth = toMonthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const classFilter = String((parsed && parsed.classFilter) || '').trim();
  const normClass = classFilter ? normalizeText(classFilter) : '';
  const mode = parsed && parsed.mode === 'compare' ? 'compare' : 'single';
  const mk = parsed && parsed.monthKey ? String(parsed.monthKey) : '';
  const hasDayScope = !!(parsed && parsed.hasDayScope);
  const dayWindow = (parsed && parsed.dayWindow) || { start: '', end: '' };
  const askAttendanceBased = !!(parsed && parsed.askAttendanceBased);
  const asksHealth = !!(parsed && parsed.asksHealth);

  const inClass = (p) => {
    if (!normClass) return true;
    const cn = normalizeText(String((p && p.class_name) || (p && p.class) || ''));
    return cn && cn === normClass;
  };
  const sumDayRange = (start, end) => {
    let sum = 0;
    let count = 0;
    pay.forEach((p) => {
      const d = paymentRowDate(p);
      if (!d) return;
      const ds = normalizeDateToYmd(d);
      if (!ds) return;
      if (start && ds < start) return;
      if (end && ds > end) return;
      if (!inClass(p)) return;
      sum += paymentRowAmount(p);
      count += 1;
    });
    return { sum, count };
  };
  const sumMonth = (monthKey) => {
    let sum = 0;
    let count = 0;
    pay.forEach((p) => {
      const d = paymentRowDate(p);
      if (!d) return;
      if (toMonthKey(d) !== monthKey) return;
      if (!inClass(p)) return;
      sum += paymentRowAmount(p);
      count += 1;
    });
    return { sum, count };
  };

  let titleScope = 'Doanh thu';
  if (classFilter) titleScope += ' · lớp ' + classFilter;

  const estimateByAttendanceForDate = (dateStr) => {
    const att = toArraySafe(merged && merged.attendance);
    const feeByClass = getNormalizedClassFeeMapFromMerged(merged);
    const byClassPresent = {};
    att.forEach((a) => {
      const ds = normalizeDateToYmd(a && a.date);
      if (!ds || ds !== dateStr) return;
      const stRaw = normalizeText(String((a && a.status) || ''));
      const st = stRaw === 'present' || /co mat|di hoc/.test(stRaw) ? 'present' : stRaw === 'absent' || /vang/.test(stRaw) ? 'absent' : '';
      if (st !== 'present') return;
      const className = String((a && a.class_name) || '').trim();
      if (classFilter && normalizeText(className) !== normClass) return;
      const ck = normalizeText(className);
      if (!ck) return;
      byClassPresent[ck] = (byClassPresent[ck] || 0) + 1;
    });
    let estimated = 0;
    Object.keys(byClassPresent).forEach((ck) => {
      const p = Number(byClassPresent[ck] || 0);
      const fee = Number(feeByClass[ck] || 0);
      if (p > 0 && fee > 0) estimated += p * fee;
    });
    return { estimated, byClassPresent };
  };

  if (askAttendanceBased) {
    const todayStr = isoDate(new Date());
    const actual = sumDayRange(todayStr, todayStr);
    const est = estimateByAttendanceForDate(todayStr);
    const diff = actual.sum - est.estimated;
    const summary =
      titleScope +
      ' (hôm nay, đối chiếu theo điểm danh):\n' +
      '- Thu thực tế (payment_history): ' +
      formatVndAmount(actual.sum) +
      ' · ' +
      actual.count +
      ' giao dịch\n' +
      '- Ước tính theo điểm danh × học phí/buổi: ' +
      formatVndAmount(est.estimated) +
      '\n' +
      '- Chênh lệch: ' +
      (diff >= 0 ? 'cao hơn ' : 'thấp hơn ') +
      formatVndAmount(Math.abs(diff));
    return {
      type: 'info',
      summary,
      targets: [],
      requires_confirmation: false,
      insight: 'Số ước tính phụ thuộc dữ liệu class_fees và trạng thái điểm danh có mặt trong ngày.',
      next_question: '',
      actions: ['Nếu lệch lớn, kiểm tra lại payment_history chưa đối soát và class_fees theo từng lớp']
    };
  }

  if (hasDayScope) {
    const s = String(dayWindow.start || '');
    const e = String(dayWindow.end || '');
    const oneDay = s && e && s === e;
    const base = sumDayRange(s, e);
    if (mode === 'compare' && (parsed.wantsYesterday || parsed.wantsLastWeekDay || parsed.wantsToday)) {
      const d = s ? new Date(s) : new Date();
      const prev = new Date(d);
      prev.setDate(prev.getDate() - (parsed.wantsLastWeekDay ? 7 : 1));
      const prevKey = isoDate(prev);
      const cmp = sumDayRange(prevKey, prevKey);
      const diff = base.sum - cmp.sum;
      const trend = diff > 0 ? 'tăng' : diff < 0 ? 'giảm' : 'không đổi';
      const pct = cmp.sum > 0 ? (diff / cmp.sum) * 100 : null;
      const summary =
        titleScope +
        ' (' +
        (oneDay ? 'ngày ' + shortDateVi(s) : 'giai đoạn ' + shortDateVi(s) + ' - ' + shortDateVi(e)) +
        '):\n' +
        '- Hiện tại: ' +
        formatVndAmount(base.sum) +
        ' · ' +
        base.count +
        ' giao dịch\n' +
        '- So với ' +
        (parsed.wantsLastWeekDay ? 'cùng ngày tuần trước' : 'hôm qua') +
        ' (' +
        shortDateVi(prevKey) +
        '): ' +
        formatVndAmount(cmp.sum) +
        ' · ' +
        cmp.count +
        ' giao dịch\n' +
        '- Chênh lệch: ' +
        trend +
        ' ' +
        formatVndAmount(Math.abs(diff)) +
        (pct == null ? '' : ' (' + pct.toFixed(2) + '%)');
      return {
        type: 'info',
        summary,
        targets: [],
        requires_confirmation: false,
        insight: '',
        next_question: '',
        actions: []
      };
    }
    const summary =
      titleScope +
      ' (' +
      (oneDay ? 'ngày ' + shortDateVi(s) : 'giai đoạn ' + shortDateVi(s) + ' - ' + shortDateVi(e)) +
      '): ' +
      formatVndAmount(base.sum) +
      ' · ' +
      base.count +
      ' giao dịch.';
    return {
      type: 'info',
      summary,
      targets: [],
      requires_confirmation: false,
      insight: '',
      next_question: '',
      actions: []
    };
  }

  if (parsed && parsed.wantsToday && !hasDayScope) {
    const todayStr = isoDate(new Date());
    const base = sumDayRange(todayStr, todayStr);
    if (base.count === 0) {
      const est = estimateByAttendanceForDate(todayStr);
      if (est.estimated > 0) {
        return {
          type: 'warning',
          summary:
            titleScope +
            ' (ngày ' +
            shortDateVi(todayStr) +
            '): chưa ghi nhận giao dịch payment_history, ước tính theo điểm danh là ' +
            formatVndAmount(est.estimated) +
            '.',
          targets: [],
          requires_confirmation: false,
          insight: 'Không có giao dịch trong ngày nên trả thêm số ước tính từ điểm danh để bám sát thực tế vận hành.',
          next_question: '',
          actions: ['Đối soát payment_history trong ngày để chốt doanh thu thực thu']
        };
      }
    }
  }

  if (mode === 'compare') {
    const a = sumMonth(thisMonth);
    const b = sumMonth(lastMonth);
    const diff = a.sum - b.sum;
    const trend = diff > 0 ? 'tăng' : diff < 0 ? 'giảm' : 'không đổi';
    const pct = b.sum > 0 ? (diff / b.sum) * 100 : null;
    const healthLine =
      pct == null
        ? a.sum > 0
          ? '- Đánh giá: Có phát sinh doanh thu, nhưng chưa đủ mốc tháng trước để kết luận xu hướng.'
          : '- Đánh giá: Chưa ghi nhận doanh thu đáng kể trong dữ liệu đang có.'
        : pct >= 10
          ? '- Đánh giá: Khá ổn, doanh thu đang tăng tốt so với tháng trước.'
          : pct > 0
            ? '- Đánh giá: Ổn, doanh thu tăng nhẹ so với tháng trước.'
            : pct > -10
              ? '- Đánh giá: Cần theo dõi, doanh thu đang giảm nhẹ so với tháng trước.'
              : '- Đánh giá: Chưa ổn, doanh thu giảm đáng kể so với tháng trước.';
    const summary =
      titleScope +
      ' (tháng này vs tháng trước):\n' +
      '- Tháng này (' +
      monthKeyLabelVi(thisMonth) +
      '): ' +
      formatVndAmount(a.sum) +
      ' · ' +
      a.count +
      ' giao dịch\n' +
      '- Tháng trước (' +
      monthKeyLabelVi(lastMonth) +
      '): ' +
      formatVndAmount(b.sum) +
      ' · ' +
      b.count +
      ' giao dịch\n' +
      '- Chênh lệch: ' +
      trend +
      ' ' +
      formatVndAmount(Math.abs(diff)) +
      (pct == null ? '' : ' (' + pct.toFixed(2) + '%)') +
      (asksHealth ? '\n' + healthLine : '');
    return {
      type: 'info',
      summary,
      targets: [],
      requires_confirmation: false,
      insight: 'Nếu cần, em có thể tách theo kênh thanh toán hoặc theo từng lớp.',
      next_question: '',
      actions: ['Đối chiếu các giao dịch pending / needs_review để tránh lệch số']
    };
  }

  const key = mk || thisMonth;
  const r = sumMonth(key);
  const summary =
    titleScope +
    ' (' +
    monthKeyLabelVi(key) +
    '): ' +
    formatVndAmount(r.sum) +
    ' · ' +
    r.count +
    ' giao dịch.';
  return {
    type: 'info',
    summary,
    targets: [],
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: []
  };
}

function parseBankRuleFromMessage(message, merged) {
  const raw = String(message || '');
  if (!raw.trim()) return null;
  const n = normalizeText(raw);
  const asksMismatch = /(lech|khop|khong khop|chenh).*(chuyen khoan|giao dich).*(hoc phi|ghi nhan)/i.test(n);
  if (!asksMismatch && !/(giao dich|chuyen khoan|doi soat|ngan hang|bank|pending|needs_review)/i.test(n)) return null;
  const window = parseTimeWindowFromMessage(raw);
  const status =
    asksMismatch || /(needs_review|can doi soat|can xem|review)/i.test(n)
      ? 'needs_review'
      : /(pending|cho xu ly|dang cho)/i.test(n)
        ? 'pending'
        : /(thanh cong|success)/i.test(n)
          ? 'success'
          : 'any';
  // keyword: nội dung ck, mã, tên học viên... (lấy phần sau "tìm"/"chứa"/"có ghi")
  let keyword = '';
  const m =
    raw.match(/(?:tim|tìm|chua|chứa|co ghi|có ghi|noi dung|nội dung)\s*[:\-]?\s*(.{2,80})$/i) ||
    raw.match(/\"([^\"]{2,80})\"/);
  if (m) keyword = String(m[1] || m[0] || '').replace(/^[\"\']|[\"\']$/g, '').trim();
  const classes = listKnownClasses(merged);
  const classFilter = guessClassFilterFromMessage(raw, classes);
  return { window, status, keyword, classFilter, asksMismatch };
}

function buildBankDeterministicResult(merged, parsed) {
  const bank = toArraySafe(merged && merged.extra && merged.extra.bank_transactions);
  const win = parsed && parsed.window ? parsed.window : { start: '', end: '' };
  const start = win.start || '';
  const end = win.end || '';
  const status = String((parsed && parsed.status) || 'any');
  const asksMismatch = !!(parsed && parsed.asksMismatch);
  const keywordNorm = normalizeText(parsed && parsed.keyword ? parsed.keyword : '');
  const classFilter = String((parsed && parsed.classFilter) || '').trim();
  const classNorm = classFilter ? normalizeText(classFilter) : '';

  const inRange = (d) => {
    const x = String(d || '').slice(0, 10);
    if (!x) return !start && !end;
    if (start && x < start) return false;
    if (end && x > end) return false;
    return true;
  };
  const statusMatch = (b) => {
    if (status === 'any') return true;
    const st = String((b && (b.status || b.tx_status)) || '').toLowerCase();
    if (!st) return status === 'any';
    if (status === 'needs_review') return st === 'needs_review' || st === 'review';
    return st === status;
  };
  const keywordMatch = (b) => {
    if (!keywordNorm) return true;
    const blob = normalizeText(JSON.stringify(b || {}));
    return blob.includes(keywordNorm);
  };
  const classMatch = (b) => {
    if (!classNorm) return true;
    const cn = normalizeText(String((b && (b.class_name || b.class)) || ''));
    return cn && cn === classNorm;
  };
  const getDate = (b) =>
    String((b && (b.date || b.tx_date || b.paid_at || b.created_at || b.time)) || '').slice(0, 10);
  const getAmount = (b) =>
    Number((b && (b.amount_vnd ?? b.amount ?? b.value ?? b.total ?? b.money)) || 0);
  const getContent = (b) =>
    String((b && (b.content || b.description || b.note || b.memo || b.transfer_content)) || '').trim();

  const picked = bank
    .filter((b) => b && statusMatch(b) && keywordMatch(b) && classMatch(b) && inRange(getDate(b)))
    .sort((a, b) => String(getDate(b)).localeCompare(String(getDate(a))) || getAmount(b) - getAmount(a))
    .slice(0, 80);

  const labelRange =
    start && end ? (start === end ? 'ngày ' + shortDateVi(start) : 'từ ' + shortDateVi(start) + ' đến ' + shortDateVi(end)) : '';
  const labelStatus =
    status === 'any' ? 'tất cả trạng thái' : status === 'needs_review' ? 'needs_review' : status;
  const labelClass = classFilter ? ' · lớp ' + classFilter : '';
  const labelKey = keywordNorm ? ' · keyword "' + (parsed.keyword || '').trim().slice(0, 40) + '"' : '';

  const targets = picked.map((b) => {
    const d = getDate(b);
    const amt = getAmount(b);
    const cont = getContent(b);
    const st = String((b && (b.status || b.tx_status)) || '').trim();
    return {
      name: cont ? cont.slice(0, 46) : 'Giao dịch',
      phone: '',
      zalo_link: '',
      message:
        (d ? shortDateVi(d) + ' · ' : '') +
        (amt ? formatVndAmount(amt) + ' · ' : '') +
        (st ? 'trạng thái ' + st + ' · ' : '') +
        (cont ? cont : '—'),
      note: ''
    };
  });

  return {
    type: picked.length ? 'info' : 'warning',
    summary:
      (asksMismatch ? 'Các khoản lệch/chưa đối soát giữa chuyển khoản và học phí ghi nhận' : 'Giao dịch ngân hàng') +
      ' (' +
      labelStatus +
      (labelRange ? ' · ' + labelRange : '') +
      labelClass +
      labelKey +
      '): ' +
      picked.length +
      ' dòng.',
    targets,
    requires_confirmation: false,
    insight: picked.length ? 'Danh sách lọc trực tiếp từ dữ liệu giao dịch, không suy diễn từ model.' : '',
    next_question: '',
    actions: picked.length && (status === 'pending' || status === 'needs_review')
      ? ['Ưu tiên đối soát các dòng needs_review/pending trước']
      : []
  };
}

function parseLeadRuleFromMessage(message, merged) {
  const raw = String(message || '');
  if (!raw.trim()) return null;
  const n = normalizeText(raw);
  if (!/(lead|tu van|tuvan|phu huynh moi|dang ky tu van|consult)/i.test(n)) return null;
  const window = parseTimeWindowFromMessage(raw);
  const status =
    /\bnew\b|moi|chua xu ly|chua lien he/i.test(n)
      ? 'new'
      : /\bcontacted\b|da lien he/i.test(n)
        ? 'contacted'
        : /\bclosed\b|hoan tat/i.test(n)
          ? 'closed'
          : /\barchived\b|luu tru/i.test(n)
            ? 'archived'
            : 'any';
  const overdue =
    /(qua han|tre|cham|chua follow|chua follow up|overdue)/i.test(n) || /\bfollow\s*up\b/i.test(n);
  let days = 0;
  const m = n.match(/qua han\s*(\d{1,3})\s*ngay/);
  if (m) days = Math.max(1, Math.min(60, Number(m[1] || 0)));
  const keywordM =
    raw.match(/(?:tim|tìm|chua|chứa|ten|tên|sdt|sđt)\s*[:\-]?\s*(.{2,80})$/i) || raw.match(/\"([^\"]{2,80})\"/);
  const keyword = keywordM ? String(keywordM[1] || '').trim() : '';
  const classes = listKnownClasses(merged);
  const classFilter = guessClassFilterFromMessage(raw, classes);
  return { window, status, overdue, days, keyword, classFilter };
}

function buildLeadDeterministicResult(merged, parsed) {
  const leads = toArraySafe(merged && merged.extra && merged.extra.consultation_leads);
  const win = parsed && parsed.window ? parsed.window : { start: '', end: '' };
  const start = win.start || '';
  const end = win.end || '';
  const status = String((parsed && parsed.status) || 'any');
  const overdue = !!(parsed && parsed.overdue);
  const days = Math.max(0, Number((parsed && parsed.days) || 0));
  const keywordNorm = normalizeText(parsed && parsed.keyword ? parsed.keyword : '');
  const classFilter = String((parsed && parsed.classFilter) || '').trim();
  const classNorm = classFilter ? normalizeText(classFilter) : '';

  const getDate = (l) =>
    String((l && (l.created_at || l.createdAt || l.submitted_at || l.date)) || '').slice(0, 10);
  const inRange = (d) => {
    const x = String(d || '').slice(0, 10);
    if (!x) return !start && !end;
    if (start && x < start) return false;
    if (end && x > end) return false;
    return true;
  };
  const statusMatch = (l) => {
    if (status === 'any') return true;
    const st = String((l && l.status) || '').toLowerCase();
    return st === status;
  };
  const keywordMatch = (l) => {
    if (!keywordNorm) return true;
    return normalizeText(JSON.stringify(l || {})).includes(keywordNorm);
  };
  const classMatch = (l) => {
    if (!classNorm) return true;
    const cn = normalizeText(String((l && (l.class_name || l.class)) || ''));
    return cn && cn === classNorm;
  };
  const overdueMatch = (l) => {
    if (!overdue) return true;
    const st = String((l && l.status) || '').toLowerCase();
    if (st && !['new', 'pending', 'open'].includes(st)) return false;
    const d0 = getDate(l);
    if (!d0) return true;
    const baseDays = days || 3;
    const dt = new Date(d0);
    if (isNaN(dt.getTime())) return true;
    const now = new Date();
    const diff = Math.floor((now.getTime() - dt.getTime()) / (24 * 3600 * 1000));
    return diff >= baseDays;
  };

  const picked = leads
    .filter((l) => l && statusMatch(l) && keywordMatch(l) && classMatch(l) && inRange(getDate(l)) && overdueMatch(l))
    .sort((a, b) => String(getDate(a)).localeCompare(String(getDate(b))) * -1)
    .slice(0, 80);

  const labelRange =
    start && end ? (start === end ? 'ngày ' + shortDateVi(start) : 'từ ' + shortDateVi(start) + ' đến ' + shortDateVi(end)) : '';
  const labelStatus = status === 'any' ? 'tất cả trạng thái' : status;
  const labelOverdue = overdue ? ' · quá hạn follow-up' + (days ? ' ≥ ' + days + ' ngày' : '') : '';
  const labelClass = classFilter ? ' · lớp ' + classFilter : '';
  const labelKey = keywordNorm ? ' · keyword "' + (parsed.keyword || '').trim().slice(0, 40) + '"' : '';

  const targets = picked.map((l) => {
    const name = String((l && (l.name || l.full_name || l.parent_name)) || '').trim();
    const phone = String((l && (l.phone || l.phone_number || l.sdt)) || '').trim();
    const st = String((l && l.status) || '').trim();
    const d = getDate(l);
    const note = String((l && (l.note || l.message || l.requirement)) || '').trim();
    return {
      name: name || 'Lead',
      phone,
      zalo_link: '',
      message:
        (d ? shortDateVi(d) + ' · ' : '') +
        (st ? 'trạng thái ' + st + ' · ' : '') +
        (note ? note.slice(0, 140) : 'Cần follow-up'),
      note: phone ? '' : 'Thiếu SĐT'
    };
  });

  return {
    type: picked.length ? 'info' : 'warning',
    summary:
      'Lead tư vấn (' +
      labelStatus +
      (labelRange ? ' · ' + labelRange : '') +
      labelOverdue +
      labelClass +
      labelKey +
      '): ' +
      picked.length +
      ' hồ sơ.',
    targets,
    requires_confirmation: false,
    insight: picked.length ? 'Danh sách lọc trực tiếp từ dữ liệu lead, không suy diễn từ model.' : '',
    next_question: '',
    actions: picked.length ? ['Ưu tiên gọi các lead quá hạn trước'] : []
  };
}

function parseLeaderboardRuleFromMessage(message) {
  const raw = String(message || '');
  const n = normalizeText(raw);
  if (!n) return null;
  const mentionsMinigame = /\bmini\s*game\b/.test(n);
  const mentionsLeaderboardWord = /\b(top|bang\s*xep\s*hang|xep\s*hang|rank|ranking|leaderboard)\b/.test(n);
  const wantsMinigame =
    (mentionsMinigame && mentionsLeaderboardWord) ||
    /(diem\s*mini\s*game|mini\s*game\s*(cao|nhieu|tot|gioi))/.test(n);
  const wantsAchievement = /(top\s*\d*\s*thanh\s*tich|thanh\s*tich\s*(cao|tot|nhieu)|bang\s*xep\s*hang\s*thanh\s*tich)/.test(n);
  const wantsContribution = /(top\s*\d*\s*cong\s*hien|cong\s*hien\s*(cao|nhieu)|gioi\s*thieu|bang\s*xep\s*hang\s*cong\s*hien)/.test(n);
  const wantsLeaderboard =
    mentionsLeaderboardWord &&
    /(thanh\s*tich|diem\s*thanh\s*tich|cong\s*hien|gioi\s*thieu|mini\s*game|diem\s*so|score|hoc\s*vien|hoc\s*sinh)/.test(n);
  if (!wantsLeaderboard && !wantsAchievement && !wantsContribution && !wantsMinigame) return null;

  const m = n.match(/\btop\s*(\d{1,2})\b/);
  const limit = m ? Math.max(1, Math.min(30, Number(m[1] || 0))) : 10;
  let metric = 'performance';
  if (wantsMinigame) metric = 'minigame';
  else if (wantsContribution && !wantsAchievement) metric = 'contribution';
  return { metric, limit };
}

function buildLeaderboardDeterministicResult(merged, parsed) {
  const students = toArraySafe(merged && merged.students);
  const rows = toArraySafe(merged && merged.extra && merged.extra.leaderboard_manual_scores);
  const byStudent = {};
  students.forEach((s) => {
    const sid = String((s && s.id) || '').trim();
    if (sid) byStudent[sid] = s;
  });

  const allowedMetrics = { performance: 1, contribution: 1, minigame: 1 };
  const metric = parsed && allowedMetrics[parsed.metric] ? parsed.metric : 'performance';
  const limit = Math.max(1, Math.min(30, Number((parsed && parsed.limit) || 10)));
  const labelByMetric = {
    performance: 'thành tích',
    contribution: 'cống hiến/giới thiệu',
    minigame: 'minigame'
  };
  const label = labelByMetric[metric];
  const readPerf = (r) => Number((r && (r.performance_pts || r.performance_score || r.performance || 0)) || 0);
  const readContrib = (r) => Number((r && (r.contribution_pts || r.contribution_score || r.contribution || 0)) || 0);
  const readMini = (r) => Number((r && (r.minigame_pts || r.minigame_score || r.minigame || 0)) || 0);
  const readers = { performance: readPerf, contribution: readContrib, minigame: readMini };
  const scoreOf = readers[metric];

  const ranked = rows
    .map((r) => {
      const sid = String((r && r.student_id) || '').trim();
      const s = byStudent[sid] || {};
      return {
        sid,
        name: String((s && s.name) || (r && (r.student_name || r.name)) || sid || 'Không rõ').trim(),
        phone: String((s && s.phone) || '').trim(),
        class_name: toShortClassLabel(String((s && s.class_name) || '').trim()),
        score: scoreOf(r),
        perf: readPerf(r),
        contrib: readContrib(r),
        mini: readMini(r)
      };
    })
    .filter((r) => r.score > 0 || r.perf > 0 || r.contrib > 0 || r.mini > 0)
    .sort((a, b) => b.score - a.score || b.perf + b.contrib + b.mini - (a.perf + a.contrib + a.mini) || a.name.localeCompare(b.name, 'vi'))
    .slice(0, limit);

  const targets = ranked.map((r, idx) => {
    const extras = [];
    if (metric !== 'performance') extras.push('thành tích: ' + r.perf + ' điểm');
    if (metric !== 'contribution') extras.push('cống hiến: ' + r.contrib + ' điểm');
    if (metric !== 'minigame') extras.push('minigame: ' + r.mini + ' điểm');
    return {
      name: r.name,
      phone: r.phone,
      zalo_link: '',
      message:
        '#' +
        (idx + 1) +
        ' · ' +
        label +
        ': ' +
        r.score +
        ' điểm' +
        (r.class_name ? ' · lớp ' + r.class_name : '') +
        (extras.length ? ' · ' + extras.join(' · ') : ''),
      note: r.phone ? '' : 'Thiếu SĐT'
    };
  });

  const lines = ranked.map((r, idx) => {
    return (
      idx + 1 + '. ' + r.name + (r.class_name ? ' (' + r.class_name + ')' : '') + ': ' + r.score + ' điểm'
    );
  });

  return {
    type: ranked.length ? 'info' : 'warning',
    summary: ranked.length
      ? 'Top ' + ranked.length + ' học viên theo điểm ' + label + ':\n' + lines.join('\n')
      : 'Chưa có dữ liệu điểm ' + label + ' trong bảng xếp hạng.',
    targets,
    requires_confirmation: false,
    insight: ranked.length ? 'Kết quả lấy từ bảng leaderboard_manual_scores (cột ' + (metric === 'minigame' ? 'minigame_pts' : metric === 'contribution' ? 'contribution_pts' : 'performance_pts') + '), không dựa vào số buổi điểm danh.' : '',
    next_question: '',
    actions: ranked.length
      ? []
      : metric === 'minigame'
        ? ['Chạy migration 034_leaderboard_minigame_pts.sql và cập nhật điểm minigame cho học viên ở tab Bảng xếp hạng']
        : ['Kiểm tra tab Bảng xếp hạng hoặc chạy migration 029_leaderboard_manual_scores.sql']
  };
}

function weekdayViShortFromEn(dayEn) {
  const map = { Mon: 'Thứ 2', Tue: 'Thứ 3', Wed: 'Thứ 4', Thu: 'Thứ 5', Fri: 'Thứ 6', Sat: 'Thứ 7', Sun: 'CN' };
  return map[String(dayEn || '').trim()] || String(dayEn || '').trim();
}

function toShortClassLabel(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s
    .replace(/\s*[:\-–]\s*(Thứ\s*[2-7]|CN|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b[\s\S]*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isClassDefinitionPaused(def) {
  if (!def) return false;
  return def.dashboard_hidden === true || String(def.dashboard_hidden || '').toLowerCase() === 'true';
}

function wantsClassTimeDetails(message) {
  const n = normalizeText(message || '');
  if (!n) return false;
  return (
    /(gio hoc|khung gio|lich hoc|khung gio lop|thu [2-7]|t2|t3|t4|t5|t6|t7)/i.test(n) ||
    /(lop nao|thong tin lop|chi tiet lop|lop .* nhu the nao)/i.test(n)
  );
}

/** Lịch lớp như app (class_definitions.schedule: Mon..Sun → { start, end }). */
function collectScheduleLinesFromClassDefinitions(defs) {
  const dayOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const rows = [];
  toArraySafe(defs).forEach((def) => {
    if (!def || !def.schedule || typeof def.schedule !== 'object') return;
    if (isClassDefinitionPaused(def)) return;
    const className = toShortClassLabel(String(def.display_name || def.name || def.label || '').trim());
    if (!className) return;
    const parts = [];
    dayOrder.forEach((day) => {
      const slot = def.schedule[day];
      if (!slot || slot.start == null || slot.end == null) return;
      const a = String(slot.start).trim();
      const b = String(slot.end).trim();
      if (!a || !b) return;
      parts.push(weekdayViShortFromEn(day) + ' ' + a + '–' + b);
    });
    if (parts.length) rows.push({ className, parts: parts.slice() });
  });
  rows.sort((a, b) => a.className.localeCompare(b.className, 'vi'));
  return rows;
}

function dayEnFromDate(dateObj) {
  const idx = dateObj instanceof Date ? dateObj.getDay() : new Date().getDay();
  const map = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return map[idx] || 'Mon';
}

function getCurrentVnDateParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  }).formatToParts(new Date());
  const pick = (type) => {
    const p = parts.find((x) => x && x.type === type);
    return p ? p.value : '';
  };
  const y = pick('year');
  const m = pick('month');
  const d = pick('day');
  let weekday = pick('weekday');
  if (weekday === 'T2') weekday = 'Mon';
  else if (weekday === 'T3') weekday = 'Tue';
  else if (weekday === 'T4') weekday = 'Wed';
  else if (weekday === 'T5') weekday = 'Thu';
  else if (weekday === 'T6') weekday = 'Fri';
  else if (weekday === 'T7') weekday = 'Sat';
  else if (weekday === 'CN') weekday = 'Sun';
  return {
    ymd: y && m && d ? y + '-' + m + '-' + d : isoDate(new Date()),
    weekdayEn: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(weekday) ? weekday : dayEnFromDate(new Date())
  };
}

function collectTodayScheduleLinesFromClassDefinitions(defs, todayEn) {
  const dayVi = weekdayViShortFromEn(todayEn);
  const rows = [];
  toArraySafe(defs).forEach((def) => {
    if (!def || !def.schedule || typeof def.schedule !== 'object') return;
    if (isClassDefinitionPaused(def)) return;
    const className = toShortClassLabel(String(def.display_name || def.name || def.label || '').trim());
    if (!className) return;
    const slot = def.schedule[todayEn];
    if (!slot || slot.start == null || slot.end == null) return;
    const a = String(slot.start).trim();
    const b = String(slot.end).trim();
    if (!a || !b) return;
    rows.push({ className, slotText: dayVi + ' ' + a + '–' + b });
  });
  rows.sort((a, b) => a.className.localeCompare(b.className, 'vi'));
  return rows;
}

/** Trả lời lần lượt tiếng Việt: số lớp, lớp–giờ, điểm danh, doanh thu ước tính theo có mặt × class_fees. */
function buildTodayOperationalOverviewResult(merged, userMessage) {
  const vnNow = getCurrentVnDateParts();
  const todayStr = vnNow.ymd;
  const showTimeDetails = wantsClassTimeDetails(userMessage);
  const classDefs = toArraySafe(merged && merged.extra && merged.extra.class_definitions);
  const todayRows = collectTodayScheduleLinesFromClassDefinitions(classDefs, vnNow.weekdayEn);
  const att = toArraySafe(merged && merged.attendance);

  const todayClassFromAttendance = distinctNonEmpty(
    att
      .filter((a) => normalizeDateToYmd(a && a.date) === todayStr)
      .map((a) => toShortClassLabel(String((a && a.class_name) || '').trim()))
  ).sort((a, b) => a.localeCompare(b, 'vi'));

  let classLines = [];
  if (showTimeDetails && todayRows.length) {
    classLines = todayRows.map((r) => '- ' + r.className + ': ' + r.slotText);
  } else if (todayRows.length) {
    classLines = todayRows.map((r) => '- ' + r.className);
  } else if (todayClassFromAttendance.length) {
    classLines = todayClassFromAttendance.map((className) => '- ' + className);
  } else {
    classLines = ['- Hôm nay chưa có lớp theo lịch đã cấu hình'];
  }

  const todayClassCount = todayRows.length || todayClassFromAttendance.length;

  const feeMap = getNormalizedClassFeeMapFromMerged(merged);
  const presentByNorm = {};
  let totalPresentMarks = 0;
  let totalRecordsToday = 0;
  att.forEach((a) => {
    if (!a) return;
    const ds = normalizeDateToYmd(a && a.date);
    if (!ds || ds !== todayStr) return;
    totalRecordsToday += 1;
    const stRaw = normalizeText(String((a && a.status) || ''));
    const st =
      stRaw === 'present' || /co mat|di hoc/.test(stRaw) ? 'present' : stRaw === 'absent' || /vang/.test(stRaw) ? 'absent' : '';
    if (st !== 'present') return;
    const rawCn = String((a && a.class_name) || '').trim();
    const nk = normalizeText(rawCn);
    if (!nk) return;
    if (!presentByNorm[nk]) presentByNorm[nk] = { label: rawCn || nk, count: 0 };
    if (rawCn) presentByNorm[nk].label = rawCn;
    presentByNorm[nk].count += 1;
    totalPresentMarks += 1;
  });

  let estimatedTotal = 0;
  let hasPresentMissingFee = false;
  Object.keys(presentByNorm).forEach((nk) => {
    const p = Number(presentByNorm[nk].count || 0);
    const fee = Number(feeMap[nk] || 0);
    const contrib = p > 0 && fee > 0 ? Math.round(p * fee) : 0;
    estimatedTotal += contrib;
    if (p > 0 && !fee) hasPresentMissingFee = true;
  });

  let revNote = '';
  if (!totalPresentMarks) revNote = ', chưa có lượt có mặt hôm nay';
  else if (estimatedTotal <= 0 && hasPresentMissingFee) revNote = ', thiếu học phí/buổi trong class_fees khớp tên lớp';

  const line1 = shortDateVi(todayStr) + ': ' + todayClassCount + ' lớp:';
  const line1b = classLines.join('\n');
  const line2 =
    'Điểm danh: ' + totalRecordsToday + ' bản ghi, ' + totalPresentMarks + ' lượt có mặt.';
  const line3 =
    'Doanh thu ước tính hôm nay (lượt có mặt × học phí/buổi): ' + formatVndAmount(estimatedTotal) + revNote + '.';
  const line4 =
    '(Ước tính, không phải số đã thu thực tế.)';

  const needSetup = !classDefs.length || !Object.keys(feeMap).length;
  const lines = ['Tổng quan hôm nay', line1, line1b, line2, line3, line4];
  return {
    type: totalRecordsToday || estimatedTotal || todayClassCount ? 'info' : 'warning',
    summary: lines.join('\n'),
    targets: [],
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: needSetup ? ['Bổ sung class_definitions và class_fees để đủ lịch và học phí/buổi'] : []
  };
}

function parseOwnerOpsRuleFromMessage(message) {
  const raw = String(message || '');
  if (!raw.trim()) return null;
  const n = normalizeText(raw);

  if (
    /\bhom nay\b/.test(n) &&
    /(\btong quan\b|overview|dash board|dashboard|snap shot|tinh hinh trung tam)/.test(n)
  ) {
    return { type: 'today_operational_overview' };
  }
  const asksTodayClassSchedule =
    (/(lop nao).*(co lich|lich hoc).*(hom nay)/i.test(n) || /(lich lop).*(hom nay)/i.test(n)) ||
    (/(toi nay|chieu nay|sang nay|dem nay).*(co lop|lop nao|lich hoc|lich day)/i.test(n)) ||
    (/(co lop|lop nao|lich hoc|lich day).*(toi nay|chieu nay|sang nay|dem nay)/i.test(n)) ||
    (/(hom nay|toi nay|chieu nay).*(co|day|hoc).*(lop)/i.test(n));
  if (asksTodayClassSchedule) {
    return { type: 'today_operational_overview' };
  }

  if (/(canh bao|can xu ly ngay|xu ly trong 24h|24h toi|24 gio toi)/i.test(n)) {
    return { type: 'alerts_24h' };
  }
  if (/(can luu y|luu y gi|dieu gi can luu y)/i.test(n)) {
    return { type: 'alerts_24h' };
  }
  const asksForecastPhrase =
    /(du bao|forecast|uoc tinh cuoi thang|du phong cuoi thang)/i.test(n) ||
    /cuoi thang/.test(n) ||
    /(giu|giu nguyen)\s*toc do/.test(n);
  const hasRevenueHint = /(doanh thu|revenue|thu hoc phi|thu tien|muc tieu thang)/i.test(n);
  if (asksForecastPhrase && (hasRevenueHint || /(giu|giu nguyen)\s*toc do.*(hien tai|bay gio)?/.test(n))) {
    return { type: 'forecast_month_end' };
  }
  if (/(thang nay).*(bao nhieu).*(%|phan tram).*(muc tieu)/i.test(n)) {
    return { type: 'forecast_month_end' };
  }
  const asksClassByDay =
    /(lop nao).*(thu\s*[2-7]|t2|t3|t4|t5|t6|t7)/i.test(n) ||
    /((danh sach|cac|nhung)\s*lop).*(thu\s*[2-7]|t2|t3|t4|t5|t6|t7)/i.test(n) ||
    /(thu\s*[2-7]|t2|t3|t4|t5|t6|t7).*(co|day|hoc|lich).*(lop)/i.test(n) ||
    /(lich).*(thu\s*[2-7]|t2|t3|t4|t5|t6|t7)/i.test(n);
  if (asksClassByDay) {
    return { type: 'class_schedule_by_days' };
  }
  const hasThresholdPhrase = parseClassCountThreshold(raw) != null;
  const mentionsClassWord = /\blop\b/.test(n);
  const mentionsClassCountConcept = /(si so|so luong hoc vien|so luong hoc sinh|so luong hv|so luong hs|bao nhieu hoc vien|bao nhieu hoc sinh|bao nhieu hv|bao nhieu hs|bao nhieu em|bao nhieu be|bao nhieu nguoi)/i.test(n);
  if (
    (mentionsClassWord && (mentionsClassCountConcept || hasThresholdPhrase)) ||
    (mentionsClassCountConcept && /\b(cac|nhung|moi|tat ca)\b/.test(n))
  ) {
    return { type: 'class_student_count' };
  }
  if (/(hom nay doanh thu|doanh thu hom nay)/i.test(n) && /(hom qua|tuan truoc|so voi)/i.test(n)) {
    return { type: 'revenue_today_compare' };
  }
  if (/(ty le vang|vang cao|vang bat thuong|lop nao vang)/i.test(n) && /(7|30|7-30|7 30|7 den 30)/i.test(n)) {
    return { type: 'class_absence_abnormal_7_30' };
  }
  if (/(dong tien cham|dong hoc phi cham|cham dong|tre hoc phi|qua han hoc phi|hoc vien nao dong tien cham)/i.test(n)) {
    return { type: 'late_payers' };
  }
  return null;
}

function buildOwnerClassScheduleByDaysResult(merged, message) {
  const defs = collectScheduleLinesFromClassDefinitions(toArraySafe(merged && merged.extra && merged.extra.class_definitions));
  const n = normalizeText(message || '');
  const wants = [];
  if (/thu\s*2|t2/.test(n)) wants.push('Thứ 2');
  if (/thu\s*3|t3/.test(n)) wants.push('Thứ 3');
  if (/thu\s*4|t4/.test(n)) wants.push('Thứ 4');
  if (/thu\s*5|t5/.test(n)) wants.push('Thứ 5');
  if (/thu\s*6|t6/.test(n)) wants.push('Thứ 6');
  if (/thu\s*7|t7/.test(n)) wants.push('Thứ 7');
  const picked = defs.filter((r) => {
    if (!wants.length) return true;
    const blob = String((r && r.parts ? r.parts.join(' | ') : '') || '');
    return wants.every((d) => blob.includes(d));
  });
  const lines = picked.slice(0, 20).map((r) => '- ' + r.className + ': ' + r.parts.filter((p) => /^Thứ\s*[2-7]\b/.test(p)).join(', '));
  return {
    type: picked.length ? 'info' : 'warning',
    summary: picked.length ? 'Các lớp khớp lịch yêu cầu: ' + picked.length + ' lớp.\n' + lines.join('\n') : 'Chưa thấy lớp nào khớp khung ngày yêu cầu.',
    targets: [],
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: []
  };
}

function softNormalizeKeepSymbols(message) {
  return String(message || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseClassCountThreshold(message) {
  const n = softNormalizeKeepSymbols(message);
  const unit = '(?:\\s*(?:hoc vien|hoc sinh|hv|hs|em|be|nguoi|ban))?';
  const tries = [
    { re: new RegExp('(?:<=|=<|≤)\\s*(\\d{1,3})' + unit), cmp: 'lte' },
    { re: new RegExp('(?:>=|=>|≥)\\s*(\\d{1,3})' + unit), cmp: 'gte' },
    { re: new RegExp('(?:khong qua|toi da)\\s+(\\d{1,3})' + unit), cmp: 'lte' },
    { re: new RegExp('(?:it nhat|toi thieu|tu)\\s+(\\d{1,3})' + unit), cmp: 'gte' },
    { re: new RegExp('(?:duoi|it hon|nho hon|<)\\s*(\\d{1,3})' + unit), cmp: 'lt' },
    { re: new RegExp('(?:tren|hon|lon hon|nhieu hon|>)\\s*(\\d{1,3})' + unit), cmp: 'gt' },
    { re: new RegExp('(?:bang|dung|chinh xac|=)\\s*(\\d{1,3})' + unit), cmp: 'eq' }
  ];
  for (const t of tries) {
    const m = n.match(t.re);
    if (m) {
      const v = Number(m[1] || 0);
      if (Number.isFinite(v)) return { threshold: v, comparator: t.cmp };
    }
  }
  return null;
}

function comparatorLabelVi(cmp) {
  if (cmp === 'lt') return 'dưới';
  if (cmp === 'lte') return 'không quá';
  if (cmp === 'gt') return 'trên';
  if (cmp === 'gte') return 'ít nhất';
  if (cmp === 'eq') return 'đúng';
  return '';
}

function buildOwnerClassStudentCountResult(merged, message) {
  const students = toArraySafe(merged && merged.students);
  const classes = listKnownClasses(merged);
  const classFilter = guessClassFilterFromMessage(message, classes);
  const n = normalizeText(message || '');
  const parsed = parseClassCountThreshold(message);
  const threshold = parsed ? parsed.threshold : null;
  const comparator = parsed ? parsed.comparator : null;

  const wantsListExplicit = /(danh sach|liet ke|cac lop|nhung lop|lop nao|moi lop|tat ca cac lop|tat ca lop)/i.test(n);
  const wantsList = wantsListExplicit || (parsed != null && !classFilter);

  if (!classFilter && wantsList && Number.isFinite(threshold) && comparator) {
    const countByClass = {};
    students.forEach((s) => {
      const className = String((s && s.class_name) || '').trim();
      if (!className) return;
      countByClass[className] = (countByClass[className] || 0) + 1;
    });
    const rows = Object.keys(countByClass)
      .map((name) => ({ name, count: Number(countByClass[name] || 0) }))
      .filter((r) => {
        if (comparator === 'lt') return r.count < threshold;
        if (comparator === 'lte') return r.count <= threshold;
        if (comparator === 'gt') return r.count > threshold;
        if (comparator === 'gte') return r.count >= threshold;
        if (comparator === 'eq') return r.count === threshold;
        return false;
      })
      .sort((a, b) => a.count - b.count || a.name.localeCompare(b.name, 'vi'));
    const cmpLabel = comparatorLabelVi(comparator);
    const lines = rows.slice(0, 30).map((r) => '- ' + toShortClassLabel(r.name) + ': ' + r.count + ' học viên');
    const more = rows.length > 30 ? '\n… và ' + (rows.length - 30) + ' lớp khác.' : '';
    return {
      type: rows.length ? 'info' : 'warning',
      summary: rows.length
        ? 'Có ' + rows.length + ' lớp có sĩ số ' + cmpLabel + ' ' + threshold + ' học viên:\n' + lines.join('\n') + more
        : 'Không có lớp nào có sĩ số ' + cmpLabel + ' ' + threshold + ' học viên trong dữ liệu hiện tại.',
      targets: [],
      requires_confirmation: false,
      insight: rows.length ? 'Đếm trên danh sách students hiện tại theo class_name.' : '',
      next_question: '',
      actions: []
    };
  }

  if (!classFilter) {
    return {
      type: 'warning',
      summary: 'Cần rõ tên lớp để đếm sĩ số. Ví dụ: "Lớp Kèm Dương hiện có bao nhiêu học viên?" hoặc "Các lớp có sĩ số dưới 3 học sinh".',
      targets: [],
      requires_confirmation: true,
      insight: '',
      next_question: 'Muốn xem sĩ số của lớp nào, hay liệt kê các lớp theo ngưỡng số học viên?',
      actions: []
    };
  }
  const classNorm = normalizeText(classFilter);
  const count = students.filter((s) => studentClassNames(s).some((c) => classMatchesFilterValue(c, classFilter))).length;
  return {
    type: 'info',
    summary: 'Lớp ' + toShortClassLabel(classFilter) + ' hiện có ' + count + ' học viên.',
    targets: [],
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: []
  };
}

function parseExpandedDataRuleFromMessage(message, merged) {
  const raw = String(message || '');
  const n = normalizeText(raw);
  if (!n) return null;

  const classFilter = guessClassFilterFromMessage(raw, listKnownClasses(merged));
  const window = parseTimeWindowFromMessage(raw);
  const limitMatch = n.match(/\b(?:top|lay|cho|xem|liet ke)?\s*(\d{1,3})\s*(?:dong|muc|giao dich|hoc vien|hoc sinh|ban|em|link|thong bao|lan)?\b/i);
  const limit = limitMatch ? Math.max(1, Math.min(100, Number(limitMatch[1] || 0))) : 20;

  if (/(link thanh toan|payment link|ma thanh toan|ref code|ref_code|phu huynh thanh toan|link dong hoc phi|link dong phi)/i.test(n)) {
    return { type: 'payment_links', window, classFilter, limit };
  }
  if (/(push|fcm|notification|thong bao dien thoai|gui ve dien thoai|log thong bao)/i.test(n)) {
    return { type: 'notification_logs', window, classFilter, limit };
  }
  if (/(dashboard|thong bao|nhac nho|notice|announcement|bang tin)/i.test(n)) {
    return { type: 'dashboard_notices', window, limit };
  }
  if (
    /(giao vien|teacher|check in|checkin|diem danh giao vien|luong giao vien|tien cong|pay rate|day thay|day bu|substitution|phan cong)/i.test(n)
  ) {
    return { type: 'teacher_ops', window, classFilter, limit };
  }
  if (/(lich su diem|cong diem|tru diem|leaderboard history|diem gan day|ai vua duoc cong|performance history)/i.test(n)) {
    return { type: 'leaderboard_history', window, classFilter, limit };
  }
  const asksRoster =
    /(danh sach|liet ke|nhung|cac)\s+(hoc vien|hoc sinh|em|ban)/i.test(n) && /\blop\b/i.test(n);
  const asksBirthYear = /(sinh nam|nam sinh|birth year|bao nhieu tuoi|tuoi)/i.test(n);
  const asksLearningNote = /(ghi chu hoc tap|learning note|nhan xet|note hoc vien|ghi chu cua hoc vien)/i.test(n);
  if (asksRoster || asksBirthYear || asksLearningNote) {
    return { type: 'student_directory', window, classFilter, limit, asksBirthYear, asksLearningNote };
  }
  return null;
}

function inRuleDateWindow(v, window) {
  const d = normalizeDateToYmd(v);
  if (!d) return true;
  const w = window || {};
  if (w.start && d < String(w.start)) return false;
  if (w.end && d > String(w.end)) return false;
  return true;
}

function labelRuleWindow(window) {
  const w = window || {};
  if (w.start && w.end) return w.start === w.end ? 'ngày ' + shortDateVi(w.start) : 'từ ' + shortDateVi(w.start) + ' đến ' + shortDateVi(w.end);
  return 'toàn bộ dữ liệu đang tải';
}

function statusVi(raw) {
  const s = normalizeText(raw || '');
  if (!s) return 'không rõ';
  if (s === 'active' || s === 'open') return 'đang mở';
  if (s === 'expired') return 'hết hạn';
  if (s === 'used' || s === 'paid') return 'đã dùng';
  if (s === 'pending') return 'đang chờ';
  if (s === 'inactive' || s === 'cancelled' || s === 'canceled') return 'đã tắt';
  return String(raw || '').trim() || 'không rõ';
}

function classMatchesFilterValue(value, filter) {
  const a = normalizeText(value || '');
  const b = normalizeText(filter || '');
  if (!b) return true;
  if (!a) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function buildPaymentLinksExpandedResult(merged, rule) {
  const students = toArraySafe(merged && merged.students);
  const byId = {};
  students.forEach((s) => {
    const sid = String((s && s.id) || '').trim();
    if (sid) byId[sid] = s;
  });
  const singleLinks = toArraySafe(merged && merged.extra && merged.extra.payment_links);
  const classLinks = toArraySafe(merged && merged.extra && merged.extra.class_payment_links);
  const refs = toArraySafe(merged && merged.extra && merged.extra.parent_payment_refs);
  const classFilter = String((rule && rule.classFilter) || '').trim();
  const classNorm = normalizeText(classFilter);
  const limit = Math.max(1, Math.min(100, Number((rule && rule.limit) || 20)));

  const rows = [];
  singleLinks.forEach((r) => {
    if (!inRuleDateWindow(r && (r.created_at || r.updated_at || r.expires_at), rule && rule.window)) return;
    const s = byId[String((r && r.student_id) || '')] || {};
    if (classNorm && !studentClassNames(s).some((c) => classMatchesFilterValue(c, classFilter))) return;
    rows.push({
      kind: 'học viên',
      label: String((s && s.name) || r.student_id || 'Không rõ'),
      sub: String((s && s.class_name) || ''),
      status: statusVi(r && r.status),
      ref: String((r && r.ref_code) || ''),
      expires: normalizeDateToYmd(r && r.expires_at),
      opened: normalizeDateToYmd(r && r.last_opened_at)
    });
  });
  classLinks.forEach((r) => {
    if (!inRuleDateWindow(r && (r.created_at || r.updated_at || r.expires_at), rule && rule.window)) return;
    const cls = String((r && r.class_name) || '').trim();
    if (classNorm && !classMatchesFilterValue(cls, classFilter)) return;
    rows.push({
      kind: 'lớp',
      label: cls || 'Không rõ lớp',
      sub: '',
      status: statusVi(r && r.status),
      ref: '',
      expires: normalizeDateToYmd(r && r.expires_at),
      opened: normalizeDateToYmd(r && r.last_opened_at)
    });
  });
  refs.forEach((r) => {
    if (!inRuleDateWindow(r && (r.created_at || r.updated_at || r.expires_at || r.used_at), rule && rule.window)) return;
    const s = byId[String((r && r.student_id) || '')] || {};
    if (classNorm && !studentClassNames(s).some((c) => classMatchesFilterValue(c, classFilter))) return;
    rows.push({
      kind: 'ref phụ huynh',
      label: String((s && s.name) || r.student_id || 'Không rõ'),
      sub: String((s && s.class_name) || ''),
      status: statusVi(r && r.status),
      ref: String((r && r.ref_code) || ''),
      expires: normalizeDateToYmd(r && r.expires_at),
      opened: normalizeDateToYmd(r && r.used_at)
    });
  });

  rows.sort((a, b) => String(b.expires || '').localeCompare(String(a.expires || '')));
  const lines = rows.slice(0, limit).map((r) => {
    const bits = [r.kind + ': ' + r.label];
    if (r.sub) bits.push(r.sub);
    bits.push(r.status);
    if (r.ref) bits.push('mã ' + r.ref);
    if (r.expires) bits.push('hết hạn ' + shortDateVi(r.expires));
    if (r.opened) bits.push('mở/dùng ' + shortDateVi(r.opened));
    return '- ' + bits.join(' · ');
  });
  return {
    type: rows.length ? 'info' : 'warning',
    summary: rows.length
      ? 'Link/mã thanh toán ' + labelRuleWindow(rule && rule.window) + ': ' + rows.length + ' mục.\n' + lines.join('\n')
      : 'Chưa có link hoặc mã thanh toán nào khớp điều kiện trong dữ liệu Supabase hiện tại.',
    targets: [],
    requires_confirmation: false,
    insight: rows.length ? 'Kết quả gộp từ payment_links, class_payment_links và parent_payment_refs.' : '',
    next_question: '',
    actions: []
  };
}

function buildDashboardNoticesExpandedResult(merged, rule) {
  const rows = toArraySafe(merged && merged.extra && merged.extra.dashboard)
    .filter((r) => inRuleDateWindow(r && (r.created_at || r.start_at || r.updated_at), rule && rule.window))
    .sort((a, b) => String((b && b.created_at) || '').localeCompare(String((a && a.created_at) || '')));
  const limit = Math.max(1, Math.min(100, Number((rule && rule.limit) || 20)));
  const lines = rows.slice(0, limit).map((r) => {
    const tag = String((r && r.tag) || '').trim();
    const active = r && r.is_active === false ? 'đã tắt' : 'đang bật';
    const d = normalizeDateToYmd(r && (r.start_at || r.created_at));
    return '- ' + String((r && r.title) || 'Không tiêu đề') + (tag ? ' · ' + tag : '') + ' · ' + active + (d ? ' · ' + shortDateVi(d) : '');
  });
  return {
    type: rows.length ? 'info' : 'warning',
    summary: rows.length ? 'Thông báo/dashboard ' + labelRuleWindow(rule && rule.window) + ': ' + rows.length + ' mục.\n' + lines.join('\n') : 'Hiện chưa có thông báo dashboard nào trong dữ liệu Supabase.',
    targets: [],
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: []
  };
}

function buildTeacherOpsExpandedResult(merged, rule) {
  const profiles = toArraySafe(merged && merged.extra && merged.extra.profiles);
  const classes = toArraySafe(merged && merged.extra && merged.extra.teacher_classes);
  const rates = toArraySafe(merged && merged.extra && merged.extra.teacher_pay_rates);
  const checks = toArraySafe(merged && merged.extra && merged.extra.teacher_check_ins);
  const subs = toArraySafe(merged && merged.extra && merged.extra.teacher_substitutions);
  const byId = {};
  profiles.forEach((p) => {
    const id = String((p && p.id) || '').trim();
    if (id) byId[id] = p;
  });
  const classNorm = normalizeText((rule && rule.classFilter) || '');
  const teacherIds = new Set();
  classes.forEach((r) => {
    if (classNorm && !classMatchesFilterValue((r && r.class_name) || '', rule && rule.classFilter)) return;
    if (r && r.teacher_id) teacherIds.add(String(r.teacher_id));
  });
  profiles.forEach((p) => {
    if (normalizeText(p && p.role).includes('teacher')) teacherIds.add(String(p.id));
  });
  checks.forEach((r) => {
    if (inRuleDateWindow(r && (r.checked_in_at || r.created_at), rule && rule.window)) teacherIds.add(String(r.teacher_id));
  });

  const rows = Array.from(teacherIds)
    .filter(Boolean)
    .map((id) => {
      const p = byId[id] || {};
      const assigned = classes.filter((r) => String((r && r.teacher_id) || '') === id && (!classNorm || classMatchesFilterValue((r && r.class_name) || '', rule && rule.classFilter)));
      const rate = rates.find((r) => String((r && r.teacher_id) || '') === id);
      const checkRows = checks.filter((r) => String((r && r.teacher_id) || '') === id && inRuleDateWindow(r && (r.checked_in_at || r.created_at), rule && rule.window));
      const subOut = subs.filter((r) => String((r && r.from_teacher_id) || '') === id && inRuleDateWindow(r && r.date, rule && rule.window)).length;
      const subIn = subs.filter((r) => String((r && r.to_teacher_id) || '') === id && inRuleDateWindow(r && r.date, rule && rule.window)).length;
      return {
        name: String((p && (p.display_name || p.email)) || id).trim(),
        classNames: assigned.map((r) => String((r && r.class_name) || '').trim()).filter(Boolean),
        rate: Number((rate && rate.rate_per_session) || 0),
        checkins: checkRows.length,
        autoAbsent: checkRows.filter((r) => !!(r && r.auto_absent)).length,
        subOut,
        subIn
      };
    })
    .sort((a, b) => b.checkins - a.checkins || a.name.localeCompare(b.name, 'vi'));

  const lines = rows.slice(0, Math.max(1, Math.min(100, Number((rule && rule.limit) || 20)))).map((r) => {
    const bits = [r.name];
    if (r.classNames.length) bits.push('lớp: ' + r.classNames.slice(0, 4).join(', '));
    if (r.rate > 0) bits.push('rate: ' + formatVndAmount(r.rate) + '/buổi');
    bits.push('check-in: ' + r.checkins);
    if (r.autoAbsent) bits.push('auto absent: ' + r.autoAbsent);
    if (r.subIn || r.subOut) bits.push('dạy thay/nhờ thay: ' + r.subIn + '/' + r.subOut);
    return '- ' + bits.join(' · ');
  });
  return {
    type: rows.length ? 'info' : 'warning',
    summary: rows.length ? 'Dữ liệu giáo viên ' + labelRuleWindow(rule && rule.window) + ': ' + rows.length + ' giáo viên.\n' + lines.join('\n') : 'Chưa có dữ liệu giáo viên/check-in/lương giáo viên khớp điều kiện.',
    targets: [],
    requires_confirmation: false,
    insight: rows.length ? 'Gộp từ profiles, teacher_classes, teacher_pay_rates, teacher_check_ins và teacher_substitutions.' : '',
    next_question: '',
    actions: []
  };
}

function buildLeaderboardHistoryExpandedResult(merged, rule) {
  const students = toArraySafe(merged && merged.students);
  const byId = {};
  students.forEach((s) => {
    const id = String((s && s.id) || '').trim();
    if (id) byId[id] = s;
  });
  const classNorm = normalizeText((rule && rule.classFilter) || '');
  const rows = toArraySafe(merged && merged.extra && merged.extra.leaderboard_performance_history)
    .filter((r) => inRuleDateWindow(r && (r.event_at || r.created_at), rule && rule.window))
    .filter((r) => {
      if (!classNorm) return true;
      const s = byId[String((r && r.student_id) || '')] || {};
      const label = (r && r.class_short) || (s && s.class_name) || '';
      return classMatchesFilterValue(label, rule && rule.classFilter);
    })
    .sort((a, b) => String((b && (b.event_at || b.created_at)) || '').localeCompare(String((a && (a.event_at || a.created_at)) || '')));
  const lines = rows.slice(0, Math.max(1, Math.min(100, Number((rule && rule.limit) || 20)))).map((r) => {
    const s = byId[String((r && r.student_id) || '')] || {};
    const name = String((r && r.student_name) || (s && s.name) || 'Không rõ');
    const d = normalizeDateToYmd(r && (r.event_at || r.created_at));
    return '- ' + name + ': ' + Number((r && r.points) || 0) + ' điểm · ' + String((r && r.metric) || 'performance') + (r && r.class_short ? ' · ' + r.class_short : '') + (d ? ' · ' + shortDateVi(d) : '');
  });
  return {
    type: rows.length ? 'info' : 'warning',
    summary: rows.length ? 'Lịch sử điểm leaderboard ' + labelRuleWindow(rule && rule.window) + ': ' + rows.length + ' lượt.\n' + lines.join('\n') : 'Chưa có lịch sử điểm leaderboard khớp điều kiện.',
    targets: [],
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: []
  };
}

function studentClassNames(s) {
  const out = [];
  if (s && s.class_name) out.push(String(s.class_name));
  const arr = s && Array.isArray(s.class_names) ? s.class_names : [];
  arr.forEach((x) => {
    const v = String(x || '').trim();
    if (v && !out.includes(v)) out.push(v);
  });
  return out;
}

function buildStudentDirectoryExpandedResult(merged, rule) {
  const students = toArraySafe(merged && merged.students);
  const cls = String((rule && rule.classFilter) || '').trim();
  const clsNorm = normalizeText(cls);
  const rows = students
    .filter((s) => {
      if (!clsNorm) return true;
      return studentClassNames(s).some((c) => classMatchesFilterValue(c, cls));
    })
    .sort((a, b) => String((a && a.name) || '').localeCompare(String((b && b.name) || ''), 'vi'));
  const limit = Math.max(1, Math.min(100, Number((rule && rule.limit) || 40)));
  const lines = rows.slice(0, limit).map((s) => {
    const bits = [String((s && s.name) || 'Không rõ')];
    const classes = studentClassNames(s);
    if (classes.length) bits.push(classes.slice(0, 3).join(', '));
    if (rule && rule.asksBirthYear && s && s.birth_year) bits.push('sinh năm ' + s.birth_year);
    if (rule && rule.asksLearningNote && s && s.learning_note) bits.push('ghi chú: ' + fitTextBudget(String(s.learning_note), 90));
    if (s && s.parent_name) bits.push('PH: ' + s.parent_name);
    if (s && s.phone) bits.push('SĐT: ' + s.phone);
    return '- ' + bits.join(' · ');
  });
  const more = rows.length > limit ? '\n… và ' + (rows.length - limit) + ' học viên khác.' : '';
  return {
    type: rows.length ? 'info' : 'warning',
    summary: rows.length ? 'Danh sách học viên' + (cls ? ' lớp ' + cls : '') + ': ' + rows.length + ' học viên.\n' + lines.join('\n') + more : 'Không tìm thấy học viên khớp điều kiện.',
    targets: rows.slice(0, limit).map((s) => ({
      name: String((s && s.name) || 'Không rõ'),
      phone: String((s && s.phone) || ''),
      zalo_link: '',
      message: studentClassNames(s).join(', ') || '',
      note: s && s.learning_note ? String(s.learning_note) : ''
    })),
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: []
  };
}

function buildNotificationLogsExpandedResult(merged, rule) {
  const rows = toArraySafe(merged && merged.extra && merged.extra.notification_dispatch_log)
    .filter((r) => inRuleDateWindow(r && (r.created_at || r.slot_date), rule && rule.window))
    .filter((r) => {
      const cls = String((rule && rule.classFilter) || '').trim();
      if (!cls) return true;
      return classMatchesFilterValue((r && r.class_name) || '', cls);
    })
    .sort((a, b) => String((b && b.created_at) || '').localeCompare(String((a && a.created_at) || '')));
  const lines = rows.slice(0, Math.max(1, Math.min(100, Number((rule && rule.limit) || 20)))).map((r) => {
    const d = normalizeDateToYmd(r && (r.created_at || r.slot_date));
    return '- ' + String((r && r.kind) || 'notification') + ' · ' + String((r && r.class_name) || 'Không rõ lớp') + (d ? ' · ' + shortDateVi(d) : '') + ' · ' + fitTextBudget(String((r && r.title) || ''), 80);
  });
  return {
    type: rows.length ? 'info' : 'warning',
    summary: rows.length ? 'Log thông báo ' + labelRuleWindow(rule && rule.window) + ': ' + rows.length + ' dòng.\n' + lines.join('\n') : 'Chưa có log thông báo nào khớp điều kiện trong Supabase.',
    targets: [],
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: []
  };
}

function buildExpandedDataDeterministicResult(merged, rule) {
  if (!rule || !rule.type) return null;
  if (rule.type === 'payment_links') return buildPaymentLinksExpandedResult(merged, rule);
  if (rule.type === 'dashboard_notices') return buildDashboardNoticesExpandedResult(merged, rule);
  if (rule.type === 'teacher_ops') return buildTeacherOpsExpandedResult(merged, rule);
  if (rule.type === 'leaderboard_history') return buildLeaderboardHistoryExpandedResult(merged, rule);
  if (rule.type === 'student_directory') return buildStudentDirectoryExpandedResult(merged, rule);
  if (rule.type === 'notification_logs') return buildNotificationLogsExpandedResult(merged, rule);
  return null;
}

function getDateOnly(v) {
  return String(v || '').slice(0, 10);
}

function sumRevenueByDate(payments, dateStr) {
  let sum = 0;
  let count = 0;
  toArraySafe(payments).forEach((p) => {
    const d = paymentRowDate(p);
    if (!d) return;
    if (isoDate(d) !== dateStr) return;
    sum += paymentRowAmount(p);
    count += 1;
  });
  return { sum, count };
}

function buildOwnerAlerts24hResult(merged) {
  const att = toArraySafe(merged && merged.attendance);
  const bank = toArraySafe(merged && merged.extra && merged.extra.bank_transactions);
  const leads = toArraySafe(merged && merged.extra && merged.extra.consultation_leads);
  const today = isoDate(new Date());
  const pendingBank = bank.filter((b) => {
    const st = String((b && (b.status || b.tx_status)) || '').toLowerCase();
    return st === 'pending' || st === 'needs_review' || st === 'review';
  });
  const overdueLeads = leads.filter((l) => {
    const st = String((l && l.status) || '').toLowerCase();
    if (!['new', 'pending', 'open'].includes(st)) return false;
    const d = getDateOnly((l && (l.created_at || l.submitted_at || l.date)) || '');
    if (!d) return true;
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return true;
    const diff = Math.floor((Date.now() - dt.getTime()) / (24 * 3600 * 1000));
    return diff >= 3;
  });
  const absentToday = att.filter((a) => getDateOnly(a && a.date) === today && String((a && a.status) || '').toLowerCase() === 'absent').length;
  const totalToday = att.filter((a) => getDateOnly(a && a.date) === today).length;
  const absentRate = totalToday > 0 ? absentToday / totalToday : 0;
  const highAbsenceToday = totalToday > 0 && absentRate >= 0.35;

  const alerts = [];
  if (pendingBank.length) alerts.push('Có ' + pendingBank.length + ' giao dịch pending/needs_review chưa đối soát.');
  if (overdueLeads.length) alerts.push('Có ' + overdueLeads.length + ' lead mới quá hạn follow-up (>= 3 ngày).');
  if (highAbsenceToday) alerts.push('Tỷ lệ vắng hôm nay cao: ' + (absentRate * 100).toFixed(1) + '% (' + absentToday + '/' + totalToday + ').');
  if (!alerts.length) alerts.push('Chưa thấy cảnh báo vận hành nghiêm trọng trong 24h tới theo dữ liệu hiện tại.');

  return {
    type: alerts.length > 1 || pendingBank.length || overdueLeads.length || highAbsenceToday ? 'warning' : 'info',
    summary: 'Cảnh báo xử lý trong 24h tới:\n- ' + alerts.join('\n- '),
    targets: [],
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions:
      pendingBank.length || overdueLeads.length || highAbsenceToday
        ? ['Ưu tiên xử lý đối soát ngân hàng và follow-up lead quá hạn trước']
        : []
  };
}

function buildOwnerRevenueTodayCompareResult(merged, message) {
  const pay = toArraySafe(merged && merged.payment);
  const today = new Date();
  const todayStr = isoDate(today);
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  const yStr = isoDate(y);
  const lw = new Date(today);
  lw.setDate(lw.getDate() - 7);
  const lwStr = isoDate(lw);
  const n = normalizeText(message || '');
  const askYesterday = /hom qua/.test(n);
  const askLastWeek = /tuan truoc/.test(n);

  const t = sumRevenueByDate(pay, todayStr);
  const dY = sumRevenueByDate(pay, yStr);
  const dW = sumRevenueByDate(pay, lwStr);

  const lines = ['Doanh thu hôm nay (' + shortDateVi(todayStr) + '): ' + formatVndAmount(t.sum) + ' · ' + t.count + ' giao dịch'];
  const cmp = (base, label) => {
    const diff = t.sum - base.sum;
    const trend = diff > 0 ? 'tăng' : diff < 0 ? 'giảm' : 'không đổi';
    const pct = base.sum > 0 ? ' (' + ((diff / base.sum) * 100).toFixed(2) + '%)' : '';
    lines.push('- So với ' + label + ': ' + trend + ' ' + formatVndAmount(Math.abs(diff)) + pct);
  };
  if (askYesterday || !askLastWeek) cmp(dY, 'hôm qua (' + shortDateVi(yStr) + ')');
  if (askLastWeek || !askYesterday) cmp(dW, 'cùng ngày tuần trước (' + shortDateVi(lwStr) + ')');

  return {
    type: 'info',
    summary: lines.join('\n'),
    targets: [],
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: []
  };
}

function buildOwnerClassAbsenceAbnormalResult(merged) {
  const att = toArraySafe(merged && merged.attendance);
  const now = new Date();
  const s7 = new Date(now);
  s7.setDate(s7.getDate() - 6);
  const s30 = new Date(now);
  s30.setDate(s30.getDate() - 29);
  const today = isoDate(now);
  const map = {};

  const acc = (key, slot, status) => {
    if (!map[key]) map[key] = { className: key, p7: 0, a7: 0, p30: 0, a30: 0 };
    if (slot === 7) {
      if (status === 'present') map[key].p7 += 1;
      if (status === 'absent') map[key].a7 += 1;
    }
    if (slot === 30) {
      if (status === 'present') map[key].p30 += 1;
      if (status === 'absent') map[key].a30 += 1;
    }
  };

  att.forEach((a) => {
    const d = getDateOnly(a && a.date);
    if (!d) return;
    const st = String((a && a.status) || '').toLowerCase();
    if (st !== 'present' && st !== 'absent') return;
    const cn = String((a && a.class_name) || '').trim();
    if (!cn) return;
    if (d >= isoDate(s30) && d <= today) acc(cn, 30, st);
    if (d >= isoDate(s7) && d <= today) acc(cn, 7, st);
  });

  const rows = Object.values(map)
    .map((r) => {
      const t7 = r.p7 + r.a7;
      const t30 = r.p30 + r.a30;
      const rate7 = t7 > 0 ? r.a7 / t7 : 0;
      const rate30 = t30 > 0 ? r.a30 / t30 : 0;
      return Object.assign({}, r, { rate7, rate30, delta: rate7 - rate30, t7, t30 });
    })
    .filter((r) => r.t7 >= 6 && (r.rate7 >= 0.35 || r.rate30 >= 0.25 || r.delta >= 0.1))
    .sort((a, b) => b.rate7 - a.rate7 || b.delta - a.delta)
    .slice(0, 30);

  const targets = rows.map((r) => ({
    name: r.className,
    phone: '',
    zalo_link: '',
    message:
      'Tỷ lệ vắng 7 ngày: ' +
      (r.rate7 * 100).toFixed(1) +
      '% (' +
      r.a7 +
      '/' +
      r.t7 +
      '), 30 ngày: ' +
      (r.rate30 * 100).toFixed(1) +
      '% (' +
      r.a30 +
      '/' +
      r.t30 +
      ').',
    note: r.delta >= 0.1 ? '7 ngày gần đây xấu đi rõ rệt so với nền 30 ngày.' : ''
  }));

  return {
    type: rows.length ? 'warning' : 'info',
    summary: rows.length
      ? 'Các lớp có tỷ lệ vắng cao bất thường trong 7–30 ngày gần đây: ' + rows.length + ' lớp.'
      : 'Chưa thấy lớp nào có tỷ lệ vắng cao bất thường theo ngưỡng 7–30 ngày hiện tại.',
    targets,
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: rows.length ? ['Ưu tiên gọi phụ huynh ở lớp có tỷ lệ vắng 7 ngày cao nhất'] : []
  };
}

function buildOwnerLatePayersResult(merged) {
  const students = toArraySafe(merged && merged.students);
  const tuitionByClass = toArraySafe(merged && merged.extra && merged.extra.student_tuition_by_class);
  const pay = toArraySafe(merged && merged.payment);
  const now = new Date();
  const byStudent = {};
  tuitionByClass.forEach((r) => {
    const sid = String((r && r.student_id) || '').trim();
    if (!sid) return;
    const sess = Number((r && (r.sessions_due || r.debt_sessions || r.remaining_sessions || 0)) || 0);
    const amt = Number((r && (r.amount_due || r.debt_amount || r.remaining_amount || 0)) || 0);
    if (sess <= 0 && amt <= 0) return;
    if (!byStudent[sid]) byStudent[sid] = { sessions: 0, amount: 0 };
    byStudent[sid].sessions += Math.max(0, sess);
    byStudent[sid].amount += Math.max(0, amt);
  });

  const lastPayBySid = {};
  pay.forEach((p) => {
    const sid = String((p && p.student_id) || '').trim();
    if (!sid) return;
    const d = paymentRowDate(p);
    if (!d) return;
    const x = isoDate(d);
    if (!lastPayBySid[sid] || x > lastPayBySid[sid]) lastPayBySid[sid] = x;
  });

  const rows = Object.keys(byStudent)
    .map((sid) => {
      const s = students.find((x) => String((x && x.id) || '') === sid);
      const lp = lastPayBySid[sid] || '';
      let overdueDays = 999;
      if (lp) {
        const d = new Date(lp);
        overdueDays = isNaN(d.getTime()) ? 999 : Math.max(0, Math.floor((now.getTime() - d.getTime()) / (24 * 3600 * 1000)));
      }
      return {
        sid,
        name: String((s && s.name) || '').trim(),
        phone: String((s && s.phone) || '').trim(),
        sessions: Math.round(Number(byStudent[sid].sessions || 0)),
        amount: Number(byStudent[sid].amount || 0),
        overdueDays,
        lastPay: lp
      };
    })
    .sort((a, b) => b.sessions - a.sessions || b.overdueDays - a.overdueDays)
    .slice(0, 120);

  const targets = rows.map((r) => ({
    name: r.name || 'Không rõ',
    phone: r.phone || '',
    zalo_link: '',
    message:
      'Nợ ' +
      r.sessions +
      ' buổi' +
      (r.amount > 0 ? ' (' + formatVndAmount(r.amount) + ')' : '') +
      (r.lastPay ? '; lần đóng gần nhất: ' + shortDateVi(r.lastPay) + ' (' + r.overdueDays + ' ngày trước).' : '; chưa ghi nhận lịch sử thanh toán.'),
    note: r.phone ? '' : 'Thiếu SĐT'
  }));

  return {
    type: rows.length ? 'warning' : 'info',
    summary: rows.length
      ? 'Danh sách học viên đóng tiền chậm / còn nợ học phí: ' + rows.length + ' học viên.'
      : 'Không có học viên nào đang đóng tiền chậm theo dữ liệu hiện tại.',
    targets,
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: rows.length ? ['Ưu tiên nhắc nhóm nợ buổi cao và quá hạn lâu'] : []
  };
}

function buildOwnerMonthEndForecastResult(merged) {
  const pay = toArraySafe(merged && merged.payment);
  const now = new Date();
  const today = isoDate(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const monthEnd = new Date(nextMonth.getTime() - 24 * 3600 * 1000);
  const daysInMonth = monthEnd.getDate();
  const dayOfMonth = now.getDate();
  const remainingDays = Math.max(0, daysInMonth - dayOfMonth);

  let mtd = 0;
  const daily = {};
  pay.forEach((p) => {
    const d = paymentRowDate(p);
    if (!d) return;
    const ds = isoDate(d);
    const amt = paymentRowAmount(p);
    if (ds >= isoDate(monthStart) && ds <= today) mtd += amt;
    daily[ds] = (daily[ds] || 0) + amt;
  });

  let weekSum = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const ds = isoDate(d);
    weekSum += Number(daily[ds] || 0);
  }
  const weekDailyAvg = weekSum / 7;
  const projected = mtd + weekDailyAvg * remainingDays;
  return {
    type: 'info',
    summary:
      'Dự báo doanh thu cuối tháng (giữ tốc độ 7 ngày gần nhất):\n' +
      '- Doanh thu đã ghi nhận MTD: ' +
      formatVndAmount(mtd) +
      '\n- Tốc độ trung bình 7 ngày: ' +
      formatVndAmount(weekDailyAvg) +
      '/ngày' +
      '\n- Số ngày còn lại: ' +
      remainingDays +
      '\n- Dự báo cuối tháng: ' +
      formatVndAmount(projected),
    targets: [],
    requires_confirmation: false,
    insight: '',
    next_question: '',
    actions: ['Theo dõi lệch thực tế vs dự báo mỗi 2-3 ngày để điều chỉnh kế hoạch thu']
  };
}

function isLikelyDataScopedRequest(message) {
  const n = normalizeText(message || '');
  if (!n) return false;
  if (isCapabilityHelpQuery(message)) return false;
  const keys = [
    'doanh thu',
    'revenue',
    'thu hoc phi',
    'thu tien',
    'cong no',
    'no hoc phi',
    'no buoi',
    'diem danh',
    'vang',
    'co mat',
    'giao dich',
    'chuyen khoan',
    'doi soat',
    'ngan hang',
    'lead',
    'tu van',
    'hoc vien',
    'hoc sinh',
    'thong tin',
    'ho so',
    'chi tiet',
    'lop',
    'giao vien',
    'lich day',
    'schedule',
    'payment',
    'link thanh toan',
    'ref code',
    'dashboard',
    'thong bao',
    'notification',
    'fcm',
    'check in',
    'checkin',
    'luong giao vien',
    'leaderboard',
    'cong diem',
    'lich su diem',
    'nam sinh',
    'ghi chu hoc tap',
    'hoc phi',
    'tong quan',
    'bao cao',
    'thong ke',
    'kpi',
    'ti le',
    'forecast',
    'du bao',
    'thang',
    'tuan',
    'hom nay',
    'hom qua',
    '24h',
    '24 gio'
  ];
  return keys.some((k) => n.includes(k));
}

function extractLatestUserQuery(message) {
  const raw = String(message || '').trim();
  if (!raw) return '';
  const markers = ['YÊU CẦU MỚI:', 'YEU CAU MOI:'];
  for (const mk of markers) {
    const idx = raw.lastIndexOf(mk);
    if (idx >= 0) {
      const tail = raw.slice(idx + mk.length).trim();
      if (tail) return tail;
    }
  }
  return raw;
}

function isCapabilityHelpQuery(message) {
  const n = normalizeText(message || '');
  if (!n) return false;
  return (
    /\b(ban con giup toi duoc gi|ban con ho tro duoc gi|ban lam duoc gi|ban co the giup gi|ban co the ho tro gi)\b/.test(n) ||
    /\b(giup toi duoc gi nua|ho tro toi duoc gi nua|con giup duoc gi nua)\b/.test(n) ||
    (/\b(ngoai nhung thong tin vua roi|ngoai thong tin vua roi)\b/.test(n) && /\b(giup|ho tro|duoc gi|lam duoc gi)\b/.test(n))
  );
}

function shouldIncludeChatHistoryForQuery(message, intentName) {
  const raw = String(message || '').trim();
  if (!raw) return false;
  const n = normalizeText(raw);
  if (!n) return false;
  if (isCapabilityHelpQuery(raw)) return false;
  if (/\b(lich su chat|doan chat truoc|tin nhan truoc|cuoc tro chuyen truoc)\b/.test(n)) return true;
  if (/\b(vua roi|truoc do|o tren|ben tren|nhu tren|tiep theo|tiep tuc|nhu cu|bo sung|cap nhat them|them nua)\b/.test(n)) return true;
  if (/\b(ban ay|ban nay|hoc vien do|nguoi do|doi tuong do|thong tin vua roi)\b/.test(n)) return true;
  if (/\b(con gi nua|ngoai nhung thong tin vua roi|ngoai thong tin vua roi)\b/.test(n)) return true;
  if (String(intentName || '') === 'student_360' && /\b(ho so|chi tiet|thong tin)\b/.test(n) && /\b(ay|do|nay)\b/.test(n)) return true;
  return false;
}

function isClarifyingAssistantMessage(text) {
  const n = normalizeText(text || '');
  if (!n) return false;
  return (
    /(co the lam ro hon|cho em them|can ro hon|xac nhan ro hon|mo ta them|bo sung thong tin)/.test(n) ||
    /(vui long xac nhan|xac nhan hoc vien|hay chon|chon hoc vien|chon dung)/.test(n) ||
    /(nhieu hoc vien|trung ten|học viên trùng|có nhiều học viên)/.test(text || '') ||
    /(muon xem .* nao|lop nao|hoc vien nao|doi tuong nao)/.test(n) ||
    /(ban co the cho biet ro hon|ban co the lam ro)/.test(n)
  );
}

function isShortAffirmation(message) {
  const n = normalizeText(message || '');
  if (!n || n.length > 48) return false;
  if (/^(dung|dung roi|dung a|dung vay|chinh xac|phai|phai roi|ok|oke|oce|co|co a|co day|vang|ua|ung|thay|duoc|hay|the|xin|cam on)\b/.test(n)) return true;
  if (/\b(dung roi|chinh xac|phai roi|dung the|dung day|vang a|co a|thay day)\b/.test(n)) return true;
  return false;
}

function looksLikeClarificationAnswer(message) {
  const raw = String(message || '').trim();
  const n = normalizeText(raw);
  if (!n) return false;
  if (isShortAffirmation(raw)) return true;
  if (/\b(so dien thoai|sdt|lop|hoc vien|ten|id)\b/.test(n)) return true;
  if (/\b\d{7,}\b/.test(n.replace(/\D/g, ''))) return true;
  if (raw.length <= 80 && /\b(la|là|lop|lớp|sdt|sđt|so)\b/.test(n)) return true;
  return raw.length <= 48 && n.split(/\s+/).length <= 6;
}

function getLastAssistantMsgWithIndex(tabMessages) {
  const msgs = toArraySafe(tabMessages);
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (String((msgs[i] && msgs[i].role) || '') === 'assistant') return { idx: i, msg: msgs[i] };
  }
  return null;
}

function findPriorUserContentBeforeIndex(tabMessages, beforeIdx) {
  const msgs = toArraySafe(tabMessages);
  for (let i = beforeIdx - 1; i >= 0; i -= 1) {
    if (String((msgs[i] && msgs[i].role) || '') === 'user') return String((msgs[i] && msgs[i].content) || '').trim();
  }
  return '';
}

/** Trích lựa chọn đầu trong câu làm rõ dạng "... Tên (lớp XXX) hay một học viên khác". */
function extractFirstStudentOptionFromClarifyAssistant(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  let head = raw.split(/\s+hay một\s+học viên\b/i)[0];
  head = head.split(/\s+hoặc\s+/i)[0];
  head = head.split(/\s+học viên khác\b/i)[0];
  const m =
    head.match(/\b([\p{L}][\p{L}\s\d]{1,72}?)\s*\(\s*(?:lớp|lop)\s*([^)]+)\)/iu) ||
    head.match(/\b([\p{L}][\p{L}\s\d]{1,72}?)\s*[-–—]\s*(?:lớp|lop)\s*([^-–—\n]+)/iu);
  if (!m) return null;
  const name = String(m[1] || '')
    .replace(/^[\s:.,\-–—]+/, '')
    .replace(/^(ví dụ|vidu|bao gồm|gom|la|là)\s+/iu, '')
    .trim()
    .replace(/\s+/g, ' ');
  const klass = String(m[2] || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.?]+$/, '')
    .trim();
  return name && klass ? { name, className: klass } : null;
}

/**
 * Tin user ngắn sau câu hỏi làm rõ: ghép ngữ cảnh thành câu hỏi đầy đủ cho pipeline (intent + deterministic).
 */
function buildEnrichedQueryFromClarificationTurn(tabMessages, currentMessage) {
  const raw = String(currentMessage || '').trim();
  if (!raw) return '';
  const lastAi = getLastAssistantMsgWithIndex(tabMessages);
  if (!lastAi || !isClarifyingAssistantMessage(lastAi.msg.content || '')) return '';
  if (!isShortAffirmation(raw) && !looksLikeClarificationAnswer(raw)) return '';
  const opt = extractFirstStudentOptionFromClarifyAssistant(lastAi.msg.content || '');
  if (!opt) return '';
  const prior = findPriorUserContentBeforeIndex(tabMessages, lastAi.idx);
  const pn = normalizeText(prior || '');
  const hoSoCue = /\b(ho so|hoc vien|thong tin|chi tiet)\b/.test(pn);
  const prefix = hoSoCue ? 'Hồ sơ học viên' : 'Chi tiết học viên';
  return prefix + ' ' + opt.name + ' lớp ' + opt.className;
}

function resolveStudentFromHoSoLopPhrase(message, students) {
  const raw = String(message || '').trim();
  const m =
    raw.match(/hồ\s*sơ\s+học\s+viên\s+(.+?)\s+lớp\s+(.+)$/iu) ||
    raw.match(/ho\s+so\s+hoc\s+vien\s+(.+?)\s+lop\s+(.+)$/iu) ||
    raw.match(/chi\s+tiết\s+học\s+viên\s+(.+?)\s+lớp\s+(.+)$/iu);
  if (!m) return null;
  const wantNameTokens = normalizeText(String(m[1] || ''))
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const wantClassNorm = normalizeText(String(m[2] || '').trim());
  if (!wantNameTokens.length || !wantClassNorm) return null;
  const hits = toArraySafe(students).filter((s) => {
    const sn = normalizeText((s && s.name) || '');
    const sc = normalizeText(String((s && s.class_name) || '').trim());
    if (!sn || !sc || sc !== wantClassNorm) return false;
    return wantNameTokens.every((t) => sn.includes(t));
  });
  return hits.length === 1 ? hits[0] : null;
}

function shouldIncludeHistoryAfterClarification(tabMessages, currentMessage) {
  const msgs = toArraySafe(tabMessages);
  if (!msgs.length) return false;
  let lastAssistant = null;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (String((msgs[i] && msgs[i].role) || '') === 'assistant') {
      lastAssistant = msgs[i];
      break;
    }
  }
  if (!lastAssistant) return false;
  if (!isClarifyingAssistantMessage(lastAssistant.content || '')) return false;
  return looksLikeClarificationAnswer(currentMessage);
}

function buildAutoSmallTalkResult(message, userDisplayName) {
  const q = String(message || '').trim();
  const n = normalizeText(q);
  const voc = peerNameVocativePrefix(userDisplayName);
  const peerLo = peerAdminAddress(userDisplayName);
  let summary =
    'Em là Trợ lý vận hành MV Klass. Em đang sẵn sàng hỗ trợ các câu hỏi về dữ liệu trung tâm như doanh thu, công nợ, điểm danh, giao dịch, lead và báo cáo lớp.';
  let nextQuestion =
    voc + 'muốn em bắt đầu từ mục nào: doanh thu, công nợ, điểm danh, giao dịch hay lead?';
  if (/la ai|who are you/i.test(n)) {
    summary =
      'Em là Trợ lý vận hành MV Klass, chuyên hỗ trợ tra cứu và tóm tắt dữ liệu trung tâm (doanh thu, công nợ, điểm danh, giao dịch, lead, link thanh toán, giáo viên và leaderboard).';
  }
  if (/\btat ca\b|\ball\b/.test(n)) {
    summary = peerLo
      ? 'Em hiểu ' + peerLo + ' muốn xem đầy đủ thông tin. Cho em xin rõ đối tượng để em trả đúng dữ liệu.'
      : 'Em hiểu cần xem đầy đủ thông tin. Cho em xin rõ đối tượng để em trả đúng dữ liệu.';
    nextQuestion = voc + 'muốn xem đầy đủ thông tin của học viên nào?';
  }
  if (isCapabilityHelpQuery(n)) {
    summary =
      'Em có thể hỗ trợ: tổng quan hôm nay, học viên cụ thể, danh sách học viên theo lớp, điểm danh, công nợ học phí, giao dịch/chuyển khoản, lead, link thanh toán, giáo viên/check-in, dashboard, log thông báo và lịch sử điểm leaderboard.';
    nextQuestion =
      voc +
      'muốn em làm ngay mục nào: tổng quan hôm nay, danh sách lớp, ai vắng nhiều trong tháng, hay lịch sử điểm leaderboard gần đây?';
  }
  return {
    type: 'info',
    summary,
    targets: [],
    requires_confirmation: false,
    insight: '',
    next_question: nextQuestion,
    actions: []
  };
}

function isSmallTalk(message) {
  const m = String(message || '').trim().toLowerCase();
  if (!m) return false;
  if (isCapabilityHelpQuery(m)) return true;
  const patterns = [
    /^hi+$/,
    /^hello+$/,
    /^hey+$/,
    /^alo+$/,
    /^ch[aà]o(\s|$)/,
    /^xin ch[aà]o(\s|$)/,
    /^ch[àa]o b[aạ]n(\s|$)/,
    /^good (morning|afternoon|evening|night)$/,
    /^b[aạ]n kho[eẻ] kh[oô]ng\??$/,
    /^h[oô]m nay th[eế] n[aà]o\??$/,
    /^(t[ôo]i|toi|t[úu]|tu)\s+l[aà]\s+ai\??$/,
    /^b[aạ]n\s+l[aà]\s+ai\??$/,
    /^ai\s+đ[aâ]y\??$/,
    /^who are you\??$/,
    /^b[aạ]n\s+t[eê]n\s+g[iì]\??$/,
    /^tôi\s+không\s+phải\s+bạn\.?$/,
    /^toi\s+khong\s+phai\s+ban\.?$/
  ];
  return patterns.some((re) => re.test(m));
}

function goiOpenAI(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.35,
      max_tokens: 1400,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    const key = getResolvedOpenAiKey();
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(90000, () => {
      req.destroy();
      reject(new Error('OpenAI: hết thời gian chờ (90s).'));
    });
    req.write(body);
    req.end();
  });
}

function goiOpenAIEx(systemPrompt, userPrompt, cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: c.model || 'gpt-4o-mini',
      temperature: typeof c.temperature === 'number' ? c.temperature : 0.35,
      max_tokens: typeof c.max_tokens === 'number' ? c.max_tokens : 1400,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });
    const key = getResolvedOpenAiKey();
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (ch) => (data += ch));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 400) {
            const msg =
              (parsed && parsed.error && parsed.error.message) ||
              ('OpenAI HTTP ' + res.statusCode);
            reject(new Error(msg));
            return;
          }
          if (parsed && parsed.error && parsed.error.message) {
            reject(new Error(parsed.error.message));
            return;
          }
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(90000, () => {
      req.destroy();
      reject(new Error('OpenAI: hết thời gian chờ (90s).'));
    });
    req.write(body);
    req.end();
  });
}

function extractOpenAIText(aiRes) {
  if (!aiRes || typeof aiRes !== 'object') return '';
  const choices = Array.isArray(aiRes.choices) ? aiRes.choices : [];
  const first = choices[0] && choices[0].message ? choices[0].message : null;
  const txt = first && typeof first.content === 'string' ? String(first.content) : '';
  return txt.trim();
}

function tryParseJsonLoose(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {}
  const firstObj = cleaned.indexOf('{');
  const lastObj = cleaned.lastIndexOf('}');
  if (firstObj >= 0 && lastObj > firstObj) {
    try {
      return JSON.parse(cleaned.slice(firstObj, lastObj + 1));
    } catch (_) {}
  }
  return null;
}

function normalizeOutput(rawText) {
  const cleaned = String(rawText || '').trim();
  let parsed = tryParseJsonLoose(cleaned);
  if (parsed && typeof parsed === 'object') {
    if (parsed.summary && typeof parsed.summary === 'string') {
      const nested = tryParseJsonLoose(parsed.summary);
      if (nested && typeof nested === 'object' && Array.isArray(nested.targets)) {
        parsed = nested;
      }
    }
    return parsed;
  }
  return { type: 'info', summary: cleaned || 'Không có nội dung trả về.', targets: [], requires_confirmation: false };
}

/**
 * Gỡ JSON thô lẫn vào summary/target (model đôi khi dán cả object vào chuỗi).
 */
/** Câu làm rõ từ intent-parser LLM phải luôn là tiếng Việt trong app. */
function toVietnameseClarificationIfNeeded(text, userDisplayName) {
  const t = String(text || '').trim();
  const voc = peerNameVocativePrefix(userDisplayName);
  if (!t) return voc + 'nói rõ giúp em cần số liệu nào (điểm danh / học phí / doanh thu / giao dịch / lead)?';
  const lower = t.toLowerCase();
  const englishClarify =
    /^(could|would|please|can you|sure)\b/i.test(lower) ||
    /\b(your request|more details|provide more|clarify|not sure what)\b/i.test(lower);
  if (englishClarify) {
    return 'Em chưa hiểu đúng ý. ' + voc + 'mô tả thêm giúp — cần xem mục vận hành nào (điểm danh theo ngày hay lớp, công nợ, hay doanh thu)?';
  }
  return t;
}

function polishUserFacingTextField(text) {
  let s = String(text || '').trim();
  if (!s) return s;
  s = s.replace(/```(?:json)?\s*[\s\S]*?```/gi, '').trim();
  for (let i = 0; i < 4; i++) {
    const t = s.trim();
    if ((t.startsWith('{') && t.includes('"')) || (t.startsWith('[') && t.includes('"'))) {
      const parsed = tryParseJsonLoose(t);
      if (parsed && typeof parsed === 'object') {
        const inner =
          typeof parsed.summary === 'string'
            ? String(parsed.summary).trim()
            : typeof parsed.message === 'string'
              ? String(parsed.message).trim()
              : '';
        if (inner) {
          s = inner;
          continue;
        }
      }
    }
    break;
  }
  s = s
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line.startsWith('{') && line.endsWith('}')) {
        const p = tryParseJsonLoose(line);
        if (p && typeof p === 'object') return false;
      }
      if (/^["']?(type|targets|summary|requires_confirmation|insight)\s*[:=]/i.test(line)) return false;
      return true;
    })
    .join('\n')
    .trim();
  return s;
}

function sanitizeAiResult(result, intent) {
  const r = result && typeof result === 'object' ? result : { type: 'info', summary: '', targets: [], requires_confirmation: false };
  const out = {
    type: ['info', 'warning', 'success', 'error'].includes(String(r.type || '').toLowerCase()) ? String(r.type).toLowerCase() : 'info',
    summary: polishUserFacingTextField(String(r.summary || '')),
    targets: [],
    requires_confirmation: !!r.requires_confirmation,
    insight: polishUserFacingTextField(String(r.insight || '')),
    next_question: String(r.next_question || '').trim(),
    actions: Array.isArray(r.actions) ? r.actions.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3) : []
  };
  if (!out.summary) out.summary = 'Em đã xử lý xong yêu cầu.';

  const tg = Array.isArray(r.targets) ? r.targets : [];
  out.targets = tg.slice(0, 80).map((t) => {
    const name = String((t && t.name) || '').trim();
    const phone = String((t && t.phone) || '').trim();
    const zalo = String((t && t.zalo_link) || '').trim();
    const msg = polishUserFacingTextField(String((t && t.message) || ''));
    const note = polishUserFacingTextField(String((t && t.note) || ''));
    return {
      name: name || 'Không rõ',
      phone,
      zalo_link: phone ? zalo : '',
      message: msg || 'Cần xử lý mục này.',
      note: note || (phone ? '' : 'Thiếu SĐT')
    };
  });

  if (intent && intent.name === 'student_360' && /ambiguous_match/i.test(String(out.summary)) && !out.requires_confirmation) {
    out.requires_confirmation = true;
  }
  out.summary = humanizeSummaryByIntent(out.summary, intent);
  if (!String(out.summary || '').trim()) out.summary = 'Em đã xử lý xong yêu cầu.';
  if (out.insight) {
    out.insight = humanizeSummaryByIntent(out.insight, intent);
    if (!String(out.insight || '').trim()) delete out.insight;
  }
  return out;
}

function stripDisposableAssistantPhrases(text) {
  let s = String(text || '');
  const blobs = [
    /Em\s+đang\s+ưu\s+tiên\s+phương\s+án\s+an\s+toàn\s+nhất\s+dựa\s+trên\s+dữ\s+liệu\s+hiện\s+có\.?/gi,
    /Em\s+dang\s+uu\s+tien\s+phuong\s+an\s+an\s+toan\s+nhat\s+dua\s+tren\s+du\s+lieu\s+hien\s+co\.?/gi,
    /Em\s+đã\s+trả\s+lời\s+theo\s+dữ\s+liệu\s+hiện\s+có[;.]*\s*(anh\/chị)?[^\n.]*/gi,
    /Da\s+tra\s+loi\s+theo\s+du\s+lieu\s+hien\s+co[^\n.]*/gi
  ];
  blobs.forEach((re) => {
    s = s.replace(re, '');
  });
  return s
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function humanizeSummaryByIntent(summary, intent) {
  const s = String(summary || '').trim();
  if (!s) return s;
  const name = (intent && intent.name) || 'general';
  const toLineSummary = (text) =>
    String(text || '')
      .split(/\n+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .join('\n');
  if (/khong du du lieu|chua co du lieu|không đủ dữ liệu|chưa có dữ liệu/i.test(s)) {
    return stripDisposableAssistantPhrases(
      toLineSummary(
        s
          .replace(/khong du du lieu/gi, 'Em đang thiếu một phần dữ liệu')
          .replace(/chua co du lieu/gi, 'Hiện dữ liệu này chưa cập nhật đầy đủ')
          .replace(/không đủ dữ liệu/gi, 'Em đang thiếu một phần dữ liệu')
          .replace(/chưa có dữ liệu/gi, 'Hiện dữ liệu này chưa cập nhật đầy đủ')
      )
    );
  }
  if (name === 'student_360') {
    const lines = toLineSummary(s)
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .filter(
        (line) =>
          !/ID hệ thống|id hệ thống|mã\s+UUID|student_id/i.test(line) &&
          !/đã\s+liệt\s+kê\s+(đầy đủ\s+)?trong\s+hồ\s+sơ\s+(phía\s+)?trên/i.test(line)
      )
      .map((line) =>
        String(line || '')
          .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
          .replace(/\(\s*\)/g, '')
          .trim()
      )
      .filter(Boolean);
    return stripDisposableAssistantPhrases(lines.join('\n'));
  }
  if (name === 'revenue_compare' && !/^Tổng quan:/i.test(s)) {
    return stripDisposableAssistantPhrases(toLineSummary('Tổng quan: ' + s));
  }
  if (name === 'debt_ops' && !/^Ưu tiên xử lý:/i.test(s)) {
    return stripDisposableAssistantPhrases(toLineSummary('Ưu tiên xử lý: ' + s));
  }
  return stripDisposableAssistantPhrases(toLineSummary(s));
}

function extractNumbers(text) {
  return (String(text || '').match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(/,/g, ''));
}

function needsDataGroundingGuard(result, contextText) {
  const summaryNums = extractNumbers(result && result.summary);
  if (!summaryNums.length) return false;
  const ctx = String(contextText || '');
  let miss = 0;
  summaryNums.slice(0, 8).forEach((n) => {
    if (!ctx.includes(n)) miss += 1;
  });
  return miss >= Math.max(2, Math.floor(summaryNums.length * 0.6));
}

function actionabilityScore(result) {
  const r = result || {};
  let score = 0;
  if (String(r.summary || '').trim().length >= 20) score += 0.35;
  if (Array.isArray(r.actions) && r.actions.length > 0) score += 0.3;
  if (Array.isArray(r.targets) && r.targets.length > 0) score += 0.2;
  if (String(r.insight || '').trim()) score += 0.15;
  return Math.max(0, Math.min(1, score));
}

function parseRevenueMetricsFromContext(contextText) {
  const c = String(contextText || '');
  const single = c.match(/REVENUE_MONTH\(([^)]+)\):\s*(-?\d+(?:\.\d+)?)/i);
  if (single) {
    const mk = String(single[1] || '').trim();
    const esc = mk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cntRe = new RegExp('REVENUE_MONTH_PAYMENT_COUNT\\(' + esc + '\\):\\s*(\\d+)', 'i');
    const cntM = c.match(cntRe);
    return {
      mode: 'single_month',
      monthKey: mk,
      amount: Number(single[2]),
      paymentCount: cntM ? Number(cntM[1]) : null
    };
  }
  const getNum = (label) => {
    const re = new RegExp(label + '\\s*\\([^)]*\\):\\s*(-?\\d+(?:\\.\\d+)?)', 'i');
    const m = c.match(re);
    return m ? Number(m[1]) : null;
  };
  const revThis = getNum('REVENUE_THIS_MONTH');
  const revLast = getNum('REVENUE_LAST_MONTH');
  const revDiff = getNum('REVENUE_DIFF');
  return { mode: 'compare', revThis, revLast, revDiff };
}

function enforceRevenueAnswer(result, contextText, userDisplayName) {
  const r = Object.assign({}, result || {});
  const m = parseRevenueMetricsFromContext(contextText);
  if (m && m.mode === 'single_month') {
    const amt = Number(m.amount || 0);
    const label = monthKeyLabelVi(m.monthKey);
    const pc = m.paymentCount != null ? m.paymentCount : 0;
    r.type = 'info';
    if (amt === 0 && pc === 0) {
      r.summary =
        'Tổng quan doanh thu:\n' +
        '- Kỳ: ' + label + '\n' +
        '- Doanh thu: 0 đ\n' +
        '- Giao dịch: 0';
    } else {
      r.summary =
        'Tổng quan doanh thu:\n' +
        '- Kỳ: ' + label + '\n' +
        '- Doanh thu: ' + formatVndAmount(amt) + '\n' +
        '- Giao dịch: ' + pc;
    }
    const dn = peerAdminAddress(userDisplayName);
    r.insight =
      amt === 0
        ? 'Nếu đã thu nhưng số trên là 0, hãy kiểm tra ngày ghi nhận (paid_at) và kênh thanh toán.'
        : 'Có thể tách thêm theo lớp hoặc kênh thanh toán' + (dn ? ' nếu ' + dn + ' cần.' : ' nếu cần.');
    if (!Array.isArray(r.actions)) r.actions = [];
    if (!r.actions.length) {
      r.actions = [
        'Đối chiếu payment_history kỳ ' + label,
        'Lọc theo lớp trong báo cáo học phí (tab Học phí)'
      ];
    }
    r.next_question =
      peerNameVocativePrefix(userDisplayName) +
      'có muốn em tách doanh thu theo từng lớp hoặc theo tiền mặt / chuyển khoản không?';
    return r;
  }

  const hasNums =
    m &&
    m.mode === 'compare' &&
    Number.isFinite(m.revThis) &&
    Number.isFinite(m.revLast) &&
    Number.isFinite(m.revDiff);
  if (!hasNums) return r;

  const thisV = Number(m.revThis || 0);
  const lastV = Number(m.revLast || 0);
  const diff = Number(m.revDiff || 0);
  const growthPct = lastV > 0 ? ((thisV - lastV) / lastV) * 100 : null;

  let summary = '';
  if (thisV === 0 && lastV === 0) {
    summary =
      'Tổng quan doanh thu:\n' +
      '- Tháng này: 0 đ\n' +
      '- Tháng trước: 0 đ\n' +
      '- Chênh lệch: 0 đ';
  } else {
    const trend = diff > 0 ? 'tăng' : diff < 0 ? 'giảm' : 'không đổi';
    summary =
      'Tổng quan doanh thu:\n' +
      '- Tháng này: ' + formatVndAmount(thisV) + '\n' +
      '- Tháng trước: ' + formatVndAmount(lastV) + '\n' +
      '- Chênh lệch: ' + trend + ' ' + formatVndAmount(Math.abs(diff));
  }

  r.type = 'info';
  r.summary = summary;
  r.insight =
    growthPct == null
      ? 'Chưa có đủ cơ sở để tính % vì tháng trước bằng 0.'
      : 'Biến động so với tháng trước: ' + growthPct.toFixed(2) + '%.';
  if (!Array.isArray(r.actions)) r.actions = [];
  if (!r.actions.length) {
    r.actions = [
      'Đối chiếu payment_history hai tháng gần nhất',
      'Xử lý giao dịch pending / chưa gán học viên'
    ];
  }
  r.next_question =
    peerNameVocativePrefix(userDisplayName) +
    'có muốn em tách theo lớp để xem lớp nào đóng góp doanh thu nhiều nhất không?';
  return r;
}

function parseStudentDebtHintFromContext(contextText) {
  const text = String(contextText || '');
  if (text.includes('STUDENT 360 CONTEXT')) {
    const idx = text.indexOf('=== STUDENT 360 CONTEXT ===');
    const chunk = idx >= 0 ? text.slice(idx) : text;
    const blocks = chunk
      .split(/CANDIDATE_\d+:\s*\n/)
      .slice(1)
      .map((b) => String(b || '').trim())
      .filter(Boolean);
    /** Một học viên trong context → không lấy max nhầm từ ứng viên khác. */
    if (blocks.length === 1) {
      const d = parseDebtFromCandidateBlock(blocks[0]);
      if (d && d.sessions > 0) return { sessions: d.sessions, amount: d.amount || 0 };
    }
    if (blocks.length > 1) {
      let maxSessions = 0;
      let maxAmount = 0;
      blocks.forEach((bk) => {
        const d = parseDebtFromCandidateBlock(bk);
        if (!d || d.sessions <= 0) return;
        if (d.sessions > maxSessions) {
          maxSessions = d.sessions;
          maxAmount = d.amount || 0;
        }
      });
      if (maxSessions > 0) return { sessions: maxSessions, amount: maxAmount };
    }
  }
  const rows = Array.from(
    text.matchAll(/debt_total:\s*sessions_due=(-?\d+(?:\.\d+)?),\s*amount_due=(-?\d+(?:\.\d+)?)/gi)
  );
  if (!rows.length) return null;
  let maxSessions = 0;
  let maxAmount = 0;
  rows.forEach((m) => {
    const s = Number(m[1] || 0);
    const a = Number(m[2] || 0);
    if (s > maxSessions) maxSessions = s;
    if (a > maxAmount) maxAmount = a;
  });
  return { sessions: maxSessions, amount: maxAmount };
}

/** Câu trả lời có vẻ phủ nhận còn nợ (kể cả “không có học phí nợ” — không chỉ substring “không có nợ”). */
function summaryDeniesTuitionDebt(summary) {
  const s = String(summary || '');
  const n = normalizeText(s);
  if (!n.trim()) return false;
  if (/còn\s*nợ|con\s+no|còn\s+phải\s+đóng|sessions_due|Nợ học phí:\s*\d/i.test(s)) return false;
  if (/\bcòn\s+\d+\s*buổi/i.test(s) || /\d+\s*buổi\s*(nợ|học phí nợ)/i.test(s)) return false;
  const denies = [
    'khong co hoc phi no',
    'khong co no hoc phi',
    'khong co no',
    'khong con no',
    'khong no hoc phi',
    'hien khong co hoc phi no',
    'hien dang khong co no',
    'khong can dong hoc phi',
    'het no',
    'da dong du',
    'da dong het',
    'khong con phai dong',
    'khong co khoan no hoc phi'
  ];
  return denies.some((p) => n.includes(p));
}

/** Đã nêu đúng số buổi nợ gần với hint (±1) hay có khối nợ rõ ràng. */
function summaryAffirmsDebtHint(summary, hintSessions) {
  const sess = Math.round(Number(hintSessions || 0));
  const s = String(summary || '');
  if (!sess) return true;
  if (/Hồ sơ học viên:?[\s\S]*Nợ học phí:\s*\d/i.test(s)) return true;
  if (/sessions_due|debt_total|no_buoi=\d/i.test(s)) return true;
  for (let d = -1; d <= 1; d++) {
    const n = sess + d;
    if (n > 0 && new RegExp(String(n) + '[\\s\\S]{0,32}(buổi|buoi).*nợ', 'i').test(s)) return true;
    if (n > 0 && new RegExp('nợ[\\s\\S]{0,24}' + String(n), 'i').test(s)) return true;
  }
  return false;
}

/** Tin nhắn trước trong tab để hỏi tiếp (“còn nợ không?”) vẫn bám được học viên. */
function buildConversationAnchorForStudentTab(tabMessages, maxChars) {
  const cap = maxChars || 2800;
  const arr = Array.isArray(tabMessages) ? tabMessages.slice(-10) : [];
  if (!arr.length) return '';
  const chunks = [];
  let used = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const row = arr[i];
    if (!row || !row.role) continue;
    let c = String(row.content || '').trim();
    c = c.replace(/\s*\n\[plan\][^\n]*/gi, '').trim();
    const head =
      row.role === 'assistant' ? 'Assistant' : row.role === 'user' ? 'User' : String(row.role);
    const line = head + ': ' + c.slice(0, 920);
    if (used + line.length > cap) break;
    chunks.push(line);
    used += line.length + 2;
  }
  return chunks.reverse().join('\n');
}

function findCandidateBlockForTargetName(contextText, targetName) {
  const text = String(contextText || '');
  if (!text.includes('STUDENT 360 CONTEXT')) return '';
  const parts = text.split(/CANDIDATE_\d+:\s*\n/);
  const nn = normalizeText(targetName || '');
  if (!nn) return '';
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const nm = block.match(/name=\s*([^|\n]+)/);
    if (!nm) continue;
    const bn = normalizeText(String(nm[1] || '').trim());
    if (!bn) continue;
    if (bn.includes(nn) || nn.includes(bn)) return block;
  }
  return '';
}

function parseDebtFromCandidateBlock(block) {
  const debtM = String(block || '').match(/debt_total:\s*sessions_due=([\d.-]+),\s*amount_due=([\d.-]+)/i);
  if (!debtM) return null;
  const sessions = Math.round(Number(debtM[1] || 0));
  const amount = Number(debtM[2] || 0);
  return { sessions, amount: Number.isFinite(amount) ? amount : 0 };
}

/** Model often omits target.message; sanitize falls back to generic line. Fill from DATA when possible. */
function fillPlaceholderTargetMessages(result, contextText, userDisplayName) {
  if (!result || !Array.isArray(result.targets) || !result.targets.length) return;
  const GENERIC = /^cần\s+xử\s+lý\s+mục\s+này\.?$/i;
  const OLD_DEBT_LINE = /(?:hiện|hien|đang|dang)\s+còn\s+nợ|(?:con|còn)\s+no\s+\d+\s*buổi|lớp\s+liên\s+quan|lop\s+lien\s+quan/i;
  const ctx = String(contextText || '');
  const summary = String(result.summary || '');
  result.targets = result.targets.map((t) => {
    const rawMsg = String((t && t.message) || '').trim();
    if (rawMsg && !GENERIC.test(rawMsg) && !OLD_DEBT_LINE.test(rawMsg)) return t;

    const block = findCandidateBlockForTargetName(ctx, (t && t.name) || '');
    let sessions = null;
    let amount = 0;
    const fromBlock = block ? parseDebtFromCandidateBlock(block) : null;
    if (fromBlock && fromBlock.sessions > 0) {
      sessions = fromBlock.sessions;
      amount = fromBlock.amount || 0;
    }
    if ((sessions == null || sessions <= 0) && result.targets.length === 1) {
      const hint = parseStudentDebtHintFromContext(ctx);
      if (hint && hint.sessions > 0) {
        sessions = hint.sessions;
        amount = hint.amount || 0;
      }
    }
    if ((sessions == null || sessions <= 0) && /(\d+)\s*buổi/i.test(summary)) {
      const m = summary.match(/(\d+)\s*buổi/i);
      if (m) sessions = Number(m[1] || 0);
    }

    let message = '';
    if (sessions != null && sessions > 0) {
      message = buildParentTuitionReminderMessage({
        name: (t && t.name) || 'học viên',
        className: '',
        sessions,
        amount
      });
    } else {
      const dn = peerAdminAddress(userDisplayName);
      message =
        'Chưa chốt được số buổi nợ từ snapshot — ' +
        (dn ? dn + ', mở tab Học phí / Điểm danh để đối chiếu theo lớp' : 'mở tab Học phí / Điểm danh để đối chiếu theo lớp') +
        ', hoặc hỏi em kèm tên lớp để em tóm tắt rõ hơn.';
    }
    return Object.assign({}, t, { message });
  });
}

function enforceStudentDebtAnswer(result, contextText) {
  const r = Object.assign({}, result || {});
  const hint = parseStudentDebtHintFromContext(contextText);
  if (!hint || hint.sessions <= 0) return r;
  const summary = String(r.summary || '');
  const denies = summaryDeniesTuitionDebt(summary);
  const affirms = summaryAffirmsDebtHint(summary, hint.sessions);
  /** Không ép sửa câu trả lời trung lập; chỉ khi có phủ định gần từ nợ/học phí mà không khớp số buổi theo DATA. */
  const negatesNearDebtTopic =
    /\b(?:không|khong|chưa|chua)\b[^\n]{0,90}(?:nợ|no\s*học|học\s*phí|hoc\s+phi\b)|(?:nợ|hoc\s+phi\b|học\s*phí)[^\n]{0,80}\b(?:không|khong|chưa|chua)\b/i.test(
      summary
    );
  if (denies || (!affirms && negatesNearDebtTopic)) {
    r.summary =
      'Hồ sơ học viên:\n' +
      '- Nợ học phí: ' + Math.round(hint.sessions) + ' buổi\n' +
      '- Ước tính còn nợ: ' + (hint.amount > 0 ? formatVndAmount(hint.amount) : 'Chưa xác định');
  }
  if (!String(r.insight || '').trim()) {
    r.insight =
      'Nên đối chiếu tab Học phí để xem chi tiết nợ theo lớp và lên kế hoạch thu phù hợp.';
  }
  return r;
}

function forceClarifyingResponse(result, intent, message, userDisplayName) {
  const r = Object.assign({}, result || {});
  r.type = r.type || 'info';
  r.requires_confirmation = true;
  const voc = peerNameVocativePrefix(userDisplayName);
  if (!String(r.next_question || '').trim()) {
    if (intent && intent.name === 'student_360') {
      r.next_question =
        voc +
        'cho em thêm số điện thoại hoặc tên lớp của học viên trong câu: "' +
        fitTextBudget(message, 80) +
        '" nhé?';
    } else {
      r.next_question =
        voc + 'muốn em ưu tiên kiểm tra theo lớp, theo thời gian hay theo học viên cụ thể?';
    }
  }
  if (!Array.isArray(r.actions)) r.actions = [];
  if (!r.actions.length) {
    r.actions = ['Xác nhận thêm dữ liệu đầu vào (tab Học phí / Điểm danh)', 'Chọn hướng ưu tiên để em đào sâu'];
  }
  return r;
}

function normalizeLLMIntentName(rawIntent) {
  const x = String(rawIntent || '').trim().toLowerCase();
  if (['revenue_compare', 'student_360', 'debt_ops', 'attendance_ops', 'bank_ops', 'lead_ops', 'general'].includes(x)) {
    return x;
  }
  return 'general';
}

function normalizeLLMWindowType(rawType) {
  const t = String(rawType || '').trim().toLowerCase();
  if (['today', 'yesterday', 'last_n_days', 'range', 'month', 'this_month', 'last_month', 'none'].includes(t)) return t;
  return 'none';
}

function normalizeLLMParsedQuery(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const out = {
    intent: normalizeLLMIntentName(p.intent),
    confidence: Math.max(0, Math.min(1, Number(p.confidence || 0))),
    metric: String(p.metric || '').trim().toLowerCase(),
    scope: String(p.scope || '').trim().toLowerCase(),
    compare_to: String(p.compare_to || '').trim().toLowerCase(),
    ask_attendance_based: !!p.ask_attendance_based,
    class_filter: String(p.class_filter || '').trim(),
    student_keyword: String(p.student_keyword || '').trim(),
    threshold: Number.isFinite(Number(p.threshold)) ? Number(p.threshold) : null,
    top_n: Number.isFinite(Number(p.top_n)) ? Math.max(1, Math.min(50, Number(p.top_n))) : null,
    requires_clarification: !!p.requires_clarification,
    clarification_question: String(p.clarification_question || '').trim(),
    time_window: {
      type: normalizeLLMWindowType(p && p.time_window ? p.time_window.type : ''),
      days: Number.isFinite(Number(p && p.time_window ? p.time_window.days : null))
        ? Math.max(1, Math.min(365, Number(p.time_window.days)))
        : null,
      from: String((p && p.time_window && p.time_window.from) || '').trim(),
      to: String((p && p.time_window && p.time_window.to) || '').trim(),
      month: String((p && p.time_window && p.time_window.month) || '').trim()
    }
  };
  return out;
}

function buildIntentParserStudentNamesHint(merged) {
  const students = toArraySafe(merged && merged.students);
  const names = distinctNonEmpty(students.map((s) => String((s && s.name) || '').trim())).filter(Boolean);
  const max = 90;
  const slice = names.slice(0, max);
  if (!slice.length) return '';
  let s = slice.join(', ');
  if (s.length > 1900) s = s.slice(0, 1900) + '…';
  return (
    'KNOWN_STUDENT_NAMES (subset — chỉ để gắn entity, không được coi là câu hỏi): ' +
    s +
    (names.length > max ? '\n(+ ' + String(names.length - max) + ' tên không liệt kê)' : '')
  );
}

function stripNormalizedQueryHint(message) {
  const s = String(message || '');
  const idx = s.indexOf('[normalized_query_hint]');
  return (idx >= 0 ? s.slice(0, idx) : s).trim();
}

function buildQueryFromParsedSlots(originalMessage, parsedSlots) {
  const base = String(originalMessage || '').trim();
  const p = parsedSlots && typeof parsedSlots === 'object' ? parsedSlots : {};
  const hints = [];
  const intent = normalizeLLMIntentName(p.intent);
  const sk = String(p.student_keyword || '').trim();
  if (intent === 'attendance_ops') {
    hints.push('diem danh');
    if (p.metric === 'present' || /co mat/.test(String(p.scope || ''))) hints.push('co mat');
    if (p.metric === 'absent') hints.push('vang');
  } else if (intent === 'revenue_compare') {
    hints.push('doanh thu');
    if (p.ask_attendance_based) hints.push('dua tren diem danh');
  } else if (intent === 'student_360') {
    hints.push('hoc sinh');
    if (sk) hints.push(sk);
  } else if (intent === 'debt_ops') {
    hints.push('cong no');
    if (sk) hints.push(sk);
  } else if (intent === 'bank_ops') {
    hints.push('giao dich ngan hang');
  } else if (intent === 'lead_ops') {
    hints.push('lead tu van');
  }
  if (p.class_filter) hints.push('lop ' + p.class_filter);
  if (p.top_n) hints.push('top ' + String(p.top_n));
  if (p.threshold != null) hints.push('tren ' + String(p.threshold));

  const tw = p.time_window || {};
  if (tw.type === 'today') hints.push('hom nay');
  else if (tw.type === 'yesterday') hints.push('hom qua');
  else if (tw.type === 'last_n_days' && tw.days) hints.push(String(tw.days) + ' ngay');
  else if (tw.type === 'range' && tw.from && tw.to) hints.push('tu ' + tw.from + ' den ' + tw.to);
  else if ((tw.type === 'month' || tw.type === 'this_month' || tw.type === 'last_month') && tw.month) hints.push('thang ' + tw.month);

  if (!hints.length) return base;
  return base + '\n[normalized_query_hint] ' + hints.join(' | ');
}

/**
 * Bước hiểu nghĩa (GPT) — chạy trước deterministic trong pipeline /ai-chat.
 * `merged` chỉ dùng để gắn tên học viên có trong hệ thống.
 */
async function parseIntentWithLLMSchema(message, merged) {
  const msg = String(message || '').trim();
  if (!msg) return null;
  const nameHint = merged ? buildIntentParserStudentNamesHint(merged) : '';
  const sys =
    'You are the first routing stage: read EVERY user message, classify intent only. Later stages run deterministic rules on database data — you only decide WHICH branch. Return only strict JSON. No markdown, no explanation.';
  const user =
    [
      'Parse user query into this schema:',
      '{',
      '  "intent": "revenue_compare|student_360|debt_ops|attendance_ops|bank_ops|lead_ops|general",',
      '  "confidence": 0..1,',
      '  "metric": "present|absent|revenue|debt|bank|lead|student|other",',
      '  "scope": "today|yesterday|month|range|top|threshold|general",',
      '  "compare_to": "yesterday|last_week|last_month|none",',
      '  "ask_attendance_based": boolean,',
      '  "class_filter": "string",',
      '  "student_keyword": "string",',
      '  "threshold": number|null,',
      '  "top_n": number|null,',
      '  "time_window": {"type":"today|yesterday|last_n_days|range|month|this_month|last_month|none","days":number|null,"from":"YYYY-MM-DD|","to":"YYYY-MM-DD|","month":"M/YYYY|"},',
      '  "requires_clarification": boolean,',
      '  "clarification_question": "string"',
      '}',
      'Rules:',
      '- Prefer attendance_ops for phrases like "co mat", "vang", "diem danh" (absent/present counts from attendance).',
      '- NEVER claim you can cancel/edit/delete attendance marks; the assistant is read-only — user must use the app attendance tab.',
      '- debt_ops: tuition debt / sessions owed (no hoc phi, dang no, con no, list "hoc sinh / hoc vien dang no tren N buoi") — NOT the same as absence counts. Use top/highest debt only when the query explicitly mentions tuition/payment debt AND top/cao nhat/nhieu nhat/uu tien.',
      '- Prefer revenue_compare for "doanh thu", "thu hoc phi".',
      '- student_360: user asks profile/info about ONE learner (thong tin, ho so, chi tiet, hoc sinh X, diem danh cua X if about person not class stats).',
      '- If KNOWN_STUDENT_NAMES is present and the query names a person matching or clearly referring to one of them, set intent=student_360, fill student_keyword, confidence high (>=0.72).',
      '- Pure greetings/small talk → intent="general", confidence high, requires_clarification=false, empty clarification_question.',
      '- If unsure (data question), set intent="general", confidence <= 0.55, requires_clarification=true.',
      '- clarification_question MUST be Vietnamese only (no English).',
      '- Output valid JSON only.',
      nameHint,
      'User query:',
      msg
    ]
      .filter((line) => String(line || '').trim() !== '')
      .join('\n');
  try {
    const aiRes = await goiOpenAIEx(sys, user, { temperature: 0, max_tokens: 320 });
    const raw = extractOpenAIText(aiRes);
    const parsed = tryParseJsonLoose(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return normalizeLLMParsedQuery(parsed);
  } catch (_) {
    return null;
  }
}

/**
 * LLM-first: nếu model phân loại được nhánh cụ thể (không general) với đủ tin cậy → dùng để chạy rule deterministic tiếp theo.
 */
function attendanceRecordMergeKey(row) {
  if (!row || typeof row !== 'object') return '';
  const sid = String((row.student_id || row.studentId) || '').trim();
  if (!sid) return '';
  const d = normalizeDateToYmd(row.date || row.session_date || row.attendance_date || '');
  if (!d) return '';
  const cls = normalizeText(String(row.class_name || row.class || '').trim());
  return sid + '\t' + d + '\t' + cls;
}

/**
 * Client thường chỉ gửi snapshot tab Điểm danh (một lớp / ngày đang mở) — không được thay thế toàn bộ bảng attendance từ DB.
 * Gộp: lấy đủ ca từ fallback, ghi đè bằng bản client khi trùng (học viên + ngày + lớp).
 */
function mergeAttendanceClientAndFallback(clientRows, fallbackRows) {
  const m = new Map();
  toArraySafe(fallbackRows).forEach((r) => {
    const k = attendanceRecordMergeKey(r);
    if (k) m.set(k, r);
  });
  toArraySafe(clientRows).forEach((r) => {
    const k = attendanceRecordMergeKey(r);
    if (k) m.set(k, r);
  });
  return Array.from(m.values());
}

function mergeStudentsPreferClient(clientList, fallbackList) {
  const m = new Map();
  toArraySafe(fallbackList).forEach((s) => {
    const id = String((s && s.id) || '').trim();
    if (id) m.set(id, s);
  });
  toArraySafe(clientList).forEach((s) => {
    const id = String((s && s.id) || '').trim();
    if (id) m.set(id, s);
  });
  return Array.from(m.values());
}

function mergeIntentLLMPrimary(ruleIntent, llmParsed) {
  const base = ruleIntent && typeof ruleIntent === 'object' ? Object.assign({}, ruleIntent) : detectIntent('');
  if (!llmParsed || typeof llmParsed !== 'object') return syncIntentFlagsFromName(base);
  const llmIntent = normalizeLLMIntentName(llmParsed.intent);
  const llmConf = Math.max(0, Math.min(1, Number(llmParsed.confidence || 0)));
  const LLM_ROUTE_MIN = 0.42;
  if (llmIntent !== 'general' && llmConf >= LLM_ROUTE_MIN) {
    base.name = llmIntent;
    base.confidence = Number(Math.min(0.96, Math.max(llmConf, 0.71)).toFixed(2));
    return syncIntentFlagsFromName(base);
  }
  return syncIntentFlagsFromName(base);
}

function extractRequestedTopLimit(message, parsedSlots) {
  const pTop = parsedSlots && Number.isFinite(Number(parsedSlots.top_n)) ? Number(parsedSlots.top_n) : null;
  if (pTop != null && pTop > 0) return Math.max(1, Math.min(120, Math.round(pTop)));
  const n = normalizeText(message || '');
  let m = n.match(/top\s*(\d{1,3})/i);
  if (m) return Math.max(1, Math.min(120, Number(m[1] || 0)));
  const wordToNum = {
    mot: 1,
    hai: 2,
    ba: 3,
    bon: 4,
    tu: 4,
    nam: 5,
    sau: 6,
    bay: 7,
    tam: 8,
    chin: 9,
    muoi: 10
  };
  m = n.match(/(?:lay|cho|tra|liet ke|danh sach)?\s*(\d{1,3}|mot|hai|ba|bon|tu|nam|sau|bay|tam|chin|muoi)\s*(?:hoc sinh|hoc vien|ban|em)\s+(?:dang\s+)?no\s+(?:hoc phi\s+)?(?:nhieu|cao|nhieu nhat|cao nhat)/i);
  if (m) {
    const raw = String(m[1] || '');
    const v = /^\d+$/.test(raw) ? Number(raw) : wordToNum[raw];
    if (v) return Math.max(1, Math.min(120, v));
  }
  return null;
}

function resolveStudentEntitySlot(message, students, parsedSlots) {
  const p = parsedSlots && typeof parsedSlots === 'object' ? parsedSlots : {};
  const keyword = String(p.student_keyword || '').trim();
  const query = keyword || extractStudentNameHint(message) || String(message || '').trim();
  const out = {
    status: 'none',
    student: null,
    candidates: [],
    keyword: keyword || extractStudentNameHint(message) || ''
  };
  if (!query || normalizeText(query).split(/\s+/).filter(Boolean).length < 1) return out;
  const anchored = pickSingleStudentByNameHint(query, students) || pickSingleStudentByNameHint(message, students);
  if (anchored) {
    out.status = 'unique';
    out.student = anchored;
    out.candidates = [anchored];
    return out;
  }
  const scored = findStudentCandidatesWithScore(query, students);
  if (!scored.length) return out;
  const top = scored[0];
  const close = scored.filter((x) => x.score >= Math.max(1, top.score - 1)).slice(0, 5);
  out.candidates = close.map((x) => x.student);
  if (close.length === 1 && top.score >= 2) {
    out.status = 'unique';
    out.student = top.student;
  } else if (close.length > 1) {
    out.status = 'ambiguous';
  }
  return out;
}

function resolveQuerySlots(message, merged, parsedSlots) {
  const n = normalizeText(message || '');
  const p = parsedSlots && typeof parsedSlots === 'object' ? parsedSlots : {};
  const student = resolveStudentEntitySlot(message, toArraySafe(merged && merged.students), p);
  const tuitionSignal = /(hoc phi|dong phi|nop phi|thanh toan|cong no|no hoc phi|no phi|chua dong|chua nop|sessions_due|debt)/i.test(n);
  const topSignal = /(top\s*\d{0,3}|cao nhat|nhieu nhat|no nhieu|no cao|uu tien|sap xep)/i.test(n);
  const messageDraftSignal = wantsTuitionReminderDraft(message);
  const requestedTopLimit = extractRequestedTopLimit(message, p);
  const hasExplicitStudent = student.status === 'unique' || student.status === 'ambiguous' || !!String(p.student_keyword || '').trim();
  return {
    student,
    hasExplicitStudent,
    tuitionSignal,
    topSignal,
    messageDraftSignal,
    requestedTopLimit,
    wantsTuitionTopDebt: tuitionSignal && topSignal && !hasExplicitStudent,
    wantsStudentTuition: tuitionSignal && hasExplicitStudent,
    parsedIntent: normalizeLLMIntentName(p.intent),
    parsedConfidence: Math.max(0, Math.min(1, Number(p.confidence || 0)))
  };
}

function routeIntentByRegistry(currentIntent, slots) {
  const cur = currentIntent && typeof currentIntent === 'object' ? Object.assign({}, currentIntent) : detectIntent('');
  const s = slots || {};
  let reason = 'keep_existing';

  if (s.student && s.student.status === 'ambiguous') {
    cur.name = 'student_360';
    cur.confidence = Math.max(Number(cur.confidence || 0), 0.88);
    reason = 'ambiguous_student_requires_clarification';
  } else if (s.messageDraftSignal && s.student && s.student.status === 'unique') {
    cur.name = 'student_360';
    cur.confidence = Math.max(Number(cur.confidence || 0), 0.94);
    reason = 'student_payment_reminder_locked_student';
  } else if (s.wantsStudentTuition && s.student && s.student.status === 'unique') {
    cur.name = 'student_360';
    cur.confidence = Math.max(Number(cur.confidence || 0), 0.9);
    reason = 'single_student_tuition_query';
  } else if (s.wantsTuitionTopDebt) {
    cur.name = 'debt_ops';
    cur.confidence = Math.max(Number(cur.confidence || 0), 0.9);
    reason = 'tuition_top_debt';
  }

  cur.route_reason = reason;
  return syncIntentFlagsFromName(cur);
}

function compactRouteDebug(intentBefore, intentAfter, slots, handlerName) {
  const student = slots && slots.student ? slots.student : {};
  return {
    intent_before: intentBefore && intentBefore.name ? String(intentBefore.name) : '',
    intent_after: intentAfter && intentAfter.name ? String(intentAfter.name) : '',
    route_reason: intentAfter && intentAfter.route_reason ? String(intentAfter.route_reason) : '',
    handler: String(handlerName || ''),
    student_resolution: String(student.status || 'none'),
    student_name:
      student.student && student.student.name ? String(student.student.name) : '',
    candidate_count: Array.isArray(student.candidates) ? student.candidates.length : 0,
    tuition_signal: !!(slots && slots.tuitionSignal),
    top_signal: !!(slots && slots.topSignal),
    message_draft_signal: !!(slots && slots.messageDraftSignal),
    requested_top_limit: slots && slots.requestedTopLimit != null ? slots.requestedTopLimit : null
  };
}

function attachRouteDebug(result, intentBefore, intentAfter, slots, handlerName) {
  const out = result && typeof result === 'object' ? result : {};
  out.route_debug = compactRouteDebug(intentBefore, intentAfter, slots, handlerName);
  return out;
}

function mergeContext(clientContext, fallbackData) {
  const c = clientContext && typeof clientContext === 'object' ? clientContext : {};
  const f = fallbackData || { students: [], attendance: [], payment: [], extra: {} };
  const clientPayment = Array.isArray(c.payment) ? c.payment : [];
  const looksLikePaymentHistory =
    clientPayment.length > 0 &&
    clientPayment.some((row) => {
      if (!row || typeof row !== 'object') return false;
      return (
        row.amount_vnd != null ||
        row.amount != null ||
        row.paid_at != null ||
        row.created_at != null ||
        row.payment_date != null
      );
    });
  return {
    students: mergeStudentsPreferClient(
      Array.isArray(c.students) ? c.students : [],
      Array.isArray(f.students) ? f.students : []
    ),
    attendance: mergeAttendanceClientAndFallback(
      Array.isArray(c.attendance) ? c.attendance : [],
      Array.isArray(f.attendance) ? f.attendance : []
    ),
    payment: looksLikePaymentHistory ? clientPayment : f.payment || [],
    tuition_rows: Array.isArray(c.tuition_rows) ? c.tuition_rows : [],
    extra: f.extra || {}
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-MV-AI-Server, X-MV-Server-Build, X-MV-OpenAI-Ready'
  );
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  if (
    req.method !== 'POST' ||
    (req.url !== '/ai-chat' && req.url !== '/ai-chat-feedback')
  ) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const authedAdmin = await verifySupabaseAdminRequest(req);
  if (!authedAdmin) {
    res.writeHead(401);
    res.end('Unauthorized');
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      const data = JSON.parse(body || '{}');
      const tabId = String(data.tab_id || 'default');
      const userId = String(authedAdmin.id || data.user_id || 'admin');

      if (req.url === '/ai-chat-feedback') {
        const store = readStore();
        const profile = applyExplicitFeedback(store, userId, tabId, data || {});
        writeStore(store);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            adaptive_profile: {
              preferred_style: profile.preferredStyle,
              negative: profile.negative,
              positive: profile.positive,
              clarity_need: profile.clarityNeed,
              detail_need: profile.detailNeed
            }
          })
        );
        return;
      }

      const message = String(data.message || '').trim();
      const userMessage = String(data.user_message || data.message || '').trim();
      const effectiveUserMessage = extractLatestUserQuery(userMessage);
      const userDisplayName = sanitizeUserDisplayName(data.user_display_name || '');

      if (!effectiveUserMessage) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enrichAiChatResultPayload({ error: 'message is required' })));
        return;
      }

      res.setHeader('X-MV-AI-Server', 'server');
      res.setHeader('X-MV-Server-Build', SERVER_BUILD);
      res.setHeader('X-MV-OpenAI-Ready', hasConfiguredOpenAIKey() ? 'yes' : 'no');

      const fallback = await layDuLieuFallback();
      // Always merge client snapshot (tab Học phí / tuition_rows) với dữ liệu Supabase vừa tải.
      const merged = mergeContext(data.context || {}, {
        students: Array.isArray(fallback.students) ? fallback.students : [],
        attendance: Array.isArray(fallback.attendance) ? fallback.attendance : [],
        payment: Array.isArray(fallback.payment) ? fallback.payment : [],
        extra: fallback.extra || {}
      });
      const store = readStore();
      const tabMessages = getTabMessages(store, userId, tabId);
      const enrichedFromClarification = buildEnrichedQueryFromClarificationTurn(tabMessages, effectiveUserMessage);
      const pipelineUserMessage = enrichedFromClarification || effectiveUserMessage;
      /**
       * Pipeline (mặc định):
       * — Có OpenAI: LUÔN gọi GPT đọc yêu cầu (`parseIntentWithLLMSchema`) → deterministic nếu khớp intent; còn lại (small talk / general) đi tiếp planner + GPT trả lời — không dùng template xã giao cố định.
       * — Không key: heuristic + refine + deterministic; chỉ dùng template small talk khi thật sự không có OpenAI.
       */
      const ruleIntentSeed = detectIntent(pipelineUserMessage);
      let intent = ruleIntentSeed;
      let llmParsedQuery = null;

      if (hasConfiguredOpenAIKey()) {
        llmParsedQuery = await parseIntentWithLLMSchema(pipelineUserMessage, merged);
        intent = mergeIntentLLMPrimary(ruleIntentSeed, llmParsedQuery);
        if (intent.name === 'general') {
          intent = refineIntentWithLikelyStudentName(pipelineUserMessage, merged.students, intent) || intent;
          intent = syncIntentFlagsFromName(intent);
        }
      } else {
        intent = refineIntentWithLikelyStudentName(pipelineUserMessage, merged.students, ruleIntentSeed) || ruleIntentSeed;
        intent = syncIntentFlagsFromName(intent);
      }
      const intentBeforeRegistry = Object.assign({}, intent);
      const routeSlots = resolveQuerySlots(pipelineUserMessage, merged, llmParsedQuery);
      intent = routeIntentByRegistry(intent, routeSlots);

      const messageForRules = buildQueryFromParsedSlots(pipelineUserMessage, llmParsedQuery);

      if (
        looksLikeTuitionDebtBySessionsQuery(pipelineUserMessage) &&
        intent.name !== 'debt_ops' &&
        !(routeSlots && routeSlots.hasExplicitStudent)
      ) {
        intent = syncIntentFlagsFromName(
          Object.assign({}, intent, {
            name: 'debt_ops',
            confidence: Math.max(Number(intent.confidence || 0), 0.88)
          })
        );
      }
      if (String(enrichedFromClarification || '').trim()) {
        intent = syncIntentFlagsFromName(
          Object.assign({}, intent, {
            name: 'student_360',
            confidence: Math.max(Number(intent.confidence || 0), 0.9)
          })
        );
      }
      const followupAfterClarify = shouldIncludeHistoryAfterClarification(tabMessages, effectiveUserMessage);
      const useChatHistory = shouldIncludeChatHistoryForQuery(effectiveUserMessage, intent.name) || followupAfterClarify;
      const shouldUseAnchor =
        useChatHistory &&
        (intent.name === 'student_360' || intent.name === 'debt_ops') &&
        shouldAttachStudentChatAnchor(pipelineUserMessage, merged.students);
      const chatAnchorForStudentCtx = shouldUseAnchor ? buildConversationAnchorForStudentTab(tabMessages) : '';
      const contextUserMessage =
        intent.name === 'student_360' || intent.name === 'debt_ops'
          ? messageForRules +
            (String(chatAnchorForStudentCtx).trim()
              ? '\n\n[LICH_SU_CHAT_TRONG_TAB — dùng để nhận học viên đang được nhắc tới]\n' +
                chatAnchorForStudentCtx
              : '')
          : messageForRules;

      const contextText = buildSmartContext(contextUserMessage, merged, intent);
      const feedbackProfile = getFeedbackProfile(store, userId, tabId);
      const feedbackGuide = buildFeedbackStyleGuide(feedbackProfile);
      if (isCapabilityHelpQuery(effectiveUserMessage)) {
        const result = buildAutoSmallTalkResult(effectiveUserMessage, userDisplayName);
        result.confidence = 0.96;
        result.intent = 'general';
        result.intent_confidence = Number((intent.confidence || 0).toFixed(2));
        result.cache_hit = false;
        result.adaptive_profile = {
          preferred_style: feedbackProfile.preferredStyle,
          negative: feedbackProfile.negative,
          positive: feedbackProfile.positive,
          clarity_need: feedbackProfile.clarityNeed,
          detail_need: feedbackProfile.detailNeed
        };
        appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
        appendTabMessage(store, userId, tabId, 'assistant', String(result.summary || ''));
        writeStore(store);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enrichAiChatResultPayload(result)));
        return;
      }
      if (routeSlots && routeSlots.student && routeSlots.student.status === 'ambiguous') {
        const names = toArraySafe(routeSlots.student.candidates)
          .map((s) => String((s && s.name) || '').trim() + (s && s.class_name ? ' - ' + String(s.class_name) : ''))
          .filter(Boolean)
          .slice(0, 5);
        const result = attachRouteDebug(
          {
            type: 'warning',
            summary:
              'Em thấy nhiều học viên có tên gần giống nhau nên chưa chốt để tránh nhầm dữ liệu.',
            targets: [],
            requires_confirmation: true,
            insight: '',
            next_question: names.length
              ? 'Thầy/cô muốn chọn học viên nào: ' + names.join(', ') + '?'
              : 'Thầy/cô cho em thêm lớp hoặc SĐT của học viên nhé?',
            actions: ['Gửi thêm lớp hoặc SĐT để em lọc đúng học viên']
          },
          intentBeforeRegistry,
          intent,
          routeSlots,
          'entity_resolution'
        );
        appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
        appendTabMessage(store, userId, tabId, 'assistant', String(result.summary || ''));
        writeStore(store);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enrichAiChatResultPayload(result)));
        return;
      }
      const tuitionReminderDraft = buildStudentTuitionReminderDraftResult(
        merged,
        pipelineUserMessage,
        userDisplayName
      );
      if (tuitionReminderDraft) {
        tuitionReminderDraft.confidence = 0.97;
        tuitionReminderDraft.intent = 'student_360';
        tuitionReminderDraft.intent_confidence = Math.max(Number(intent.confidence || 0), 0.9);
        tuitionReminderDraft.cache_hit = false;
        tuitionReminderDraft.adaptive_profile = {
          preferred_style: feedbackProfile.preferredStyle,
          negative: feedbackProfile.negative,
          positive: feedbackProfile.positive,
          clarity_need: feedbackProfile.clarityNeed,
          detail_need: feedbackProfile.detailNeed
        };
        attachRouteDebug(tuitionReminderDraft, intentBeforeRegistry, intent, routeSlots, 'student_payment_reminder');
        appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
        appendTabMessage(store, userId, tabId, 'assistant', String(tuitionReminderDraft.summary || ''));
        writeStore(store);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enrichAiChatResultPayload(tuitionReminderDraft)));
        return;
      }
      const deterministicStudent =
        intent.name === 'student_360' && !isOperationalOverviewMessage(effectiveUserMessage)
          ? tryDeterministicStudentSummary(pipelineUserMessage, merged)
          : null;
      const hasDeterministicStudent = !!(deterministicStudent && deterministicStudent.summary);
      const debtSessionsRule = intent.name === 'debt_ops' ? parseDebtSessionsRuleFromMessage(messageForRules) : null;
      const recentN = followupAfterClarify ? 5 : RECENT_WINDOW;
      const relevantK = followupAfterClarify
        ? 5
        : intent.name === 'student_360' || intent.name === 'revenue_compare'
          ? Math.max(RELEVANT_K, 10)
          : RELEVANT_K;
      const recent = useChatHistory ? tabMessages.slice(-recentN) : [];
      const relevant = useChatHistory ? pickRelevantMessages(tabMessages, pipelineUserMessage, relevantK, intent.name) : [];

      const leaderboardRule = parseLeaderboardRuleFromMessage(effectiveUserMessage);
      if (leaderboardRule && !hasDeterministicStudent) {
        const result = buildLeaderboardDeterministicResult(merged, leaderboardRule);
        result.confidence = 0.96;
        result.intent = 'leaderboard_ops';
        result.intent_confidence = 0.96;
        result.cache_hit = false;
        result.adaptive_profile = {
          preferred_style: feedbackProfile.preferredStyle,
          negative: feedbackProfile.negative,
          positive: feedbackProfile.positive,
          clarity_need: feedbackProfile.clarityNeed,
          detail_need: feedbackProfile.detailNeed
        };
        result.summary = polishUserFacingTextField(String(result.summary || ''));
        if (result.insight) result.insight = polishUserFacingTextField(String(result.insight));
        attachRouteDebug(result, intentBeforeRegistry, intent, routeSlots, 'leaderboard_ops');
        appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
        appendTabMessage(store, userId, tabId, 'assistant', String(result.summary || ''));
        writeStore(store);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enrichAiChatResultPayload(result)));
        return;
      }

      const ownerRule = parseOwnerOpsRuleFromMessage(effectiveUserMessage);
      if (ownerRule && !hasDeterministicStudent) {
        let result = null;
        if (ownerRule.type === 'alerts_24h') result = buildOwnerAlerts24hResult(merged);
        if (ownerRule.type === 'today_operational_overview') result = buildTodayOperationalOverviewResult(merged, effectiveUserMessage);
        if (ownerRule.type === 'revenue_today_compare') result = buildOwnerRevenueTodayCompareResult(merged, effectiveUserMessage);
        if (ownerRule.type === 'class_absence_abnormal_7_30') result = buildOwnerClassAbsenceAbnormalResult(merged);
        if (ownerRule.type === 'late_payers') result = buildOwnerLatePayersResult(merged);
        if (ownerRule.type === 'forecast_month_end') result = buildOwnerMonthEndForecastResult(merged);
        if (ownerRule.type === 'class_schedule_by_days') result = buildOwnerClassScheduleByDaysResult(merged, effectiveUserMessage);
        if (ownerRule.type === 'class_student_count') result = buildOwnerClassStudentCountResult(merged, effectiveUserMessage);
        if (result) {
          result.confidence = 0.94;
          result.intent = intent.name || 'general';
          result.intent_confidence = Number((intent.confidence || 0).toFixed(2));
          result.cache_hit = false;
          result.adaptive_profile = {
            preferred_style: feedbackProfile.preferredStyle,
            negative: feedbackProfile.negative,
            positive: feedbackProfile.positive,
            clarity_need: feedbackProfile.clarityNeed,
            detail_need: feedbackProfile.detailNeed
          };
          result.summary = polishUserFacingTextField(String(result.summary || ''));
          if (result.insight) result.insight = polishUserFacingTextField(String(result.insight));
          attachRouteDebug(result, intentBeforeRegistry, intent, routeSlots, 'owner_ops:' + String(ownerRule.type || ''));
          appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
          appendTabMessage(store, userId, tabId, 'assistant', String(result.summary || ''));
          writeStore(store);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(enrichAiChatResultPayload(result)));
          return;
        }
      }

      if (debtSessionsRule && !hasDeterministicStudent) {
        const result = buildDebtThresholdDeterministicResult(merged, debtSessionsRule);
        result.confidence = 0.95;
        result.intent = intent.name;
        result.intent_confidence = Number((intent.confidence || 0).toFixed(2));
        result.cache_hit = false;
        result.adaptive_profile = {
          preferred_style: feedbackProfile.preferredStyle,
          negative: feedbackProfile.negative,
          positive: feedbackProfile.positive,
          clarity_need: feedbackProfile.clarityNeed,
          detail_need: feedbackProfile.detailNeed
        };
        result.summary = polishUserFacingTextField(String(result.summary || ''));
        if (result.insight) result.insight = polishUserFacingTextField(String(result.insight));
        attachRouteDebug(result, intentBeforeRegistry, intent, routeSlots, 'debt_ops');

        appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
        appendTabMessage(store, userId, tabId, 'assistant', String(result.summary || ''));
        writeStore(store);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enrichAiChatResultPayload(result)));
        return;
      }

      if (
        intent.name === 'attendance_ops' &&
        looksLikeAttendanceWriteCancelMessage(effectiveUserMessage) &&
        !hasDeterministicStudent
      ) {
        const result = buildAttendanceMutationUnsupportedResult(userDisplayName);
        result.confidence = 0.92;
        result.intent = intent.name;
        result.intent_confidence = Number((intent.confidence || 0).toFixed(2));
        result.cache_hit = false;
        result.adaptive_profile = {
          preferred_style: feedbackProfile.preferredStyle,
          negative: feedbackProfile.negative,
          positive: feedbackProfile.positive,
          clarity_need: feedbackProfile.clarityNeed,
          detail_need: feedbackProfile.detailNeed
        };
        result.summary = polishUserFacingTextField(String(result.summary || ''));
        if (result.insight) result.insight = polishUserFacingTextField(String(result.insight));
        attachRouteDebug(result, intentBeforeRegistry, intent, routeSlots, 'attendance_mutation_unsupported');
        appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
        appendTabMessage(store, userId, tabId, 'assistant', String(result.summary || ''));
        writeStore(store);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enrichAiChatResultPayload(result)));
        return;
      }

      const attendanceRule = intent.name === 'attendance_ops' ? parseAttendanceRuleFromMessage(messageForRules, merged) : null;
      if (attendanceRule && !hasDeterministicStudent) {
        const result = buildAttendanceDeterministicResult(merged, attendanceRule);
        result.confidence = 0.93;
        result.intent = intent.name;
        result.intent_confidence = Number((intent.confidence || 0).toFixed(2));
        result.cache_hit = false;
        result.adaptive_profile = {
          preferred_style: feedbackProfile.preferredStyle,
          negative: feedbackProfile.negative,
          positive: feedbackProfile.positive,
          clarity_need: feedbackProfile.clarityNeed,
          detail_need: feedbackProfile.detailNeed
        };
        result.summary = polishUserFacingTextField(String(result.summary || ''));
        if (result.insight) result.insight = polishUserFacingTextField(String(result.insight));
        attachRouteDebug(result, intentBeforeRegistry, intent, routeSlots, 'attendance_ops');
        appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
        appendTabMessage(store, userId, tabId, 'assistant', String(result.summary || ''));
        writeStore(store);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enrichAiChatResultPayload(result)));
        return;
      }

      const revenueRule = intent.name === 'revenue_compare' ? parseRevenueRuleFromMessage(messageForRules, merged) : null;
      if (revenueRule && !hasDeterministicStudent) {
        const result = buildRevenueDeterministicResult(merged, revenueRule);
        result.confidence = 0.93;
        result.intent = intent.name;
        result.intent_confidence = Number((intent.confidence || 0).toFixed(2));
        result.cache_hit = false;
        result.adaptive_profile = {
          preferred_style: feedbackProfile.preferredStyle,
          negative: feedbackProfile.negative,
          positive: feedbackProfile.positive,
          clarity_need: feedbackProfile.clarityNeed,
          detail_need: feedbackProfile.detailNeed
        };
        result.summary = polishUserFacingTextField(String(result.summary || ''));
        if (result.insight) result.insight = polishUserFacingTextField(String(result.insight));
        attachRouteDebug(result, intentBeforeRegistry, intent, routeSlots, 'revenue_compare');
        appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
        appendTabMessage(store, userId, tabId, 'assistant', String(result.summary || ''));
        writeStore(store);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enrichAiChatResultPayload(result)));
        return;
      }

      const bankRule = intent.name === 'bank_ops' ? parseBankRuleFromMessage(messageForRules, merged) : null;
      if (bankRule && !hasDeterministicStudent) {
        const result = buildBankDeterministicResult(merged, bankRule);
        result.confidence = 0.92;
        result.intent = intent.name;
        result.intent_confidence = Number((intent.confidence || 0).toFixed(2));
        result.cache_hit = false;
        result.adaptive_profile = {
          preferred_style: feedbackProfile.preferredStyle,
          negative: feedbackProfile.negative,
          positive: feedbackProfile.positive,
          clarity_need: feedbackProfile.clarityNeed,
          detail_need: feedbackProfile.detailNeed
        };
        result.summary = polishUserFacingTextField(String(result.summary || ''));
        if (result.insight) result.insight = polishUserFacingTextField(String(result.insight));
        attachRouteDebug(result, intentBeforeRegistry, intent, routeSlots, 'bank_ops');
        appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
        appendTabMessage(store, userId, tabId, 'assistant', String(result.summary || ''));
        writeStore(store);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enrichAiChatResultPayload(result)));
        return;
      }

      const leadRule = intent.name === 'lead_ops' ? parseLeadRuleFromMessage(messageForRules, merged) : null;
      if (leadRule && !hasDeterministicStudent) {
        const result = buildLeadDeterministicResult(merged, leadRule);
        result.confidence = 0.92;
        result.intent = intent.name;
        result.intent_confidence = Number((intent.confidence || 0).toFixed(2));
        result.cache_hit = false;
        result.adaptive_profile = {
          preferred_style: feedbackProfile.preferredStyle,
          negative: feedbackProfile.negative,
          positive: feedbackProfile.positive,
          clarity_need: feedbackProfile.clarityNeed,
          detail_need: feedbackProfile.detailNeed
        };
        result.summary = polishUserFacingTextField(String(result.summary || ''));
        if (result.insight) result.insight = polishUserFacingTextField(String(result.insight));
        attachRouteDebug(result, intentBeforeRegistry, intent, routeSlots, 'lead_ops');
        appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
        appendTabMessage(store, userId, tabId, 'assistant', String(result.summary || ''));
        writeStore(store);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enrichAiChatResultPayload(result)));
        return;
      }

      const expandedDataRule = parseExpandedDataRuleFromMessage(messageForRules, merged);
      if (expandedDataRule && !hasDeterministicStudent) {
        const result = buildExpandedDataDeterministicResult(merged, expandedDataRule);
        if (result) {
          result.confidence = 0.93;
          result.intent = intent.name || 'general';
          result.intent_confidence = Number((intent.confidence || 0).toFixed(2));
          result.cache_hit = false;
          result.adaptive_profile = {
            preferred_style: feedbackProfile.preferredStyle,
            negative: feedbackProfile.negative,
            positive: feedbackProfile.positive,
            clarity_need: feedbackProfile.clarityNeed,
            detail_need: feedbackProfile.detailNeed
          };
          result.summary = polishUserFacingTextField(String(result.summary || ''));
          if (result.insight) result.insight = polishUserFacingTextField(String(result.insight));
          attachRouteDebug(result, intentBeforeRegistry, intent, routeSlots, 'expanded_data:' + String(expandedDataRule.type || ''));
          appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
          appendTabMessage(store, userId, tabId, 'assistant', String(result.summary || ''));
          writeStore(store);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(enrichAiChatResultPayload(result)));
          return;
        }
      }

      if (
        llmParsedQuery &&
        llmParsedQuery.requires_clarification &&
        String((llmParsedQuery && llmParsedQuery.clarification_question) || '').trim() &&
        !hasDeterministicStudent
      ) {
        const question = toVietnameseClarificationIfNeeded(
          String(llmParsedQuery.clarification_question || '').trim(),
          userDisplayName
        );
        const result = {
          type: 'info',
          summary: polishUserFacingTextField(question),
          targets: [],
          requires_confirmation: true,
          insight: '',
          next_question: question,
          actions: ['Trả lời rõ thêm phạm vi: thời gian/lớp/ngưỡng để em lọc chính xác']
        };
        result.confidence = Number(Math.max(0.45, Math.min(0.75, Number(intent.confidence || 0))).toFixed(2));
        result.intent = intent.name || 'general';
        result.intent_confidence = Number((intent.confidence || 0).toFixed(2));
        result.cache_hit = false;
        result.adaptive_profile = {
          preferred_style: feedbackProfile.preferredStyle,
          negative: feedbackProfile.negative,
          positive: feedbackProfile.positive,
          clarity_need: feedbackProfile.clarityNeed,
          detail_need: feedbackProfile.detailNeed
        };
        appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
        appendTabMessage(store, userId, tabId, 'assistant', String(result.summary || ''));
        writeStore(store);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enrichAiChatResultPayload(result)));
        return;
      }

      if (!hasConfiguredOpenAIKey()) {
        if (
          intent.name === 'general' &&
          !isLikelyDataScopedRequest(effectiveUserMessage) &&
          isSmallTalk(effectiveUserMessage)
        ) {
          const result = buildAutoSmallTalkResult(effectiveUserMessage, userDisplayName);
          result.confidence = 0.96;
          result.intent = 'general';
          result.intent_confidence = Number((intent.confidence || 0).toFixed(2));
          result.cache_hit = false;
          result.adaptive_profile = {
            preferred_style: feedbackProfile.preferredStyle,
            negative: feedbackProfile.negative,
            positive: feedbackProfile.positive,
            clarity_need: feedbackProfile.clarityNeed,
            detail_need: feedbackProfile.detailNeed
          };
          result.summary = polishUserFacingTextField(String(result.summary || ''));
          if (result.insight) result.insight = polishUserFacingTextField(String(result.insight));
          appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
          appendTabMessage(store, userId, tabId, 'assistant', String(result.summary || ''));
          writeStore(store);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(enrichAiChatResultPayload(result)));
          return;
        }
        const result = {
          type: 'warning',
          summary:
            'Server chưa thấy OpenAI API key hợp lệ trong scripts/server.js hoặc .env.local, nên chưa gửi request tới OpenAI. Câu này không match rule dữ liệu cố định nên không trả lời đủ được. Đây không phải lỗi mạng hay OpenAI từ chối key — request chưa được gửi đi.',
          targets: [],
          requires_confirmation: true,
          insight:
            'Cách xử lý: trên đúng máy chạy `/ai-chat`, đặt OPENAI_API_KEY trong `.env.local` hoặc trong `scripts/server.js`, rồi khởi động lại tiến trình Node. Kiểm tra log khi start có dòng \'OpenAI API key: da cau hinh\'. Key dính BOM/ngoặc sẽ được chuẩn hóa tự động.',
          next_question:
            peerNameVocativePrefix(userDisplayName) +
            'muốn em tiếp tục lọc theo lớp, theo ngày hay theo ngưỡng cụ thể?',
          actions: [
            'Điền OPENAI_API_KEY trong .env.local hoặc scripts/server.js rồi restart server',
            'Mở tab Điểm danh/Học phí để nạp context dữ liệu'
          ],
          openai_configured: false,
          openai_block_reason: 'no_valid_key_in_node_process'
        };
        result.confidence = 0.86;
        result.intent = intent.name || 'general';
        result.intent_confidence = Number((intent.confidence || 0).toFixed(2));
        result.cache_hit = false;
        result.adaptive_profile = {
          preferred_style: feedbackProfile.preferredStyle,
          negative: feedbackProfile.negative,
          positive: feedbackProfile.positive,
          clarity_need: feedbackProfile.clarityNeed,
          detail_need: feedbackProfile.detailNeed
        };
        appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
        appendTabMessage(store, userId, tabId, 'assistant', String(result.summary || ''));
        writeStore(store);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enrichAiChatResultPayload(result)));
        return;
      }

      const systemPrompt = buildSystemPrompt(userDisplayName);
      const baseIntentGuide =
        buildIntentGuidance(intent) +
        '\n' +
        buildIntentToneGuide(intent) +
        '\nINTENT_CONFIDENCE=' +
        String(intent.confidence || 0) +
        '\nIf intent_confidence < 0.55, ask one concise clarifying question before hard conclusion.';
      const plannerPrompt = buildPlannerPrompt(contextText, pipelineUserMessage, baseIntentGuide, userDisplayName);
      const plannerRes = await goiOpenAIEx(systemPrompt, plannerPrompt, {
        temperature: 0.15,
        max_tokens: 280
      });
      const plannerRaw = extractOpenAIText(plannerRes);
      const plan = parsePlannerOutput(plannerRaw);
      const plannerGuide = buildPlannerGuidanceBlock(plan);

      const userPrompt = buildUserPrompt(
        contextText,
        recent,
        relevant,
        pipelineUserMessage,
        baseIntentGuide + '\n' + plannerGuide,
        feedbackGuide,
        userDisplayName
      );
      const aiRes = await goiOpenAIEx(systemPrompt, userPrompt, {
        temperature: 0.3,
        max_tokens: 1000
      });
      const rawText = extractOpenAIText(aiRes);
      if (!rawText) {
        throw new Error('OpenAI trả về rỗng (không có content).');
      }

      const result = sanitizeAiResult(normalizeOutput(rawText), intent);
      const confidence = computeConfidence(plan, intent, result, contextText);
      if (needsDataGroundingGuard(result, contextText) && !hasDeterministicStudent) {
        result.summary =
          String(result.summary || '').trim() +
          ' (Lưu ý: một số số liệu cần đối chiếu thêm để chốt chính xác tuyệt đối.)';
        result.type = 'warning';
        result.requires_confirmation = true;
      }
      const followup = confidence < 0.67 ? buildFollowupQuestion(intent, plan, pipelineUserMessage, userDisplayName) : '';
      if (followup && !hasDeterministicStudent) {
        result.summary = String(result.summary || '').trim() + '\n' + followup;
      }
      result.confidence = Number(confidence.toFixed(2));
      result.intent = intent.name;
      result.intent_confidence = Number((intent.confidence || 0).toFixed(2));
      result.cache_hit = false;
      result.adaptive_profile = {
        preferred_style: feedbackProfile.preferredStyle,
        negative: feedbackProfile.negative,
        positive: feedbackProfile.positive,
        clarity_need: feedbackProfile.clarityNeed,
        detail_need: feedbackProfile.detailNeed
      };

      if (result.targets.length > 0 && !result.insight) {
        result.insight = 'Có ' + result.targets.length + ' mục cần xử lý ưu tiên.';
      }
      if (!Array.isArray(result.actions)) {
        result.actions = [];
      }
      if (result.actions.length > 3) result.actions = result.actions.slice(0, 3);
      if (!result.next_question && followup && !hasDeterministicStudent) {
        result.next_question = followup;
      }
      if (intent.name === 'revenue_compare') {
        const fixed = enforceRevenueAnswer(result, contextText, userDisplayName);
        Object.assign(result, fixed);
      }
      if (
        (intent.name === 'student_360' || intent.name === 'debt_ops') &&
        !hasDeterministicStudent
      ) {
        const fixedDebt = enforceStudentDebtAnswer(result, contextText);
        Object.assign(result, fixedDebt);
      }
      if (confidence < LOW_CONFIDENCE_THRESHOLD && !hasDeterministicStudent) {
        Object.assign(result, forceClarifyingResponse(result, intent, pipelineUserMessage, userDisplayName));
      }
      const qaScore = actionabilityScore(result);
      if (qaScore < QUALITY_REWRITE_THRESHOLD && !hasDeterministicStudent) {
        const rewritePrompt = buildQualityRewritePrompt(result, pipelineUserMessage, intent.name, userDisplayName);
        const rewriteRes = await goiOpenAIEx(systemPrompt, rewritePrompt, {
          temperature: 0.2,
          max_tokens: 520
        });
        const rewriteText = extractOpenAIText(rewriteRes);
        const rewritten = sanitizeAiResult(normalizeOutput(rewriteText), intent);
        if (actionabilityScore(rewritten) >= qaScore) {
          Object.assign(result, rewritten);
          result.confidence = Number(confidence.toFixed(2));
          result.intent = intent.name;
          result.intent_confidence = Number((intent.confidence || 0).toFixed(2));
          result.cache_hit = false;
        }
      }

      if (hasDeterministicStudent) {
        result.summary = deterministicStudent.summary;
        result.type = 'info';
        result.requires_confirmation = false;
        result.insight = '';
        result.actions = [];
        result.next_question = '';
        const scoredOnce = findStudentCandidatesWithScore(pipelineUserMessage, merged.students);
        let stu = scoredOnce.length ? scoredOnce[0].student : null;
        if (!stu && deterministicStudent && deterministicStudent.metrics && deterministicStudent.metrics.sid) {
          const sid = deterministicStudent.metrics.sid;
          stu =
            toArraySafe(merged.students).find((x) => String((x && x.id) || '') === String(sid)) || null;
        }
        if (stu) {
          const pn = String(stu && stu.phone ? stu.phone : '');
          const blurb =
            (deterministicStudent && deterministicStudent.targetBlurb) ||
            String(deterministicStudent.summary || '').replace(/\n/g, ' ').slice(0, 320);
          result.targets = [
            {
              name: String((stu && stu.name) || 'Không rõ'),
              phone: pn,
              zalo_link: '',
              message: blurb,
              note: pn ? '' : 'Thiếu SĐT'
            }
          ];
        }
      }

      if (intent.name === 'student_360' || intent.name === 'debt_ops') {
        fillPlaceholderTargetMessages(result, contextText, userDisplayName);
      }

      if (!hasDeterministicStudent) {
        result.summary = polishUserFacingTextField(String(result.summary || ''));
        if (result.insight) result.insight = polishUserFacingTextField(String(result.insight));
      }
      enforceAdminAddressingInResult(result, userDisplayName);
      attachRouteDebug(
        result,
        intentBeforeRegistry,
        intent,
        routeSlots,
        hasDeterministicStudent ? 'student_360_deterministic' : 'planner_llm'
      );

      appendTabMessage(store, userId, tabId, 'user', effectiveUserMessage);
      appendTabMessage(
        store,
        userId,
        tabId,
        'assistant',
        (result.summary || '') + (plan && plan.reasoning_steps && plan.reasoning_steps.length ? '\n[plan] ' + plan.reasoning_steps[0] : '')
      );
      if (confidence >= 0.78) {
        feedbackProfile.positive = Number(feedbackProfile.positive || 0) + 1;
      } else if (confidence <= 0.45) {
        feedbackProfile.negative = Number(feedbackProfile.negative || 0) + 1;
      }
      writeStore(store);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(enrichAiChatResultPayload(result)));
    } catch (err) {
      console.error('Loi:', err && err.message ? err.message : err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify(
          enrichAiChatResultPayload({
            error: err && err.message ? err.message : 'Unknown error'
          })
        )
      );
    }
  });
});

server.listen(PORT, () => {
  console.log('AI Server v2 chay tai cong ' + PORT + ' | server_build=' + SERVER_BUILD);
  if (!hasConfiguredOpenAIKey()) {
    console.warn(
      '[server] OPENAI_API_KEY chua hop le (can sk-... trong .env.local hoac scripts/server.js) -> khong goi duoc OpenAI cho planner/chat day du.'
    );
  } else {
    const k = getResolvedOpenAiKey();
    const mask = k.length > 12 ? k.slice(0, 7) + '...' + k.slice(-4) : '(ok)';
    console.log('[server] OpenAI API key: da cau hinh (' + mask + '), goi api.openai.com khi can.');
  }
  if (!hasConfiguredSupabase()) {
    console.warn('[server] Supabase URL/KEY chua hop le -> fallback data co the rong neu client khong gui context.');
  }
});
