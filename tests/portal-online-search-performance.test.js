const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readSource() {
  return fs.readFileSync(sourcePath, 'utf8');
}

test('portal online search is debounced and renders from prepared rows', () => {
  const source = readSource();

  assert.match(source, /const PORTAL_ONLINE_RENDER_LIMIT = \d+;/);
  assert.match(source, /const PORTAL_ONLINE_SEARCH_RENDER_DELAY_MS = \d+;/);
  assert.match(source, /let portalOnlinePreparedRows = \[\];/);
  assert.match(source, /function portalOnlineHasSearchQuery\(\)/);
  assert.match(source, /function portalOnlineBuildSearchText\(row\)/);
  assert.match(source, /function schedulePortalOnlineRender\(delayMs = 0\)/);
  assert.match(source, /function preparePortalOnlineRows\(\)/);
  assert.match(source, /rows\.slice\(0, PORTAL_ONLINE_RENDER_LIMIT\)/);
  assert.match(source, /Nhập từ khóa để tìm đề online/);

  const searchHandler = source.match(/function onPortalOnlineSearch\(value\) \{[\s\S]*?\n\}/);
  assert.ok(searchHandler, 'onPortalOnlineSearch handler should exist');
  assert.match(searchHandler[0], /schedulePortalOnlineRender\(PORTAL_ONLINE_SEARCH_RENDER_DELAY_MS\)/);
  assert.doesNotMatch(searchHandler[0], /renderPortalOnlineExams\(\)/);

  const filterFn = source.match(/function portalOnlineFilteredRows\(\) \{[\s\S]*?\n\}/);
  assert.ok(filterFn, 'portalOnlineFilteredRows should exist');
  assert.match(filterFn[0], /if \(!q\) return \[\];/);

  const renderFn = source.match(/function renderPortalOnlineExams\(\) \{[\s\S]*?\n\}\n\nfunction renderPortalOnlineRow/);
  assert.ok(renderFn, 'renderPortalOnlineExams should exist');
  assert.match(renderFn[0], /if \(!portalOnlineHasSearchQuery\(\)\) \{/);
});
