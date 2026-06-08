const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.join(__dirname, '..', 'web', 'attendance-app.html');
const edgePath = path.join(__dirname, '..', 'supabase', 'functions', 'exam-online', 'index.ts');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} should exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${endMarker} should exist after ${startMarker}`);
  return source.slice(start, end);
}

test('portal online rows do not expose direct AI JSON generation', () => {
  const source = read(htmlPath);

  assert.doesNotMatch(source, /let portalOnlineGeneratingId = ''/);
  assert.doesNotMatch(source, /generatePortalOnlineJsonAi/);
  assert.doesNotMatch(source, /callExamOnline\('generate_json_ai'/);

  const rowFn = extractBetween(source, 'function renderPortalOnlineRow(row)', 'function portalOnlineRowById');
  assert.doesNotMatch(rowFn, /portalOnlineGeneratingId/);
  assert.doesNotMatch(rowFn, /is-ai/);
  assert.doesNotMatch(rowFn, /Tạo AI/);
  assert.match(rowFn, /is-json/);
  assert.doesNotMatch(rowFn, /Đang tạo/);
  assert.doesNotMatch(rowFn, /generatePortalOnlineJsonAi/);
  assert.doesNotMatch(rowFn, /openPortalOnlineAssets/);
});

test('exam-online direct AI generation action is removed', () => {
  const source = read(edgePath);
  assert.doesNotMatch(source, /if \(action === "generate_json_ai"\)/);
  assert.doesNotMatch(source, /NVIDIA_API_KEY|OPENAI_API_KEY|generateExamJsonWithNvidia|generateExamJsonWithOpenAi/);
  assert.doesNotMatch(source, /pdfjsLib|extractPdfTextForAi|fetchExamPdfForAi/);
  assert.doesNotMatch(source, /https:\/\/integrate\.api\.nvidia\.com\/v1\/chat\/completions|https:\/\/api\.openai\.com\/v1\/responses/);
});
