#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');

const {
  scanLocalExamFolder,
  runLocalBatch
} = require('./exam-local-batch.js');
const { validateExamJson } = require('../web/eng10-online-exam.js');

const DEFAULT_PORT = 4050;

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(html);
}

function sendText(res, status, contentType, text) {
  const body = String(text || '');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('REQUEST_TOO_LARGE'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_err) {
        reject(new Error('INVALID_JSON_BODY'));
      }
    });
    req.on('error', reject);
  });
}

function localJobRoot() {
  return path.resolve(process.cwd(), '_exam_agent_runs', 'local-jobs');
}

function resolvePreviewFile(run, file) {
  const runId = String(run || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(runId) || runId.includes('..')) {
    throw new Error('PREVIEW_RUN_INVALID');
  }
  const normalizedFile = String(file || '').replace(/\\/g, '/').trim();
  if (!/^(draft|needs-review)\/[^/]+\.json$/i.test(normalizedFile) || normalizedFile.includes('..')) {
    throw new Error('PREVIEW_FILE_INVALID');
  }
  const root = localJobRoot();
  const runRoot = path.resolve(root, runId);
  const filePath = path.resolve(runRoot, ...normalizedFile.split('/'));
  if (filePath !== runRoot && !filePath.startsWith(runRoot + path.sep)) {
    throw new Error('PREVIEW_PATH_OUTSIDE_RUN');
  }
  return filePath;
}

function readPreviewPayload(searchParams) {
  const filePath = resolvePreviewFile(searchParams.get('run'), searchParams.get('file'));
  if (!fs.existsSync(filePath)) throw new Error('PREVIEW_JSON_NOT_FOUND');
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    throw new Error('PREVIEW_JSON_INVALID');
  }
  const exam = validateExamJson(payload.exam || payload.exam_json || payload);
  return {
    row: payload.row || {},
    exam,
    errors: Array.isArray(payload.errors) ? payload.errors : [],
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    file: {
      run: String(searchParams.get('run') || ''),
      name: String(searchParams.get('file') || '')
    }
  };
}

function cleanNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function cleanPromptText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, 300000);
}

function sanitizeJobOptions(body) {
  const mode = String(body.mode || 'dry-run').trim();
  if (!['dry-run', 'draft'].includes(mode)) throw new Error('Tool local chỉ hỗ trợ dry-run hoặc draft, không hỗ trợ publish hàng loạt.');
  const folder = String(body.folder || '').trim();
  if (!folder) throw new Error('LOCAL_FOLDER_REQUIRED');
  return {
    folder,
    source: String(body.source || 'Thanh Hoa').trim() || 'Thanh Hoa',
    level: String(body.level || 'vao10').trim() || 'vao10',
    mode,
    limit: cleanNumber(body.limit, 20, 1, 9999),
    expectedQuestionCount: cleanNumber(body.expectedQuestionCount, 50, 0, 200),
    delayMs: cleanNumber(body.delayMs, 12000, 0, 120000),
    runDir: String(body.runDir || path.join('_exam_agent_runs', 'local-jobs')).trim(),
    promptText: cleanPromptText(body.promptText)
  };
}

function publicOptions(options = {}) {
  const out = { ...options };
  if (out.promptText) out.promptText = `[manual prompt ${out.promptText.length} chars]`;
  return out;
}

function isFinishedRow(row) {
  const status = String(row && row.status || '');
  return Boolean(status && !['pending', 'running'].includes(status));
}

function jobProgress(job) {
  const report = job && job.report;
  const rows = Array.isArray(report && report.rows) ? report.rows : [];
  const total = Math.max(0, Number(report && report.summary && report.summary.total || 0) || rows.length || 0);
  const completed = rows.filter(isFinishedRow).length;
  const runningRow = rows.find(row => String(row.status || '') === 'running') || null;
  const running = Boolean(job && job.status === 'running');
  let percent = total ? Math.floor((completed / total) * 100) : 0;
  if (job && job.status === 'completed' && total > 0) percent = 100;
  if (running && percent >= 100) percent = 99;
  const currentExam = runningRow ? String(runningRow.examCode || runningRow.title || '') : '';
  const label = running
    ? (currentExam ? `Đang chạy ${percent}% · Đề ${currentExam}` : `Đang chạy ${percent}%`)
    : job && job.status === 'completed'
      ? 'Hoàn tất 100%'
      : job && job.status === 'stopped'
        ? `Đã dừng ${percent}%`
        : job && job.status === 'error'
          ? 'Batch lỗi'
          : 'Chưa chạy';
  return { total, completed, percent, running, currentExam, label };
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    paused: job.paused,
    stopAfterCurrent: job.stopAfterCurrent,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || '',
    options: publicOptions(job.options),
    progress: jobProgress(job),
    logs: job.logs.slice(-120),
    error: job.error || '',
    report: job.report || null
  };
}

