const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readSource() {
  return fs.readFileSync(sourcePath, 'utf8');
}

test('portal online admin has a source prompt manager modal', () => {
  const source = readSource();

  assert.match(source, /id="portal-online-source-prompt-modal"/);
  assert.match(source, /id="portal-online-source-prompt-province"/);
  assert.match(source, /id="portal-online-source-prompt-year"/);
  assert.match(source, /id="portal-online-source-prompt-text"/);
  assert.match(source, /openPortalOnlineSourcePromptManager/);
  assert.match(source, /loadPortalOnlineSourcePrompts/);
  assert.match(source, /savePortalOnlineSourcePrompt/);
  assert.match(source, /renderPortalOnlineSourcePromptList/);
  assert.match(source, /callExamOnline\('prompt_sources_list'/);
  assert.match(source, /callExamOnline\('save_prompt_source'/);
});

test('portal online rows show matched prompt source status', () => {
  const source = readSource();

  assert.match(source, /portalOnlinePromptSourceLabel/);
  assert.match(source, /Chưa có prompt nguồn/);
  assert.match(source, /Prompt nguồn/);
  assert.match(source, /source_prompt/);
});
