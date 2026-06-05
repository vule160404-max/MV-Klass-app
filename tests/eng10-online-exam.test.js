const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  collectImageSlots,
  displayQuestionText,
  formatExamDisplayText,
  hydrateExamAssetUrls,
  safeRichText,
  scoreExam,
  shouldRenderRewritePrompt,
  sourceTextForPage,
  validateExamJson
} = require('../web/eng10-online-exam.js');

const runnerSourcePath = path.join(__dirname, '..', 'web', 'eng10-online-exam.js');
const runnerCssPath = path.join(__dirname, '..', 'web', 'eng10-online-exam.css');

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

test('submitted result is a top-layer dialog instead of an inline grid row', () => {
  const source = fs.readFileSync(runnerSourcePath, 'utf8');
  const css = fs.readFileSync(runnerCssPath, 'utf8');

  assert.match(source, /resultOpen:\s*false/);
  assert.match(source, /state\.resultOpen\s*=\s*true/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /eng10-online-result-card/);
  assert.match(source, /data-action="close-result"/);

  const resultRule = css.match(/\.eng10-online-result\s*\{[^}]+\}/)?.[0] || '';
  assert.match(resultRule, /position:\s*fixed/);
  assert.match(resultRule, /z-index:\s*53\d\d/);
});

test('submit loading uses a centered viewport overlay', () => {
  const source = fs.readFileSync(runnerSourcePath, 'utf8');
  const css = fs.readFileSync(runnerCssPath, 'utf8');

  assert.match(source, /eng10-online-submit-panel/);
  const submitRule = css.match(/\.eng10-online-submit-state\s*\{[^}]+\}/)?.[0] || '';
  assert.match(submitRule, /position:\s*fixed/);
  assert.match(submitRule, /inset:\s*0/);
  assert.match(submitRule, /align-items:\s*center/);
  assert.match(submitRule, /justify-content:\s*center/);
});

test('footer submit button becomes exit after a completed submission', () => {
  const source = fs.readFileSync(runnerSourcePath, 'utf8');

  assert.match(source, /state\.submitted\s*\?\s*'close'\s*:\s*'submit'/);
  assert.match(source, /state\.submitted\s*\?\s*'Thoát'\s*:\s*\(state\.submitting\s*\?\s*'Đang chấm\.\.\.'\s*:\s*'Nộp bài'\)/);
});

test('formatExamDisplayText renders cloze placeholders as numbered blanks', () => {
  assert.equal(
    formatExamDisplayText('First [BLANK_19], then [blank-20], finally [blank 21].'),
    'First ___19___, then ___20___, finally ___21___.'
  );
  assert.equal(
    formatExamDisplayText('It is close to everyone’s ***26*** life. It is ***27*** that gives you light.'),
    'It is close to everyone’s ___26___ life. It is ___27___ that gives you light.'
  );
  assert.equal(
    formatExamDisplayText('You should buy this book. It’s very ******.'),
    'You should buy this book. It’s very ______.'
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

test('keyword-only rewrite prompts are hidden while sentence starters remain visible', () => {
  assert.equal(
    shouldRenderRewritePrompt({
      type: 'sentence_rewrite',
      question: 'It seems that he will come late. (APPEARS)',
      prompt: 'APPEARS'
    }),
    false
  );
  assert.equal(
    shouldRenderRewritePrompt({
      type: 'sentence_rewrite',
      question: 'I sent my friend a letter in London last week.',
      prompt: 'A letter ______'
    }),
    true
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

test('word bank cloze pages render draggable bank chips and passage drop targets', () => {
  const js = fs.readFileSync(runnerSourcePath, 'utf8');
  const css = fs.readFileSync(runnerCssPath, 'utf8');

  assert.match(js, /data-bank-word/);
  assert.match(js, /draggable="true"/);
  assert.match(js, /data-fill-drop-target/);
  assert.match(js, /usedWordKeys/);
  assert.match(js, /data-word-bank-drop/);
  assert.match(js, /delete state\.answers\[sourceKey\]/);
  assert.match(js, /addEventListener\('dragstart'/);
  assert.match(js, /addEventListener\('drop'/);
  assert.match(css, /\.eng10-online-drop-blank/);
  assert.match(css, /\.eng10-online-bank-chip/);
  assert.match(css, /transition:/);
  assert.match(css, /\.eng10-online-source-bank\.empty/);
});
