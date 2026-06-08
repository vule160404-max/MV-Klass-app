const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createLocalJobReport,
  scanLocalExamFolder,
  matchLocalPairToExamFile,
  runLocalBatch
} = require('../scripts/exam-local-batch.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mvklass-local-exam-'));
}

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'pdf');
}

function validExam(id = 'exam-001') {
  return {
    exam_id: id,
    title: 'De 001 Vao 10 Thanh Hoa 2025',
    pages: [{ id: 'part_1', title: 'Part 1', question_ids: [1, 2] }],
    questions: [
      {
        id: 1,
        display_id: '1',
        type: 'multiple_choice',
        question: 'Choose the best answer.',
        options: ['A. one', 'B. two', 'C. three', 'D. four'],
        answer: 'A',
        explanation: 'Answer A.'
      },
      {
        id: 2,
        display_id: '2',
        type: 'multiple_choice',
        question: 'Choose the best answer.',
        options: ['A. one', 'B. two', 'C. three', 'D. four'],
        answer: 'B',
        explanation: 'Answer B.'
      }
    ]
  };
}

test('scanLocalExamFolder pairs local exam and answer PDFs by exam code', () => {
  const root = makeTempDir();
  touch(path.join(root, 'de', 'De 001 Vao 10 Thanh Hoa 2025.pdf'));
  touch(path.join(root, 'dap-an', 'Dap an De 001 Vao 10 Thanh Hoa 2025.pdf'));
  touch(path.join(root, 'De 002 Vao 10 Thanh Hoa 2025.pdf'));
  touch(path.join(root, 'Dap an De 002 Vao 10 Thanh Hoa 2025.pdf'));
  touch(path.join(root, 'De 003 Vao 10 Thanh Hoa 2025.pdf'));

  const scan = scanLocalExamFolder(root);

  assert.equal(scan.totalPdf, 5);
  assert.deepEqual(scan.pairs.map(pair => pair.examCode), ['001', '002', '003']);
  assert.equal(scan.pairs[0].status, 'ready');
  assert.match(scan.pairs[0].examPath, /De 001/);
  assert.match(scan.pairs[0].answerPath, /Dap an De 001/);
  assert.equal(scan.pairs[2].status, 'missing_answer');
  assert.deepEqual(scan.readyPairs.map(pair => pair.examCode), ['001', '002']);
});

test('matchLocalPairToExamFile uses Thanh Hoa exam number first', () => {
  const pair = { examCode: '010', title: 'De 010 Vao 10 Thanh Hoa 2025' };
  const rows = [
    { id: 'hn-010', title: 'De HN 010 Vao 10 Ha Noi 2025', province: 'Ha Noi', exam_code: 'HN 010' },
    { id: 'th-010', title: 'De 010 Vao 10 Thanh Hoa 2025', province: 'Thanh Hoa', exam_code: '010' }
  ];

  const match = matchLocalPairToExamFile(pair, rows);

  assert.equal(match.id, 'th-010');
});

test('runLocalBatch creates local draft artifacts without saving to Supabase in dry-run', async () => {
  const root = makeTempDir();
  touch(path.join(root, 'De 001 Vao 10 Thanh Hoa 2025.pdf'));
  touch(path.join(root, 'Dap an De 001 Vao 10 Thanh Hoa 2025.pdf'));
  const calls = [];

  const report = await runLocalBatch({
    folder: root,
    source: 'Thanh Hoa',
    level: 'vao10',
    mode: 'dry-run',
    limit: 1,
    expectedQuestionCount: 2,
    runDir: path.join(root, 'runs'),
    now: () => new Date('2026-06-09T00:00:00Z')
  }, {
    loadRemoteExamFiles: async () => [{ id: 'exam-file-001', title: 'De 001 Vao 10 Thanh Hoa 2025', province: 'Thanh Hoa', exam_code: '001' }],
    loadPromptTemplate: async () => 'Prompt __EXAM_ID__ __EXAM_TITLE__\n{{EXAM_TEXT}}\n{{ANSWER_TEXT}}',
    readPairText: async () => ({ examText: 'Question text from PDF', answerText: '1 A\n2 B', answerKeys: new Map([[1, 'A'], [2, 'B']]) }),
    convertWithGemini: async () => validExam('exam-file-001'),
    saveDraft: async () => calls.push('saveDraft')
  });

  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.dry_run_ready, 1);
  assert.equal(report.summary.draft_saved, 0);
  assert.equal(calls.length, 0);
  assert.ok(fs.existsSync(path.join(report.artifact_dir, 'draft', '001_De_001_Vao_10_Thanh_Hoa_2025.json')));
});

test('runLocalBatch saves draft only when local pair matches an exam_file row', async () => {
  const root = makeTempDir();
  touch(path.join(root, 'De 001 Vao 10 Thanh Hoa 2025.pdf'));
  touch(path.join(root, 'Dap an De 001 Vao 10 Thanh Hoa 2025.pdf'));
  const saved = [];

  const report = await runLocalBatch({
    folder: root,
    source: 'Thanh Hoa',
    level: 'vao10',
    mode: 'draft',
    limit: 1,
    expectedQuestionCount: 2,
    runDir: path.join(root, 'runs'),
    now: () => new Date('2026-06-09T00:00:00Z')
  }, {
    loadRemoteExamFiles: async () => [{ id: 'exam-file-001', title: 'De 001 Vao 10 Thanh Hoa 2025', province: 'Thanh Hoa', exam_code: '001' }],
    loadPromptTemplate: async () => 'Prompt __EXAM_ID__',
    readPairText: async () => ({ examText: 'Question text from PDF', answerText: '1 A\n2 B', answerKeys: new Map([[1, 'A'], [2, 'B']]) }),
    convertWithGemini: async () => validExam('exam-file-001'),
    saveDraft: async (row, exam) => saved.push({ row, exam })
  });

  assert.equal(report.summary.draft_saved, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].row.id, 'exam-file-001');
});

test('runLocalBatch does not save draft when local pair has no exam_file match', async () => {
  const root = makeTempDir();
  touch(path.join(root, 'De 009 Vao 10 Thanh Hoa 2025.pdf'));
  touch(path.join(root, 'Dap an De 009 Vao 10 Thanh Hoa 2025.pdf'));

  const report = await runLocalBatch({
    folder: root,
    source: 'Thanh Hoa',
    level: 'vao10',
    mode: 'draft',
    limit: 1,
    expectedQuestionCount: 2,
    runDir: path.join(root, 'runs'),
    now: () => new Date('2026-06-09T00:00:00Z')
  }, {
    loadRemoteExamFiles: async () => [],
    loadPromptTemplate: async () => 'Prompt',
    readPairText: async () => ({ examText: 'Question text from PDF', answerText: '1 A\n2 B', answerKeys: new Map([[1, 'A'], [2, 'B']]) }),
    convertWithGemini: async () => validExam('local-009'),
    saveDraft: async () => { throw new Error('should not save without match'); }
  });

  assert.equal(report.summary.local_ready, 1);
  assert.match(report.rows[0].warnings.join(' '), /NO_EXAM_FILE_MATCH/);
});

test('createLocalJobReport is safe for UI polling', () => {
  const report = createLocalJobReport({
    source: 'Thanh Hoa',
    level: 'vao10',
    mode: 'draft',
    startedAt: '2026-06-09T00:00:00.000Z'
  });

  assert.equal(report.source, 'Thanh Hoa');
  assert.equal(report.mode, 'draft');
  assert.equal(report.summary.running, 0);
});
