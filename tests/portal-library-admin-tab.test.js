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

test('portal admin is consolidated into one sidebar tab with internal subtabs', () => {
  const source = readSource();

  assert.match(source, /id="tab-btn-portal-admin" onclick="showTab\('portal-admin'\)"[\s\S]*Quản trị portal/);
  assert.match(source, /id="tab-btn-portal-library-admin" onclick="showTab\('portal-library-admin'\)" hidden/);
  assert.match(source, /id="tab-btn-portal-users-admin" onclick="showTab\('portal-users-admin'\)" hidden/);
  assert.match(source, /#tab-btn-portal-library-admin,\s*#tab-btn-portal-users-admin\s*\{\s*display: none !important;/);
  assert.match(source, /setVisible\('tab-btn-portal-library-admin', 'tab-portal-library-admin', false\)/);
  assert.match(source, /setVisible\('tab-btn-portal-users-admin', 'tab-portal-users-admin', false\)/);

  assert.match(source, /class="website-admin-subtabs" role="tablist" aria-label="Quản trị portal"/);
  assert.match(source, /id="website-admin-subtab-online"[\s\S]*>Đề online<\/button>/);
  assert.match(source, /id="website-admin-subtab-library"[\s\S]*>Kho tài liệu<\/button>/);
  assert.match(source, /id="website-admin-subtab-users"[\s\S]*>Tài khoản<\/button>/);
  assert.match(source, /id="website-admin-panel-online"/);
  assert.match(source, /id="website-admin-panel-library"/);
  assert.match(source, /id="website-admin-panel-users"/);
});

test('legacy portal admin tabs route into the consolidated portal admin subtabs', () => {
  const source = readSource();
  const setSubtabBlock = functionBlock(source, 'setWebsiteAdminSubtab', 'callExamOnline');
  const showTabBlock = functionBlock(source, 'showTab');

  assert.match(setSubtabBlock, /tab === 'library' \? 'library' : \(tab === 'users' \? 'users' : 'online'\)/);
  assert.match(setSubtabBlock, /users: document\.getElementById\('website-admin-subtab-users'\)/);
  assert.match(setSubtabBlock, /users: document\.getElementById\('website-admin-panel-users'\)/);
  assert.match(setSubtabBlock, /setWebsiteAdminSubtab users/);

  assert.match(showTabBlock, /if \(t === 'portal-library-admin'\)[\s\S]*portalAdminSubtab = 'library'/);
  assert.match(showTabBlock, /else if \(t === 'portal-users-admin'\)[\s\S]*portalAdminSubtab = 'users'/);
  assert.match(showTabBlock, /setWebsiteAdminSubtab\(portalAdminSubtab \|\| websiteAdminSubtab \|\| 'online'\)/);
  assert.doesNotMatch(showTabBlock, /mountPortalLibraryAdminPanel\(\)/);
  assert.doesNotMatch(showTabBlock, /mountPortalUsersAdminPanel\(\)/);
});
