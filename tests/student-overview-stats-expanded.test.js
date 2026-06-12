const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readSource() {
  return fs.readFileSync(sourcePath, 'utf8');
}

function functionBlock(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = nextName ? source.indexOf(`function ${nextName}(`, start) : -1;
  return source.slice(start, end === -1 ? undefined : end);
}

test('overview page renders a full dashboard instead of only KPI cards', () => {
  const source = readSource();
  const renderBlock = functionBlock(source, 'renderStudentExamOverviewPanel', 'studentExamShowOverview');

  assert.match(source, /id="student-exam-overview-hero"/);
  assert.match(source, /id="student-exam-overview-focus"/);
  assert.match(source, /id="student-exam-overview-activity"/);
  assert.match(source, /class="student-exam-overview-layout"/);
  assert.match(source, /function studentExamOverviewFocusItems\(\)/);
  assert.match(source, /function studentExamOverviewActivityItems\(\)/);
  assert.match(renderBlock, /student-exam-overview-hero/);
  assert.match(renderBlock, /student-exam-overview-focus/);
  assert.match(renderBlock, /student-exam-overview-activity/);
});

test('progress page renders compact KPI, recommendation, and result sections', () => {
  const source = readSource();
  const showStatsBlock = functionBlock(source, 'studentExamShowStats', 'document.addEventListener');
  const statsBlock = functionBlock(source, 'renderStudentExamStatsPanel', 'document.addEventListener');

  assert.match(source, />Tiến độ</);
  assert.match(source, /Kết quả học tập/);
  assert.match(source, /id="student-exam-stats-kpi-grid"/);
  assert.match(source, /id="student-exam-stats-online-list"/);
  assert.match(source, /id="student-exam-stats-insights"/);
  assert.match(source, /student-exam-quiet-actions/);
  assert.match(source, /function studentExamStatsKpiItems\(\)/);
  assert.match(source, /function studentExamStatsInsightItems\(\)/);
  assert.match(source, /function studentExamOpenedRows\(limit\)/);
  assert.match(source, /function studentExamBestOnlineAttempt\(\)/);
  assert.doesNotMatch(source, /id="student-exam-stats-activity-list"/);
  assert.match(showStatsBlock, /renderStudentExamStatsPanel\(\)/);
  assert.match(statsBlock, /student-exam-stats-kpi-grid/);
  assert.match(statsBlock, /student-exam-stats-online-list/);
  assert.match(statsBlock, /student-exam-stats-insights/);
});
