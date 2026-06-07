const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readSource() {
  return fs.readFileSync(sourcePath, 'utf8');
}

test('portal online row actions use a compact toolbar and separated publish state', () => {
  const source = readSource();

  assert.match(source, /\.website-online-action-tools/);
  assert.match(source, /\.website-online-action-publish/);
  assert.match(source, /is-publish/);
  assert.match(source, /is-unpublish/);

  const rowTemplate = source.match(/function renderPortalOnlineRow\(row\) \{[\s\S]*?<\/div>`;\n\}/);
  assert.ok(rowTemplate, 'renderPortalOnlineRow template should exist');
  assert.match(rowTemplate[0], /class="website-online-action-tools"/);
  assert.match(rowTemplate[0], />Prompt<\/button>/);
  assert.match(rowTemplate[0], />JSON<\/button>/);
  assert.match(rowTemplate[0], />Ảnh<\/button>|>áº¢nh<\/button>/);
  assert.match(rowTemplate[0], />Nguồn<\/button>|>Nguá»“n<\/button>/);
  assert.doesNotMatch(rowTemplate[0], />Prompt AI<\/button>/);
  assert.doesNotMatch(rowTemplate[0], />Nạp JSON<\/button>|>Náº¡p JSON<\/button>/);
});
