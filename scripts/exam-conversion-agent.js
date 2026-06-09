#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const {
  collectImageSlots,
  normalizeText,
  validateExamJson
} = require('../web/eng10-online-exam.js');

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_GEMINI_MODEL = DEFAULT_MODEL;
const DEFAULT_NVIDIA_MODEL = 'mistralai/mistral-medium-3.5-128b';
const DEFAULT_NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_NVIDIA_MAX_ATTEMPTS = 6;
const DEFAULT_NVIDIA_RETRY_DELAY_MS = 5000;
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MAX_ATTEMPTS = 4;
const DEFAULT_OPENAI_RETRY_DELAY_MS = 2000;
const DEFAULT_RUN_DIR = '_exam_agent_runs';
const DEFAULT_EXPECTED_QUESTION_COUNT = 50;
const MAX_GEMINI_TEXT_CHARS = 180000;
const MIN_EXAM_TEXT_CHARS = 500;
const MIN_ANSWER_TEXT_CHARS = 20;

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

function loadDefaultEnv() {
  const root = path.resolve(__dirname, '..');
  loadEnvFile(path.join(root, '.env.local'));
  loadEnvFile(path.join(root, '.env.r2.local'));
  loadEnvFile(path.join(process.cwd(), '.env.local'));
  loadEnvFile(path.join(process.cwd(), '.env.r2.local'));
}

function envValue(env, names) {
  const source = env || process.env;
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    if (source[name]) return source[name];
  }
  const entries = Object.entries(source);
  for (const name of list) {
    const wanted = String(name).toLowerCase();
    const found = entries.find(([key, value]) => key.toLowerCase() === wanted && value);
    if (found) return found[1];
  }
  return '';
}

function normalizeAiProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (['openai', 'open-ai', 'chatgpt'].includes(provider)) return 'openai';
  if (['nvidia', 'nim'].includes(provider)) return 'nvidia';
  if (['gemini', 'google'].includes(provider)) return 'gemini';
  return '';
}

function detectAiProvider(env = process.env) {
  const configured = normalizeAiProvider(envValue(env, 'EXAM_AGENT_PROVIDER'));
  if (configured) return configured;
  if (envValue(env, 'OPENAI_API_KEY')) return 'openai';
  if (envValue(env, 'NVIDIA_API_KEY')) return 'nvidia';
  return 'gemini';
}

function defaultModelForProvider(provider) {
  const normalized = normalizeAiProvider(provider);
  if (normalized === 'openai') return DEFAULT_OPENAI_MODEL;
  if (normalized === 'nvidia') return DEFAULT_NVIDIA_MODEL;
  return DEFAULT_GEMINI_MODEL;
}

function resolveAiProvider(options = {}, env = process.env) {
  return normalizeAiProvider(options.provider) || detectAiProvider(env);
}

function resolveAiModel(provider, options = {}, env = process.env) {
  const envModel = String(envValue(env, 'EXAM_AGENT_MODEL') || '').trim();
  if (envModel) return envModel;
  const optionModel = String(options.model || '').trim();
  if (optionModel && !(normalizeAiProvider(provider) === 'nvidia' && optionModel === DEFAULT_GEMINI_MODEL)) {
    return optionModel;
  }
  return defaultModelForProvider(provider);
}

function positiveInt(value, fallback, min = 1, max = 999999) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function resolveNvidiaMaxAttempts(options = {}, env = process.env) {
  return positiveInt(options.nvidiaMaxAttempts || envValue(env, 'NVIDIA_MAX_ATTEMPTS'), DEFAULT_NVIDIA_MAX_ATTEMPTS, 1, 20);
}

function resolveNvidiaRetryDelayMs(options = {}, env = process.env) {
  return positiveInt(options.nvidiaRetryDelayMs || envValue(env, 'NVIDIA_RETRY_DELAY_MS'), DEFAULT_NVIDIA_RETRY_DELAY_MS, 0, 120000);
}

function parseArgs(argv = process.argv.slice(2)) {
  const provider = detectAiProvider(process.env);
  const envModel = envValue(process.env, 'EXAM_AGENT_MODEL');
  const out = {
    source: 'Thanh Hoa',
    level: 'vao10',
    limit: 20,
    mode: 'dry-run',
    expectedQuestionCount: DEFAULT_EXPECTED_QUESTION_COUNT,
    provider,
    model: envModel || defaultModelForProvider(provider),
    runDir: DEFAULT_RUN_DIR,
    promptFile: '',
    examId: '',
    minExamTextChars: MIN_EXAM_TEXT_CHARS,
    minAnswerTextChars: MIN_ANSWER_TEXT_CHARS
  };
  let modelFromArg = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    if (key === 'source') out.source = next;
    else if (key === 'level') out.level = next;
    else if (key === 'limit') out.limit = Math.max(1, Number(next) || out.limit);
    else if (key === 'mode') out.mode = next;
    else if (key === 'expected-count') out.expectedQuestionCount = Math.max(0, Number(next) || 0);
    else if (key === 'provider') out.provider = normalizeAiProvider(next) || next;
    else if (key === 'model') {
      out.model = next;
      modelFromArg = true;
    }
    else if (key === 'run-dir') out.runDir = next;
    else if (key === 'prompt-file') out.promptFile = next;
    else if (key === 'exam-id') out.examId = next;
    else if (key === 'min-exam-text') out.minExamTextChars = Math.max(0, Number(next) || 0);
    else if (key === 'min-answer-text') out.minAnswerTextChars = Math.max(0, Number(next) || 0);
  }
  if (!modelFromArg && !envModel) out.model = defaultModelForProvider(out.provider);
  if (!['dry-run', 'draft', 'publish'].includes(out.mode)) {
    throw new Error('mode must be dry-run, draft, or publish');
  }
  return out;
}

function maybeRepairMojibake(value) {
  const text = String(value || '');
  if (!/[ÃÂÄÅÆâ]/.test(text)) return text;
  try {
    return Buffer.from(text, 'latin1').toString('utf8');
  } catch (_err) {
    return text;
  }
}

function displayTitle(row) {
  return maybeRepairMojibake(row && (row.title || row.id) || 'exam').trim();
}

function normalizeSourceText(value) {
  return normalizeText(maybeRepairMojibake(value))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowHaystack(row) {
  return [
    row && row.title,
    row && row.province,
    row && row.exam_code,
    row && row.object_key,
    row && row.storage_path,
    row && row.answer_object_key,
    row && row.answer_path
  ].map(x => String(x || '')).join(' ');
}

function sourceMatchesThanhHoa(row) {
  const hay = normalizeSourceText(rowHaystack(row));
  if (/\bthanh hoa\b/.test(hay)) return true;
  const code = normalizeSourceText(row && row.exam_code);
  return /\bth\s*0*\d{1,3}\b/.test(code);
}

function inferThanhHoaExamNumber(row) {
  const raw = rowHaystack(row);
  const patterns = [
    /\bTH\s*0*(\d{1,3})\b/i,
    /\bDe\s+TH\s*0*(\d{1,3})\b/i,
    /\bDe\s*0*(\d{3})\b/i,
    /\b0*(\d{3})\b/
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const value = match ? Number(match[1]) : 0;
    if (value >= 1 && value <= 500) return value;
  }
  return null;
}

function cleanAnswerValue(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[;,.]+$/g, '')
    .trim();
}

