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

  const saveFn = extractBetween(source, 'async function savePortalOnlineJson()', 'function openPortalOnlineAssets');
  assert.match(saveFn, /renderPortalOnlineJsonAssets\(\)/);
  assert.doesNotMatch(saveFn, /closePortalOnlineJsonModal\(\)/);

  const assetsFn = source.match(/function openPortalOnlineAssets\(examId\) \{[\s\S]*?\n\}/);
  assert.ok(assetsFn, 'openPortalOnlineAssets should exist');
  assert.match(assetsFn[0], /openPortalOnlineJson\(id, \{ focusAssets: true \}\)/);

  const imageUploadFn = extractBetween(source, 'function uploadPortalOnlineJsonImage()', 'function openPortalOnlineAssets');
  assert.match(imageUploadFn, /choosePortalOnlineAsset\(id, slotId\)/);
  assert.doesNotMatch(imageUploadFn, /portal-online-json-input/);
});
