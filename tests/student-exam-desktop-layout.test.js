const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const portalPath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readPortal() {
  return fs.readFileSync(portalPath, 'utf8');
}

test('student portal desktop layout uses the full wide viewport', () => {
  const html = readPortal();

  assert.match(html, /@media \(min-width:1180px\)\{[\s\S]*\.student-exam-shell\{width:min\(1540px,calc\(100% - 72px\)\)/);
  assert.match(html, /@media \(min-width:1180px\)\{[\s\S]*\.student-premium-entry\{display:grid;grid-template-columns:minmax\(260px,\.86fr\) minmax\(520px,1\.28fr\) minmax\(220px,\.58fr\);align-items:center/);
  assert.match(html, /@media \(min-width:1180px\)\{[\s\S]*\.student-online-history-card\{grid-template-columns:minmax\(220px,\.95fr\) minmax\(280px,1fr\);align-items:center/);
  assert.match(html, /@media \(min-width:1180px\)\{[\s\S]*\.student-exam-history-btn\{width:100%;min-width:0;min-height:54px/);
  assert.match(html, /@media \(min-width:1180px\)\{[\s\S]*\.student-premium-entry-btn\{width:100%;min-width:0;min-height:54px/);
  assert.match(html, /@media \(min-width:1500px\)\{[\s\S]*\.student-exam-shell\{width:min\(1680px,calc\(100% - 88px\)\)/);
  assert.match(html, /@media \(min-width:1500px\)\{[\s\S]*\.student-exam-list\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
});

test('student portal mobile layout remains one column', () => {
  const html = readPortal();

  assert.match(html, /@media \(max-width:699px\)\{[\s\S]*\.student-premium-entry\{display:grid;grid-template-columns:1fr;justify-content:stretch\}/);
  assert.match(html, /@media \(max-width:699px\)\{[\s\S]*\.student-exam-list[^\{]*\{grid-template-columns:1fr\}/);
});
