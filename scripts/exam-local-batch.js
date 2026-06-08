const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const {
  callGemini,
  evaluateQualityGate,
  extractAnswerKeys,
  extractPdfText,
  inferThanhHoaExamNumber,
  listCandidatesFromSupabase,
  loadDefaultEnv,
  loadPromptTemplateFromSupabase,
  renderAgentPrompt,
  saveDraftToSupabase
} = require('./exam-conversion-agent.js');

const DEFAULT_LOCAL_RUN_DIR = path.join('_exam_agent_runs', 'local-jobs');
const DEFAULT_EXPECTED_QUESTION_COUNT = 50;
const DEFAULT_DELAY_MS = 12000;

function foldText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function normalizeMatchText(value) {
  return foldText(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function localFileKind(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  return '';
}

function isSupportedLocalFile(filePath) {
  return Boolean(localFileKind(filePath));
}

function isAnswerFile(filePath) {
  const text = normalizeMatchText(path.basename(filePath || ''));
  return /\b(dap an|dapan|answer|key|loi giai|loigiai)\b/.test(text);
}

function readZipEntry(buffer, wantedName) {
  const maxComment = Math.min(buffer.length, 0xffff + 22);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= buffer.length - maxComment; i -= 1) {
    if (i >= 0 && buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('DOCX_ZIP_EOCD_NOT_FOUND');
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  let ptr = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) throw new Error('DOCX_ZIP_CENTRAL_DIRECTORY_INVALID');
    const method = buffer.readUInt16LE(ptr + 10);
    const compressedSize = buffer.readUInt32LE(ptr + 20);
    const fileNameLength = buffer.readUInt16LE(ptr + 28);
    const extraLength = buffer.readUInt16LE(ptr + 30);
    const commentLength = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.slice(ptr + 46, ptr + 46 + fileNameLength).toString('utf8');
    if (name === wantedName) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('DOCX_ZIP_LOCAL_HEADER_INVALID');
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataOffset, dataOffset + compressedSize);
      if (method === 0) return compressed;
      if (method === 8) return zlib.inflateRawSync(compressed);
      throw new Error(`DOCX_ZIP_METHOD_UNSUPPORTED:${method}`);
    }
    ptr += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error(`DOCX_ENTRY_NOT_FOUND:${wantedName}`);
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractDocxText(bytes) {
  const xml = readZipEntry(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), 'word/document.xml').toString('utf8');
  const textXml = xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeXmlEntities(textXml)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function answerHeadingIndex(text) {
  let offset = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const normalized = normalizeMatchText(line);
    const compactEnough = normalized.length > 0 && normalized.length <= 90;
    const isHeading = compactEnough && (
      /^dap an\b/.test(normalized) ||
      /^answer key\b/.test(normalized) ||
      /^answers\b/.test(normalized) ||
      /^huong dan cham\b/.test(normalized) ||
      /^huong dan giai\b/.test(normalized) ||
      /^loi giai\b/.test(normalized)
    );
    if (isHeading) return offset;
    offset += line.length + 1;
  }
  return -1;
}

function splitCombinedExamAnswerText(text) {
  const idx = answerHeadingIndex(text);
  if (idx < 0) throw new Error('COMBINED_ANSWER_SECTION_NOT_FOUND');
  const examText = String(text || '').slice(0, idx).trim();
  const answerText = String(text || '').slice(idx).trim();
  return { examText, answerText, answerKeys: extractAnswerKeys(answerText) };
}

function docxContainsAnswerSection(filePath) {
  try {
    return answerHeadingIndex(extractDocxText(fs.readFileSync(filePath))) >= 0;
  } catch (_err) {
    return false;
  }
}

function inferLocalExamNumber(filePath) {
  const text = normalizeMatchText(path.basename(filePath || '', path.extname(filePath || '')));
  const direct = text.match(/\b(?:de|ma de|vmp|hn)\s*0*(\d{1,3})\b/);
  if (direct) return Number(direct[1]);
  const all = [...text.matchAll(/\b0*(\d{1,3})\b/g)]
    .map(match => Number(match[1]))
    .filter(number => number > 0 && number !== 10);
  return all[0] || 0;
}

function formatExamCode(number) {
  return String(Number(number) || 0).padStart(3, '0');
}

