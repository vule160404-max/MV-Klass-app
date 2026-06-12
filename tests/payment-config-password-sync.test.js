const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const htmlPath = path.join(__dirname, '..', 'web', 'attendance-app.html');
const html = fs.readFileSync(htmlPath, 'utf8');

test('payment account unlock uses the current login password verifier', () => {
  const fn = html.match(/async function unlockPaymentConfigCard\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'unlockPaymentConfigCard should exist');
  assert.match(fn[0], /verifyCurrentPassword\(password\)/);
  assert.doesNotMatch(fn[0], /paymentConfigPassword|unlockPassword|adminPassword/);
});

test('changing login password re-locks payment account settings', () => {
  const fn = html.match(/async function submitStudentExamPasswordChange\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'submitStudentExamPasswordChange should exist');
  assert.match(fn[0], /fetch\(SUPABASE_URL \+ '\/auth\/v1\/user'/);
  assert.match(fn[0], /lockPaymentConfigCard\(\{ silent: true \}\)/);
});