function extractAnswerKeys(text) {
  const keys = new Map();
  const normalized = maybeRepairMojibake(text).replace(/\r/g, '\n');
  const letterPattern = /(?:c[aâ]u|question|q)?\s*0*([1-9]\d?)\s*[:.)\-\s]+([A-D])\b/gi;
  let match;
  while ((match = letterPattern.exec(normalized))) {
    const index = Number(match[1]);
    if (index >= 1 && index <= 50 && !keys.has(index)) keys.set(index, match[2].toUpperCase());
  }
  for (const line of normalized.split(/\n+/)) {
    const markers = [...line.matchAll(/(?:^|[\t ]+)0*([1-9]\d?)\s*[:.)]\s*/g)];
    if (markers.length > 1) {
      for (let i = 0; i < markers.length; i += 1) {
        const index = Number(markers[i][1]);
        if (index < 1 || index > 50 || keys.has(index)) continue;
        const start = markers[i].index + markers[i][0].length;
        const end = i + 1 < markers.length ? markers[i + 1].index : line.length;
        const value = cleanAnswerValue(line.slice(start, end));
        if (value && !/^(part|section|page)\b/i.test(value)) keys.set(index, value);
      }
      continue;
    }
    const clean = line.trim();
    if (!clean) continue;
    const textMatch = clean.match(/^(?:c[aâ]u\s*)?0*([1-9]\d?)\s*[:.)-]\s*(.{2,160})$/i);
    if (!textMatch) continue;
    const index = Number(textMatch[1]);
    if (index < 1 || index > 50 || keys.has(index)) continue;
    const value = cleanAnswerValue(textMatch[2]);
    if (value && !/^(part|section|page)\b/i.test(value)) keys.set(index, value);
  }
  return keys;
}

function jsonStringValues(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => jsonStringValues(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => jsonStringValues(item, out));
  return out;
}

function hasForbiddenField(value, fieldName) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => hasForbiddenField(item, fieldName));
  if (Object.prototype.hasOwnProperty.call(value, fieldName)) return true;
  return Object.values(value).some(item => hasForbiddenField(item, fieldName));
}

function answerLetter(value) {
  const text = String(value || '').trim().toUpperCase();
  const match = text.match(/^([A-D])(?:\b|[.)\s-])/);
  return match ? match[1] : '';
}

function answerComparable(value) {
  return normalizeSourceText(String(value || '').replace(/^[A-D][.)\s-]+/i, ''));
}

function cloneGeneratedJson(input) {
  if (typeof input === 'string') return JSON.parse(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  return JSON.parse(JSON.stringify(input));
}

function normalizeGeneratedOptions(options) {
  if (Array.isArray(options)) return options;
  if (!options || typeof options !== 'object') return options;
  const keys = Object.keys(options).sort((a, b) => String(a).localeCompare(String(b)));
  return keys
    .map(key => {
      const label = String(key || '').trim().toUpperCase();
      const value = String(options[key] ?? '').trim();
      return label && value ? `${label}. ${value.replace(/^[A-D][.)\s-]+/i, '')}` : value;
    })
    .filter(Boolean);
}

function stripSimpleHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, '');
}

function inferRewritePrompt(question, id) {
  const text = stripSimpleHtml(question).trim();
  const keyword = text.match(/\(([A-Z][A-Z0-9\s/-]{1,30})\)\s*$/);
  if (keyword && keyword[1]) return keyword[1].trim().replace(/\s+/g, ' ');
  return `REWRITE_${id}`;
}

function rewritePromptNeedsRepair(prompt, question) {
  const cleanPrompt = stripSimpleHtml(prompt).trim();
  if (!cleanPrompt) return true;
  return normalizeSourceText(cleanPrompt) === normalizeSourceText(stripSimpleHtml(question));
}

function decodeBasicHtmlEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function plainRichText(value) {
  return decodeBasicHtmlEntities(stripSimpleHtml(value)).replace(/\s+/g, ' ').trim();
}

function normalizeRichComparable(value) {
  return normalizeSourceText(plainRichText(value));
}

function richOptionKey(value) {
  return normalizeRichComparable(String(value || '').replace(/^\s*[A-D]\s*[.)-]?\s*/i, ''));
}

function hasAllowedRichMarkup(value) {
  return /<(?:strong|u)\b/i.test(String(value || ''));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function richSegmentsFromSource(sourceText, tagName) {
  const source = String(sourceText || '');
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const seen = new Set();
  const segments = [];
  let match;
  while ((match = re.exec(source))) {
    const body = String(match[1] || '').trim();
    const plain = plainRichText(body);
    const key = normalizeSourceText(plain);
    if (!key || seen.has(`${tagName}:${key}`)) continue;
    if (plain.length < 2 || plain.length > 80) continue;
    seen.add(`${tagName}:${key}`);
    segments.push({
      plain,
      rich: `<${tagName}>${body}</${tagName}>`,
      before: plainRichText(source.slice(Math.max(0, match.index - 160), match.index)),
      after: plainRichText(source.slice(match.index + match[0].length, match.index + match[0].length + 160))
    });
  }
  return segments;
}

function textTail(value, length = 44) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? text.slice(-length).replace(/^\S*\s*/, '') : text;
}

function textHead(value, length = 44) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? text.slice(0, length).replace(/\s+\S*$/, '') : text;
}

function flexibleTextPattern(value) {
  return escapeRegExp(String(value || '').trim()).replace(/\s+/g, '\\s+');
}

function restoreSegmentWithContext(text, segment) {
  const source = String(text || '');
  const plainPattern = flexibleTextPattern(segment.plain);
  const before = textTail(segment.before);
  const after = textHead(segment.after);
  const candidates = [];
  if (before && after) candidates.push(new RegExp(`(${flexibleTextPattern(before)}\\s*)(${plainPattern})(?=\\s*${flexibleTextPattern(after)})`, 'i'));
  if (before) candidates.push(new RegExp(`(${flexibleTextPattern(before)}\\s*)(${plainPattern})(?=$|[^<\\w])`, 'i'));
  if (after) candidates.push(new RegExp(`(^|[^>\\w])(${plainPattern})(?=\\s*${flexibleTextPattern(after)})`, 'i'));
  for (const re of candidates) {
    if (re.test(source)) return source.replace(re, (_full, prefix) => `${prefix}${segment.rich}`);
  }
  return source;
}