function walkLocalExamFiles(rootDir) {
  const root = path.resolve(rootDir || '');
  if (!fs.existsSync(root)) throw new Error(`LOCAL_FOLDER_NOT_FOUND:${root}`);
  if (!fs.statSync(root).isDirectory()) throw new Error(`LOCAL_FOLDER_NOT_DIRECTORY:${root}`);
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== '_exam_agent_runs') stack.push(fullPath);
      } else if (entry.isFile() && isSupportedLocalFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b, 'vi'));
}

function scanLocalExamFolder(rootDir) {
  const files = walkLocalExamFiles(rootDir);
  const byCode = new Map();
  for (const filePath of files) {
    const number = inferLocalExamNumber(filePath);
    const code = number ? formatExamCode(number) : 'unknown';
    if (!byCode.has(code)) {
      byCode.set(code, { examCode: code, examFiles: [], answerFiles: [] });
    }
    const bucket = isAnswerFile(filePath) ? 'answerFiles' : 'examFiles';
    byCode.get(code)[bucket].push(filePath);
  }
  const pairs = [...byCode.values()]
    .filter(group => group.examCode !== 'unknown')
    .sort((a, b) => Number(a.examCode) - Number(b.examCode))
    .map(group => {
      const examPath = group.examFiles[0] || '';
      const combined = Boolean(examPath && !group.answerFiles.length && localFileKind(examPath) === 'docx' && docxContainsAnswerSection(examPath));
      const answerPath = group.answerFiles[0] || (combined ? examPath : '');
      const issues = [];
      if (!examPath) issues.push('MISSING_EXAM_FILE');
      if (!answerPath) issues.push('MISSING_ANSWER_FILE');
      if (combined) issues.push('COMBINED_EXAM_ANSWER_DOCX');
      if (group.examFiles.length > 1) issues.push('DUPLICATE_EXAM_FILE');
      if (group.answerFiles.length > 1) issues.push('DUPLICATE_ANSWER_FILE');
      return {
        examCode: group.examCode,
        title: examPath ? path.basename(examPath, path.extname(examPath)) : `Đề ${group.examCode}`,
        examPath,
        answerPath,
        examFileName: examPath ? path.basename(examPath) : '',
        answerFileName: answerPath ? path.basename(answerPath) : '',
        combined,
        status: examPath && answerPath ? 'ready' : (examPath ? 'missing_answer' : 'missing_exam'),
        issues
      };
    });
  return {
    rootDir: path.resolve(rootDir || ''),
    totalPdf: files.length,
    totalFiles: files.length,
    pairs,
    readyPairs: pairs.filter(pair => pair.examPath && pair.answerPath)
  };
}

function localPairTitle(pair) {
  return pair && pair.title ? pair.title : `Đề ${pair && pair.examCode || ''}`.trim();
}

function localPairRow(pair, remoteRow) {
  if (remoteRow) return { ...remoteRow, localPair: pair };
  return {
    id: `local-${pair.examCode}`,
    title: localPairTitle(pair),
    exam_code: pair.examCode,
    province: 'Thanh Hóa',
    level: 'entrance_10',
    year: inferYearFromName(localPairTitle(pair)) || new Date().getFullYear(),
    localPair: pair
  };
}

function inferYearFromName(value) {
  const match = String(value || '').match(/\b(20\d{2})\b/);
  return match ? Number(match[1]) : 0;
}

function matchScore(pair, row) {
  const pairNo = Number(pair && pair.examCode || 0);
  const rowNo = inferThanhHoaExamNumber(row);
  if (!pairNo || pairNo !== rowNo) return -1;
  let score = 10;
  const rowText = normalizeMatchText([row && row.title, row && row.province, row && row.exam_code].join(' '));
  const pairText = normalizeMatchText([pair && pair.title, pair && pair.examCode].join(' '));
  if (/\bthanh hoa\b/.test(rowText)) score += 10;
  if (/\bthanh hoa\b/.test(pairText) && /\bthanh hoa\b/.test(rowText)) score += 4;
  const pairYear = inferYearFromName(pairText);
  const rowYear = Number(row && row.year || 0) || inferYearFromName(rowText);
  if (pairYear && rowYear && pairYear === rowYear) score += 3;
  if (normalizeMatchText(row && row.exam_code).includes(pair.examCode)) score += 2;
  return score;
}

