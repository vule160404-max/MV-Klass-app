const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readSource() {
  return fs.readFileSync(sourcePath, 'utf8');
}

test('online JSON upload button saves pasted textarea JSON instead of opening a file picker', () => {
  const source = readSource();

  const uploadButton = source.match(/<button type="button"[^>]*id="portal-online-json-upload"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(uploadButton, 'JSON modal should have an upload button');
  assert.match(uploadButton[0], /onclick="savePortalOnlineJson\(\)"/);
  assert.doesNotMatch(uploadButton[0], /choosePortalOnlineJsonFile/);
  assert.match(uploadButton[0], />Upload JSON<\/button>/);

  assert.doesNotMatch(source, /<button type="button"[^>]*onclick="choosePortalOnlineJsonFile\(\)"[^>]*>Upload \.json<\/button>/);
});
