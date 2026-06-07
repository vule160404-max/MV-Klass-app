const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const portalPath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readPortal() {
  return fs.readFileSync(portalPath, 'utf8');
}

function functionBlock(html, name, nextName) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = nextName ? html.indexOf(`function ${nextName}(`, start) : -1;
  return html.slice(start, end === -1 ? undefined : end);
}

test('student portal exposes real navigation popovers and compact avatar menu', () => {
  const html = readPortal();

  assert.match(html, /id="student-exam-overview-panel"/);
  assert.match(html, /id="student-exam-notification-button"/);
  assert.match(html, /id="student-exam-notification-popover"/);
  assert.match(html, /id="student-exam-settings-button"/);
  assert.match(html, /id="student-exam-settings-popover"/);
  assert.match(html, /id="student-setting-page-size"/);
  assert.match(html, /id="student-setting-sort"/);
  assert.match(html, /id="student-setting-online"/);

  assert.doesNotMatch(html, /studentExamShowOverview\(\)" role="menuitem">Thông tin học sinh/);
  assert.doesNotMatch(html, /studentExamShowStats\(\)" role="menuitem">Thống kê học tập/);
});

test('student portal premium card uses custom crown svg and fixed desktop sidebar', () => {
  const html = readPortal();

  assert.match(html, /class="student-premium-crown-svg"/);
  assert.match(html, /\.student-exam-sidebar-premium-title::before\{[\s\S]*content:none !important;[\s\S]*display:none !important;/);
  assert.match(html, /@media \(min-width:1180px\)\{[\s\S]*#student-exam-portal \.student-exam-sidebar\{[\s\S]*position:fixed !important;[\s\S]*height:100dvh !important;[\s\S]*overflow-y:auto !important;/);
});

test('student portal settings persist locally and do not live-filter on input/change', () => {
  const html = readPortal();
  const bindBlock = functionBlock(html, 'bindStudentExamPortalEvents', 'studentExamFind');

  assert.match(html, /const STUDENT_EXAM_SETTINGS_KEY = 'mvk_student_portal_settings_v1'/);
  assert.match(html, /localStorage\.setItem\(STUDENT_EXAM_SETTINGS_KEY, JSON\.stringify\(studentExamSettings\)\)/);
  assert.match(html, /studentExamApplySettingsFromPanel\(\)[\s\S]*applyStudentExamFilters\(\)/);

  assert.doesNotMatch(bindBlock, /addEventListener\('input'[\s\S]*applyStudentExamFilters/);
  assert.doesNotMatch(bindBlock, /addEventListener\('change',\s*applyStudentExamFilters/);
  assert.match(bindBlock, /addEventListener\('keydown', event => \{[\s\S]*event\.key !== 'Enter'[\s\S]*applyStudentExamFilters\(\)/);
  assert.match(html, /id="student-exam-filter-reset"/);
});