function restoreSegment(text, segment) {
  const source = String(text || '');
  if (!source || !segment || !segment.plain || !segment.rich) return source;
  if (normalizeRichComparable(source).indexOf(normalizeSourceText(segment.plain)) < 0) return source;
  if (source.includes(segment.rich)) return source;
  const contextual = restoreSegmentWithContext(source, segment);
  if (contextual !== source) return contextual;
  if (segment.plain.length <= 3) return source;
  const re = new RegExp(`(^|[^>\\w])(${escapeRegExp(segment.plain)})(?=$|[^<\\w])`, 'i');
  if (!re.test(source)) return source;
  return source.replace(re, (_full, prefix) => `${prefix}${segment.rich}`);
}

function sourceOptionMap(sourceText) {
  const byLetterAndText = new Map();
  const byText = new Map();
  for (const line of String(sourceText || '').split(/\r?\n/)) {
    if (!hasAllowedRichMarkup(line)) continue;
    const matches = [...line.matchAll(/(?:^|[\s\t])([A-D])\.\s*([\s\S]*?)(?=(?:\s+[A-D]\.\s)|$)/gi)];
    for (const match of matches) {
      const letter = String(match[1] || '').toUpperCase();
      const body = String(match[2] || '').trim();
      if (!letter || !body || !hasAllowedRichMarkup(body)) continue;
      const rich = `${letter}. ${body}`;
      const key = richOptionKey(rich);
      if (!key) continue;
      byLetterAndText.set(`${letter}:${key}`, rich);
      if (!byText.has(key)) byText.set(key, rich);
    }
  }
  return { byLetterAndText, byText };
}

function restoreOptionMarkup(option, optionMaps) {
  const value = String(option || '');
  if (!value || hasAllowedRichMarkup(value)) return value;
  const letter = (value.match(/^\s*([A-D])\s*[.)-]?/i) || [])[1]?.toUpperCase() || '';
  const key = richOptionKey(value);
  if (!key) return value;
  return (letter && optionMaps.byLetterAndText.get(`${letter}:${key}`)) || optionMaps.byText.get(key) || value;
}

function restoreRichTextMarkersFromSource(input, sourceText) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const exam = cloneGeneratedJson(input);
  const strongSegments = richSegmentsFromSource(sourceText, 'strong');
  const optionMaps = sourceOptionMap(sourceText);
  const sourceKeys = Object.keys(exam).filter(key => (
    key === 'passage' ||
    key === 'fill_passage' ||
    /^fill_passage_\d+$/i.test(key)
  ));
  for (const key of sourceKeys) {
    if (typeof exam[key] !== 'string') continue;
    for (const segment of strongSegments) {
      exam[key] = restoreSegment(exam[key], segment);
    }
  }
  if (Array.isArray(exam.questions)) {
    exam.questions = exam.questions.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
      const q = { ...raw };
      if (Array.isArray(q.options)) q.options = q.options.map(option => restoreOptionMarkup(option, optionMaps));
      return q;
    });
  }
  return exam;
}

function normalizeGeneratedExamJson(input) {
  const warnings = [];
  const exam = cloneGeneratedJson(input);
  if (!exam || typeof exam !== 'object' || Array.isArray(exam)) return { exam: input, warnings };
  if (!Array.isArray(exam.questions)) return { exam, warnings };

  exam.questions = exam.questions.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const q = { ...raw };
    const id = q.id === undefined || q.id === null || String(q.id).trim() === '' ? index + 1 : q.id;
    const type = String(q.type || '').trim();
    q.id = id;
    if (q.options && !Array.isArray(q.options)) {
      q.options = normalizeGeneratedOptions(q.options);
      warnings.push(`AUTO_NORMALIZED_OPTIONS:${id}`);
    }
    if (type === 'fill_blank' && !String(q.blank_id || '').trim()) {
      q.blank_id = `blank_${id}`;
      warnings.push(`AUTO_FILLED_BLANK_ID:${id}`);
    }
    if (type === 'sentence_rewrite' && rewritePromptNeedsRepair(q.prompt, q.question || q.answer)) {
      q.prompt = inferRewritePrompt(q.question || q.answer, id);
      warnings.push(`AUTO_FILLED_PROMPT:${id}`);
    }
    return q;
  });

  return { exam, warnings };
}

function evaluateQualityGate(input, options = {}) {
  const mode = options.mode || 'draft';
  const expectedQuestionCount = Number(options.expectedQuestionCount || 0);
  const answerKeys = options.answerKeys instanceof Map ? options.answerKeys : new Map();
  const hardErrors = [];
  const publishBlockers = [];
  const warnings = [];
  let exam = null;
  const normalized = normalizeGeneratedExamJson(input);
  warnings.push(...normalized.warnings);

  try {
    exam = validateExamJson(normalized.exam);
  } catch (err) {
    hardErrors.push(`SCHEMA_INVALID: ${err && err.message || err}`);
    return { ok: false, canPublish: false, errors: hardErrors, warnings, exam: normalized.exam || null, imageSlots: [] };
  }

  const strings = jsonStringValues(exam);
  if (strings.some(s => /placeholder|option\s*1|kh[oô]ng c[oó] d[uữ]\s*li[eệ]u|\(khong co du lieu de\)/i.test(normalizeSourceText(s)))) {
    hardErrors.push('PLACEHOLDER_CONTENT');
  }
  if (strings.some(s => /\[blank[_\s-]*\d+\]/i.test(s) || /\*{2,}/.test(s))) {
    hardErrors.push('FORBIDDEN_BLANK_OR_MARKDOWN');
  }
  if (strings.some(s => /<(?!\/?(strong|u)\b)[^>]+>/i.test(s))) {
    hardErrors.push('UNSUPPORTED_HTML_TAG');
  }
  if (hasForbiddenField(exam, 'answer_alt')) {
    hardErrors.push('FORBIDDEN_FIELD_ANSWER_ALT');
  }
  if (expectedQuestionCount && exam.questions.length !== expectedQuestionCount) {
    hardErrors.push(`QUESTION_COUNT_MISMATCH:${exam.questions.length}/${expectedQuestionCount}`);
  }

  const questionIds = new Set(exam.questions.map(q => String(q.id)));
  for (const q of exam.questions) {
    if (!String(q.explanation || '').trim()) hardErrors.push(`EXPLANATION_MISSING:${q.id}`);
    if (q.type === 'multiple_choice' && (!Array.isArray(q.options) || q.options.length < 4)) {
      hardErrors.push(`MCQ_OPTIONS_INCOMPLETE:${q.id}`);
    }
    const expected = answerKeys.get(Number(q.id));
    if (expected) {
      const expectedLetter = answerLetter(expected);
      if (expectedLetter && q.type === 'multiple_choice' && answerLetter(q.answer) !== expectedLetter) {
        hardErrors.push(`ANSWER_KEY_MISMATCH:${q.id}`);
      } else if (!expectedLetter && answerComparable(expected) && answerComparable(q.answer) && answerComparable(expected) !== answerComparable(q.answer)) {
        warnings.push(`ANSWER_TEXT_DIFFERS:${q.id}`);
      }
    }
  }

  const pageIds = [];
  for (const page of exam.pages || []) {
    for (const id of Array.isArray(page.question_ids) ? page.question_ids : []) pageIds.push(String(id));
  }
  const missingPageIds = pageIds.filter(id => !questionIds.has(id));
  if (missingPageIds.length) hardErrors.push(`PAGE_QUESTION_ID_MISSING:${missingPageIds.join(',')}`);

  if (expectedQuestionCount && answerKeys.size && answerKeys.size !== expectedQuestionCount) {
    hardErrors.push(`ANSWER_KEY_COUNT_MISMATCH:${answerKeys.size}/${expectedQuestionCount}`);
  }

  const imageSlots = collectImageSlots(exam);
  if (imageSlots.length) {
    const code = `IMAGE_SLOTS_NEED_UPLOAD:${imageSlots.length}`;
    if (mode === 'publish') publishBlockers.push(code);
    else warnings.push(code);
  }

  const ok = hardErrors.length === 0;
  const canPublish = mode === 'publish' && ok && publishBlockers.length === 0;
  return {
    ok,
    canPublish,
    errors: [...hardErrors, ...publishBlockers],
    warnings,
    exam,
    imageSlots
  };
}

