const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readSource() {
  return fs.readFileSync(sourcePath, 'utf8');
}

test('website management can filter recently created student portal accounts', () => {
  const source = readSource();

  assert.match(source, /const PORTAL_RECENT_ACCOUNT_WINDOW_DAYS = 7;/);
  assert.match(source, /portal_class_label,last_seen_at,portal_presence_status,created_at/);
  assert.match(source, /function portalUserIsRecentlyCreated\(profile\)/);
  assert.match(source, /Date\.now\(\) - createdAt <= PORTAL_RECENT_ACCOUNT_WINDOW_DAYS \* 24 \* 60 \* 60 \* 1000/);
  assert.match(source, /<option value="recent">Tài khoản mới lập gần đây<\/option>/);
  assert.match(source, /filter === 'recent' \? portalUserIsRecentlyCreated\(p\)/);
  assert.match(source, /<span class="portal-user-chip">Mới lập <strong>\$\{counts\.recent\}<\/strong><\/span>/);
});

test('student portal account list does not become empty when optional profile fields are missing', () => {
  const source = readSource();

  assert.match(source, /const PORTAL_PROFILE_FIELD_SETS = \[/);
  assert.match(source, /portal_class_label,last_seen_at,portal_presence_status,created_at/);
  assert.match(source, /id,email,display_name,role,portal_plan,portal_status,portal_free_group/);
  assert.match(source, /async function loadPortalProfilesForAnalytics\(\)/);
  assert.match(source, /catch \(e\) \{[\s\S]*portal_profiles_query_failed/);
  assert.match(source, /loadPortalProfilesForAnalytics\(\)/);
  assert.doesNotMatch(source, /api\('GET', profilePath\)\.catch\(\(\) => \[\]\)/);
});
