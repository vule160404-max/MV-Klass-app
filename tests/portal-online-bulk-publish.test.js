const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readSource() {
  return fs.readFileSync(sourcePath, 'utf8');
}

function functionBlock(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = nextName ? source.indexOf(`function ${nextName}(`, start) : -1;
  assert.ok(end > start, `${nextName} follows ${name}`);
  return source.slice(start, end);
}

test('portal online admin supports selecting and publishing multiple exams', () => {
  const source = readSource();

  assert.match(source, /let portalOnlineBulkSelectedIds = new Set\(\);/);
  assert.match(source, /let portalOnlineBulkBusy = false;/);
  assert.match(source, /\.website-online-bulk-bar/);
  assert.match(source, /\.website-online-select/);

  const renderList = functionBlock(source, 'renderPortalOnlineExams', 'renderPortalOnlineRow');
  assert.match(renderList, /renderPortalOnlineBulkBar\(rows,\s*pageRows\)/);
  assert.match(renderList, /renderPortalOnlinePager\(rows\.length,\s*startIndex,\s*endIndex\)/);

  const rowBlock = functionBlock(source, 'renderPortalOnlineRow', 'portalOnlineRowById');
  assert.match(rowBlock, /website-online-select/);
  assert.match(rowBlock, /portalOnlineBulkSelectedIds\.has\(id\)/);
  assert.match(rowBlock, /togglePortalOnlineBulkSelect/);

  assert.match(source, /function renderPortalOnlineBulkBar\(rows,\s*pageRows\)/);
  assert.match(source, /function togglePortalOnlineSelectVisible\(checked\)/);
  assert.match(source, /function renderPortalOnlinePager\(totalRows,\s*startIndex,\s*endIndex\)/);
  assert.match(source, /function publishSelectedPortalOnlineExams\(\)/);
  assert.match(source, /function unpublishSelectedPortalOnlineExams\(\)/);
  assert.match(source, /function applyPortalOnlineBulkPublish\(publish\)/);
  assert.match(source, /function portalOnlineSetPublished\(rowOrId,\s*publish\)/);

  const setPublishedBlock = functionBlock(source, 'portalOnlineSetPublished', 'applyPortalOnlineBulkPublish');
  assert.match(setPublishedBlock, /callExamOnline\(publish \? 'publish' : 'unpublish'/);
  const bulkBlock = functionBlock(source, 'applyPortalOnlineBulkPublish', 'publishSelectedPortalOnlineExams');
  assert.match(bulkBlock, /portalOnlineSetPublished\(row,\s*!!publish\)/);
  assert.match(bulkBlock, /confirmApp/);
  assert.match(bulkBlock, /portalOnlineBulkSelectedIds\.clear\(\)/);

  const selectAllBlock = functionBlock(source, 'togglePortalOnlineSelectVisible', 'clearPortalOnlineBulkSelection');
  assert.match(selectAllBlock, /const foundRows = portalOnlineFilteredRows\(\);/);
  assert.doesNotMatch(selectAllBlock, /slice\(0,\s*PORTAL_ONLINE_RENDER_LIMIT\)/);
});
