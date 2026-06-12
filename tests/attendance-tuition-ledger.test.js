const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '..', 'web', 'attendance-app.html');

function readSource() {
  return fs.readFileSync(sourcePath, 'utf8');
}

function functionBlock(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = nextName ? source.indexOf(`function ${nextName}(`, start) : -1;
  assert.ok(end > start, `${nextName} follows ${name}`);
  return source.slice(start, end);
}

function asyncFunctionBlock(source, name, nextName) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = nextName ? source.indexOf(`${nextName.includes('function') ? '' : 'async function '}${nextName}(`, start) : -1;
  assert.ok(end > start, `${nextName} follows ${name}`);
  return source.slice(start, end);
}

test('attendance save seeds missing per-class tuition ledger rows for present students only', () => {
  const source = readSource();
  const ensureBlock = asyncFunctionBlock(source, 'ensureTuitionLedgerRowsForAttendance', 'insertPaymentHistory');
  const saveBlock = asyncFunctionBlock(source, 'saveAttendance', 'addStudent');

  assert.match(ensureBlock, /rec\.status === 'present'/);
  assert.match(ensureBlock, /student_tuition_by_class\?on_conflict=student_id,class_name/);
  assert.match(ensureBlock, /resolution=ignore-duplicates,return=minimal/);
  assert.match(ensureBlock, /charged_sessions:\s*0/);
  assert.match(ensureBlock, /prepaid_balance_vnd:\s*0/);
  assert.doesNotMatch(ensureBlock, /payment_history/);

  assert.match(saveBlock, /await ensureTuitionLedgerRowsForAttendance\(records\)/);
  assert.match(saveBlock, /await loadChargedSessions\(\)/);
});