function matchLocalPairToExamFile(pair, rows) {
  let best = null;
  let bestScore = -1;
  for (const row of Array.isArray(rows) ? rows : []) {
    const score = matchScore(pair, row);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return bestScore >= 0 ? best : null;
}

function extractLocalTextFromFile(filePath) {
  const kind = localFileKind(filePath);
  const bytes = fs.readFileSync(filePath);
  if (kind === 'pdf') return extractPdfText(bytes);
  if (kind === 'docx') return extractDocxText(bytes);
  throw new Error(`LOCAL_FILE_TYPE_UNSUPPORTED:${path.extname(filePath || '')}`);
}

async function readLocalPairText(pair, options = {}) {
  let examText;
  let answerText;
  let answerKeys;
  if (pair.combined || path.resolve(pair.examPath) === path.resolve(pair.answerPath)) {
    const split = splitCombinedExamAnswerText(extractLocalTextFromFile(pair.examPath));
    examText = split.examText;
    answerText = split.answerText;
    answerKeys = split.answerKeys;
  } else {
    examText = extractLocalTextFromFile(pair.examPath);
    answerText = extractLocalTextFromFile(pair.answerPath);
    answerKeys = extractAnswerKeys(answerText);
  }
  const minExamTextChars = Number(options.minExamTextChars || 500);
  const minAnswerTextChars = Number(options.minAnswerTextChars || 20);
  if (examText.length < minExamTextChars) throw new Error(`EXAM_TEXT_TOO_SHORT:${examText.length}`);
  if (answerText.length < minAnswerTextChars) throw new Error(`ANSWER_TEXT_TOO_SHORT:${answerText.length}`);
  return { examText, answerText, answerKeys };
}

function createLocalJobReport(options = {}) {
  return {
    started_at: options.startedAt || new Date().toISOString(),
    source: options.source || 'Thanh Hoa',
    level: options.level || 'vao10',
    mode: options.mode || 'dry-run',
    folder: options.folder || '',
    artifact_dir: '',
    summary: {
      total: 0,
      running: 0,
      dry_run_ready: 0,
      draft_saved: 0,
      local_ready: 0,
      needs_review: 0,
      errors: 0,
      skipped: 0
    },
    rows: []
  };
}

function safeFileName(pair) {
  const title = localPairTitle(pair)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90);
  return `${pair.examCode}_${title || 'exam'}.json`;
}

