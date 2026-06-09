const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createLocalJobReport,
  extractDocxText,
  htmlToRichText,
  readLocalPairText,
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

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function writeUInt16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

function writeUInt32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function makeDocxXml(text) {
  const paragraphs = String(text).split(/\r?\n/).map(line => (
    `<w:p><w:r><w:t>${xmlEscape(line)}</w:t></w:r></w:p>`
  )).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`;
}

function writeSimpleDocx(filePath, text) {
  writeDocxXml(filePath, makeDocxXml(text));
}

function writeDocxXml(filePath, documentXml) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const entries = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'utf8')
    },
    {
      name: '_rels/.rels',
      data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'utf8')
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(documentXml, 'utf8')
    }
  ];
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(crc),
      writeUInt32(entry.data.length),
      writeUInt32(entry.data.length),
      writeUInt16(name.length),
      writeUInt16(0),
      name,
      entry.data
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      writeUInt32(0x02014b50),
      writeUInt16(20),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(crc),
      writeUInt32(entry.data.length),
      writeUInt32(entry.data.length),
      writeUInt16(name.length),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(offset),
      name
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(entries.length),
    writeUInt16(entries.length),
    writeUInt32(central.length),
    writeUInt32(offset),
    writeUInt16(0)
  ]);
  fs.writeFileSync(filePath, Buffer.concat([...localParts, central, eocd]));
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

test('scanLocalExamFolder pairs local DOCX exam and answer files', () => {
  const root = makeTempDir();
  writeSimpleDocx(path.join(root, 'De 004 Vao 10 Thanh Hoa 2025.docx'), 'Question 1\nQuestion 2');
  writeSimpleDocx(path.join(root, 'Dap an De 004 Vao 10 Thanh Hoa 2025.docx'), '1. A\n2. B');

  const scan = scanLocalExamFolder(root);

  assert.equal(scan.totalFiles, 2);
  assert.equal(scan.readyPairs.length, 1);
  assert.equal(scan.readyPairs[0].examCode, '004');
  assert.match(scan.readyPairs[0].examPath, /\.docx$/);
  assert.match(scan.readyPairs[0].answerPath, /\.docx$/);
});

test('extractDocxText preserves underline and bold markers for OpenAI prompts', () => {
  const root = makeTempDir();
  const filePath = path.join(root, 'De 001 Vao 10 Thanh Hoa 2025.docx');
  writeDocxXml(filePath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p>
        <w:r><w:t>A. </w:t></w:r>
        <w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>thank</w:t></w:r>
        <w:r><w:t> B. </w:t></w:r>
        <w:r><w:rPr><w:b/></w:rPr><w:t>English</w:t></w:r>
      </w:p>
    </w:body></w:document>`);

  const text = extractDocxText(fs.readFileSync(filePath));

  assert.match(text, /A\. <u>thank<\/u> B\. <strong>English<\/strong>/);
});

test('htmlToRichText preserves Word HTML underline and bold markers', () => {
  const text = htmlToRichText(`
    <html><body>
      <p>A. <span style="text-decoration: underline">thank</span></p>
      <p><span style="font-weight: bold">English</span></p>
    </body></html>
  `);

  assert.match(text, /A\. <u>thank<\/u>/);
  assert.match(text, /<strong>English<\/strong>/);
});

test('scanLocalExamFolder treats legacy DOC files as combined exam-answer candidates', () => {
  const root = makeTempDir();
  touch(path.join(root, 'MÃ ĐỀ 002.doc'));
  touch(path.join(root, 'MÃ ĐỀ 003.doc'));

  const scan = scanLocalExamFolder(root);

  assert.equal(scan.totalFiles, 2);
  assert.equal(scan.totalUnsupported, 0);
  assert.equal(scan.readyPairs.length, 2);
  assert.equal(scan.readyPairs[0].combined, true);
  assert.match(scan.readyPairs[0].examPath, /\.doc$/);
  assert.equal(scan.readyPairs[0].answerPath, scan.readyPairs[0].examPath);
});

test('scanLocalExamFolder detects one DOCX file containing both exam and answer key', () => {
  const root = makeTempDir();
  writeSimpleDocx(path.join(root, 'De 005 Vao 10 Thanh Hoa 2025.docx'), 'Question 1: Choose A B C D\nQuestion 2: Rewrite\n\nĐÁP ÁN\n1. A\n2. B');

  const scan = scanLocalExamFolder(root);

  assert.equal(scan.readyPairs.length, 1);
  assert.equal(scan.readyPairs[0].examCode, '005');
  assert.equal(scan.readyPairs[0].combined, true);
  assert.equal(scan.readyPairs[0].answerPath, scan.readyPairs[0].examPath);
});

