const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.join(__dirname, '..', 'web', 'attendance-app.html');
const edgePath = path.join(__dirname, '..', 'supabase', 'functions', 'exam-online', 'index.ts');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function extractActionBlock(source, actionName) {
  const marker = `if (action === "${actionName}")`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${actionName} action should exist`);
  const next = source.indexOf('\n    if (action === ', start + marker.length);
  const fallback = source.indexOf('\n    return json({ ok: false, error: "Unknown action" }', start);
  const end = next === -1 ? fallback : next;
  assert.ok(end > start, `${actionName} action block should be extractable`);
  return source.slice(start, end);
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} should exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${endMarker} should exist after ${startMarker}`);
  return source.slice(start, end);
}

test('portal online rows expose AI JSON generation without auto publishing', () => {
  const source = read(htmlPath);

  assert.match(source, /let portalOnlineGeneratingId = ''/);
  assert.match(source, /generatePortalOnlineJsonAi/);
  assert.match(source, /callExamOnline\('generate_json_ai', \{ exam_file_id: id \}\)/);
  assert.match(source, /confirmApp\([\s\S]*Tạo JSON bằng AI/);
  assert.match(source, /portalOnlineMergeExam\(id, data\.online_exam\)/);
  assert.match(source, /loadPortalOnlineExams\(true\)/);
  assert.match(source, /Đã tạo JSON bản nháp/);

  const rowFn = extractBetween(source, 'function renderPortalOnlineRow(row)', 'function portalOnlineRowById');
  assert.match(rowFn, /portalOnlineGeneratingId === id/);
  assert.match(rowFn, /is-ai/);
  assert.match(rowFn, /Tạo AI/);
  assert.match(rowFn, /is-json/);
  assert.match(rowFn, /Đang tạo/);
  assert.match(rowFn, /generatePortalOnlineJsonAi/);
  assert.doesNotMatch(rowFn, /openPortalOnlineAssets/);

  const generateFn = extractBetween(source, 'async function generatePortalOnlineJsonAi(examId)', 'function openPortalOnlineJson');
  assert.doesNotMatch(generateFn, /callExamOnline\('publish'/);
  assert.doesNotMatch(generateFn, /togglePortalOnlinePublished/);
});

test('exam-online generate_json_ai is admin only and fails closed before publishing', () => {
  const source = read(edgePath);
  const block = extractActionBlock(source, 'generate_json_ai');

  assert.match(block, /assertAdmin\(actor\)/);
  assert.match(block, /findPromptTemplateForExam\(service, row\)/);
  assert.match(block, /renderPromptTemplate\(template, row\)/);
  assert.match(block, /OPENAI_API_KEY/);
  assert.match(block, /fetchExamPdfForAi\(service, row\)/);
  assert.match(block, /generateExamJsonWithOpenAi\(/);
  assert.match(block, /saveGeneratedExamJsonDraft\(service, actor, examFileId, examJson\)/);
  assert.match(source, /function saveGeneratedExamJsonDraft/);
  assert.match(source, /async function fetchExamPdfForAi/);
  assert.match(source, /GetObjectCommand/);
  assert.match(source, /async function getR2ObjectBytes/);
  assert.match(source, /async function generateExamJsonWithOpenAi/);
  assert.match(source, /https:\/\/api\.openai\.com\/v1\/responses/);
  assert.match(source, /type:\s*"input_file"/);
  assert.match(source, /file_data:\s*`data:application\/pdf;base64,/);
  assert.match(source, /text:\s*\{\s*format:\s*\{\s*type:\s*"json_object"/);
  assert.match(source, /validateExamJson/);
  assert.match(source, /status:\s*"draft"/);
  assert.doesNotMatch(block, /status:\s*"published"/);
  assert.doesNotMatch(block, /published_at:\s*new Date/);
  assert.doesNotMatch(block, /AI_GENERATION_NOT_READY/);
});

test('AI PDF reader uses server-side R2 object reads instead of signed fetch URLs', () => {
  const source = read(edgePath);
  const pdfReader = extractBetween(source, 'async function fetchExamPdfForAi', 'function responseOutputText');
  const candidateReader = extractBetween(source, 'async function readAiPdfCandidate', 'async function fetchExamPdfForAi');

  assert.match(candidateReader, /getR2ObjectBytes\(item\.key\)/);
  assert.match(candidateReader, /getSupabaseStorageBytes\(service, item\.path\)/);
  assert.doesNotMatch(pdfReader, /createR2SignedGetUrl/);
  assert.doesNotMatch(pdfReader, /fetch\(url/);
});

test('AI PDF reader requires both exam and answer PDFs with distinct errors', () => {
  const source = read(edgePath);
  const candidatesFn = extractBetween(source, 'function examPdfObjectCandidates', 'function aiPdfFileName');
  const pdfReader = extractBetween(source, 'async function fetchExamPdfForAi', 'function responseOutputText');
  const candidateReader = extractBetween(source, 'async function readAiPdfCandidate', 'async function fetchExamPdfForAi');
  const block = extractActionBlock(source, 'generate_json_ai');

  assert.match(candidatesFn, /kind:\s*"exam"/);
  assert.match(candidatesFn, /kind:\s*"answer"/);
  assert.match(candidatesFn, /source:\s*"r2"/);
  assert.match(candidatesFn, /source:\s*"supabase"/);
  assert.match(source, /pdfErrorCode\(kind: string, suffix: string\)/);
  assert.match(source, /kind === "answer" \? "ANSWER" : "EXAM"/);
  assert.match(pdfReader, /pdfErrorCode\(missingKinds\[0\], "NOT_FOUND"\)/);
  assert.match(candidateReader, /pdfErrorCode\(item\.kind, "FETCH_FAILED"\)/);
  assert.match(pdfReader, /pdfErrorCode\(kind, "SIGNATURE_INVALID"\)/);
  assert.match(block, /fetchExamPdfForAi\(service, row\)/);
});

test('NVIDIA API key is preferred and uses chat completions with extracted PDF text', () => {
  const source = read(edgePath);
  const block = extractActionBlock(source, 'generate_json_ai');
  const nvidiaFn = extractBetween(source, 'async function generateExamJsonWithNvidia', 'async function generateExamJsonWithOpenAi');

  assert.match(block, /Deno\.env\.get\("NVIDIA_API_KEY"\)/);
  assert.match(block, /generateExamJsonWithNvidia\(nvidiaKey, prompt, pdfFiles\)/);
  assert.match(block, /generateExamJsonWithOpenAi\(openAiKey, prompt, pdfFiles\)/);
  assert.match(source, /function extractPdfTextForAi/);
  assert.match(nvidiaFn, /https:\/\/integrate\.api\.nvidia\.com\/v1\/chat\/completions/);
  assert.match(nvidiaFn, /NVIDIA_EXAM_JSON_MODEL/);
  assert.match(nvidiaFn, /openai\/gpt-oss-120b/);
  assert.match(nvidiaFn, /pdfFiles\.map/);
  assert.match(nvidiaFn, /extractPdfTextForAi\(file\.bytes\)/);
  assert.match(nvidiaFn, /validateExamJson\(parsed\)/);
  assert.match(nvidiaFn, /QUESTIONS_REQUIRED/);
  assert.match(nvidiaFn, /attempt < 2/);
  assert.match(nvidiaFn, /NVIDIA_RESPONSE_INVALID_JSON/);
  assert.match(nvidiaFn, /parseOpenAiExamJson\(text\)[\s\S]*catch \(err\)/);
  assert.match(nvidiaFn, /response_format:\s*\{\s*type:\s*"json_object"\s*\}/);
  assert.doesNotMatch(nvidiaFn, /type:\s*"input_file"/);
});