function pushLog(job, message) {
  const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  job.logs.push(`[${time}] ${message}`);
}

function startJob(state, options, deps = {}) {
  if (state.job && state.job.status === 'running') throw new Error('Đang có batch chạy. Hãy dừng hoặc chờ hoàn tất.');
  const job = {
    id: `job-${Date.now()}`,
    status: 'running',
    paused: false,
    stopAfterCurrent: false,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    options,
    logs: [],
    report: null,
    error: ''
  };
  state.job = job;
  pushLog(job, `Bắt đầu ${options.mode} từ thư mục ${options.folder}`);
  setImmediate(async () => {
    try {
      const report = await (deps.runLocalBatch || runLocalBatch)(options, {
        control: {
          shouldStop: () => job.stopAfterCurrent,
          isPaused: () => job.paused
        },
        onProgress: (nextReport, item) => {
          job.report = nextReport;
          if (item) pushLog(job, `${item.examCode} - ${item.status}${item.question_count ? ` - ${item.question_count} câu` : ''}`);
        }
      });
      job.report = report;
      job.status = job.stopAfterCurrent ? 'stopped' : 'completed';
      job.finishedAt = new Date().toISOString();
      pushLog(job, job.status === 'completed' ? 'Batch hoàn tất.' : 'Batch đã dừng sau đề hiện tại.');
    } catch (err) {
      job.status = 'error';
      job.finishedAt = new Date().toISOString();
      job.error = String(err && err.message || err);
      pushLog(job, `Lỗi: ${job.error}`);
    }
  });
  return job;
}

function createServer(deps = {}) {
  const state = { job: null };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        return sendHtml(res, renderHtml());
      }
      if (req.method === 'GET' && url.pathname === '/preview') {
        return sendHtml(res, renderPreviewHtml());
      }
      if (req.method === 'GET' && url.pathname === '/assets/eng10-online-exam.js') {
        const scriptPath = path.resolve(__dirname, '..', 'web', 'eng10-online-exam.js');
        return sendText(res, 200, 'application/javascript; charset=utf-8', fs.readFileSync(scriptPath, 'utf8'));
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, tool: 'exam-agent-ui', public: false });
      }
      if (req.method === 'GET' && url.pathname === '/api/preview-json') {
        return sendJson(res, 200, { ok: true, ...readPreviewPayload(url.searchParams) });
      }
      if (req.method === 'POST' && url.pathname === '/api/scan') {
        const body = await readJsonBody(req);
        const folder = String(body.folder || '').trim();
        if (!folder) throw new Error('LOCAL_FOLDER_REQUIRED');
        const scan = (deps.scanLocalExamFolder || scanLocalExamFolder)(folder);
        return sendJson(res, 200, { ok: true, scan });
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs/start') {
        const body = await readJsonBody(req);
        const options = sanitizeJobOptions(body);
        const job = startJob(state, options, deps);
        return sendJson(res, 200, { ok: true, job: publicJob(job) });
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs/current') {
        return sendJson(res, 200, { ok: true, job: publicJob(state.job) });
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs/pause') {
        if (state.job && state.job.status === 'running') {
          state.job.paused = true;
          pushLog(state.job, 'Đã tạm dừng sau bước hiện tại.');
        }
        return sendJson(res, 200, { ok: true, job: publicJob(state.job) });
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs/resume') {
        if (state.job && state.job.status === 'running') {
          state.job.paused = false;
          pushLog(state.job, 'Tiếp tục chạy.');
        }
        return sendJson(res, 200, { ok: true, job: publicJob(state.job) });
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs/stop') {
        if (state.job && state.job.status === 'running') {
          state.job.stopAfterCurrent = true;
          state.job.paused = false;
          pushLog(state.job, 'Sẽ dừng sau đề hiện tại.');
        }
        return sendJson(res, 200, { ok: true, job: publicJob(state.job) });
      }
      return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: String(err && err.message || err) });
    }
  });
}

