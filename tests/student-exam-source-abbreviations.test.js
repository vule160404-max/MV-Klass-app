const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function loadSourceParser() {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const start = source.indexOf('function studentExamProvinceKey');
  const end = source.indexOf('function studentExamSourceLabel', start);
  assert.ok(start > 0, 'studentExamProvinceKey not found');
  assert.ok(end > start, 'studentExamSourceLabel not found');
  const context = {
    normalizeText(value) {
      return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    },
    repairMojibakeText(value) {
      return String(value || '');
    },
    result: null
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context.studentExamSourceTextFromName;
}

test('student exam source parser recognizes province-only abbreviations from filenames', () => {
  const sourceTextFromName = loadSourceParser();
  const cases = [
    ['De SL 001 Vao 10 2026.pdf', 'Sơn La'],
    ['De BK 001 Vao 10 2026.pdf', 'Bắc Kạn'],
    ['De CB 001 Vao 10 2026.pdf', 'Cao Bằng'],
    ['De LC 001 Vao 10 2026.pdf', 'Lào Cai'],
    ['De LCH 001 Vao 10 2026.pdf', 'Lai Châu'],
    ['De LS 001 Vao 10 2026.pdf', 'Lạng Sơn'],
    ['De HNA 001 Vao 10 2026.pdf', 'Hà Nam'],
    ['De HUE 001 Vao 10 2026.pdf', 'Huế']
  ];

  for (const [fileName, expected] of cases) {
    assert.equal(sourceTextFromName(fileName), expected, fileName);
  }
});
