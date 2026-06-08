const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildGeminiRequestBody,
  evaluateQualityGate,
  extractAnswerKeys,
  filterConversionCandidates,
  inferThanhHoaExamNumber,
  runBatch,
  sourceMatchesThanhHoa
} = require('../scripts/exam-conversion-agent.js');

function validExam(overrides = {}) {
  return {
    exam_id: 'exam-001',
    title: 'De 001 Vao 10 Thanh Hoa 2025',
    pages: [
      { id: 'part_a', title: 'Part A', question_ids: [1, 2, 3, 4] }
    ],
    questions: [
      {
        id: 1,
        display_id: '1',
        type: 'multiple_choice',
        question: 'Choose the word with different sound.',
        options: ['A. one', 'B. two', 'C. three', 'D. four'],
        answer: 'A',
        explanation: 'A is different.'
      },
      {
        id: 2,
        display_id: '2',
        type: 'multiple_choice',
        question: 'Choose the best answer.',
        options: ['A. one', 'B. two', 'C. three', 'D. four'],
        answer: 'B',
        explanation: 'B is correct.'
      },
      {
        id: 3,
        display_id: '3',
        type: 'fill_blank',
        blank_id: 'blank_3',
        question: 'Fill ______.',
        word_bank: [],
        answer: 'goes',
        explanation: 'Present simple.'
      },
      {
        id: 4,
        display_id: '4',
        type: 'sentence_rewrite',
        question: 'Rewrite the sentence.',
        prompt: 'Although ______',
        answer: 'although it rained, we went out',
        explanation: 'Use although.'
      }
    ],
    ...overrides
  };
}

test('Thanh Hoa source parser recognizes source and exam number', () => {
  const row = {
    title: 'De TH 001 Vao 10 Thanh Hoa 2025',
    province: 'So Thanh Hoa',
    exam_code: 'TH 001',
    object_key: 'vao10/thanh-hoa/de-001.pdf'
  };

  assert.equal(sourceMatchesThanhHoa(row), true);
  assert.equal(inferThanhHoaExamNumber(row), 1);
  assert.equal(sourceMatchesThanhHoa({ title: 'De HN 001 Vao 10 Ha Noi' }), false);
});

test('answer parser extracts numbered Thanh Hoa answer keys', () => {
  const keys = extractAnswerKeys('Cau 1: A\n2. B\n3 C\nCau 4 - D\n51. A');

  assert.equal(keys.size, 4);
  assert.equal(keys.get(1), 'A');
  assert.equal(keys.get(2), 'B');
  assert.equal(keys.get(3), 'C');
  assert.equal(keys.get(4), 'D');
  assert.equal(keys.has(51), false);
});

test('candidate filter skips already published online exams', () => {
  const rows = [
    { id: 'published', title: 'De TH 001 Vao 10 Thanh Hoa 2025', province: 'Thanh Hoa', exam_code: 'TH 001' },
    { id: 'draft', title: 'De TH 002 Vao 10 Thanh Hoa 2025', province: 'Thanh Hoa', exam_code: 'TH 002' },
    { id: 'missing', title: 'De TH 003 Vao 10 Thanh Hoa 2025', province: 'Thanh Hoa', exam_code: 'TH 003' },
    { id: 'blank-level', title: 'De TH 005 Thanh Hoa 2025', province: 'Thanh Hoa', exam_code: 'TH 005', level: '' },
    { id: 'other', title: 'De HN 004 Vao 10 Ha Noi 2025', province: 'Ha Noi', exam_code: 'HN 004' }
  ];
  const onlineRows = [
    { exam_file_id: 'published', status: 'published' },
    { exam_file_id: 'draft', status: 'draft' }
  ];

  assert.deepEqual(
    filterConversionCandidates(rows, onlineRows, { level: 'vao10', limit: 10 }).map(row => row.id),
    ['draft', 'missing', 'blank-level']
  );
});