function ensureRunDirs(root) {
  for (const name of ['draft', 'needs-review', 'errors']) fs.mkdirSync(path.join(root, name), { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function writeLocalArtifacts(report, artifacts, root) {
  ensureRunDirs(root);
  writeJson(path.join(root, 'report.json'), report);
  writeJson(path.join(root, 'state.json'), report);
  for (const artifact of artifacts) {
    if (artifact.written) continue;
    const bucket = artifact.status === 'error' ? 'errors'
      : artifact.status === 'needs_review' ? 'needs-review'
      : 'draft';
    const filePath = path.join(root, bucket, artifact.fileName);
    if (artifact.status === 'error') {
      fs.writeFileSync(filePath.replace(/\.json$/, '.txt'), artifact.error || 'UNKNOWN_ERROR', 'utf8');
    } else {
      writeJson(filePath, artifact.payload);
    }
    artifact.written = true;
  }
}

async function defaultLoadRemoteExamFiles(options) {
  return await listCandidatesFromSupabase({
    source: options.source || 'Thanh Hoa',
    level: options.level || 'vao10',
    limit: Math.max(200, Number(options.remoteLimit || options.limit || 20) * 4)
  });
}

async function defaultLoadPromptTemplate(row, options) {
  return await loadPromptTemplateFromSupabase(row, options);
}

async function defaultConvertWithGemini(payload, options) {
  return await callGemini({
    apiKey: process.env.GEMINI_API_KEY || '',
    model: options.model || process.env.EXAM_AGENT_MODEL || 'gemini-2.5-flash',
    prompt: payload.prompt
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitWhilePaused(control) {
  while (control && typeof control.isPaused === 'function' && control.isPaused()) {
    await wait(500);
  }
}

async function runLocalBatch(options = {}, deps = {}) {
  if (!deps.skipEnv) loadDefaultEnv();
  const opts = {
    source: 'Thanh Hoa',
    level: 'vao10',
    mode: 'dry-run',
    limit: 20,
    expectedQuestionCount: DEFAULT_EXPECTED_QUESTION_COUNT,
    delayMs: DEFAULT_DELAY_MS,
    runDir: DEFAULT_LOCAL_RUN_DIR,
    now: () => new Date(),
    ...options
  };
  if (!['dry-run', 'draft'].includes(opts.mode)) throw new Error('LOCAL_BATCH_MODE_MUST_BE_DRY_RUN_OR_DRAFT');
  const scan = deps.scanResult || scanLocalExamFolder(opts.folder);
  const startedAt = opts.now().toISOString();
  const artifactRoot = path.resolve(opts.runDir, startedAt.replace(/[:.]/g, '-'));
  ensureRunDirs(artifactRoot);
  const report = createLocalJobReport({ ...opts, startedAt });
  report.artifact_dir = artifactRoot;
  const artifacts = [];
  const pairs = scan.readyPairs.slice(0, Math.max(1, Number(opts.limit || 20)));
  const remoteRows = await (deps.loadRemoteExamFiles || defaultLoadRemoteExamFiles)(opts);
  report.summary.total = pairs.length;
  writeLocalArtifacts(report, artifacts, artifactRoot);

  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (deps.control && typeof deps.control.shouldStop === 'function' && deps.control.shouldStop()) {
      report.summary.skipped += pairs.length - index;
      break;
    }
    await waitWhilePaused(deps.control);
    const matchedRow = matchLocalPairToExamFile(pair, remoteRows);
    const row = localPairRow(pair, matchedRow);
    const item = {
      index: index + 1,
      examCode: pair.examCode,
      title: localPairTitle(pair),
      examPath: pair.examPath,
      answerPath: pair.answerPath,
      exam_file_id: matchedRow ? matchedRow.id : null,
      status: 'running',
      question_count: 0,
      answer_key_count: 0,
      exam_text_chars: 0,
      answer_text_chars: 0,
      errors: [],
      warnings: matchedRow ? [] : ['NO_EXAM_FILE_MATCH']
    };
    report.rows.push(item);
    report.summary.running = 1;
    writeLocalArtifacts(report, artifacts, artifactRoot);
    if (deps.onProgress) deps.onProgress(report, item);
    try {
      const pairText = await (deps.readPairText || readLocalPairText)(pair, opts);
      item.exam_text_chars = pairText.examText.length;
      item.answer_text_chars = pairText.answerText.length;
      item.answer_key_count = pairText.answerKeys ? pairText.answerKeys.size : 0;
      const template = await (deps.loadPromptTemplate || defaultLoadPromptTemplate)(row, opts);
      const prompt = renderAgentPrompt(template, row, pairText);
      const generated = await (deps.convertWithGemini || defaultConvertWithGemini)({ prompt, row, pair, pairText }, opts);
      const gate = evaluateQualityGate(generated, {
        mode: 'draft',
        expectedQuestionCount: opts.expectedQuestionCount,
        answerKeys: pairText.answerKeys
      });
      item.errors = gate.errors;
      item.warnings = item.warnings.concat(gate.warnings || []);
      item.question_count = gate.exam && Array.isArray(gate.exam.questions) ? gate.exam.questions.length : 0;
      if (!gate.ok || gate.errors.length) {
        item.status = 'needs_review';
        report.summary.needs_review += 1;
      } else if (opts.mode === 'draft' && matchedRow) {
        await (deps.saveDraft || saveDraftToSupabase)(matchedRow, gate.exam, gate, opts);
        item.status = 'draft_saved';
        report.summary.draft_saved += 1;
      } else if (opts.mode === 'draft' && !matchedRow) {
        item.status = 'local_ready';
        report.summary.local_ready += 1;
      } else {
        item.status = 'dry_run_ready';
        report.summary.dry_run_ready += 1;
      }
      artifacts.push({
        status: item.status === 'needs_review' ? 'needs_review' : 'draft',
        fileName: safeFileName(pair),
        payload: { row: item, exam: gate.exam, errors: item.errors, warnings: item.warnings }
      });
    } catch (err) {
      item.status = 'error';
      item.errors = [String(err && err.message || err)];
      report.summary.errors += 1;
      artifacts.push({
        status: 'error',
        fileName: safeFileName(pair),
        error: item.errors[0]
      });
    } finally {
      report.summary.running = 0;
      writeLocalArtifacts(report, artifacts, artifactRoot);
      if (deps.onProgress) deps.onProgress(report, item);
      if (index < pairs.length - 1 && Number(opts.delayMs || 0) > 0) {
        await wait(Number(opts.delayMs || 0));
      }
    }
  }
  writeLocalArtifacts(report, artifacts, artifactRoot);
  return report;
}

module.exports = {
  createLocalJobReport,
  extractDocxText,
  inferLocalExamNumber,
  isAnswerFile,
  matchLocalPairToExamFile,
  readLocalPairText,
  runLocalBatch,
  scanLocalExamFolder
};
