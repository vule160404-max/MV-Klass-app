const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { createServer, jobProgress, renderHtml, renderPreviewHtml, sanitizeJobOptions } = require('../scripts/exam-agent-ui.js');

function request(server, method, route, body) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path: route,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: data ? JSON.parse(data) : null
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(handler) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await handler(server);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function validExam(id = 'preview-001') {
  return {
    exam_id: id,
    title: 'De preview',
    pages: [{ id: 'page-1', title: 'Page 1', question_ids: [1] }],
    questions: [{
      id: 1,
      type: 'multiple_choice',
      question: 'Choose the best answer.',
      options: ['A. one', 'B. two', 'C. three', 'D. four'],
      answer: 'A'
    }]
  };
}

test('local exam agent UI health endpoint is localhost admin tooling', async () => {
  await withServer(async server => {
    const res = await request(server, 'GET', '/api/health');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.tool, 'exam-agent-ui');
    assert.equal(res.body.public, false);
  });
});

test('local exam agent UI renders as an app shell', () => {
  const html = renderHtml();

  assert.match(html, /class="app-shell"/);
  assert.match(html, /class="app-sidebar"/);
  assert.match(html, /class="app-workspace"/);
  assert.match(html, /id="activity-panel"/);
  assert.match(html, /id="detail-panel"/);
});

test('local preview CSS makes rich text markers visually distinct', () => {
  const html = renderPreviewHtml();

  assert.match(html, /\.eng10-online-source strong/);
  assert.match(html, /\.eng10-online-option u/);
});

test('local exam agent UI reports scan errors as JSON', async () => {
  await withServer(async server => {
    const res = await request(server, 'POST', '/api/scan', { folder: 'Z:/missing-folder-for-mvklass' });

    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /LOCAL_FOLDER/);
  });
});

test('local exam agent UI rejects publish mode', async () => {
  await withServer(async server => {
    const res = await request(server, 'POST', '/api/jobs/start', {
      folder: '.',
      mode: 'publish'
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /dry-run|draft/);
  });
});

test('local exam agent UI accepts a manual source prompt override', () => {
  const options = sanitizeJobOptions({
    folder: 'C:/DeThi/ThanhHoa',
    mode: 'dry-run',
    promptText: '  Prompt nguồn Thanh Hóa  '
  });

  assert.equal(options.promptText, 'Prompt nguồn Thanh Hóa');
});

test('local exam agent UI progress reports running percent from batch rows', () => {
  const progress = jobProgress({
    status: 'running',
    report: {
      summary: { total: 4 },
      rows: [
        { status: 'dry_run_ready' },
        { status: 'running', examCode: '002', title: 'Đề 002' }
      ]
    }
  });

  assert.equal(progress.percent, 25);
  assert.equal(progress.running, true);
  assert.match(progress.label, /002/);
});

test('local exam agent preview endpoint reads generated draft JSON', async () => {
  const runId = `test-preview-${Date.now()}`;
  const filePath = path.resolve('_exam_agent_runs', 'local-jobs', runId, 'draft', '001_preview.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    row: { title: 'De preview' },
    exam: validExam(),
    errors: [],
    warnings: []
  }), 'utf8');

  try {
    await withServer(async server => {
      const res = await request(server, 'GET', `/api/preview-json?run=${encodeURIComponent(runId)}&file=${encodeURIComponent('draft/001_preview.json')}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.exam.exam_id, 'preview-001');
      assert.deepEqual(res.body.errors, []);
    });
  } finally {
    fs.rmSync(path.resolve('_exam_agent_runs', 'local-jobs', runId), { recursive: true, force: true });
  }
});

test('local exam agent preview endpoint blocks path traversal', async () => {
  await withServer(async server => {
    const res = await request(server, 'GET', '/api/preview-json?run=..&file=draft%2Fsecret.json');

    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /PREVIEW/);
  });
});