test('quality gate accepts publish only for clean JSON without image slots', () => {
  const result = evaluateQualityGate(validExam(), {
    mode: 'publish',
    expectedQuestionCount: 4,
    answerKeys: new Map([[1, 'A'], [2, 'B'], [3, 'goes'], [4, 'although it rained, we went out']])
  });

  assert.equal(result.ok, true);
  assert.equal(result.canPublish, true);
  assert.deepEqual(result.errors, []);
});

test('quality gate blocks placeholder, missing counts, weak MCQ, and image slots', () => {
  const placeholder = evaluateQualityGate(validExam({
    questions: [{ id: 1, type: 'multiple_choice', question: '(Khong co du lieu de)', options: ['A. Option 1', 'B. Option 2', 'C. Option 3', 'D. Option 4'], answer: 'A' }]
  }), { mode: 'publish', expectedQuestionCount: 1, answerKeys: new Map([[1, 'A']]) });
  assert.equal(placeholder.canPublish, false);
  assert.match(placeholder.errors.join(' '), /PLACEHOLDER_CONTENT|SCHEMA_INVALID/);

  const weakMcq = evaluateQualityGate(validExam({
    questions: [validExam().questions[0], { ...validExam().questions[1], options: ['A. one', 'B. two'] }, validExam().questions[2], validExam().questions[3]]
  }), { mode: 'publish', expectedQuestionCount: 4, answerKeys: new Map([[1, 'A'], [2, 'B'], [3, 'goes'], [4, 'although it rained, we went out']]) });
  assert.equal(weakMcq.canPublish, false);
  assert.match(weakMcq.errors.join(' '), /MCQ_OPTIONS_INCOMPLETE/);

  const imageSlots = evaluateQualityGate(validExam({
    images: [{ id: 'chart', file_name: 'chart.png' }]
  }), { mode: 'publish', expectedQuestionCount: 4, answerKeys: new Map([[1, 'A'], [2, 'B'], [3, 'goes'], [4, 'although it rained, we went out']]) });
  assert.equal(imageSlots.ok, true);
  assert.equal(imageSlots.canPublish, false);
  assert.match(imageSlots.errors.join(' '), /IMAGE_SLOTS_NEED_UPLOAD/);
});

test('Gemini request body uses Gemini 2.5 Flash structured JSON output', () => {
  const body = buildGeminiRequestBody({
    prompt: 'Convert this exam.',
    model: 'gemini-2.5-flash'
  });

  assert.match(body.contents[0].parts[0].text, /Convert this exam/);
  assert.equal(body.generationConfig.responseFormat.text.mimeType, 'application/json');
  assert.equal(body.generationConfig.responseFormat.text.schema.type, 'object');
});

test('dry-run batch creates report without saving or publishing', async () => {
  const calls = [];
  const report = await runBatch({
    source: 'Thanh Hoa',
    level: 'vao10',
    limit: 1,
    mode: 'dry-run',
    expectedQuestionCount: 4,
    now: () => new Date('2026-06-09T00:00:00Z')
  }, {
    listCandidates: async () => [{ id: 'exam-001', title: 'De TH 001 Vao 10 Thanh Hoa 2025', province: 'Thanh Hoa', exam_code: 'TH 001' }],
    loadPromptTemplate: async () => 'Prompt __EXAM_ID__ __EXAM_TITLE__',
    readExamPairText: async () => ({ examText: 'Noi dung de day du', answerText: '1 A\n2 B\n3 goes\n4 although it rained, we went out', answerKeys: new Map([[1, 'A'], [2, 'B'], [3, 'goes'], [4, 'although it rained, we went out']]) }),
    convertWithGemini: async () => validExam(),
    saveDraft: async () => calls.push('saveDraft'),
    publishExam: async () => calls.push('publishExam'),
    writeRunArtifacts: async () => calls.push('writeRunArtifacts')
  });

  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.dry_run_ready, 1);
  assert.deepEqual(calls, ['writeRunArtifacts']);
});
