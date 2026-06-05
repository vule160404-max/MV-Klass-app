const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const portalPath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readPortal() {
  return fs.readFileSync(portalPath, 'utf8');
}

function extractCardActionsTemplate(html) {
  const marker = '<div class="student-exam-actions">';
  const start = html.indexOf(marker, html.indexOf('function studentExamCard'));
  assert.notEqual(start, -1, 'student exam card actions template should exist');
  const end = html.indexOf('</div>', start);
  assert.ok(end > start, 'student exam card actions template should be extractable');
  return html.slice(start, end);
}

test('online exam card action is above the preview action when available', () => {
  const html = readPortal();
  const actions = extractCardActionsTemplate(html);

  const onlineIndex = actions.indexOf('data-exam-online="${id}"');
  const downloadIndex = actions.indexOf('data-exam-download="${id}" data-exam-kind="file"');
  const previewIndex = actions.indexOf('data-exam-preview="${id}" data-exam-kind="file"');
  const answerIndex = actions.indexOf('data-exam-preview="${id}" data-exam-kind="answer"');

  assert.notEqual(onlineIndex, -1, 'online action should be rendered in the card actions');
  assert.notEqual(downloadIndex, -1, 'download action should be rendered in the card actions');
  assert.notEqual(previewIndex, -1, 'preview action should be rendered in the card actions');
  assert.notEqual(answerIndex, -1, 'answer action should be rendered in the card actions');
  assert.ok(onlineIndex < downloadIndex, 'online action should occupy the first grid cell');
  assert.ok(downloadIndex < previewIndex, 'download action should stay on the first row');
  assert.ok(previewIndex < answerIndex, 'preview action should move below the online action');
  assert.match(html, /\.student-exam-card \.student-exam-action\.online\{[\s\S]*grid-column:auto !important/);
});
