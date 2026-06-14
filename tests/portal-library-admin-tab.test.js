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
  const end = nextName ? source.indexOf(`function ${nextName}(`, start) : source.length;
  assert.ok(end > start, nextName ? `${nextName} follows ${name}` : `${name} block is readable`);
  return source.slice(start, end);
}

test('portal library admin is separated into an admin-only sidebar tab', () => {
  const source = readSource();

  assert.match(source, /id="tab-btn-portal-library-admin" onclick="showTab\('portal-library-admin'\)"/);
  assert.match(source, /id="tab-portal-library-admin"/);
  assert.match(source, /id="portal-library-admin-mount"/);
  assert.match(source, /id="tab-btn-portal-users-admin" onclick="showTab\('portal-users-admin'\)"/);
  assert.match(source, /id="tab-portal-users-admin"/);
  assert.match(source, /id="portal-users-admin-mount"/);
  assert.match(source, /id="portal-student-users-panel"/);
  assert.match(source, /'portal-library-admin'/);
  assert.match(source, /'portal-users-admin'/);
  assert.match(source, /setVisible\('tab-btn-portal-library-admin', 'tab-portal-library-admin', isAdmin\(\)\)/);
  assert.match(source, /setVisible\('tab-btn-portal-users-admin', 'tab-portal-users-admin', isAdmin\(\)\)/);
  assert.match(source, /teacherHiddenTabBtnIds[\s\S]*'tab-btn-portal-library-admin'/);
  assert.match(source, /teacherHiddenTabBtnIds[\s\S]*'tab-btn-portal-users-admin'/);
  assert.match(source, /t === 'portal-library-admin'/);
  assert.match(source, /t === 'portal-users-admin'/);
});

test('website admin stays focused on online exams while library panel is mounted elsewhere', () => {
  const source = readSource();

  assert.match(source, /class="website-admin-subtabs is-online-only"/);
  assert.match(source, /id="website-admin-subtab-library"[\s\S]*hidden>Quản lí kho tài liệu/);
  assert.match(source, /id="website-admin-panel-library"/);
  assert.match(source, /class="website-admin-panel active" id="website-admin-panel-online"/);

  const mountBlock = functionBlock(source, 'mountPortalLibraryAdminPanel', 'setWebsiteAdminSubtab');
  assert.match(mountBlock, /mount\.appendChild\(panel\)/);
  assert.match(mountBlock, /websiteAdminSubtab = 'library'/);
  assert.match(mountBlock, /mountPortalUsersAdminPanel\(\)/);
  assert.match(mountBlock, /portal-library-kpi-last-sync/);

  const usersMountBlock = functionBlock(source, 'mountPortalUsersAdminPanel', 'setWebsiteAdminSubtab');
  assert.match(usersMountBlock, /portal-student-users-panel/);
  assert.match(usersMountBlock, /portal-users-admin-mount/);
  assert.match(usersMountBlock, /mount\.appendChild\(panel\)/);
  assert.match(usersMountBlock, /portal-users-kpi-last-sync/);

  const showTabBlock = functionBlock(source, 'showTab');
  assert.match(showTabBlock, /setWebsiteAdminSubtab\('online'\)/);
  assert.match(showTabBlock, /mountPortalLibraryAdminPanel\(\)/);
  assert.match(showTabBlock, /mountPortalUsersAdminPanel\(\)/);
});
