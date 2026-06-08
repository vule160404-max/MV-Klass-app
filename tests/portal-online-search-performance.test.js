const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readSource() {
  return fs.readFileSync(sourcePath, 'utf8');
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} should exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${endMarker} should exist after ${startMarker}`);
  return source.slice(start, end);
}

test('portal online search is debounced and renders from prepared rows', () => {
  const source = readSource();

  assert.match(source, /const PORTAL_ONLINE_RENDER_LIMIT = 24;/);
  assert.match(source, /const PORTAL_ONLINE_SEARCH_RENDER_DELAY_MS = 420;/);
  assert.match(source, /const PORTAL_ONLINE_MIN_QUERY_LENGTH = 2;/);
  assert.match(source, /let portalOnlinePreparedRows = \[\];/);
  assert.match(source, /function portalOnlineNormalizedQuery\(\)/);
  assert.match(source, /function portalOnlineHasSearchQuery\(\)/);
  assert.match(source, /function portalOnlineBuildSearchText\(row\)/);
  assert.match(source, /function schedulePortalOnlineRender\(delayMs = 0\)/);
  assert.match(source, /requestIdleCallback/);
  assert.match(source, /function preparePortalOnlineRows\(\)/);
  assert.match(source, /rows\.slice\(0, PORTAL_ONLINE_RENDER_LIMIT\)/);
  assert.match(source, /website-online-empty/);

  const searchHandler = extractBetween(source, 'function onPortalOnlineSearch(value)', 'function onPortalOnlineStatus');
  assert.match(searchHandler, /schedulePortalOnlineRender\(PORTAL_ONLINE_SEARCH_RENDER_DELAY_MS\)/);
  assert.doesNotMatch(searchHandler, /renderPortalOnlineExams\(\)/);

  const filterFn = extractBetween(source, 'function portalOnlineFilteredRows()', 'function renderPortalOnlineExams');
  assert.match(filterFn, /if \(q\.length < PORTAL_ONLINE_MIN_QUERY_LENGTH\) return \[\];/);

  const renderFn = extractBetween(source, 'function renderPortalOnlineExams()', 'function renderPortalOnlineRow');
  assert.match(renderFn, /if \(!portalOnlineHasSearchQuery\(\)\) \{/);
});
