const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readSource() {
  return fs.readFileSync(sourcePath, 'utf8');
}

test('website management can filter recently created student portal accounts', () => {
  const source = readSource();

  assert.match(source, /const PORTAL_RECENT_ACCOUNT_WINDOW_DAYS = 7;/);
  assert.match(source, /profiles\?select=[^']*created_at[^']*&limit=5000/);
  assert.match(source, /function portalUserIsRecentlyCreated\(profile\)/);
  assert.match(source, /Date\.now\(\) - createdAt <= PORTAL_RECENT_ACCOUNT_WINDOW_DAYS \* 24 \* 60 \* 60 \* 1000/);
  assert.match(source, /<option value="recent">Tài khoản mới lập gần đây<\/option>/);
  assert.match(source, /filter === 'recent' \? portalUserIsRecentlyCreated\(p\)/);
  assert.match(source, /<span class="portal-user-chip">Mới lập <strong>\$\{counts\.recent\}<\/strong><\/span>/);
});