test('readLocalPairText extracts and splits a combined legacy DOC exam file through converter', async () => {
  const root = makeTempDir();
  const file = path.join(root, 'MÃ ĐỀ 002.doc');
  touch(file);

  const pairText = await readLocalPairText({
    examCode: '002',
    examPath: file,
    answerPath: file,
    combined: true
  }, {
    minExamTextChars: 10,
    minAnswerTextChars: 3,
    legacyDocTextExtractor: () => 'Question 1: Choose A B C D\nQuestion 2: Rewrite\n\nĐÁP ÁN\n1. A\n2. B'
  });

  assert.match(pairText.examText, /Question 1/);
  assert.doesNotMatch(pairText.examText, /ĐÁP ÁN/);
  assert.equal(pairText.answerKeys.get(1), 'A');
  assert.equal(pairText.answerKeys.get(2), 'B');
});

test('readLocalPairText splits a legacy DOC when answer key has no explicit heading', async () => {
  const root = makeTempDir();
  const file = path.join(root, 'MÃ ĐỀ 007.doc');
  touch(file);

  const pairText = await readLocalPairText({
    examCode: '007',
    examPath: file,
    answerPath: file,
    combined: true
  }, {
    minExamTextChars: 10,
    minAnswerTextChars: 3,
    legacyDocTextExtractor: () => [
      'PHAN A: NGU AM',
      '1. A. different B. world C. practiced D. disaster',
      '2. A. pollute B. receipt C. species D. accept',
      'PHAN D: VIET',
      '50. Rewrite the sentence.',
      '',
      'PHAN A: NGU AM',
      '1. C\t2. B\t3. B',
      '4. C\t5. B',
      'PHAN B: NGU PHAP',
      '6. are made\t7. watching'
    ].join('\n')
  });

  assert.match(pairText.examText, /different/);
  assert.doesNotMatch(pairText.examText, /1\. C\t2\. B/);
  assert.match(pairText.answerText, /1\. C/);
  assert.equal(pairText.answerKeys.get(1), 'C');
  assert.equal(pairText.answerKeys.get(5), 'B');
});

test('readLocalPairText extracts and splits a combined DOCX exam file', async () => {
  const root = makeTempDir();
  const file = path.join(root, 'De 006 Vao 10 Thanh Hoa 2025.docx');
  writeSimpleDocx(file, 'Question 1: Choose A B C D\nQuestion 2: Rewrite this sentence.\n\nĐÁP ÁN VÀ HƯỚNG DẪN GIẢI\n1. A\n2. B');

  const pairText = await readLocalPairText({
    examCode: '006',
    examPath: file,
    answerPath: file,
    combined: true
  }, { minExamTextChars: 10, minAnswerTextChars: 3 });

  assert.match(pairText.examText, /Question 1/);
  assert.doesNotMatch(pairText.examText, /ĐÁP ÁN/);
  assert.match(pairText.answerText, /1\. A/);
  assert.equal(pairText.answerKeys.get(1), 'A');
  assert.equal(pairText.answerKeys.get(2), 'B');
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
  assert.equal(report.rows[0].preview_file, 'draft/001_De_001_Vao_10_Thanh_Hoa_2025.json');
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

test('runLocalBatch continues with later exams after one exam fails and uses manual prompt text', async () => {
  const root = makeTempDir();
  touch(path.join(root, 'De 001 Vao 10 Thanh Hoa 2025.pdf'));
  touch(path.join(root, 'Dap an De 001 Vao 10 Thanh Hoa 2025.pdf'));
  touch(path.join(root, 'De 002 Vao 10 Thanh Hoa 2025.pdf'));
  touch(path.join(root, 'Dap an De 002 Vao 10 Thanh Hoa 2025.pdf'));
  const prompts = [];

  const report = await runLocalBatch({
    folder: root,
    source: 'Thanh Hoa',
    level: 'vao10',
    mode: 'dry-run',
    limit: 2,
    expectedQuestionCount: 2,
    delayMs: 0,
    promptText: 'Manual prompt __EXAM_ID__',
    runDir: path.join(root, 'runs'),
    now: () => new Date('2026-06-09T00:00:00Z')
  }, {
    loadRemoteExamFiles: async () => [
      { id: 'exam-file-001', title: 'De 001 Vao 10 Thanh Hoa 2025', province: 'Thanh Hoa', exam_code: '001' },
      { id: 'exam-file-002', title: 'De 002 Vao 10 Thanh Hoa 2025', province: 'Thanh Hoa', exam_code: '002' }
    ],
    readPairText: async () => ({ examText: 'Question text from PDF', answerText: '1 A\n2 B', answerKeys: new Map([[1, 'A'], [2, 'B']]) }),
    convertWithGemini: async (payload, options) => {
      prompts.push({ prompt: payload.prompt, examCode: payload.pair.examCode, promptText: options.promptText });
      if (payload.pair.examCode === '001') throw new Error('MODEL_FAILED_FOR_001');
      return validExam('exam-file-002');
    }
  });

  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.errors, 1);
  assert.equal(report.summary.dry_run_ready, 1);
  assert.deepEqual(report.rows.map(row => row.status), ['error', 'dry_run_ready']);
  assert.match(report.rows[0].errors.join(' '), /MODEL_FAILED_FOR_001/);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every(item => item.prompt.includes('Manual prompt')));
  assert.ok(prompts.every(item => item.promptText === 'Manual prompt __EXAM_ID__'));
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
