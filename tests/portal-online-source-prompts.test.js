const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'web', 'attendance-app.html');
const edgePath = path.join(__dirname, '..', 'supabase', 'functions', 'exam-online', 'index.ts');

function readSource() {
  return fs.readFileSync(sourcePath, 'utf8');
}

function readEdge() {
  return fs.readFileSync(edgePath, 'utf8');
}

test('portal online admin has a source prompt manager modal', () => {
  const source = readSource();

  assert.match(source, /id="portal-online-source-prompt-modal"/);
  assert.match(source, /id="portal-online-source-prompt-level"/);
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

test('source prompt manager chooses a source from uploaded exam groups', () => {
  const source = readSource();

  const sourceControl = source.match(/<select[^>]*id="portal-online-source-prompt-province"[\s\S]*?<\/select>/);
  assert.ok(sourceControl, 'source prompt province should be a dropdown, not a free text input');
  assert.match(sourceControl[0], /onchange="onPortalOnlineSourcePromptProvinceChange\(\)"/);
  assert.doesNotMatch(source, /<input[^>]*id="portal-online-source-prompt-province"/);

  assert.match(source, /function portalOnlineSourceOptions\(/);
  assert.match(source, /function renderPortalOnlineSourcePromptOptions/);
  assert.match(source, /function portalOnlineSourcePromptLevelKey/);
  assert.match(source, /portalOnlineRows/);
  assert.match(source, /studentExamSourceLabel\(row\)/);
  assert.match(source, /studentExamOverviewSourceDisplayLabel/);
  assert.match(source, /portalExamGroupKey\(row\) === levelKey/);
  const sourceOptions = source.match(/function portalOnlineSourceOptions\(extra = null\) \{[\s\S]*?\n\}\n\nfunction renderPortalOnlineSourcePromptOptions/);
  assert.ok(sourceOptions, 'portalOnlineSourceOptions should exist');
  assert.doesNotMatch(sourceOptions[0], /source_prompt_candidate/);
});

test('source prompt keys include exam level to avoid Vào 10 and THPT QG conflicts', () => {
  const source = readSource();
  const edge = readEdge();

  assert.match(source, /portalOnlineSourcePromptTemplateKey\(examLevel, provinceLabel, year\)/);
  assert.match(source, /exam_level:\s*portalOnlineSourcePromptLevelKey/);
  assert.match(source, /callExamOnline\('save_prompt_source', \{[\s\S]*exam_level: selected\.exam_level/);
  assert.match(source, /portalFreeGroupLabel\(row\.exam_level \|\| portalOnlineSourcePromptLevelKeyFromProvinceKey\(row\.province_key\)\)/);

  assert.match(edge, /function promptExamLevelKey\(row: any\)/);
  assert.match(edge, /function scopedPromptProvinceKey\(provinceKey: string, examLevel: string\)/);
  assert.match(edge, /const examLevel = normalizePromptExamLevel\(body\?\.exam_level/);
  assert.match(edge, /province_key: scopedPromptProvinceKey\(provinceKey, examLevel\)/);
  assert.match(edge, /upsert\(payload, \{ onConflict: "province_key,year" \}\)/);
  assert.match(edge, /const levelScopedKeys = promptSourceKeysForExam\(row\)\.map\(\(key\) => scopedPromptProvinceKey\(key, examLevel\)\)/);
});

test('portal online rows show matched prompt source status', () => {
  const source = readSource();

  assert.match(source, /portalOnlinePromptSourceLabel/);
  assert.match(source, /Chưa có prompt nguồn/);
  assert.match(source, /Prompt nguồn/);
  assert.match(source, /source_prompt/);
});