function renderHtml() {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MV Klass - Exam Conversion App</title>
  <style>
    :root{--navy:#102858;--navy-2:#183b75;--ink:#102033;--muted:#6a7890;--line:#dbe6f5;--soft:#edf4fb;--panel:#fff;--blue:#2563eb;--cyan:#0891b2;--green:#059669;--amber:#d97706;--red:#dc2626;--shadow:0 18px 42px rgba(16,40,88,.11);--radius:18px}
    *{box-sizing:border-box}
    body{margin:0;background:linear-gradient(180deg,#e8f0fa 0,#f5f8fc 42%,#eaf1f9 100%);color:var(--ink);font-family:Segoe UI,system-ui,sans-serif;font-size:14px}
    button,input,select,textarea{font:inherit}
    .app-shell{min-height:100vh;display:grid;grid-template-columns:248px minmax(620px,1fr) 360px;gap:16px;padding:16px}
    .app-sidebar,.app-workspace,.app-detail{min-width:0}
    .app-sidebar{position:sticky;top:16px;height:calc(100vh - 32px);border:1px solid rgba(255,255,255,.3);border-radius:24px;background:linear-gradient(180deg,#102858,#173c78);color:#fff;box-shadow:var(--shadow);padding:18px;display:flex;flex-direction:column;gap:18px}
    .brand{display:flex;align-items:center;gap:12px}
    .brand-mark{width:42px;height:42px;border-radius:14px;background:#fff;color:var(--navy);display:grid;place-items:center;font-weight:1000;box-shadow:0 12px 26px rgba(0,0,0,.18)}
    .brand-title{font-size:18px;font-weight:1000;line-height:1.1}
    .brand-sub{margin-top:3px;color:#cfe0fb;font-size:12px;font-weight:800}
    .side-section{display:grid;gap:8px}
    .side-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#a9c6f7;font-weight:950}
    .side-step{display:grid;grid-template-columns:28px 1fr;gap:10px;align-items:start;padding:10px;border-radius:14px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.10)}
    .side-step b{width:28px;height:28px;border-radius:10px;background:rgba(255,255,255,.14);display:grid;place-items:center}
    .side-step strong{display:block;font-size:13px}.side-step span{display:block;margin-top:2px;color:#cfe0fb;font-size:12px;font-weight:750;line-height:1.35}
    .side-note{margin-top:auto;border:1px solid rgba(255,255,255,.16);border-radius:16px;background:rgba(255,255,255,.09);padding:12px;color:#dbeafe;font-weight:800;line-height:1.45}
    .app-workspace{display:grid;gap:14px}
    .app-topbar{border:1px solid var(--line);border-radius:24px;background:rgba(255,255,255,.82);box-shadow:var(--shadow);padding:18px 20px;display:flex;justify-content:space-between;gap:16px;align-items:center}
    .app-kicker{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--cyan);font-weight:1000}
    h1{margin:4px 0 0;color:var(--navy);font-size:26px;line-height:1.12}
    .top-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
    .badge{display:inline-flex;align-items:center;min-height:34px;padding:8px 12px;border-radius:999px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-weight:950;white-space:nowrap}
    .status-dot{display:inline-flex;align-items:center;gap:7px;min-height:34px;padding:8px 12px;border-radius:999px;background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;font-weight:950;white-space:nowrap}
    .status-dot::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
    .status-dot.running{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8}.status-dot.error{background:#fff1f2;border-color:#fecdd3;color:#be123c}.status-dot.completed{background:#ecfdf5;border-color:#a7f3d0;color:#047857}
    .panel{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);box-shadow:var(--shadow);overflow:hidden}
    .panel-head{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:15px 16px;border-bottom:1px solid var(--line);background:#fbfdff}
    .panel-title{font-weight:1000;color:var(--navy);font-size:15px}
    .panel-sub{color:var(--muted);font-weight:800;font-size:12px}
    .controls{display:grid;grid-template-columns:minmax(280px,1.7fr) 130px 116px 116px 130px 130px;gap:10px;padding:16px}
    label{display:grid;gap:6px;color:#5d6d87;font-size:11px;font-weight:950;text-transform:uppercase}
    input,select,textarea{width:100%;border:1px solid var(--line);border-radius:12px;background:#fff;color:var(--ink);outline:none;font-weight:800}
    input,select{height:42px;padding:0 12px}
    textarea{min-height:116px;padding:12px;resize:vertical;line-height:1.5}
    input:focus,select:focus,textarea:focus{border-color:#7aa7ff;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
    .prompt-panel{display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:12px;padding:0 16px 16px}
    .prompt-help{align-self:stretch;border:1px dashed #c9d9ee;border-radius:14px;background:#f8fbff;color:#637590;font-weight:800;line-height:1.45;padding:12px}
    .prompt-help strong{display:block;color:var(--navy);font-size:13px;margin-bottom:4px}
    .actions{display:flex;flex-wrap:wrap;gap:9px;padding:0 16px 16px}
    .btn{height:42px;border:1px solid transparent;border-radius:12px;padding:0 15px;background:#fff;color:var(--navy);font-weight:950;cursor:pointer;box-shadow:0 8px 18px rgba(15,42,85,.08)}
    .btn:hover{transform:translateY(-1px)}
    .btn.primary{background:#102858;color:#fff}
    .btn.blue{background:#eaf3ff;color:#155eaa;border-color:#b9d8ff}
    .btn.green{background:#ecfdf5;color:#047857;border-color:#a7f3d0}
    .btn.warn{background:#fff7ed;color:#9a3412;border-color:#fed7aa}
    .btn.danger{background:#fff1f2;color:#be123c;border-color:#fecdd3}
    .btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
    .progress-panel{display:grid;gap:9px;padding:14px;border:1px solid var(--line);border-radius:16px;background:#f8fbff}
    .progress-copy{display:flex;justify-content:space-between;gap:12px;align-items:center;color:#5d6d87;font-weight:900}
    .progress-copy strong{color:var(--navy)}
    .progress-track{height:13px;overflow:hidden;border-radius:999px;background:#e6edf7;border:1px solid #d5e2f2}
    .progress-fill{position:relative;height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,#2563eb,#22c55e);transition:width .45s ease}
    .progress-fill.running::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 0 30%,rgba(255,255,255,.35) 30% 45%,transparent 45% 70%);background-size:44px 100%;animation:progress-stripe .85s linear infinite}
    @keyframes progress-stripe{from{background-position:0 0}to{background-position:44px 0}}
    .metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}
    .metric{border:1px solid var(--line);border-radius:14px;background:#fff;padding:12px}
    .metric span{display:block;color:#6b7d98;font-size:11px;font-weight:900;text-transform:uppercase}
    .metric strong{display:block;margin-top:4px;color:var(--navy);font-size:24px;line-height:1}
    .activity-panel{display:grid;gap:12px}
    .table-wrap{overflow:auto;max-height:calc(100vh - 342px);min-height:360px}
    table{width:100%;border-collapse:separate;border-spacing:0}
    th,td{text-align:left;padding:11px 12px;border-bottom:1px solid #edf2f8;vertical-align:top}
    th{position:sticky;top:0;background:#f8fbff;color:#5d6d87;font-size:11px;text-transform:uppercase;z-index:1}
    td{font-weight:780;color:#263852}
    .status{display:inline-flex;align-items:center;min-height:26px;padding:5px 9px;border-radius:999px;font-size:11px;font-weight:950;border:1px solid var(--line);white-space:nowrap}
    .status.ready,.status.dry_run_ready,.status.draft_saved{background:#ecfdf5;color:#047857;border-color:#a7f3d0}
    .status.local_ready,.status.warning{background:#fff7ed;color:#9a3412;border-color:#fed7aa}
    .status.error,.status.needs_review,.status.missing_answer,.status.missing_exam{background:#fff1f2;color:#be123c;border-color:#fecdd3}
    .mono{font-family:Consolas,ui-monospace,monospace;font-size:12px;color:#52627a;overflow-wrap:anywhere}
    .mini-link{display:inline-flex;align-items:center;justify-content:center;min-width:54px;height:32px;border:1px solid #b9d8ff;border-radius:10px;background:#eaf3ff;color:#155eaa;text-decoration:none;font-weight:950;white-space:nowrap}
    .mini-link:hover{background:#dbeafe}
    .muted-mini{color:#94a3b8;font-weight:900}
    .app-detail{position:sticky;top:16px;height:calc(100vh - 32px);display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:14px}
    .detail-card{border:1px solid var(--line);border-radius:22px;background:#fff;box-shadow:var(--shadow);padding:16px;min-width:0}
    .detail-card.dark{background:#0b1730;color:#dbeafe;border-color:#17294d}
    .detail-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;color:var(--navy);font-weight:1000}
    .detail-card.dark .detail-title{color:#eaf2ff}
    .log{height:100%;min-height:260px;overflow:auto;background:transparent;color:#dbeafe;padding:0;border-radius:14px;font:12px/1.55 Consolas,ui-monospace,monospace;white-space:pre-wrap}
    .empty{padding:22px;text-align:center;color:#74839a;font-weight:850}
    .notice{padding:10px 12px;border-radius:12px;background:#fff7ed;color:#9a3412;border:1px solid #fed7aa;font-weight:850;line-height:1.4}
    .quick-list{display:grid;gap:8px;color:#52627a;font-weight:820;line-height:1.45}.quick-list span{display:flex;gap:8px}.quick-list b{color:var(--navy)}
    @media (max-width:1180px){.app-shell{grid-template-columns:220px minmax(0,1fr)}.app-detail{position:static;height:auto;grid-column:1/-1;grid-template-columns:1fr 1fr;grid-template-rows:auto}.detail-card.dark{min-height:280px}.controls{grid-template-columns:repeat(3,1fr)}}
    @media (max-width:840px){.app-shell{display:block;padding:10px}.app-sidebar{position:static;height:auto;margin-bottom:12px}.app-workspace{display:grid}.app-topbar{display:grid}.controls,.prompt-panel{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}.app-detail{display:grid;grid-template-columns:1fr;margin-top:12px}.table-wrap{max-height:none}.top-actions{justify-content:flex-start}}
    @media (max-width:560px){h1{font-size:21px}.metrics{grid-template-columns:1fr 1fr}.actions .btn{flex:1 1 145px}.progress-copy{display:grid}.side-section{display:none}}
  </style>
</head>
<body>
  <main class="app-shell">
    <aside class="app-sidebar">
      <div class="brand">
        <div class="brand-mark">MV</div>
        <div><div class="brand-title">Exam Agent</div><div class="brand-sub">Local conversion app</div></div>
      </div>
      <div class="side-section">
        <div class="side-label">Quy trình</div>
        <div class="side-step"><b>1</b><div><strong>Quét thư mục</strong><span>Nhận diện file đề và đáp án theo mã đề.</span></div></div>
        <div class="side-step"><b>2</b><div><strong>Tạo JSON</strong><span>Gửi đề, đáp án và prompt nguồn tới OpenAI.</span></div></div>
        <div class="side-step"><b>3</b><div><strong>Review</strong><span>Mở preview trước khi lưu nháp lên kho.</span></div></div>
      </div>
      <div class="side-note">Chạy trên máy local. Tool không publish hàng loạt và chỉ lưu draft khi thầy/cô chọn chế độ lưu.</div>
    </aside>

    <section class="app-workspace">
      <header class="app-topbar">
        <div>
          <div class="app-kicker">MV Klass internal tool</div>
          <h1>Chuyển đề Word/PDF thành JSON online</h1>
        </div>
        <div class="top-actions">
          <span id="server-status" class="status-dot">Localhost</span>
          <span class="badge">Không publish hàng loạt</span>
        </div>
      </header>

      <section class="metrics">
        <div class="metric"><span>Tổng</span><strong id="m-total">0</strong></div>
        <div class="metric"><span>Dry-run ready</span><strong id="m-ready">0</strong></div>
        <div class="metric"><span>Đã lưu draft</span><strong id="m-draft">0</strong></div>
        <div class="metric"><span>Local only</span><strong id="m-local">0</strong></div>
        <div class="metric"><span>Cần review</span><strong id="m-review">0</strong></div>
        <div class="metric"><span>Lỗi</span><strong id="m-error">0</strong></div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div><div class="panel-title">Batch workspace</div><div class="panel-sub">Chọn thư mục, prompt và chế độ chạy</div></div>
        </div>
        <div class="controls">
          <label>Thư mục đề/đáp án<input id="folder" placeholder="C:\\DeThi\\ThanhHoa"></label>
          <label>Nguồn<select id="source"><option value="Thanh Hoa">Thanh Hóa</option></select></label>
          <label>Cấp<select id="level"><option value="vao10">Vào 10</option></select></label>
          <label>Số đề<select id="limit"><option value="1">1</option><option value="5">5</option><option value="20" selected>20</option><option value="50">50</option><option value="9999">Tất cả</option></select></label>
          <label>Chế độ<select id="mode"><option value="dry-run">Dry-run</option><option value="draft">Lưu draft</option></select></label>
          <label>Nghỉ giữa đề<input id="delay" type="number" min="0" max="120" value="12"></label>
        </div>
        <div class="prompt-panel">
          <label>Prompt nguồn thủ công<textarea id="prompt-text" placeholder="Dán prompt nguồn vào đây. Nếu để trống, tool sẽ lấy prompt từ Supabase theo nguồn đề."></textarea></label>
          <div class="prompt-help">
            <strong>Prompt nguồn</strong>
            Dùng khi muốn test nhanh prompt mới hoặc chạy riêng một nguồn. Prompt này chỉ áp dụng cho batch local hiện tại.
          </div>
        </div>
        <div class="actions">
          <button class="btn blue" id="scan-btn">Quét thư mục</button>
          <button class="btn primary" id="start-btn">Bắt đầu chạy</button>
          <button class="btn warn" id="pause-btn">Tạm dừng</button>
          <button class="btn green" id="resume-btn">Tiếp tục</button>
          <button class="btn danger" id="stop-btn">Dừng sau đề hiện tại</button>
        </div>
      </section>

      <section id="activity-panel" class="panel activity-panel">
        <div class="panel-head">
          <div><div class="panel-title">Danh sách đề</div><div class="panel-sub">Mở Test để review JSON local sau khi chạy</div></div>
        </div>
        <div id="table" class="table-wrap"><div class="empty">Chưa quét thư mục.</div></div>
      </section>
    </section>

    <aside id="detail-panel" class="app-detail">
      <section class="detail-card">
        <div class="detail-title"><span>Tiến độ batch</span><span id="progress-percent">0%</span></div>
        <div class="progress-panel">
          <div class="progress-copy"><strong id="progress-label">Chưa chạy</strong></div>
          <div class="progress-track" aria-hidden="true"><div id="progress-fill" class="progress-fill"></div></div>
        </div>
      </section>
      <section class="detail-card">
        <div class="detail-title">Ghi chú vận hành</div>
        <div class="notice">Chế độ lưu draft chỉ ghi nháp khi file local khớp được đề trong kho tài liệu.</div>
        <div class="quick-list" style="margin-top:12px">
          <span><b>Dry-run:</b> chỉ tạo JSON local để kiểm tra.</span>
          <span><b>Lưu draft:</b> ghi nháp lên Supabase, chưa publish.</span>
          <span><b>Test:</b> mở preview theo artifact mới nhất.</span>
        </div>
      </section>
      <section class="detail-card dark">
        <div class="detail-title">Log chạy</div>
        <div id="log" class="log">Sẵn sàng.</div>
      </section>
    </aside>
  </main>
  <script>
    const $ = id => document.getElementById(id);
    let pollTimer = null;
    let lastScanRows = [];
    let activeReport = null;

    function html(value){return String(value ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
    async function api(path, options = {}) {
      const res = await fetch(path, {headers:{'Content-Type':'application/json'}, ...options});
      const body = await res.json();
      if (!res.ok || body.ok === false) throw new Error(body.error || 'Request failed');
      return body;
    }
    function currentOptions(){
      return {
        folder:$('folder').value.trim(),
        source:$('source').value,
        level:$('level').value,
        limit:Number($('limit').value),
        mode:$('mode').value,
        delayMs:Number($('delay').value || 0) * 1000,
        promptText:$('prompt-text').value.trim()
      };
    }
    function setMetrics(summary = {}) {
      $('m-total').textContent = summary.total || 0;
      $('m-ready').textContent = summary.dry_run_ready || 0;
      $('m-draft').textContent = summary.draft_saved || 0;
      $('m-local').textContent = summary.local_ready || 0;
      $('m-review').textContent = summary.needs_review || 0;
      $('m-error').textContent = summary.errors || 0;
    }
    function setProgress(progress = {}) {
      const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
      $('progress-label').textContent = progress.label || 'Chưa chạy';
      $('progress-percent').textContent = percent + '%';
      $('progress-fill').style.width = percent + '%';
      $('progress-fill').classList.toggle('running', Boolean(progress.running));
    }
    function runIdFromReport(report) {
      if (!report) return '';
      if (report.run_id) return String(report.run_id);
      return String(report.artifact_dir || '').split(/[\\\\/]/).filter(Boolean).pop() || '';
    }
    function previewHref(row) {
      const runId = runIdFromReport(activeReport);
      const file = row && row.preview_file;
      if (!runId || !file) return '';
      return '/preview?run=' + encodeURIComponent(runId) + '&file=' + encodeURIComponent(file);
    }
    function renderRows(rows) {
      if (!rows || !rows.length) {
        $('table').innerHTML = '<div class="empty">Không có đề để hiển thị.</div>';
        return;
      }
      $('table').innerHTML = '<table><thead><tr><th>Mã</th><th>Đề</th><th>Đáp án</th><th>Trạng thái</th><th>Test</th><th>Thông tin</th></tr></thead><tbody>' + rows.map(row => {
        const status = row.status || 'ready';
        const info = [
          row.question_count ? row.question_count + ' câu' : '',
          row.answer_key_count ? row.answer_key_count + ' đáp án' : '',
          row.exam_text_chars ? row.exam_text_chars + ' ký tự đề' : '',
          row.errors && row.errors.length ? row.errors.join('; ') : '',
          row.warnings && row.warnings.length ? row.warnings.join('; ') : ''
        ].filter(Boolean).join(' · ');
        const href = previewHref(row);
        const preview = href ? '<a class="mini-link" href="' + html(href) + '" target="_blank" rel="noopener">Test</a>' : '<span class="muted-mini">-</span>';
        return '<tr><td><strong>' + html(row.examCode || row.exam_code || '') + '</strong></td><td>' + html(row.title || row.examFileName || '') + '<div class="mono">' + html(row.examPath || '') + '</div></td><td>' + html(row.answerFileName || '') + '<div class="mono">' + html(row.answerPath || '') + '</div></td><td><span class="status ' + html(status) + '">' + html(status) + '</span></td><td>' + preview + '</td><td>' + html(info || (row.issues || []).join(' · ')) + '</td></tr>';
      }).join('') + '</tbody></table>';
    }
    function renderJob(job) {
      if (!job) return;
      $('server-status').textContent = job.status + (job.paused ? ' · paused' : '');
      $('server-status').className = 'status-dot ' + job.status;
      setProgress(job.progress || {});
      if (job.report) {
        activeReport = job.report;
        setMetrics(job.report.summary);
        renderRows(job.report.rows);
      }
      $('log').textContent = (job.logs || []).join('\\n') || 'Đang chạy...';
      $('log').scrollTop = $('log').scrollHeight;
    }
    async function poll() {
      try {
        const data = await api('/api/jobs/current');
        if (data.job) renderJob(data.job);
        if (!data.job || !['running'].includes(data.job.status)) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      } catch (err) {
        $('log').textContent += '\\n' + err.message;
      }
    }
    $('scan-btn').onclick = async () => {
      try {
        const data = await api('/api/scan', {method:'POST', body:JSON.stringify({folder:$('folder').value.trim()})});
        lastScanRows = data.scan.pairs || [];
        activeReport = null;
        setProgress();
        setMetrics({total:data.scan.readyPairs.length});
        renderRows(lastScanRows);
        $('log').textContent = 'Đã quét ' + (data.scan.totalFiles || data.scan.totalPdf || 0) + ' file hỗ trợ. Sẵn sàng: ' + data.scan.readyPairs.length + ' cặp.';
      } catch (err) {
        $('log').textContent = err.message;
      }
    };
    $('start-btn').onclick = async () => {
      const options = currentOptions();
      if (options.mode === 'draft' && !confirm('Chế độ này sẽ lưu JSON nháp lên Supabase cho các đề đã khớp. Tiếp tục?')) return;
      try {
        const data = await api('/api/jobs/start', {method:'POST', body:JSON.stringify(options)});
        renderJob(data.job);
        if (!pollTimer) pollTimer = setInterval(poll, 1500);
      } catch (err) {
        $('log').textContent = err.message;
      }
    };
    $('pause-btn').onclick = async () => renderJob((await api('/api/jobs/pause', {method:'POST'})).job);
    $('resume-btn').onclick = async () => renderJob((await api('/api/jobs/resume', {method:'POST'})).job);
    $('stop-btn').onclick = async () => renderJob((await api('/api/jobs/stop', {method:'POST'})).job);
    api('/api/health').then(() => {$('server-status').textContent='Localhost ready';}).catch(err => {$('server-status').textContent=err.message;});
  </script>
</body>
</html>`;
}

function renderPreviewHtml() {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MV Klass - Preview đề online</title>
  <style>
    :root{--navy:#0f2a55;--ink:#102033;--muted:#687894;--line:#dce7f5;--soft:#f4f8fc;--white:#fff;--blue:#2563eb;--amber:#f59e0b;--red:#dc2626;--shadow:0 18px 44px rgba(15,42,85,.10)}
    *{box-sizing:border-box}
    body{margin:0;background:#eaf1f9;color:var(--ink);font-family:Segoe UI,system-ui,sans-serif;font-size:14px}
    button{font:inherit}
    .preview-bar{height:62px;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 22px;background:#fff;border-bottom:1px solid var(--line);box-shadow:0 8px 26px rgba(15,42,85,.08);position:sticky;top:0;z-index:5}
    .preview-kicker{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7d98;font-weight:900}
    .preview-title{margin-top:2px;color:var(--navy);font-size:16px;font-weight:950}
    .preview-actions{display:flex;align-items:center;gap:8px}
    .preview-pill{display:inline-flex;align-items:center;min-height:32px;padding:7px 10px;border-radius:999px;border:1px solid #fed7aa;background:#fff7ed;color:#9a3412;font-size:12px;font-weight:950;white-space:nowrap}
    .preview-back{height:38px;border:1px solid #b9d8ff;border-radius:12px;background:#eaf3ff;color:#155eaa;font-weight:950;padding:0 14px;cursor:pointer}
    .preview-error{width:min(720px,calc(100vw - 32px));margin:80px auto;padding:18px;border:1px solid #fecdd3;border-radius:16px;background:#fff1f2;color:#991b1b;font-weight:850;line-height:1.5}
    #runner{min-height:calc(100vh - 62px)}
    .eng10-online-shell{min-height:calc(100vh - 62px);display:flex;flex-direction:column}
    .eng10-online-head{display:flex;align-items:center;gap:14px;padding:14px 18px;background:#fff;border-bottom:1px solid var(--line)}
    .eng10-online-icon-btn{width:40px;height:40px;border:1px solid var(--line);border-radius:12px;background:#fff;color:var(--navy);font-size:24px;line-height:1;cursor:pointer}
    .eng10-online-kicker{font-size:11px;text-transform:uppercase;color:#6b7d98;font-weight:900}
    .eng10-online-head h2{margin:2px 0 0;color:var(--navy);font-size:18px;line-height:1.25}
    .eng10-online-progress{margin-left:auto;min-width:76px;text-align:center;border:1px solid #fed7aa;background:#fff7ed;color:#9a3412;border-radius:999px;padding:8px 10px;font-weight:950}
    .eng10-online-main{flex:1;display:grid;grid-template-columns:minmax(280px,.75fr) minmax(420px,1fr);gap:14px;padding:14px;background:#eaf1f9}
    .eng10-online-source,.eng10-online-paper{border:1px solid var(--line);border-radius:16px;background:#fff;box-shadow:var(--shadow);overflow:auto}
    .eng10-online-source{padding:16px;color:#53657f;font-weight:800;line-height:1.6}
    .eng10-online-page-title{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line);background:#f8fbff;color:var(--navy)}
    .eng10-online-q-card{margin:12px 14px;padding:14px;border:1px solid var(--line);border-radius:14px;background:#fff}
    .eng10-online-q-num{color:#6b7d98;font-size:12px;font-weight:950;text-transform:uppercase;margin-bottom:8px}
    .eng10-online-q-text{color:var(--navy);font-weight:900;line-height:1.5;margin-bottom:10px}
    .eng10-online-options{display:grid;gap:8px}
    .eng10-online-option{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--line);border-radius:12px;background:#f8fbff;padding:10px;cursor:pointer;font-weight:850}
    .eng10-online-input{width:100%;border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-weight:800;outline:none}
    .eng10-online-rewrite-prompt{margin:10px 0;padding:10px 12px;border-radius:12px;background:#f8fbff;border:1px solid var(--line);color:#52627a;font-weight:850}
    .eng10-online-word-bank{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
    .eng10-online-word-bank button,.eng10-online-source button{border:1px solid #b9d8ff;background:#eaf3ff;color:#155eaa;border-radius:999px;padding:7px 10px;font-weight:900;cursor:pointer}
    .eng10-online-foot{display:flex;justify-content:flex-end;gap:10px;padding:12px 16px;background:#fff;border-top:1px solid var(--line)}
    .eng10-online-foot button,.eng10-online-result-actions button{height:42px;border:1px solid var(--line);border-radius:12px;background:#fff;color:var(--navy);font-weight:950;padding:0 16px;cursor:pointer}
    .eng10-online-foot button.primary,.eng10-online-result-actions button.primary{background:#102858;color:#fff;border-color:#102858}
    .eng10-online-foot button:disabled{opacity:.45;cursor:not-allowed}
    .eng10-online-result,.eng10-online-submit-state{position:fixed;inset:0;z-index:20;background:rgba(15,42,85,.34);display:grid;place-items:center;padding:16px}
    .eng10-online-result-card,.eng10-online-submit-panel{width:min(420px,100%);border-radius:18px;background:#fff;border:1px solid var(--line);box-shadow:var(--shadow);padding:22px;text-align:center}
    .eng10-online-score{font-size:48px;color:var(--navy);font-weight:950}.eng10-online-score span{font-size:24px;color:#6b7d98}
    .eng10-online-result-label,.eng10-online-result-text,.eng10-online-result-note{color:#6b7d98;font-weight:850}.eng10-online-result-actions{display:flex;justify-content:center;gap:10px;margin-top:16px}
    @media (max-width:900px){.eng10-online-main{grid-template-columns:1fr}.eng10-online-source{max-height:280px}.preview-bar{height:auto;align-items:flex-start;padding:12px 14px;display:grid}.preview-actions{justify-content:space-between}}
  </style>
</head>
<body>
  <header class="preview-bar">
    <div>
      <div class="preview-kicker">Local preview</div>
      <div id="preview-title" class="preview-title">Đang tải JSON...</div>
    </div>
    <div class="preview-actions">
      <span class="preview-pill">Không publish</span>
      <button class="preview-back" type="button" id="back-btn">Quay lại tool</button>
    </div>
  </header>
  <main id="runner"></main>
  <script src="/assets/eng10-online-exam.js"></script>
  <script>
    const params = new URLSearchParams(location.search);
    const runner = document.getElementById('runner');
    const back = () => { if (history.length > 1) history.back(); else location.href = '/'; };
    document.getElementById('back-btn').onclick = back;
    function showError(message) {
      runner.innerHTML = '<div class="preview-error">' + String(message || 'Không đọc được JSON preview.').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) + '</div>';
    }
    fetch('/api/preview-json?' + params.toString(), { cache: 'no-store' })
      .then(async res => {
        const data = await res.json();
        if (!res.ok || data.ok === false) throw new Error(data.error || 'PREVIEW_LOAD_FAILED');
        document.getElementById('preview-title').textContent = data.exam.title || data.row.title || 'Preview đề online';
        window.Eng10OnlineExam.createRunner({
          container: runner,
          exam: data.exam,
          onClose: back
        });
      })
      .catch(err => showError(err.message));
  </script>
</body>
</html>`;
}

function parsePort(argv = process.argv.slice(2)) {
  const idx = argv.indexOf('--port');
  if (idx >= 0 && argv[idx + 1]) {
    const port = Number(argv[idx + 1]);
    if (Number.isFinite(port) && port > 0) return Math.floor(port);
  }
  return DEFAULT_PORT;
}

if (require.main === module) {
  const port = parsePort();
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`MV Klass Local Exam Agent: http://127.0.0.1:${port}`);
  });
}

module.exports = {
  createServer,
  jobProgress,
  parsePort,
  renderHtml,
  sanitizeJobOptions
};
