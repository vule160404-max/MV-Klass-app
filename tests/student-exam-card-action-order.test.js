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

test('online exam card action is rendered as the bottom card action when available', () => {
  const html = readPortal();
  const actions = extractCardActionsTemplate(html);
  const cardStart = html.indexOf('function studentExamCard');
  const cardEnd = html.indexOf('</article>`;', cardStart);
  const cardTemplate = html.slice(cardStart, cardEnd);

  const onlineIndex = actions.indexOf('data-exam-online="${id}"');
  const downloadIndex = actions.indexOf('data-exam-download="${id}" data-exam-kind="file"');
  const previewIndex = actions.indexOf('data-exam-preview="${id}" data-exam-kind="file"');
  const answerIndex = actions.indexOf('data-exam-preview="${id}" data-exam-kind="answer"');
  const bottomOnlineIndex = cardTemplate.indexOf('class="student-document-detail student-document-online" data-exam-online="${id}"');

  assert.equal(onlineIndex, -1, 'online action should no longer be rendered in the primary card actions');
  assert.notEqual(downloadIndex, -1, 'download action should be rendered in the card actions');
  assert.notEqual(previewIndex, -1, 'preview action should be rendered in the card actions');
  assert.notEqual(answerIndex, -1, 'answer action should be rendered in the card actions');
  assert.notEqual(bottomOnlineIndex, -1, 'online action should be rendered as the bottom document action');
  assert.ok(downloadIndex < previewIndex, 'download action should stay on the first row');
  assert.ok(previewIndex < answerIndex, 'preview action should stay before answer');
  assert.match(html, /\.student-document-detail\.student-document-online\{[\s\S]*background:#eafaf1 !important/);
});
