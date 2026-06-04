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

  const imageButton = source.match(/<button type="button"[^>]*id="portal-online-json-image-upload"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(imageButton, 'JSON modal should have an image upload button next to Upload JSON');
  assert.match(imageButton[0], /onclick="uploadPortalOnlineJsonImage\(\)"/);
  assert.match(imageButton[0], />Upload ảnh<\/button>/);

  assert.match(source, /id="portal-online-json-assets-list"/);
  assert.doesNotMatch(source, /id="portal-online-json-save"/);
  assert.doesNotMatch(source, />Lưu bản nháp<\/button>/);
  assert.doesNotMatch(source, /<button type="button"[^>]*onclick="choosePortalOnlineJsonFile\(\)"[^>]*>Upload \.json<\/button>/);

  const saveFn = source.match(/async function savePortalOnlineJson\(\) \{[\s\S]*?\n\}\n\nfunction openPortalOnlineAssets/);
  assert.ok(saveFn, 'savePortalOnlineJson should exist');
  assert.match(saveFn[0], /renderPortalOnlineJsonAssets\(\)/);
  assert.doesNotMatch(saveFn[0], /closePortalOnlineJsonModal\(\)/);

  const assetsFn = source.match(/function openPortalOnlineAssets\(examId\) \{[\s\S]*?\n\}/);
  assert.ok(assetsFn, 'openPortalOnlineAssets should exist');
  assert.match(assetsFn[0], /openPortalOnlineJson\(id, \{ focusAssets: true \}\)/);

  const imageUploadFn = source.match(/function uploadPortalOnlineJsonImage\(\) \{[\s\S]*?\n\}\n\nfunction openPortalOnlineAssets/);
  assert.ok(imageUploadFn, 'uploadPortalOnlineJsonImage should exist');
  assert.match(imageUploadFn[0], /choosePortalOnlineAsset\(id, slotId\)/);
  assert.doesNotMatch(imageUploadFn[0], /portal-online-json-input/);
});