const EXAM_JSON_SCHEMA = {
  type: 'object',
  properties: {
    exam_id: { type: 'string' },
    title: { type: 'string' },
    passage: { type: 'string' },
    passage_range: {
      type: 'object',
      properties: { from: { type: 'integer' }, to: { type: 'integer' } }
    },
    fill_passage: { type: 'string' },
    fill_passage_range: {
      type: 'object',
      properties: { from: { type: 'integer' }, to: { type: 'integer' } }
    },
    fill_passage_2: { type: 'string' },
    fill_passage_range_2: {
      type: 'object',
      properties: { from: { type: 'integer' }, to: { type: 'integer' } }
    },
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          source_key: { type: 'string' },
          question_ids: { type: 'array', items: { type: 'integer' } }
        },
        required: ['id', 'title', 'question_ids']
      }
    },
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          file_name: { type: 'string' },
          alt: { type: 'string' },
          caption: { type: 'string' }
        }
      }
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          display_id: { type: 'string' },
          type: { type: 'string', enum: ['multiple_choice', 'fill_blank', 'sentence_rewrite'] },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          blank_id: { type: 'string' },
          word_bank: { type: 'array', items: { type: 'string' } },
          prompt: { type: 'string' },
          answer: { type: 'string' },
          answer_display: { type: 'string' },
          explanation: { type: 'string' },
          images: { type: 'array', items: { type: 'object' } }
        },
        required: ['id', 'display_id', 'type', 'question', 'answer', 'explanation']
      }
    }
  },
  required: ['exam_id', 'title', 'pages', 'questions']
};

function buildGeminiRequestBody({ prompt }) {
  return {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: EXAM_JSON_SCHEMA
    }
  };
}

