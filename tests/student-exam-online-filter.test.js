const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const portalPath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readPortal() {
  return fs.readFileSync(portalPath, 'utf8');
}

test('student portal has a desktop online-only filter toggle', () => {
  const html = readPortal();

  assert.match(html, /id="student-exam-online-filter"[^>]*type="checkbox"/);
  assert.match(html, /class="student-exam-online-toggle"/);
  assert.match(html, />Đề online</);
  assert.match(html, /@media \(min-width:1180px\)\{[\s\S]*\.student-exam-filter-grid\{display:grid;grid-template-columns:minmax\(260px,1\.35fr\) minmax\(140px,\.68fr\) minmax\(220px,1fr\) minmax\(110px,\.55fr\) minmax\(150px,\.7fr\) minmax\(130px,\.58fr\)/);
  assert.match(html, /@media \(min-width:1180px\)\{[\s\S]*\.student-exam-filter-main,\s*\.student-exam-filter-advanced\{display:contents\}/);
  assert.match(html, /@media \(min-width:1180px\)\{[\s\S]*\.student-exam-filter-toggle,\s*\.student-exam-filter-group-title\{display:none\}/);
});

test('student portal online-only filter uses published online exam state', () => {
  const html = readPortal();

  assert.match(html, /function studentExamHasPublishedOnline\(row\)/);
  assert.match(html, /onlineOnly:\s*Boolean\(document\.getElementById\('student-exam-online-filter'\)\?\.checked\)/);
  assert.match(html, /if \(f\.onlineOnly && !studentExamHasPublishedOnline\(row\)\) return false;/);
  assert.match(html, /'student-exam-online-filter':\s*false/);
  assert.match(html, /el\.type === 'checkbox'\)\s*el\.checked = Boolean\(value\)/);
  assert.match(html, /'student-exam-online-filter'/);
});
