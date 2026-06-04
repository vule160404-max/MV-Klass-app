const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readSource() {
  return fs.readFileSync(sourcePath, 'utf8');
}

test('online image upload shows immediate selected-file feedback in the assets modal', () => {
  const source = readSource();

  assert.match(source, /let portalOnlineAssetUploadPreview = null;/);
  assert.match(source, /function setPortalOnlineAssetUploadPreview\(preview\)/);
  assert.match(source, /function portalOnlineAssetPreviewForSlot\(slotId\)/);
  assert.match(source, /class="website-online-asset-preview/);
  assert.match(source, /Đã chọn:/);
  assert.match(source, /URL\.createObjectURL\(file\)/);

  const uploadFn = source.match(/async function uploadPortalOnlineAssetFromInput\(\) \{[\s\S]*?\n\}\n\nasync function togglePortalOnlinePublished/);
  assert.ok(uploadFn, 'uploadPortalOnlineAssetFromInput should exist');
  assert.ok(
    uploadFn[0].indexOf('setPortalOnlineAssetUploadPreview') < uploadFn[0].indexOf('ensureSessionFresh'),
    'selected-file feedback should render before session/network work starts'
  );
});
