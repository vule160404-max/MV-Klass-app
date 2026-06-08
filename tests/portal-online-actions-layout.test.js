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

test('portal online row actions use a compact toolbar and separated publish state', () => {
  const source = readSource();

  assert.match(source, /\.website-online-action-tools/);
  assert.match(source, /\.website-online-action-publish/);
  assert.match(source, /is-publish/);
  assert.match(source, /is-unpublish/);

  const rowTemplate = extractBetween(source, 'function renderPortalOnlineRow(row)', 'function portalOnlineRowById');
  assert.match(rowTemplate, /class="website-online-action-tools"/);
  assert.match(rowTemplate, />Prompt<\/button>/);
  assert.match(rowTemplate, />JSON<\/button>/);
  assert.match(rowTemplate, />[^<]*nh<\/button>/);
  assert.match(rowTemplate, />Ngu[^<]*n<\/button>/);
  assert.doesNotMatch(rowTemplate, />Prompt AI<\/button>/);
  assert.doesNotMatch(rowTemplate, />N[^<]*p JSON<\/button>/);
});
