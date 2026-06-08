const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.join(__dirname, '..', 'web', 'attendance-app.html');
const edgePath = path.join(__dirname, '..', 'supabase', 'functions', 'exam-online', 'index.ts');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function extractActionBlock(source, actionName) {
  const marker = `if (action === "${actionName}")`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${actionName} action should exist`);
  const next = source.indexOf('\n    if (action === ', start + marker.length);
  const fallback = source.indexOf('\n    return json({ ok: false, error: "Unknown action" }', start);
  const end = next === -1 ? fallback : next;
  assert.ok(end > start, `${actionName} action block should be extractable`);
  return source.slice(start, end);
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} should exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${endMarker} should exist after ${startMarker}`);
  return source.slice(start, end);
}

test('portal online rows expose AI JSON generation without auto publishing', () => {
  const source = read(htmlPath);

  assert.match(source, /let portalOnlineGeneratingId = ''/);
  assert.match(source, /generatePortalOnlineJsonAi/);
  assert.match(source, /callExamOnline\('generate_json_ai', \{ exam_file_id: id \}\)/);
  assert.match(source, /confirmApp\([\s\S]*Tạo JSON bằng AI/);
  assert.match(source, /portalOnlineMergeExam\(id, data\.online_exam\)/);
  assert.match(source, /loadPortalOnlineExams\(true\)/);
  assert.match(source, /Đã tạo JSON bản nháp/);

  const rowFn = extractBetween(source, 'function renderPortalOnlineRow(row)', 'function portalOnlineRowById');
  assert.match(rowFn, /portalOnlineGeneratingId === id/);
  assert.match(rowFn, /Tạo JSON AI/);
  assert.match(rowFn, /Đang tạo/);
  assert.match(rowFn, /generatePortalOnlineJsonAi/);

  const generateFn = extractBetween(source, 'async function generatePortalOnlineJsonAi(examId)', 'function openPortalOnlineJson');
  assert.doesNotMatch(generateFn, /callExamOnline\('publish'/);
  assert.doesNotMatch(generateFn, /togglePortalOnlinePublished/);
});

test('exam-online generate_json_ai is admin only and fails closed before publishing', () => {
  const source = read(edgePath);
  const block = extractActionBlock(source, 'generate_json_ai');

  assert.match(block, /assertAdmin\(actor\)/);
  assert.match(block, /findPromptTemplateForExam\(service, row\)/);
  assert.match(block, /renderPromptTemplate\(template, row\)/);
  assert.match(block, /OPENAI_API_KEY/);
  assert.match(block, /OPENAI_API_KEY_NOT_CONFIGURED|AI_GENERATION_NOT_READY/);
  assert.match(source, /function saveGeneratedExamJsonDraft/);
  assert.match(source, /validateExamJson/);
  assert.match(source, /status:\s*"draft"/);
  assert.doesNotMatch(block, /status:\s*"published"/);
  assert.doesNotMatch(block, /published_at:\s*new Date/);
});
