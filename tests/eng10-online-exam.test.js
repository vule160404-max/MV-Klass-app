const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectImageSlots,
  displayQuestionText,
  formatExamDisplayText,
  hydrateExamAssetUrls,
  safeRichText,
  scoreExam,
  sourceTextForPage,
  validateExamJson
} = require('../web/eng10-online-exam.js');

test('validateExamJson rejects missing questions', () => {
  assert.throws(
    () => validateExamJson({ exam_id: 'x', title: 'Broken' }),
    /questions/i
  );
});

test('validateExamJson accepts the ENG10 schema subset used by the portal', () => {
  const exam = validateExamJson({
    exam_id: 'demo',
    title: 'Demo exam',
    passage: 'Read this text.',
    pages: [{ id: 'p1', title: 'Part 1', question_ids: [1, 2, 3] }],
    images: [{ id: 'passage_chart', file_name: 'passage_chart.png' }],
    questions: [
      { id: 1, type: 'multiple_choice', question: 'Pick one', options: ['A. One', 'B. Two'], answer: 'B' },
      { id: 2, type: 'fill_blank', blank_id: 'blank_2', question: 'Fill', word_bank: [], answer: 'resources' },
      { id: 3, type: 'sentence_rewrite', question: 'Rewrite', prompt: 'Although...', answer: 'although he worked hard' }
    ]
  });

  assert.equal(exam.questions.length, 3);
  assert.equal(exam.pages[0].question_ids[2], 3);
});

test('scoreExam scores MCQ, fill blank, and rewrite answers without storing detail payloads', () => {
  const exam = validateExamJson({
    exam_id: 'demo',
    title: 'Demo exam',
    questions: [
      { id: 1, type: 'multiple_choice', question: 'Pick one', options: ['A', 'B'], answer: 'B' },
      { id: 2, type: 'fill_blank', blank_id: 'blank_2', question: 'Fill', word_bank: [], answer: 'resources' },
      { id: 3, type: 'sentence_rewrite', question: 'Rewrite', prompt: 'Although...', answer: 'although he worked hard, he failed' }
    ]
  });

  const result = scoreExam(exam, {
    mcq_1: 'B',
    fill_blank_2: ' Resources ',
    rw_3: 'Although he worked hard, he failed.'
  }, 92);

  assert.deepEqual(result, {
    score: 3,
    total: 3,
    percent: 100,
    duration_seconds: 92
  });
});

test('safeRichText escapes arbitrary HTML while preserving strong and underline tags', () => {
  assert.equal(
    safeRichText('<img src=x onerror=alert(1)><strong>bold</strong><u>u</u>'),
    '&lt;img src=x onerror=alert(1)&gt;<strong>bold</strong><u>u</u>'
  );
  assert.equal(
    safeRichText('A. c<strong><u>a</u></strong>lm'),
    'A. c<strong><u>a</u></strong>lm'
  );
});

test('formatExamDisplayText renders cloze placeholders as numbered blanks', () => {
  assert.equal(
    formatExamDisplayText('First [BLANK_19], then [blank-20], finally [blank 21].'),
    'First ___19___, then ___20___, finally ___21___.'
  );
});

test('displayQuestionText replaces generated cloze placeholder wording', () => {
  assert.equal(
    displayQuestionText({
      id: 19,
      display_id: '19',
      type: 'multiple_choice',
      question: 'Vị trí tương ứng với số [BLANK_19] trong đoạn văn điền từ.'
    }),
    'Chọn đáp án đúng cho chỗ trống ___19___.'
  );
  assert.equal(
    displayQuestionText({
      id: 20,
      display_id: '20',
      type: 'multiple_choice',
      question: 'Choose the correct option for [BLANK_20].'
    }),
    'Choose the correct option for ___20___.'
  );
});

test('sourceTextForPage supports dynamic source_key fields such as fill_passage_2', () => {
  const exam = validateExamJson({
    exam_id: 'demo',
    title: 'Demo exam',
    fill_passage_2: 'Second cloze ___36___ text.',
    pages: [{ id: 'p2', title: 'Cloze 2', source_key: 'fill_passage_2', question_ids: [36] }],
    questions: [
      { id: 36, type: 'multiple_choice', question: 'Pick one', options: ['A', 'B'], answer: 'A' }
    ]
  });

  assert.equal(sourceTextForPage(exam, exam.pages[0]), 'Second cloze ___36___ text.');
});

test('collectImageSlots and hydrateExamAssetUrls match assets by id, filename, and bare filename', () => {
  const exam = validateExamJson({
    exam_id: 'demo',
    title: 'Demo exam',
    images: [{ id: 'chart_1', file_name: 'chart_1.png' }],
    questions: [
      {
        id: 1,
        type: 'multiple_choice',
        question: 'Image question',
        options: ['A', 'B'],
        answer: 'A',
        images: [{ id: 'q1_notice', file_name: 'q1_notice.png' }]
      },
      {
        id: 2,
        type: 'multiple_choice',
        question: 'Notice question',
        options: ['A', 'B'],
        answer: 'A',
        images: [{ id: 'Question Notice', file_name: 'Question Notice.png' }]
      }
    ]
  });
  const slots = collectImageSlots(exam);

  assert.equal(slots.length, 3);
  assert.equal(slots[0].file_name, 'chart_1.png');

  const hydrated = hydrateExamAssetUrls(exam, [
    { slot_id: 'q1_notice', file_name: 'q1_notice.png', url: 'https://cdn.example/q1.png' },
    { slot_id: 'unused', file_name: 'chart_1', url: 'https://cdn.example/chart.png' },
    { slot_id: 'question_notice', url: 'https://cdn.example/notice.png' }
  ]);

  assert.equal(hydrated.images[0].src, 'https://cdn.example/chart.png');
  assert.equal(hydrated.questions[0].images[0].src, 'https://cdn.example/q1.png');
  assert.equal(hydrated.questions[1].images[0].src, 'https://cdn.example/notice.png');
});
