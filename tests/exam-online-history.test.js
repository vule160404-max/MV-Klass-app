const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'supabase', 'functions', 'exam-online', 'index.ts');
const portalPath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readSource(filePath) {
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

test('exam-online history action returns only the current user attempt summaries', () => {
  const source = readSource(sourcePath);
  const block = extractActionBlock(source, 'history');

  assert.match(block, /studentAttemptHistory\(service,\s*actor\)/);
  assert.match(source, /\.from\("student_online_exam_attempts"\)/);
  assert.match(source, /\.eq\("user_id",\s*actor\.user\.id\)/);
  assert.match(source, /exam_files/);
  assert.match(source, /summary/);
  assert.match(source, /completed_exam_count/);
  assert.match(source, /average_percent/);
  assert.match(source, /latest_attempt_count/);
  assert.match(source, /last_submitted_at/);
  assert.match(source, /is_latest_for_exam/);

  const historyHelper = source.slice(source.indexOf('async function studentAttemptHistory'), source.indexOf('function normalizePromptProvinceKey'));
  assert.doesNotMatch(historyHelper, /\banswers\b/);
  assert.doesNotMatch(historyHelper, /\bexam_json\b/);
});

test('exam-online history summary is based on the latest attempt for each exam file', () => {
  const source = readSource(sourcePath);
  const block = source.slice(source.indexOf('async function studentAttemptHistory'), source.indexOf('function normalizePromptProvinceKey'));

  assert.match(block, /latestByExam/);
  assert.match(block, /exam_file_id/);
  assert.match(block, /submitted_at/);
  assert.match(block, /completed_exam_count:\s*latestAttempts\.length/);
  assert.match(block, /average_percent:\s*averagePercent/);
});

test('student portal exposes online exam history and refreshes it after submit', () => {
  const html = readSource(portalPath);

  assert.match(html, /student-online-history-card/);
  assert.match(html, /student-online-history-modal/);
  assert.match(html, /Lịch sử làm đề online/);
  assert.match(html, /loadStudentOnlineExamHistory/);
  assert.match(html, /renderStudentOnlineExamHistory/);
  assert.match(html, /callExamOnline\('history'/);
  assert.match(html, /refreshStudentOnlineExamHistory/);
  assert.match(html, /onSubmit:[\s\S]*refreshStudentOnlineExamHistory/);
  assert.match(html, /completed_exam_count/);
  assert.match(html, /average_percent/);
  assert.match(html, /is_latest_for_exam/);
});
