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

test('online image upload shows immediate selected-file feedback in the assets modal', () => {
  const source = readSource();

  assert.match(source, /let portalOnlineAssetUploadPreview = null;/);
  assert.match(source, /function setPortalOnlineAssetUploadPreview\(preview\)/);
  assert.match(source, /function portalOnlineAssetPreviewForSlot\(slotId\)/);
  assert.match(source, /class="website-online-asset-preview/);
  assert.match(source, /ch[^;]*n:/i);
  assert.match(source, /URL\.createObjectURL\(file\)/);

  const uploadFn = extractBetween(
    source,
    'async function uploadPortalOnlineAssetFromInput()',
    'async function togglePortalOnlinePublished'
  );
  assert.ok(
    uploadFn.indexOf('setPortalOnlineAssetUploadPreview') < uploadFn.indexOf('ensureSessionFresh'),
    'selected-file feedback should render before session/network work starts'
  );
});
