const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createServer } = require('../scripts/exam-agent-ui.js');

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

test('local exam agent UI health endpoint is localhost admin tooling', async () => {
  await withServer(async server => {
    const res = await request(server, 'GET', '/api/health');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.tool, 'exam-agent-ui');
    assert.equal(res.body.public, false);
  });
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
