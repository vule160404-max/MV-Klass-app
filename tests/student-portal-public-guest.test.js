const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const portalPath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readPortal() {
  return fs.readFileSync(portalPath, 'utf8');
}

function functionBlock(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = nextName ? source.indexOf(`function ${nextName}(`, start) : -1;
  return source.slice(start, end === -1 ? undefined : end);
}

test('slash portal can boot the public library without a login session', () => {
  const html = readPortal();
  const initAuth = functionBlock(html, 'initAuth', 'bankTxStatusLabel');
  const loadFiles = functionBlock(html, 'loadStudentExamFiles', 'bindStudentExamPortalEvents');

  assert.match(html, /let studentExamGuestMode = false;/);
  assert.match(html, /function isPortalPublicEntryPath\(\)/);
  assert.match(html, /function bootStudentExamPublicPortal\(/);
  assert.match(initAuth, /isPortalPublicEntryPath\(\)/);
  assert.match(initAuth, /bootStudentExamPublicPortal\(\)/);
  assert.doesNotMatch(loadFiles, /if \(!currentSession\?\.access_token\) return;/);
  assert.match(loadFiles, /const isGuest = isStudentExamGuestMode\(\);/);
  assert.match(loadFiles, /headers: isGuest \? \{ apikey: KEY \} : getHeaders/);
});

test('guest library actions open auth modal instead of accessing files', () => {
  const html = readPortal();
  const preview = functionBlock(html, 'openStudentExamPreview', 'closeStudentExamPreview');
  const online = functionBlock(html, 'openStudentOnlineExam', 'incrementStudentExamDownload');
  const download = functionBlock(html, 'downloadStudentExamFile', 'trackStudentExamPortalEvent');
  const premium = functionBlock(html, 'studentExamSetView', 'studentExamSetSidebarActive');

  assert.match(html, /id="student-guest-auth-modal"/);
  assert.match(html, /function openStudentGuestAuthModal\(/);
  assert.match(html, /function requireStudentPortalAuth\(/);
  assert.match(preview, /requireStudentPortalAuth\('preview'\)/);
  assert.match(online, /requireStudentPortalAuth\('online'\)/);
  assert.match(download, /requireStudentPortalAuth\('download'\)/);
  assert.match(premium, /requireStudentPortalAuth\('premium'\)/);
});
