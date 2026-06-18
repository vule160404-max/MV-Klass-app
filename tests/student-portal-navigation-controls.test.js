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
  assert.doesNotMatch(html, /openStudentExamSettingsPanel\(\)" role="menuitem"/);
  assert.match(html, /id="student-setting-page-size"/);
  assert.match(html, /id="student-setting-sort"/);
  assert.match(html, /id="student-setting-online"/);
  assert.match(html, /id="student-setting-display-name"/);
  assert.match(html, /id="student-setting-density"/);
  assert.match(html, /class="student-exam-zalo-btn"/);
  assert.match(html, /https:\/\/zalo\.me\/0916045202/);
  assert.match(html, /\.student-exam-zalo-btn\{[\s\S]*z-index:3900 !important;/);
  assert.doesNotMatch(html, /\.student-exam-zalo-btn\{[\s\S]{0,120}z-index:8 !important;/);
  const statsStart = html.indexOf('id="student-exam-stats-panel"');
  const premiumStart = html.indexOf('id="student-exam-premium-view"');
  const statsClose = html.lastIndexOf('</section>', premiumStart);
  const zaloIndex = html.indexOf('class="student-exam-zalo-btn"');
  assert.ok(zaloIndex > statsClose, 'Zalo widget is outside hidden stats panel');

  assert.doesNotMatch(html, /studentExamShowOverview\(\)" role="menuitem">/);
  assert.doesNotMatch(html, /studentExamShowStats\(\)" role="menuitem">/);
});

test('student portal premium card uses custom crown svg and fixed desktop sidebar', () => {
  const html = readPortal();

  assert.match(html, /class="student-premium-crown-svg"/);
  assert.match(html, /id="student-exam-sidebar-premium-copy"/);
  assert.match(html, /id="student-exam-sidebar-premium-action"/);
  assert.match(html, /function renderStudentExamSidebarPremiumCard\(\)/);
  assert.match(html, /k.ch ho.t/iu);
  assert.match(html, /N.ng c.p ngay/iu);
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
  assert.match(html, /h.t l..t t.i mi.n ph./iu);
  assert.match(html, /.ng k. Premium/iu);
  assert.match(html, /data-student-notification-action="\$\{escapeHtml\(item\.action\)\}"/);
  assert.match(html, /action:\s*'premium'/);
  assert.match(html, /action:\s*'online'/);
});

test('student exam cards show manual save button instead of a three-dot menu', () => {
  const html = readPortal();
  const cardBlock = functionBlock(html, 'studentExamCard', 'renderStudentExamSelectOptions');
  const previewBlock = functionBlock(html, 'openStudentExamPreview', 'closeStudentExamPreview');

  assert.match(html, /function studentExamIsManuallySaved\(/);
  assert.match(html, /function studentExamSaveButton\(/);
  assert.match(html, /async function saveStudentExamForLater\(/);
  assert.match(html, /data-exam-save/);
  assert.match(html, /\.student-document-progress\.is-done/);
  assert.match(cardBlock, /studentExamSaveButton\(row\)/);
  assert.doesNotMatch(previewBlock, /trackStudentExamPortalEvent\(row\.id, 'open'\)/);
  assert.doesNotMatch(cardBlock, /student-document-menu/);
  assert.doesNotMatch(cardBlock, /&vellip;/);
});

test('premium signup mode can disable package sales and grant new signups premium metadata', () => {
  const html = readPortal();
  const adminBlock = functionBlock(html, 'renderPortalPremiumAdmin', 'openPortalPremiumConfigModal');
  const signupModeBlock = functionBlock(html, 'isPortalPremiumSignupBypassActive', 'signUpStudentAccount');
  const signupBlock = functionBlock(html, 'signUpStudentAccount', 'signOutUser');

  assert.match(html, /function togglePortalPremiumSignupMode\(/);
  assert.match(adminBlock, /Tắt đăng ký gói/);
  assert.match(adminBlock, /Bật lại đăng ký gói/);
  assert.match(adminBlock, /Khi tắt, học sinh đăng ký mới/);
  assert.doesNotMatch(adminBlock, /Premium\? Học sinh/);
  assert.match(adminBlock, /products\.every\(p => p && p\.is_active === false\)/);
  assert.match(adminBlock, /portal_premium_products\?product_key=in\./);
  assert.match(signupModeBlock, /portal-premium-checkout/);
  assert.match(signupModeBlock, /action:\s*'products'/);
  assert.match(signupModeBlock, /products\.every\(p => p && p\.is_active === false\)/);
  assert.match(signupBlock, /const premiumBypass = await isPortalPremiumSignupBypassActive\(\)/);
  assert.match(signupBlock, /portal_plan:\s*'premium'/);
  assert.match(signupBlock, /portal_premium_source:\s*'signup_packages_disabled'/);
});
