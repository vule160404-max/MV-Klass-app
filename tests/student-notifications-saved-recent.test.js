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
  return source.slice(start, end === -1 ? undefined : end);
}

test('student notifications persist read state and only show requested notification types', () => {
  const source = readSource();
  const notificationBlock = functionBlock(source, 'studentExamNotificationItems', 'renderStudentExamNotifications');
  const renderBlock = functionBlock(source, 'renderStudentExamNotifications', 'studentExamSaveSettings');
  const toggleBlock = functionBlock(source, 'toggleStudentExamHeaderPanel', 'toggleStudentExamUserMenu');

  assert.match(source, /const STUDENT_EXAM_NOTIFICATIONS_SEEN_KEY = 'mvk_student_notifications_seen_v1'/);
  assert.match(source, /function studentExamNotificationSignature\(items\)/);
  assert.match(source, /function studentExamMarkNotificationsSeen\(\)/);
  assert.match(toggleBlock, /studentExamMarkNotificationsSeen\(\)/);
  assert.match(renderBlock, /badge\.hidden = count <= 0 \|\| signature === seenSignature/);
  assert.match(renderBlock, /localStorage\.getItem\(STUDENT_EXAM_NOTIFICATIONS_SEEN_KEY\)/);

  assert.match(notificationBlock, /Gần hết lượt tải Free|Gáº§n háº¿t lÆ°á»£t táº£i Free/);
  assert.match(notificationBlock, /Đã hết lượt tải Free|ÄÃ£ háº¿t lÆ°á»£t táº£i Free/);
  assert.match(notificationBlock, /Tài khoản Free hiện truy cập được|TÃ i khoáº£n Free hiá»‡n truy cáº­p Ä‘Æ°á»£c/);
  assert.match(notificationBlock, /Mỗi ngày được[\s\S]*lượt tải miễn phí|Má»—i ngÃ y Ä‘Æ°á»£c[\s\S]*lÆ°á»£t táº£i miá»…n phÃ­/);
  assert.match(notificationBlock, /Đăng ký Premium thành công|ÄÄƒng kÃ½ Premium thÃ nh cÃ´ng/);
  assert.match(notificationBlock, /Tài khoản bị khóa|TÃ i khoáº£n bá»‹ khÃ³a/);
  assert.match(notificationBlock, /quota\.remaining <= 0[\s\S]*action:\s*'premium'/);
  assert.doesNotMatch(notificationBlock, /action:\s*'online'/);
  assert.doesNotMatch(notificationBlock, /Điểm TB|Äiá»ƒm TB|last_submitted_at|lâu chưa làm|lÃ¢u chÆ°a lÃ m/);
});

test('student portal has saved and recent tabs with quick actions', () => {
  const source = readSource();

  assert.match(source, /id="student-exam-saved-recent-panel"/);
  assert.match(source, /data-student-activity-tab="saved"/);
  assert.match(source, /data-student-activity-tab="recent"/);
  assert.match(source, /id="student-exam-saved-list"/);
  assert.match(source, /id="student-exam-recent-list"/);
  assert.match(source, /function studentExamSetActivityTab\(tab\)/);
  assert.match(source, /function renderStudentExamSavedRecentPanel\(\)/);
  assert.match(source, /function studentExamRecentActivityItems\(\)/);
  assert.match(source, /data-exam-preview="\$\{id\}"/);
  assert.match(source, /data-exam-download="\$\{id\}"/);
  assert.match(source, /data-exam-online="\$\{id\}"/);
});
