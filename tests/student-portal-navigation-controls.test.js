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
  assert.match(html, /student-page-library/);
  assert.match(html, /function studentExamSetPortalPage\(page\)/);
  assert.match(html, /student-page-overview[\s\S]*\.student-exam-filters/);
  assert.match(html, /student-page-stats[\s\S]*\.student-exam-section/);
  assert.match(html, /id="student-exam-notification-button"/);
  assert.match(html, /id="student-exam-notification-badge"/);
  assert.match(html, /id="student-exam-notification-popover"/);
  assert.match(html, /id="student-exam-settings-popover"/);
  assert.doesNotMatch(html, /id="student-exam-settings-button"/);
  assert.match(html, /openStudentExamSettingsPanel\(\)" role="menuitem">Cài đặt tài khoản/);
  assert.match(html, /id="student-setting-page-size"/);
  assert.match(html, /id="student-setting-sort"/);
  assert.match(html, /id="student-setting-online"/);
  assert.match(html, /id="student-setting-display-name"/);
  assert.match(html, /id="student-setting-density"/);

  assert.doesNotMatch(html, /studentExamShowOverview\(\)" role="menuitem">Thông tin học sinh/);
  assert.doesNotMatch(html, /studentExamShowStats\(\)" role="menuitem">Thống kê học tập/);
});

test('student portal premium card uses custom crown svg and fixed desktop sidebar', () => {
  const html = readPortal();

  assert.match(html, /class="student-premium-crown-svg"/);
  assert.match(html, /id="student-exam-sidebar-premium-copy"/);
  assert.match(html, /id="student-exam-sidebar-premium-action"/);
  assert.match(html, /function renderStudentExamSidebarPremiumCard\(\)/);
  assert.match(html, /ÄÃ£ kÃ­ch hoáº¡t|Đã kích hoạt/);
  assert.match(html, /NÃ¢ng cáº¥p ngay|Nâng cấp ngay/);
  assert.match(html, /\.student-exam-sidebar-premium-title::before\{[\s\S]*content:none !important;[\s\S]*display:none !important;/);
  assert.match(html, /student-exam-sidebar-premium-action\.is-active/);
  assert.match(html, /@media \(min-width:1180px\)\{[\s\S]*#student-exam-portal \.student-exam-sidebar\{[\s\S]*position:fixed !important;[\s\S]*height:100dvh !important;[\s\S]*overflow-y:auto !important;/);
});

test('student portal settings persist locally and do not live-filter on input/change', () => {
  const html = readPortal();
  const bindBlock = functionBlock(html, 'bindStudentExamPortalEvents', 'studentExamFind');

  assert.match(html, /const STUDENT_EXAM_SETTINGS_KEY = 'mvk_student_portal_settings_v1'/);
  assert.match(html, /localStorage\.setItem\(STUDENT_EXAM_SETTINGS_KEY, JSON\.stringify\(studentExamSettings\)\)/);
  assert.match(html, /displayName:\s*''/);
  assert.match(html, /density:\s*'comfortable'/);
  assert.match(html, /studentExamApplySettingsFromPanel\(\)[\s\S]*applyStudentExamFilters\(\)/);

  assert.doesNotMatch(bindBlock, /addEventListener\('input'[\s\S]*applyStudentExamFilters/);
  assert.doesNotMatch(bindBlock, /addEventListener\('change',\s*applyStudentExamFilters/);
  assert.match(bindBlock, /addEventListener\('keydown', event => \{[\s\S]*event\.key !== 'Enter'[\s\S]*applyStudentExamFilters\(\)/);
  assert.match(html, /id="student-exam-filter-reset"/);
});

test('student portal notifications are conditional and show a red badge', () => {
  const html = readPortal();

  assert.match(html, /function studentExamNotificationItems\(\)/);
  assert.match(html, /student-exam-notification-badge/);
  assert.match(html, /badge\.hidden = count <= 0/);
  assert.match(html, /Sắp hết lượt tải miễn phí|Sáº¯p háº¿t lÆ°á»£t táº£i miá»…n phÃ­/);
  assert.match(html, /Đăng ký Premium|ÄÄƒng kÃ½ Premium/);
  assert.match(html, /data-student-notification-action="\$\{escapeHtml\(item\.action\)\}"/);
  assert.match(html, /action:\s*'premium'/);
  assert.match(html, /action:\s*'online'/);
});