function responseTextFromGemini(data) {
  const parts = [];
  for (const candidate of Array.isArray(data && data.candidates) ? data.candidates : []) {
    for (const part of Array.isArray(candidate && candidate.content && candidate.content.parts) ? candidate.content.parts : []) {
      if (typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('\n').trim();
}

function parseJsonText(text, errorPrefix = 'AI') {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!raw) throw new Error(`${errorPrefix}_EMPTY_JSON`);
  try {
    return JSON.parse(raw);
  } catch (_err) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error(`${errorPrefix}_INVALID_JSON`);
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiError(status, message) {
  const text = String(message || '').toLowerCase();
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || text.includes('high demand');
}

async function callGemini({ apiKey, model, prompt, fetchImpl = fetch, sleep = sleepMs, maxAttempts = 3 }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY_REQUIRED');
  const cleanModel = String(model || DEFAULT_GEMINI_MODEL).trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`;
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  let lastMessage = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(buildGeminiRequestBody({ prompt, model: cleanModel }))
      });
    } catch (err) {
      lastMessage = String(err && err.message || err || 'fetch failed').slice(0, 240);
      if (attempt < attempts) {
        await sleep(1200 * attempt);
        continue;
      }
      throw new Error(`GEMINI_REQUEST_FAILED: ${lastMessage}`);
    }
    const data = await response.json().catch(() => null);
    if (response.ok) {
      const text = responseTextFromGemini(data);
      if (!text && attempt < attempts) {
        lastMessage = 'GEMINI_EMPTY_JSON';
        await sleep(1200 * attempt);
        continue;
      }
      return parseJsonText(text, 'GEMINI');
    }
    lastMessage = String((data && data.error && data.error.message) || `GEMINI_HTTP_${response.status}`).slice(0, 240);
    if (attempt < attempts && isRetryableGeminiError(response.status, lastMessage)) {
      await sleep(1200 * attempt);
      continue;
    }
    throw new Error(`GEMINI_REQUEST_FAILED: ${lastMessage}`);
  }
  throw new Error(`GEMINI_REQUEST_FAILED: ${lastMessage || 'UNKNOWN'}`);
}

function buildNvidiaRequestBody({ prompt, model, responseFormat = true }) {
  const body = {
    model: String(model || DEFAULT_NVIDIA_MODEL).trim(),
    messages: [
      {
        role: 'system',
        content: 'Return exactly one valid JSON object that matches the requested exam schema. Do not include markdown, comments, or extra text.'
      },
      {
        role: 'user',
        content: String(prompt || '')
      }
    ],
    temperature: 0.1,
    max_tokens: 24000
  };
  if (responseFormat) body.response_format = { type: 'json_object' };
  return body;
}

function responseTextFromNvidia(data) {
  const parts = [];
  for (const choice of Array.isArray(data && data.choices) ? data.choices : []) {
    if (choice && choice.message && typeof choice.message.content === 'string') parts.push(choice.message.content);
    else if (typeof (choice && choice.text) === 'string') parts.push(choice.text);
  }
  return parts.join('\n').trim();
}

function isRetryableNvidiaError(status, message) {
  const text = String(message || '').toLowerCase();
  return [408, 409, 429, 500, 502, 503, 504].includes(status)
    || text.includes('high demand')
    || text.includes('overload')
    || text.includes('temporar')
    || text.includes('timeout')
    || text.includes('rate limit');
}

async function callNvidia({
  apiKey,
  model,
  prompt,
  baseUrl = DEFAULT_NVIDIA_BASE_URL,
  fetchImpl = fetch,
  sleep = sleepMs,
  maxAttempts = DEFAULT_NVIDIA_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_NVIDIA_RETRY_DELAY_MS
}) {
  if (!apiKey) throw new Error('NVIDIA_API_KEY_REQUIRED');
  const cleanModel = String(model || DEFAULT_NVIDIA_MODEL).trim();
  const root = String(baseUrl || DEFAULT_NVIDIA_BASE_URL).replace(/\/+$/, '');
  const url = `${root}/chat/completions`;
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  const delayMs = Math.max(0, Number(retryDelayMs) || 0);
  let lastMessage = '';
  let useResponseFormat = true;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(buildNvidiaRequestBody({
          prompt,
          model: cleanModel,
          responseFormat: useResponseFormat
        }))
      });
    } catch (err) {
      lastMessage = String(err && err.message || err || 'fetch failed').slice(0, 240);
      if (attempt < attempts) {
        await sleep(delayMs * attempt);
        continue;
      }
      throw new Error(`NVIDIA_REQUEST_FAILED: ${lastMessage}`);
    }

    const data = await response.json().catch(() => null);
    if (response.ok) {
      const text = responseTextFromNvidia(data);
      if (!text && attempt < attempts) {
        lastMessage = 'NVIDIA_EMPTY_JSON';
        await sleep(delayMs * attempt);
        continue;
      }
      return parseJsonText(text, 'NVIDIA');
    }

    lastMessage = String(
      (data && data.error && (data.error.message || data.error)) ||
      (data && data.message) ||
      `NVIDIA_HTTP_${response.status}`
    ).slice(0, 240);
    if (useResponseFormat && response.status === 400 && /response_format|json_object|extra_forbidden|unsupported/i.test(lastMessage)) {
      useResponseFormat = false;
      if (attempt < attempts) continue;
    }
    if (attempt < attempts && isRetryableNvidiaError(response.status, lastMessage)) {
      await sleep(delayMs * attempt);
      continue;
    }
    throw new Error(`NVIDIA_REQUEST_FAILED: ${lastMessage}`);
  }
  throw new Error(`NVIDIA_REQUEST_FAILED: ${lastMessage || 'UNKNOWN'}`);
}

function buildOpenAiRequestBody({ prompt, model, responseFormat = true, maxTokens = true }) {
  const body = {
    model: String(model || DEFAULT_OPENAI_MODEL).trim(),
    messages: [
      {
        role: 'system',
        content: 'Return exactly one valid JSON object that matches the requested exam schema. Do not include markdown, comments, or extra text.'
      },
      {
        role: 'user',
        content: String(prompt || '')
      }
    ],
    temperature: 0.1
  };
  if (maxTokens) body.max_tokens = 24000;
  if (responseFormat) body.response_format = { type: 'json_object' };
  return body;
}

function responseTextFromOpenAi(data) {
  const parts = [];
  for (const choice of Array.isArray(data && data.choices) ? data.choices : []) {
    if (choice && choice.message && typeof choice.message.content === 'string') parts.push(choice.message.content);
    else if (typeof (choice && choice.text) === 'string') parts.push(choice.text);
  }
  return parts.join('\n').trim();
}

function isRetryableOpenAiError(status, message) {
  const text = String(message || '').toLowerCase();
  return [408, 409, 429, 500, 502, 503, 504].includes(status)
    || text.includes('overload')
    || text.includes('temporar')
    || text.includes('timeout')
    || text.includes('rate limit');
}

async function callOpenAi({
  apiKey,
  model,
  prompt,
  baseUrl = DEFAULT_OPENAI_BASE_URL,
  fetchImpl = fetch,
  sleep = sleepMs,
  maxAttempts = DEFAULT_OPENAI_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_OPENAI_RETRY_DELAY_MS
}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY_REQUIRED');
  const cleanModel = String(model || DEFAULT_OPENAI_MODEL).trim();
  const root = String(baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
  const url = `${root}/chat/completions`;
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  const delayMs = Math.max(0, Number(retryDelayMs) || 0);
  let lastMessage = '';
  let useResponseFormat = true;
  let useMaxTokens = true;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(buildOpenAiRequestBody({
          prompt,
          model: cleanModel,
          responseFormat: useResponseFormat,
          maxTokens: useMaxTokens
        }))
      });
    } catch (err) {
      lastMessage = String(err && err.message || err || 'fetch failed').slice(0, 240);
      if (attempt < attempts) {
        await sleep(delayMs * attempt);
        continue;
      }
      throw new Error(`OPENAI_REQUEST_FAILED: ${lastMessage}`);
    }

    const data = await response.json().catch(() => null);
    if (response.ok) {
      const text = responseTextFromOpenAi(data);
      if (!text && attempt < attempts) {
        lastMessage = 'OPENAI_EMPTY_JSON';
        await sleep(delayMs * attempt);
        continue;
      }
      return parseJsonText(text, 'OPENAI');
    }

    lastMessage = String(
      (data && data.error && (data.error.message || data.error)) ||
      (data && data.message) ||
      `OPENAI_HTTP_${response.status}`
    ).slice(0, 240);
    if (response.status === 400 && useResponseFormat && /response_format|json_object|unsupported/i.test(lastMessage)) {
      useResponseFormat = false;
      if (attempt < attempts) continue;
    }
    if (response.status === 400 && useMaxTokens && /max_tokens|max_completion_tokens|unsupported/i.test(lastMessage)) {
      useMaxTokens = false;
      if (attempt < attempts) continue;
    }
    if (attempt < attempts && isRetryableOpenAiError(response.status, lastMessage)) {
      await sleep(delayMs * attempt);
      continue;
    }
    throw new Error(`OPENAI_REQUEST_FAILED: ${lastMessage}`);
  }
  throw new Error(`OPENAI_REQUEST_FAILED: ${lastMessage || 'UNKNOWN'}`);
}

function renderAgentPrompt(templateText, row, pair) {
  const id = String(row && row.id || '').trim();
  const title = displayTitle(row) || 'De online';
  const localPair = row && row.localPair || {};
  const base = String(templateText || '')
    .replaceAll('__EXAM_ID__', id)
    .replaceAll('__EXAM_TITLE__', title)
    .replaceAll('THAY_BANG_ID', id)
    .replaceAll('THAY_BANG_TEN_DE', title)
    .replace(/\{\{\s*exam_id\s*\}\}/g, id)
    .replace(/\{\{\s*title\s*\}\}/g, title);
  const examText = String(pair && pair.examText || '').slice(0, MAX_GEMINI_TEXT_CHARS);
  const answerText = String(pair && pair.answerText || '').slice(0, MAX_GEMINI_TEXT_CHARS);
  const metadata = [
    'THONG TIN FILE:',
    `exam_file_id: ${id}`,
    `exam_title: ${title}`,
    `local_exam_code: ${String((pair && pair.examCode) || localPair.examCode || row && row.exam_code || '').trim()}`,
    `exam_file_name: ${String((pair && pair.examFileName) || localPair.examFileName || '').trim()}`,
    `answer_file_name: ${String((pair && pair.answerFileName) || localPair.answerFileName || '').trim()}`
  ];
  const formattingRules = [
    'QUY TAC BAO TOAN DINH DANG TU TOOL:',
    '- Van ban trich xuat co the chua <strong>...</strong> cho tu/cum tu in dam va <u>...</u> cho phan gach chan.',
    '- Khi dua cac doan/cau/lua chon vao JSON, phai giu nguyen cac tag <strong> va <u> nay.',
    '- Khong chuyen <strong>/<u> thanh markdown **text** hoac bo mat dinh dang.'
  ];
  return [
    base,
    '',
    ...formattingRules,
    '',
    ...metadata,
    '',
    'NOI DUNG DE THI DA TRICH XUAT:',
    examText,
    '',
    'NOI DUNG DAP AN DA TRICH XUAT:',
    answerText
  ].join('\n');
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function encodePath(value) {
  return String(value || '').replace(/^\/+/, '').split('/').map(encodeRfc3986).join('/');
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

function signR2Url(method, objectKey, env = process.env) {
  const accountId = env.R2_ACCOUNT_ID || '';
  const accessKeyId = env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY || '';
  const bucket = env.R2_BUCKET || 'mvklass-exam-files';
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) throw new Error('R2_NOT_CONFIGURED');
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const pathValue = `/${encodePath(bucket)}/${encodePath(objectKey)}`;
  const pairs = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', '300'],
    ['X-Amz-SignedHeaders', 'host']
  ].sort(([ak, av], [bk, bv]) => encodeRfc3986(ak).localeCompare(encodeRfc3986(bk)) || encodeRfc3986(av).localeCompare(encodeRfc3986(bv)));
  const canonicalQuery = pairs.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join('&');
  const canonicalRequest = [method, pathValue, canonicalQuery, `host:${host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hashHex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(secretAccessKey, dateStamp), stringToSign, 'hex');
  return `https://${host}${pathValue}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function getR2ObjectBytes(objectKey, env = process.env, fetchImpl = fetch) {
  if (!objectKey) throw new Error('R2_OBJECT_KEY_REQUIRED');
  const response = await fetchImpl(signR2Url('GET', objectKey, env));
  if (!response.ok) throw new Error(`R2_GET_FAILED_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function supabaseStorageLocation(pathValue, env = process.env) {
  const raw = String(pathValue || '').trim().replace(/^\/+/, '');
  const defaultBucket = (env.SUPABASE_EXAM_BUCKET || 'exam-files').trim();
  const parts = raw.split('/').filter(Boolean);
  if (parts.length > 1 && /^(exam-files|exam_files|mvklass-exam-files|documents|public)$/i.test(parts[0])) {
    return { bucket: parts[0], path: parts.slice(1).join('/') };
  }
  return { bucket: defaultBucket, path: raw };
}

async function getSupabaseStorageBytes(pathValue, env = process.env, fetchImpl = fetch) {
  const { url, key } = supabaseEnv(env);
  const { bucket, path: objectPath } = supabaseStorageLocation(pathValue, env);
  if (!bucket || !objectPath) throw new Error('SUPABASE_STORAGE_PATH_REQUIRED');
  const response = await fetchImpl(`${url}/storage/v1/object/${encodePath(bucket)}/${encodePath(objectPath)}`, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`
    }
  });
  if (!response.ok) throw new Error(`SUPABASE_STORAGE_GET_FAILED_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function examFileRefs(row) {
  const examObjectKey = String(row && row.object_key || '').trim().replace(/^\/+/, '');
  const answerObjectKey = String(row && row.answer_object_key || '').trim().replace(/^\/+/, '');
  const examStoragePath = String(row && row.storage_path || '').trim().replace(/^\/+/, '');
  const answerStoragePath = String(row && row.answer_path || '').trim().replace(/^\/+/, '');
  return {
    exam: examObjectKey
      ? { source: 'r2', ref: examObjectKey }
      : (examStoragePath ? { source: 'supabase', ref: examStoragePath } : null),
    answer: answerObjectKey
      ? { source: 'r2', ref: answerObjectKey }
      : (answerStoragePath ? { source: 'supabase', ref: answerStoragePath } : null)
  };
}

async function getExamFileBytes(fileRef, env = process.env, fetchImpl = fetch) {
  if (!fileRef || !fileRef.ref) throw new Error('FILE_REF_REQUIRED');
  if (fileRef.source === 'supabase') return await getSupabaseStorageBytes(fileRef.ref, env, fetchImpl);
  return await getR2ObjectBytes(fileRef.ref, env, fetchImpl);
}

function decodePdfLiteralText(value) {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = value[++i] || '';
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let j = 0; j < 2 && /[0-7]/.test(value[i + 1] || ''); j++) octal += value[++i];
      out += String.fromCharCode(parseInt(octal, 8));
    } else out += next;
  }
  return out;
}

function decodePdfHexText(value) {
  const clean = String(value || '').replace(/[^0-9a-f]/gi, '');
  if (clean.length < 2 || clean.length % 2) return '';
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
  if (bytes.length > 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) text += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return text;
  }
  return Buffer.from(bytes).toString('latin1');
}

function extractTextFromPdfSource(source) {
  const parts = [];
  const literalRegex = /\((?:\\.|[^\\()]){2,}\)\s*(?:Tj|'|"|TJ)/g;
  let literalMatch;
  while ((literalMatch = literalRegex.exec(source))) {
    const raw = literalMatch[0].replace(/\)\s*(?:Tj|'|"|TJ)\s*$/, '').slice(1);
    const decoded = decodePdfLiteralText(raw);
    if (/[A-Za-z0-9\u00c0-\u1ef9]/.test(decoded)) parts.push(decoded);
  }
  const hexRegex = /<([0-9a-fA-F\s]{6,})>\s*(?:Tj|'|"|TJ)/g;
  let hexMatch;
  while ((hexMatch = hexRegex.exec(source))) {
    const decoded = decodePdfHexText(hexMatch[1]);
    if (/[A-Za-z0-9\u00c0-\u1ef9]/.test(decoded)) parts.push(decoded);
  }
  return parts.join('\n');
}

function normalizeExtractedPdfText(text) {
  return maybeRepairMojibake(String(text || ''))
    .replace(/\u0000/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractPdfText(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.length < 4 || buffer.slice(0, 4).toString('latin1') !== '%PDF') throw new Error('PDF_SIGNATURE_INVALID');
  const source = buffer.toString('latin1');
  const parts = [extractTextFromPdfSource(source)];
  const streamRegex = /<<(?:.|\n|\r)*?\/FlateDecode(?:.|\n|\r)*?>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let streamMatch;
  while ((streamMatch = streamRegex.exec(source))) {
    try {
      const inflated = zlib.inflateSync(Buffer.from(streamMatch[1], 'latin1')).toString('latin1');
      parts.push(extractTextFromPdfSource(inflated));
    } catch (_err) {
      // Ignore compressed streams that are not plain zlib payloads.
    }
  }
  const extracted = normalizeExtractedPdfText(parts.join('\n'));
  if (extracted.length >= 80) return extracted;
  return normalizeExtractedPdfText(source.replace(/[^\x20-\x7e\u00c0-\u1ef9\r\n]+/g, ' '));
}

function supabaseEnv(env = process.env) {
  const url = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ENV_REQUIRED');
  return { url, key };
}

async function supabaseFetch(resource, options = {}, env = process.env, fetchImpl = fetch) {
  const { url, key } = supabaseEnv(env);
  const response = await fetchImpl(`${url}/rest/v1/${resource}`, {
    ...options,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text.trim() ? JSON.parse(text) : null;
  if (!response.ok) throw new Error((data && data.message) || `SUPABASE_HTTP_${response.status}`);
  return data;
}

function levelMatches(row, level) {
  const wanted = normalizeSourceText(level);
  if (!wanted || wanted === 'all') return true;
  const hay = normalizeSourceText([row && row.level, row && row.title, row && row.exam_code].join(' '));
  const rawLevel = String(row && row.level || '').trim().toLowerCase();
  if (wanted === 'vao10' || wanted === 'entrance10' || wanted === 'entrance 10') {
    if (rawLevel === 'university' || rawLevel === 'ielts') return false;
    return !/\b(thpt|qg|quoc gia|university|ielts)\b/.test(hay);
  }
  if (wanted === 'thpt' || wanted === 'university') return /\b(thpt|qg|quoc gia|university)\b/.test(hay);
  return hay.includes(wanted);
}

function filterConversionCandidates(rows, onlineRows = [], options = {}) {
  const onlineByExamId = new Map(
    (Array.isArray(onlineRows) ? onlineRows : []).map(row => [String(row && row.exam_file_id || ''), row])
  );
  return (Array.isArray(rows) ? rows : [])
    .filter(row => !options.examId || String(row.id) === String(options.examId))
    .filter(row => sourceMatchesThanhHoa(row))
    .filter(row => levelMatches(row, options.level))
    .filter(row => {
      const online = onlineByExamId.get(String(row && row.id || ''));
      return !online || String(online.status || 'draft') !== 'published';
    })
    .sort((a, b) => (inferThanhHoaExamNumber(a) || 9999) - (inferThanhHoaExamNumber(b) || 9999))
    .slice(0, Math.max(1, Number(options.limit || 20)));
}

async function listCandidatesFromSupabase(options, deps = {}) {
  const limit = Math.max(1, Number(options.limit || 20) * 4);
  const rows = await supabaseFetch(
    `exam_files?select=id,title,level,year,province,exam_code,category,storage_provider,object_key,storage_path,answer_object_key,answer_path,is_published&subject=eq.english&is_published=eq.true&category=neq.answer&limit=${limit}`,
    {},
    deps.env || process.env,
    deps.fetchImpl || fetch
  );
  const ids = (Array.isArray(rows) ? rows : []).map(row => row && row.id).filter(Boolean);
  let onlineRows = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (!chunk.length) continue;
    const encoded = chunk.map(id => `"${String(id).replace(/"/g, '')}"`).join(',');
    const data = await supabaseFetch(
      `exam_online_exams?select=exam_file_id,status,question_count&exam_file_id=in.(${encodeURIComponent(encoded)})`,
      {},
      deps.env || process.env,
      deps.fetchImpl || fetch
    );
    onlineRows = onlineRows.concat(Array.isArray(data) ? data : []);
  }
  return filterConversionCandidates(rows, onlineRows, options);
}

async function loadPromptTemplateFromSupabase(row, options, deps = {}) {
  if (options.promptFile) return fs.readFileSync(path.resolve(options.promptFile), 'utf8');
  const year = Number(row && row.year || 0) || new Date().getFullYear();
  const rows = await supabaseFetch(
    `exam_online_prompt_templates?select=id,province_key,province_label,year,template_text,is_active&is_active=eq.true&year=eq.${encodeURIComponent(year)}&order=province_label.asc`,
    {},
    deps.env || process.env,
    deps.fetchImpl || fetch
  );
  const match = (Array.isArray(rows) ? rows : []).find(tpl => normalizeSourceText([tpl.province_key, tpl.province_label].join(' ')).includes('thanh hoa'));
  if (!match || !String(match.template_text || '').trim()) throw new Error('THANH_HOA_PROMPT_TEMPLATE_NOT_FOUND');
  return match.template_text;
}

async function readExamPairTextFromR2(row, options, deps = {}) {
  const refs = examFileRefs(row);
  if (!refs.exam) throw new Error('EXAM_PDF_NOT_FOUND');
  if (!refs.answer) throw new Error('ANSWER_PDF_NOT_FOUND');
  const examBytes = await getExamFileBytes(refs.exam, deps.env || process.env, deps.fetchImpl || fetch);
  const answerBytes = await getExamFileBytes(refs.answer, deps.env || process.env, deps.fetchImpl || fetch);
  const examText = extractPdfText(examBytes);
  const answerText = extractPdfText(answerBytes);
  if (examText.length < Number(options.minExamTextChars || MIN_EXAM_TEXT_CHARS)) throw new Error(`EXAM_TEXT_TOO_SHORT:${examText.length}`);
  if (answerText.length < Number(options.minAnswerTextChars || MIN_ANSWER_TEXT_CHARS)) throw new Error(`ANSWER_TEXT_TOO_SHORT:${answerText.length}`);
  return { examText, answerText, answerKeys: extractAnswerKeys(answerText) };
}

async function convertWithGeminiDefault(payload, options, deps = {}) {
  return await callGemini({
    apiKey: envValue(deps.env || process.env, 'GEMINI_API_KEY'),
    model: options.model || DEFAULT_GEMINI_MODEL,
    prompt: payload.prompt,
    fetchImpl: deps.fetchImpl || fetch
  });
}

async function convertWithAiDefault(payload, options = {}, deps = {}) {
  const env = deps.env || process.env;
  const provider = resolveAiProvider(options, env);
  const model = resolveAiModel(provider, options, env);
  if (provider === 'openai') {
    return await (deps.callOpenAiImpl || callOpenAi)({
      apiKey: envValue(env, 'OPENAI_API_KEY'),
      model,
      prompt: payload.prompt,
      baseUrl: envValue(env, 'OPENAI_BASE_URL') || DEFAULT_OPENAI_BASE_URL,
      fetchImpl: deps.fetchImpl || fetch,
      sleep: deps.sleep || sleepMs
    });
  }
  if (provider === 'nvidia') {
    return await (deps.callNvidiaImpl || callNvidia)({
      apiKey: envValue(env, 'NVIDIA_API_KEY'),
      model,
      prompt: payload.prompt,
      baseUrl: envValue(env, 'NVIDIA_BASE_URL') || DEFAULT_NVIDIA_BASE_URL,
      maxAttempts: resolveNvidiaMaxAttempts(options, env),
      retryDelayMs: resolveNvidiaRetryDelayMs(options, env),
      fetchImpl: deps.fetchImpl || fetch,
      sleep: deps.sleep || sleepMs
    });
  }
  return await (deps.callGeminiImpl || callGemini)({
    apiKey: envValue(env, 'GEMINI_API_KEY'),
    model,
    prompt: payload.prompt,
    fetchImpl: deps.fetchImpl || fetch,
    sleep: deps.sleep || sleepMs
  });
}

async function saveDraftToSupabase(row, exam, gate, options, deps = {}) {
  const payload = {
    exam_file_id: row.id,
    status: 'draft',
    title: exam.title,
    exam_json: exam,
    image_slots: gate.imageSlots || [],
    question_count: exam.questions.length
  };
  const rows = await supabaseFetch(
    'exam_online_exams?on_conflict=exam_file_id&select=id,exam_file_id,status,title,question_count,image_slots,updated_at,published_at',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(payload)
    },
    deps.env || process.env,
    deps.fetchImpl || fetch
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

async function publishExamToSupabase(row, _exam, _gate, _options, deps = {}) {
  const rows = await supabaseFetch(
    `exam_online_exams?exam_file_id=eq.${encodeURIComponent(row.id)}&select=id,exam_file_id,status,title,question_count,image_slots,updated_at,published_at`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'published', published_at: new Date().toISOString() })
    },
    deps.env || process.env,
    deps.fetchImpl || fetch
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

function safeArtifactName(row) {
  const number = inferThanhHoaExamNumber(row);
  const title = displayTitle(row)
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90);
  return `${number ? String(number).padStart(3, '0') + '_' : ''}${title || row.id}.json`;
}

async function writeRunArtifacts(report, artifacts, options) {
  const stamp = report.started_at.replace(/[:.]/g, '-');
  const root = path.resolve(options.runDir || DEFAULT_RUN_DIR, stamp);
  for (const name of ['published', 'draft', 'needs-review', 'errors']) fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  for (const item of artifacts) {
    const bucket = item.status === 'published' ? 'published'
      : item.status === 'draft_saved' || item.status === 'dry_run_ready' || item.status === 'draft_needs_review' ? 'draft'
      : item.status === 'error' ? 'errors'
      : 'needs-review';
    const filePath = path.join(root, bucket, item.fileName || `${item.exam_file_id}.json`);
    const payload = item.error ? String(item.error) : JSON.stringify(item.payload || item, null, 2);
    fs.writeFileSync(filePath.replace(/\.json$/, bucket === 'errors' ? '.txt' : '.json'), payload, 'utf8');
  }
  report.artifact_dir = root;
}

function reportSummary() {
  return {
    total: 0,
    dry_run_ready: 0,
    draft_saved: 0,
    draft_needs_review: 0,
    published: 0,
    needs_review: 0,
    errors: 0
  };
}

async function runBatch(options = {}, deps = {}) {
  const provider = resolveAiProvider(options, process.env);
  const opts = {
    source: 'Thanh Hoa',
    level: 'vao10',
    limit: 20,
    mode: 'dry-run',
    expectedQuestionCount: DEFAULT_EXPECTED_QUESTION_COUNT,
    provider,
    model: resolveAiModel(provider, options, process.env),
    now: () => new Date(),
    ...options
  };
  opts.provider = resolveAiProvider(opts, process.env);
  if (!options.model && !envValue(process.env, 'EXAM_AGENT_MODEL')) {
    opts.model = defaultModelForProvider(opts.provider);
  }
  const listCandidates = deps.listCandidates || listCandidatesFromSupabase;
  const loadPromptTemplate = deps.loadPromptTemplate || loadPromptTemplateFromSupabase;
  const readExamPairText = deps.readExamPairText || readExamPairTextFromR2;
  const convertWithAi = deps.convertWithAi || deps.convertWithGemini || convertWithAiDefault;
  const saveDraft = deps.saveDraft || saveDraftToSupabase;
  const publishExam = deps.publishExam || publishExamToSupabase;
  const writeArtifacts = deps.writeRunArtifacts || writeRunArtifacts;
  const startedAt = opts.now().toISOString();
  const report = {
    started_at: startedAt,
    source: opts.source,
    level: opts.level,
    mode: opts.mode,
    provider: opts.provider,
    model: opts.model,
    summary: reportSummary(),
    rows: []
  };
  const artifacts = [];
  const candidates = (await listCandidates(opts)).slice(0, opts.limit);
  for (const row of candidates) {
    const item = {
      exam_file_id: row.id,
      title: displayTitle(row),
      exam_code: row.exam_code || null,
      status: 'pending',
      errors: [],
      warnings: []
    };
    report.summary.total += 1;
    try {
      const template = await loadPromptTemplate(row, opts);
      const pair = await readExamPairText(row, opts);
      const prompt = renderAgentPrompt(template, row, pair);
      const generatedRaw = await convertWithAi({ prompt, row, pair }, opts);
      const generated = restoreRichTextMarkersFromSource(generatedRaw, pair.examText);
      const gate = evaluateQualityGate(generated, {
        mode: opts.mode === 'publish' ? 'publish' : 'draft',
        expectedQuestionCount: opts.expectedQuestionCount,
        answerKeys: pair.answerKeys
      });
      item.errors = gate.errors;
      item.warnings = gate.warnings;
      item.question_count = gate.exam && gate.exam.questions ? gate.exam.questions.length : 0;
      if (opts.mode === 'dry-run') {
        item.status = gate.ok && gate.errors.length === 0 ? 'dry_run_ready' : 'needs_review';
        report.summary[item.status] += 1;
      } else if (!gate.ok) {
        item.status = 'needs_review';
        report.summary.needs_review += 1;
      } else if (opts.mode === 'draft') {
        await saveDraft(row, gate.exam, gate, opts);
        item.status = 'draft_saved';
        report.summary.draft_saved += 1;
      } else if (gate.canPublish) {
        await saveDraft(row, gate.exam, gate, opts);
        await publishExam(row, gate.exam, gate, opts);
        item.status = 'published';
        report.summary.published += 1;
      } else {
        await saveDraft(row, gate.exam, gate, opts);
        item.status = 'draft_needs_review';
        report.summary.draft_needs_review += 1;
      }
      artifacts.push({ status: item.status, exam_file_id: row.id, fileName: safeArtifactName(row), payload: { row: item, exam: gate.exam, errors: gate.errors, warnings: gate.warnings } });
    } catch (err) {
      item.status = 'error';
      item.errors = [String(err && err.message || err)];
      report.summary.errors += 1;
      artifacts.push({ status: 'error', exam_file_id: row.id, fileName: `${safeArtifactName(row).replace(/\.json$/, '')}.txt`, error: item.errors[0] });
    }
    report.rows.push(item);
  }
  await writeArtifacts(report, artifacts, opts);
  return report;
}

async function main() {
  loadDefaultEnv();
  const options = parseArgs();
  const report = await runBatch(options);
  console.log(JSON.stringify(report.summary, null, 2));
  if (report.artifact_dir) console.log(`Artifacts: ${report.artifact_dir}`);
  if (report.summary.errors) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(err => {
    console.error(err && err.stack || err);
    process.exitCode = 1;
  });
}

module.exports = {
  EXAM_JSON_SCHEMA,
  buildGeminiRequestBody,
  callGemini,
  callNvidia,
  callOpenAi,
  convertWithAiDefault,
  evaluateQualityGate,
  examFileRefs,
  extractAnswerKeys,
  extractPdfText,
  filterConversionCandidates,
  resolveAiProvider,
  resolveAiModel,
  inferThanhHoaExamNumber,
  listCandidatesFromSupabase,
  loadDefaultEnv,
  loadPromptTemplateFromSupabase,
  parseArgs,
  renderAgentPrompt,
  restoreRichTextMarkersFromSource,
  runBatch,
  saveDraftToSupabase,
  sourceMatchesThanhHoa
};
