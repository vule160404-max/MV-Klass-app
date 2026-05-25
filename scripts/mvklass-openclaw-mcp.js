#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const PAGE_SIZE = 1000;
const MAX_ROWS = 5000;

function loadEnvFile() {
  const files = [path.join(__dirname, '..', '.env.local'), path.join(process.cwd(), '.env.local')];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      raw.split(/\r?\n/).forEach((line) => {
        const m = String(line || '').match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m || process.env[m[1]] != null) return;
        let v = String(m[2] || '').trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      });
    } catch (_) {}
  }
}

loadEnvFile();

function env(name) {
  return String(process.env[name] || '').trim();
}

function supabaseConfig() {
  const url = env('SUPABASE_URL') || env('VITE_SUPABASE_URL');
  const key =
    env('SUPABASE_SERVICE_ROLE_KEY') ||
    env('SUPABASE_KEY') ||
    env('SUPABASE_ANON_KEY') ||
    env('VITE_SUPABASE_ANON_KEY');
  if (!/^https?:\/\//i.test(url) || !key) {
    throw new Error('Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY for MV-Klass MCP tools.');
  }
  return { url: new URL(url), key };
}

function requestJson(pathname) {
  return new Promise((resolve, reject) => {
    let cfg;
    try {
      cfg = supabaseConfig();
    } catch (err) {
      reject(err);
      return;
    }
    const req = https.request(
      {
        hostname: cfg.url.hostname,
        path: pathname,
        method: 'GET',
        headers: {
          apikey: cfg.key,
          Authorization: 'Bearer ' + cfg.key,
          Accept: 'application/json'
        }
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error('Supabase REST returned HTTP ' + res.statusCode + ' for ' + pathname));
            return;
          }
          try {
            resolve(JSON.parse(body || '[]'));
          } catch (err) {
            reject(new Error('Supabase returned invalid JSON for ' + pathname));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function requestSupabase(method, pathname, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    let cfg;
    try {
      cfg = supabaseConfig();
    } catch (err) {
      reject(err);
      return;
    }
    const payload = body == null ? null : JSON.stringify(body);
    const headers = Object.assign(
      {
        apikey: cfg.key,
        Authorization: 'Bearer ' + cfg.key,
        Accept: 'application/json'
      },
      extraHeaders || {}
    );
    if (payload != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload, 'utf8');
    }
    const req = https.request(
      {
        hostname: cfg.url.hostname,
        path: pathname,
        method,
        headers
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error('Supabase REST returned HTTP ' + res.statusCode + ' for ' + method + ' ' + pathname + ': ' + text.slice(0, 500)));
            return;
          }
          if (!String(text || '').trim()) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (_) {
            resolve(text);
          }
        });
      }
    );
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

async function fetchAll(table, opts) {
  const select = encodeURIComponent((opts && opts.select) || '*');
  const order = opts && opts.order ? '&order=' + encodeURIComponent(opts.order) : '';
  const filters = opts && opts.filters ? '&' + opts.filters : '';
  const limit = Math.min(MAX_ROWS, Math.max(1, Number((opts && opts.maxRows) || MAX_ROWS)));
  let offset = 0;
  let out = [];
  while (out.length < limit) {
    const n = Math.min(PAGE_SIZE, limit - out.length);
    const rows = await requestJson('/rest/v1/' + table + '?select=' + select + order + filters + '&limit=' + n + '&offset=' + offset);
    if (!Array.isArray(rows) || !rows.length) break;
    out = out.concat(rows);
    if (rows.length < n) break;
    offset += n;
  }
  return out;
}

async function loadSnapshot() {
  const today = ymd(new Date());
  const since = addDays(today, -45);
  const [
    students,
    attendance,
    payments,
    tuition,
    tuitionByClass,
    bank,
    leads,
    classDefs,
    classFees
  ] = await Promise.all([
    fetchAll('students', { order: 'name.asc' }),
    fetchAll('attendance', { order: 'date.desc', filters: 'date=gte.' + encodeURIComponent(since) }),
    fetchAll('payment_history', { order: 'paid_at.desc', maxRows: 3000 }),
    fetchAll('student_tuition', {}),
    fetchAll('student_tuition_by_class', {}),
    fetchAll('bank_transactions', { order: 'created_at.desc', maxRows: 1000 }),
    fetchAll('consultation_leads', { order: 'created_at.desc', maxRows: 1000 }),
    fetchAll('class_definitions', {}),
    fetchAll('class_fees', {})
  ]);
  return { today, students, attendance, payments, tuition, tuitionByClass, bank, leads, classDefs, classFees };
}

function ymd(d) {
  const x = d instanceof Date ? d : new Date(d);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}

function addDays(dateText, days) {
  const d = new Date(dateText + 'T00:00:00');
  d.setDate(d.getDate() + Number(days || 0));
  return ymd(d);
}

function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function money(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

function classNamesOf(student) {
  const arr = [];
  if (student && student.class_name) arr.push(String(student.class_name));
  if (Array.isArray(student && student.class_names)) {
    student.class_names.forEach((c) => c && arr.push(String(c)));
  }
  return Array.from(new Set(arr.map((x) => x.trim()).filter(Boolean)));
}

function feeMap(classFees) {
  const out = {};
  asArray(classFees).forEach((r) => {
    const k = norm(r.class_name || r.class || r.name);
    if (!k) return;
    out[k] = money(r.fee_amount || r.fee_per_session || r.amount_vnd || r.amount);
  });
  return out;
}

function getFeeForClass(fees, className) {
  return fees[norm(className)] || 0;
}

function computeDebts(snapshot) {
  const fees = feeMap(snapshot.classFees);
  const studentsById = new Map(asArray(snapshot.students).map((s) => [String(s.id), s]));
  const presentByStudent = {};
  const presentByStudentClass = {};

  asArray(snapshot.attendance).forEach((a) => {
    if (!a || a.status !== 'present') return;
    const sid = String(a.student_id || '');
    if (!sid) return;
    presentByStudent[sid] = (presentByStudent[sid] || 0) + 1;
    const cls = String(a.class_name || (studentsById.get(sid) || {}).class_name || '').trim();
    if (cls) {
      presentByStudentClass[sid + '::' + norm(cls)] = (presentByStudentClass[sid + '::' + norm(cls)] || 0) + 1;
    }
  });

  const chargedTotal = {};
  asArray(snapshot.tuition).forEach((r) => {
    chargedTotal[String(r.student_id || '')] = Number(r.charged_sessions || 0);
  });

  const chargedByClass = {};
  asArray(snapshot.tuitionByClass).forEach((r) => {
    chargedByClass[String(r.student_id || '') + '::' + norm(r.class_name)] = Number(r.charged_sessions || 0);
  });

  return asArray(snapshot.students)
    .map((s) => {
      const sid = String(s.id || '');
      const classes = classNamesOf(s);
      const perClass = classes.map((cls) => {
        const key = sid + '::' + norm(cls);
        const present = Number(presentByStudentClass[key] || 0);
        const charged = Number(chargedByClass[key] || 0);
        const sessionsDue = Math.max(0, present - charged);
        const fee = getFeeForClass(fees, cls);
        return { class_name: cls, present_sessions: present, charged_sessions: charged, sessions_due: sessionsDue, amount_due_vnd: sessionsDue * fee };
      });
      const perClassDue = perClass.reduce((sum, r) => sum + r.sessions_due, 0);
      const fallbackDue = Math.max(0, Number(presentByStudent[sid] || 0) - Number(chargedTotal[sid] || 0));
      const sessionsDue = perClass.length ? perClassDue : fallbackDue;
      const primaryClass = classes[0] || String(s.class_name || '');
      const amountDue = perClass.length
        ? perClass.reduce((sum, r) => sum + r.amount_due_vnd, 0)
        : sessionsDue * getFeeForClass(fees, primaryClass);
      return {
        student_id: sid,
        name: String(s.name || ''),
        phone: String(s.phone || ''),
        parent_name: String(s.parent_name || ''),
        class_name: primaryClass,
        class_names: classes,
        sessions_due: sessionsDue,
        amount_due_vnd: amountDue,
        per_class: perClass.filter((r) => r.sessions_due > 0)
      };
    })
    .filter((r) => r.sessions_due > 0)
    .sort((a, b) => b.sessions_due - a.sessions_due || b.amount_due_vnd - a.amount_due_vnd || a.name.localeCompare(b.name));
}

function weekdayTokens(dateText) {
  const d = new Date(dateText + 'T00:00:00');
  const idx = d.getDay();
  const vi = ['chu nhat', 'thu 2', 'thu 3', 'thu 4', 'thu 5', 'thu 6', 'thu 7'][idx];
  const en = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][idx];
  const full = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][idx];
  return new Set([
    String(idx),
    String(idx === 0 ? 8 : idx + 1),
    vi,
    vi.replace(' ', ''),
    idx === 0 ? 'cn' : 't' + (idx + 1),
    en,
    full
  ]);
}

function isClassDefinitionPaused(def) {
  if (!def) return false;
  return def.dashboard_hidden === true || String(def.dashboard_hidden || '').toLowerCase() === 'true';
}

function scheduledClassesForDate(classDefs, dateText) {
  const tokens = weekdayTokens(dateText);
  return asArray(classDefs)
    .filter((d) => {
      if (isClassDefinitionPaused(d)) return false;
      const days = Array.isArray(d.days) ? d.days : [];
      const dayMatch = days.some((x) => tokens.has(norm(x)) || tokens.has(String(x)));
      if (days.length) return dayMatch;
      const scheduleDays = d.schedule && typeof d.schedule === 'object' ? Object.keys(d.schedule) : [];
      const scheduleMatch = scheduleDays.some((x) => tokens.has(norm(x)) || tokens.has(String(x)));
      if (scheduleDays.length) return scheduleMatch;
      const labelText = norm(String(d.label || '') + ' ' + String(d.display_name || ''));
      return Array.from(tokens)
        .filter((t) => t && !/^\d+$/.test(t))
        .some((t) => new RegExp('(^| )' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)').test(labelText));
    })
    .map((d) => ({
      class_name: String(d.label || d.display_name || ''),
      display_name: String(d.display_name || d.label || ''),
      schedule: d.schedule || {}
    }))
    .filter((d) => d.class_name);
}

function timesForDate(schedule, dateText) {
  if (!schedule || typeof schedule !== 'object') return '';
  const tokens = weekdayTokens(dateText);
  const key = Object.keys(schedule).find((k) => tokens.has(norm(k)) || tokens.has(String(k)));
  if (!key || !schedule[key] || typeof schedule[key] !== 'object') return '';
  const start = String(schedule[key].start || '').trim();
  const end = String(schedule[key].end || '').trim();
  return start && end ? start + '-' + end : start || end;
}

function vnNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const pick = (type) => (parts.find((p) => p.type === type) || {}).value || '00';
  return pick('year') + '-' + pick('month') + '-' + pick('day') + 'T' + pick('hour') + ':' + pick('minute') + ':' + pick('second') + '+07:00';
}

function minutesOfDay(timeText) {
  const m = String(timeText || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function nowInfo(args) {
  const raw = String((args && args.now) || '').trim();
  const local = raw || vnNow();
  const m = local.match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})/);
  if (m) {
    return { date: m[1], minutes: Number(m[2]) * 60 + Number(m[3]), iso: local };
  }
  const fallback = vnNow();
  const fm = fallback.match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{2})/);
  return { date: fm ? fm[1] : vnDate(), minutes: fm ? Number(fm[2]) * 60 + Number(fm[3]) : 0, iso: fallback };
}

function classStartMinutes(classRow, dateText) {
  const t = timesForDate(classRow.schedule, dateText);
  const start = String(t || '').split('-')[0] || '';
  return minutesOfDay(start);
}

function attendanceRowsForClass(snapshot, date, className) {
  const studentsById = new Map(asArray(snapshot.students).map((s) => [String(s.id), s]));
  return asArray(snapshot.attendance)
    .filter((a) => String(a.date || '').slice(0, 10) === date)
    .filter((a) => classMatches(a.class_name || classNamesOf(studentsById.get(String(a.student_id || '')) || {})[0] || '', className));
}

function absenceRiskRows(snapshot) {
  const byStudent = new Map();
  asArray(snapshot.attendance).forEach((a) => {
    const sid = String(a.student_id || '');
    if (!sid) return;
    if (!byStudent.has(sid)) byStudent.set(sid, []);
    byStudent.get(sid).push(a);
  });
  const studentsById = new Map(asArray(snapshot.students).map((s) => [String(s.id), s]));
  const out = [];
  byStudent.forEach((rows, sid) => {
    const sorted = rows
      .slice()
      .filter((r) => normalizeAttendanceStatus(r.status) === 'present' || normalizeAttendanceStatus(r.status) === 'absent')
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    let streak = 0;
    const streakDates = [];
    for (const r of sorted) {
      if (normalizeAttendanceStatus(r.status) === 'absent') {
        streak += 1;
        streakDates.push(String(r.date || '').slice(0, 10));
      } else {
        break;
      }
    }
    const recent = sorted.slice(0, 8);
    const recentAbsent = recent.filter((r) => normalizeAttendanceStatus(r.status) === 'absent').length;
    const recentRate = recent.length ? recentAbsent / recent.length : 0;
    if (streak < 3 && !(recent.length >= 4 && recentAbsent >= 3 && recentRate >= 0.5)) return;
    const latestPresent = sorted.find((r) => normalizeAttendanceStatus(r.status) === 'present');
    const student = studentsById.get(sid) || {};
    out.push({
      student_id: sid,
      name: student.name || '',
      phone: student.phone || '',
      class_names: classNamesOf(student),
      current_absent_streak: streak,
      streak_dates: streakDates,
      recent_absent_count: recentAbsent,
      recent_checked_count: recent.length,
      recent_absent_rate: recentRate,
      latest_date: sorted[0] ? String(sorted[0].date || '').slice(0, 10) : '',
      latest_present_date: latestPresent ? String(latestPresent.date || '').slice(0, 10) : '',
      reason: streak >= 3 ? 'absent_streak_3_plus' : 'high_recent_absence_rate'
    });
  });
  return out.sort((a, b) =>
    b.current_absent_streak - a.current_absent_streak ||
    b.recent_absent_rate - a.recent_absent_rate ||
    String(a.name || '').localeCompare(String(b.name || ''), 'vi')
  );
}

function classReminderRows(snapshot, args) {
  const info = nowInfo(args);
  const date = String((args && args.date) || info.date).slice(0, 10);
  const nowMinutes = String((args && args.date) || '').slice(0, 10) === date && args && args.minutes_of_day != null
    ? Number(args.minutes_of_day)
    : info.minutes;
  const windowMinutes = Math.max(1, Math.min(30, Number((args && args.window_minutes) || 5)));
  return scheduledClassesForDate(snapshot.classDefs, date)
    .map((c) => {
      const start = classStartMinutes(c, date);
      if (start == null) return null;
      const minutesUntilStart = start - nowMinutes;
      const rows = attendanceRowsForClass(snapshot, date, c.class_name);
      const marked = rows.length > 0;
      let kind = '';
      if (Math.abs(minutesUntilStart - 30) <= windowMinutes) kind = 'class_starts_in_30m';
      else if (Math.abs(minutesUntilStart - 10) <= windowMinutes) kind = 'class_starts_in_10m';
      else if (nowMinutes - start >= 30 && !marked) kind = 'attendance_missing_after_30m';
      if (!kind) return null;
      return {
        kind,
        date,
        class_name: c.class_name,
        name: cleanClassName(c.display_name || c.class_name),
        time: timesForDate(c.schedule, date),
        minutes_until_start: minutesUntilStart,
        minutes_since_start: nowMinutes - start,
        attendance_rows: rows.length
      };
    })
    .filter(Boolean)
    .sort((a, b) => Math.abs(a.minutes_until_start) - Math.abs(b.minutes_until_start));
}

function latestAttendanceForStudent(snapshot, studentId, limit) {
  return asArray(snapshot.attendance)
    .filter((a) => String(a.student_id || '') === String(studentId || ''))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, limit || 10)
    .map((a) => ({ date: a.date, status: a.status, class_name: a.class_name || '' }));
}

function findStudents(snapshot, query, className) {
  const qn = norm(query);
  const qd = digits(query);
  const cn = norm(className);
  return asArray(snapshot.students)
    .map((s) => {
      const name = norm(s.name);
      const phone = digits(s.phone);
      const classes = classNamesOf(s);
      if (cn && !classes.some((c) => norm(c) === cn)) return null;
      let score = 0;
      if (qd && phone && phone.includes(qd)) score += 100;
      if (qn && name === qn) score += 90;
      if (qn && name.includes(qn)) score += 60;
      if (qn && qn.split(' ').every((p) => name.includes(p))) score += 35;
      return score > 0 ? { student: s, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.student);
}

function bankReviewRows(snapshot, status, limit) {
  const wanted = String(status || 'needs_review,pending').split(',').map((s) => s.trim()).filter(Boolean);
  return asArray(snapshot.bank)
    .filter((b) => wanted.includes(String(b.status || '').trim()))
    .slice(0, Math.min(50, Number(limit || 20)))
    .map((b) => ({
      id: b.id,
      status: b.status,
      amount_vnd: b.amount_vnd,
      occurred_at: b.occurred_at || b.created_at,
      transfer_content: b.transfer_content || '',
      payer_name: b.payer_name || '',
      matched_student_id: b.matched_student_id || '',
      matched_class_name: b.matched_class_name || '',
      error_note: b.error_note || b.reconcile_note || ''
    }));
}

async function todayOverview(args) {
  const snapshot = await loadSnapshot();
  const date = String((args && args.date) || snapshot.today).slice(0, 10);
  const scheduled = scheduledClassesForDate(snapshot.classDefs, date);
  const todayAttendance = asArray(snapshot.attendance).filter((a) => String(a.date || '').slice(0, 10) === date);
  const attendedClasses = new Set(todayAttendance.map((a) => norm(a.class_name)).filter(Boolean));
  const unmarked = scheduled.filter((c) => !attendedClasses.has(norm(c.class_name)) && !attendedClasses.has(norm(c.display_name)));
  const debts = computeDebts(snapshot).slice(0, 10);
  const bankNeedsReview = bankReviewRows(snapshot, 'needs_review,pending', 10);
  const leadsNew = asArray(snapshot.leads)
    .filter((l) => String(l.status || 'new') === 'new')
    .slice(0, 10)
    .map((l) => ({
      id: l.id,
      created_at: l.created_at,
      student_name: l.student_name,
      parent_phone: l.parent_phone,
      grade: l.grade,
      program_label: l.program_label,
      notes: l.notes || ''
    }));
  const classesText = scheduled.length
    ? scheduled.map((c) => {
        const times = timesForDate(c.schedule, date);
        return '- ' + (c.display_name || c.class_name) + (times ? ' (' + times + ')' : '');
      }).join('\n')
    : 'Không có lớp nào trong lịch.';
  return {
    answer: 'Hôm nay có ' + scheduled.length + ' lớp:\n' + classesText,
    date,
    classes_today_count: scheduled.length,
    classes_today: scheduled.map((c) => ({
      name: c.display_name || c.class_name,
      time: timesForDate(c.schedule, date)
    })),
    answer_hint_vi: 'Lịch lớp ngày ' + date + ':\n' + classesText,
    unmarked_attendance_count: unmarked.length,
    unmarked_attendance: unmarked.map((c) => ({
      name: c.display_name || c.class_name,
      time: timesForDate(c.schedule, date)
    })),
    attendance_rows_today: todayAttendance.length,
    unpaid_students_top: debts.slice(0, 3).map((d) => ({
      name: d.name,
      class_name: d.class_name,
      sessions_due: d.sessions_due,
      amount_due_vnd: d.amount_due_vnd
    })),
    bank_needs_review_count: bankNeedsReview.length,
    bank_needs_review: bankNeedsReview.slice(0, 3),
    new_consultation_leads_count: leadsNew.length,
    new_consultation_leads: leadsNew,
    note: 'Read-only summary. No messages were sent and no database rows were changed.'
  };
}

async function studentLookup(args) {
  const snapshot = await loadSnapshot();
  const query = String((args && args.query) || '').trim();
  const className = String((args && args.class_name) || '').trim();
  if (!query) throw new Error('query is required');
  const matches = findStudents(snapshot, query, className).slice(0, 6);
  const debtsById = new Map(computeDebts(snapshot).map((d) => [d.student_id, d]));
  return {
    query,
    class_name_filter: className,
    match_status: matches.length === 1 ? 'single' : matches.length > 1 ? 'ambiguous' : 'not_found',
    students: matches.map((s) => {
      const debt = debtsById.get(String(s.id)) || null;
      return {
        student_id: s.id,
        name: s.name,
        phone: s.phone || '',
        parent_name: s.parent_name || '',
        class_name: s.class_name || '',
        class_names: classNamesOf(s),
        birth_year: s.birth_year || null,
        learning_note: s.learning_note || '',
        debt,
        recent_attendance: latestAttendanceForStudent(snapshot, s.id, 8)
      };
    })
  };
}

async function tuitionDebtList(args) {
  const snapshot = await loadSnapshot();
  const minSessions = Math.max(1, Number((args && args.min_sessions_due) || 1));
  const classFilter = norm(args && args.class_name);
  const limit = Math.min(50, Math.max(1, Number((args && args.limit) || 20)));
  return {
    min_sessions_due: minSessions,
    class_name_filter: String((args && args.class_name) || ''),
    students: computeDebts(snapshot)
      .filter((d) => d.sessions_due >= minSessions)
      .filter((d) => !classFilter || d.class_names.some((c) => norm(c) === classFilter))
      .slice(0, limit),
    note: 'Read-only debt estimate from attendance present sessions minus charged sessions.'
  };
}

async function bankReviewList(args) {
  const snapshot = await loadSnapshot();
  return {
    transactions: bankReviewRows(snapshot, String((args && args.status) || 'needs_review,pending'), Number((args && args.limit) || 20)),
    note: 'Read-only list. No bank transaction was applied, ignored, or updated.'
  };
}

async function opsAlerts(args, snapshotOverride) {
  const snapshot = snapshotOverride || await loadSnapshot();
  const kind = norm((args && args.kind) || 'all');
  const limit = Math.max(1, Math.min(30, Number((args && args.limit) || 12)));
  const absence = /all|absence|nghi|vang|risk|rui ro|bo hoc/.test(kind) ? absenceRiskRows(snapshot).slice(0, limit) : [];
  const classAlerts = /all|class|lop|diem danh|attendance|reminder|nhac/.test(kind) ? classReminderRows(snapshot, args).slice(0, limit) : [];
  const lines = [];
  if (absence.length) {
    lines.push('Canh bao hoc vien nghi hoc:');
    absence.slice(0, 10).forEach((r) => {
      const reason = r.current_absent_streak >= 3
        ? r.current_absent_streak + ' buoi vang lien tiep'
        : r.recent_absent_count + '/' + r.recent_checked_count + ' buoi gan day vang';
      lines.push('- ' + r.name + (r.class_names.length ? ' · ' + r.class_names.map(cleanClassName).join(', ') : '') + ': ' + reason);
    });
  }
  if (classAlerts.length) {
    lines.push(lines.length ? '' : '');
    lines.push('Nhac viec lop/diem danh:');
    classAlerts.slice(0, 10).forEach((r) => {
      const label =
        r.kind === 'class_starts_in_30m' ? 'sap vao lop trong 30 phut' :
        r.kind === 'class_starts_in_10m' ? 'sap vao lop trong 10 phut' :
        'da bat dau hon 30 phut nhung chua diem danh';
      lines.push('- ' + r.name + (r.time ? ' (' + r.time + ')' : '') + ': ' + label);
    });
  }
  return {
    answer: lines.filter(Boolean).length ? lines.filter(Boolean).join('\n') : 'Hien chua co canh bao nghi hoc, nhac vao lop, hoac lop tre diem danh trong khung kiem tra nay.',
    absence_risk_count: absence.length,
    absence_risks: absence,
    class_alert_count: classAlerts.length,
    class_alerts: classAlerts,
    note: 'Read-only alerts. No messages were sent and no database rows were changed.'
  };
}

function vnDate() {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const pick = (type) => (parts.find((p) => p.type === type) || {}).value || '';
    const y = pick('year');
    const m = pick('month');
    const d = pick('day');
    if (y && m && d) return y + '-' + m + '-' + d;
  } catch (_) {}
  return ymd(new Date());
}

function addDaysYmd(dateText, days) {
  return addDays(String(dateText || vnDate()).slice(0, 10), days);
}

function dateFromQuestion(question) {
  const raw = String(question || '');
  const n = norm(raw);
  const iso = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  const dmy = raw.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
  if (dmy) {
    return String(dmy[3]) + '-' + String(dmy[2]).padStart(2, '0') + '-' + String(dmy[1]).padStart(2, '0');
  }
  const today = vnDate();
  if (/\bhom qua\b/.test(n)) return addDaysYmd(today, -1);
  if (/\bngay mai\b/.test(n)) return addDaysYmd(today, 1);
  const weekdays = [
    { re: /\b(chu nhat|cn|sunday|sun)\b/, idx: 0 },
    { re: /\b(thu 2|thu hai|t2|monday|mon)\b/, idx: 1 },
    { re: /\b(thu 3|thu ba|t3|tuesday|tue)\b/, idx: 2 },
    { re: /\b(thu 4|thu tu|t4|wednesday|wed)\b/, idx: 3 },
    { re: /\b(thu 5|thu nam|t5|thursday)\b/, idx: 4 },
    { re: /\b(thu 6|thu sau|t6|friday|fri)\b/, idx: 5 },
    { re: /\b(thu 7|thu bay|t7|saturday|sat)\b/, idx: 6 }
  ];
  const wanted = weekdays.find((d) => d.re.test(n));
  if (wanted) {
    const base = new Date(today + 'T00:00:00');
    const current = base.getDay();
    let diff = wanted.idx - current;
    const asksPast = /\b(vua roi|tuan truoc|qua|gan nhat)\b/.test(n);
    const asksNext = /\b(tuan sau|toi|sap toi|ke tiep)\b/.test(n);
    if (asksPast && diff >= 0) diff -= 7;
    if (!asksPast && !asksNext && diff < 0) diff += 7;
    if (asksNext && diff <= 0) diff += 7;
    return addDaysYmd(today, diff);
  }
  return today;
}

function startOfMonth(dateText) {
  return String(dateText || vnDate()).slice(0, 7) + '-01';
}

function endOfMonth(dateText) {
  const d = new Date(startOfMonth(dateText) + 'T00:00:00');
  d.setMonth(d.getMonth() + 1);
  d.setDate(d.getDate() - 1);
  return ymd(d);
}

function dateRangeFromQuestion(question) {
  const n = norm(question);
  const base = dateFromQuestion(question);
  if (/\b(tuan truoc|7 ngay truoc|vua roi)\b/.test(n)) {
    const start = addDaysYmd(mondayOfWeek(base), -7);
    return { start, end: addDaysYmd(start, 6), label: 'tuần trước' };
  }
  if (/\b(tuan sau|sap toi|ke tiep)\b/.test(n)) {
    const start = addDaysYmd(mondayOfWeek(base), 7);
    return { start, end: addDaysYmd(start, 6), label: 'tuần sau' };
  }
  if (/\b(tuan nay|trong tuan|1 tuan|mot tuan|7 ngay|bay ngay)\b/.test(n)) {
    const start = mondayOfWeek(base);
    return { start, end: addDaysYmd(start, 6), label: 'tuần này' };
  }
  if (/\b(thang truoc|thang vua roi)\b/.test(n)) {
    const d = new Date(startOfMonth(base) + 'T00:00:00');
    d.setMonth(d.getMonth() - 1);
    const start = ymd(d);
    return { start, end: endOfMonth(start), label: 'tháng trước' };
  }
  if (/\bthang nay\b/.test(n)) {
    return { start: startOfMonth(base), end: endOfMonth(base), label: 'tháng này' };
  }
  const monthMatch = n.match(/\bthang\s*(\d{1,2})\b/);
  if (monthMatch) {
    const month = String(Math.max(1, Math.min(12, Number(monthMatch[1])))).padStart(2, '0');
    const year = String(base).slice(0, 4);
    const start = year + '-' + month + '-01';
    return { start, end: endOfMonth(start), label: 'tháng ' + month + '/' + year };
  }
  return { start: base, end: base, label: 'ngày ' + base };
}

function isDateInRange(dateText, range) {
  const d = String(dateText || '').slice(0, 10);
  return d && d >= range.start && d <= range.end;
}

function shortClassName(value) {
  return String(value || '')
    .split('•')[0]
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b[\s\S]*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanClassName(value) {
  return shortClassName(value) || String(value || '').trim();
}

function normalizeAttendanceStatus(value) {
  const s = norm(value);
  if (s === 'present' || s.includes('co mat') || s.includes('di hoc')) return 'present';
  if (s === 'absent' || s.includes('vang')) return 'absent';
  return s;
}

function lineJoin(lines) {
  return lines.filter(Boolean).join('\n');
}

function classScheduleAnswer(snapshot, question) {
  const date = dateFromQuestion(question);
  const rows = scheduledClassesForDate(snapshot.classDefs, date);
  const lines = rows.map((c) => {
    const t = timesForDate(c.schedule, date);
    return '- ' + cleanClassName(c.display_name || c.class_name) + (t ? ' (' + t + ')' : '');
  });
  return {
    answer: rows.length
      ? 'Ngày ' + date + ' có ' + rows.length + ' lớp:\n' + lines.join('\n')
      : 'Ngày ' + date + ' chưa thấy lớp nào trong lịch đã cấu hình.',
    intent: 'class_schedule',
    date,
    classes: rows.map((c) => ({ name: cleanClassName(c.display_name || c.class_name), time: timesForDate(c.schedule, date) }))
  };
}

function weekdayLabelVi(dateText) {
  const d = new Date(String(dateText || vnDate()).slice(0, 10) + 'T00:00:00');
  return ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'][d.getDay()] || '';
}

function mondayOfWeek(dateText) {
  const d = new Date(String(dateText || vnDate()).slice(0, 10) + 'T00:00:00');
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return ymd(d);
}

function scheduleRangeFromQuestion(question) {
  const n = norm(question);
  const today = vnDate();
  if (/(tuan sau|next week)/.test(n)) {
    const start = addDaysYmd(mondayOfWeek(today), 7);
    return { start, days: 7, label: 'tuần sau' };
  }
  if (/(tuan nay|trong tuan nay|this week)/.test(n)) {
    return { start: mondayOfWeek(today), days: 7, label: 'tuần này' };
  }
  const num = n.match(/\b(\d{1,2})\s*(ngay|day)/);
  if (num) return { start: today, days: Math.max(1, Math.min(31, Number(num[1]))), label: Number(num[1]) + ' ngày tới' };
  return { start: today, days: 7, label: '7 ngày tới' };
}

function weeklyScheduleAnswer(snapshot, question) {
  const range = scheduleRangeFromQuestion(question);
  const days = [];
  for (let i = 0; i < range.days; i += 1) {
    const date = addDaysYmd(range.start, i);
    const classes = scheduledClassesForDate(snapshot.classDefs, date).map((c) => ({
      name: cleanClassName(c.display_name || c.class_name),
      time: timesForDate(c.schedule, date)
    }));
    days.push({ date, weekday: weekdayLabelVi(date), classes });
  }
  const lines = days.map((d) => {
    if (!d.classes.length) return '- ' + d.weekday + ' ' + d.date + ': không có lớp';
    return '- ' + d.weekday + ' ' + d.date + ': ' + d.classes.map((c) => c.name + (c.time ? ' (' + c.time + ')' : '')).join('; ');
  });
  const total = days.reduce((sum, d) => sum + d.classes.length, 0);
  return {
    answer: 'Lịch dạy ' + range.label + ' có ' + total + ' ca/lớp:\n' + lines.join('\n'),
    intent: 'class_schedule_range',
    start_date: range.start,
    days: range.days,
    total_classes: total,
    schedule: days
  };
}

function unmarkedAttendanceAnswer(snapshot, question) {
  const date = dateFromQuestion(question);
  const scheduled = scheduledClassesForDate(snapshot.classDefs, date);
  const marked = new Set(asArray(snapshot.attendance)
    .filter((a) => String(a.date || '').slice(0, 10) === date)
    .map((a) => norm(a.class_name))
    .filter(Boolean));
  const rows = scheduled.filter((c) => !marked.has(norm(c.class_name)) && !marked.has(norm(c.display_name)));
  return {
    answer: rows.length
      ? 'Ngày ' + date + ' còn ' + rows.length + ' lớp chưa điểm danh:\n' + rows.map((c) => '- ' + cleanClassName(c.display_name || c.class_name) + (timesForDate(c.schedule, date) ? ' (' + timesForDate(c.schedule, date) + ')' : '')).join('\n')
      : 'Ngày ' + date + ' không còn lớp nào trong lịch bị thiếu điểm danh.',
    intent: 'unmarked_attendance',
    date,
    count: rows.length,
    classes: rows.map((c) => ({ name: cleanClassName(c.display_name || c.class_name), time: timesForDate(c.schedule, date) }))
  };
}

function faqCatalogAnswer() {
  const examples = [
    ['Lịch dạy', 'Hôm nay có lớp nào?', 'Lịch dạy của tôi trong 1 tuần', 'Tuần sau có những lớp nào?', 'Thứ 7 này tôi dạy lớp nào?'],
    ['Lớp học', 'Sĩ số lớp MVK_C2_N1', 'Danh sách học sinh lớp MVK_C2_N3', 'Học phí lớp MVK_C2_N1 bao nhiêu?', 'Lớp MVK_C2_N1 còn nợ bao nhiêu?'],
    ['Điểm danh', 'Lớp nào chưa điểm danh hôm qua?', 'Điểm danh lớp MVK_C2_N1 hôm qua', 'Ai vắng hôm nay?', 'Tổng điểm danh hôm nay', 'Chấm lớp MVK_C2_N1 tất cả có mặt trừ Sơn'],
    ['Học viên', 'Tra cứu Sơn', 'SĐT phụ huynh của Sơn', 'Lịch sử điểm danh của Sơn', 'Sơn vắng mấy buổi gần đây?', 'Ghi chú học tập của Quỳnh Anh là gì?'],
    ['Học phí', 'Ai còn nợ học phí nhiều nhất?', 'Sơn còn nợ bao nhiêu buổi?', 'Lịch sử học phí của Sơn', 'Hôm nay đã thu tiền mặt ai?', 'Sơn đóng 1tr2'],
    ['Doanh thu', 'Doanh thu hôm nay', 'Doanh thu lớp MVK_C2_N1 hôm qua', 'Doanh thu chủ nhật vừa rồi', 'Thực thu tháng này là bao nhiêu?'],
    ['Ngân hàng', 'Tổng quan ngân hàng hôm nay', 'Giao dịch ngân hàng cần kiểm tra', 'Có khoản nào pending không?', 'Danh sách needs_review'],
    ['Lead tư vấn', 'Lead mới hôm nay', 'Lead nào quá 2 ngày chưa liên hệ?', 'Lead cần follow-up', 'Đánh dấu lead 09... đã liên hệ'],
    ['Cảnh báo', 'Ai có nguy cơ bỏ học?', 'Lớp nào sắp vào học?', 'Việc cần làm hôm nay', 'Báo cáo sáng nay'],
    ['Thao tác', 'Mã MVK-123456 đã làm gì?', 'Có action nào chờ xác nhận?', 'Ai đã sửa điểm danh Sơn hôm qua?', 'Hoàn tác MVK-123456']
  ];
  const lines = examples.map((g, i) => (i + 1) + '. ' + g[0] + ': ' + g.slice(1).map((x) => '"' + x + '"').join('; '));
  return {
    answer: 'Các nhóm câu hỏi thầy/cô có thể hỏi:\n' + lines.join('\n') + '\n\nCấu trúc phản hồi mặc định: kết luận trước, chi tiết theo dòng, rồi gợi ý bước tiếp theo nếu cần xác nhận hoặc bổ sung thông tin.',
    intent: 'faq_catalog',
    categories: examples.map((g) => ({ category: g[0], examples: g.slice(1) }))
  };
}

function attendanceAnswer(snapshot, question) {
  const date = dateFromQuestion(question);
  const n = norm(question);
  const mode = n.includes('vang') || n.includes('absent') ? 'absent' : n.includes('co mat') || n.includes('di hoc') || n.includes('present') ? 'present' : '';
  const rows = asArray(snapshot.attendance).filter((a) => {
    if (String(a.date || '').slice(0, 10) !== date) return false;
    if (!mode) return true;
    return normalizeAttendanceStatus(a.status) === mode;
  });
  const studentsById = new Map(asArray(snapshot.students).map((s) => [String(s.id), s]));
  const out = rows.slice(0, 40).map((a) => {
    const s = studentsById.get(String(a.student_id || '')) || {};
    return {
      name: s.name || a.student_name || '',
      class_name: cleanClassName(a.class_name || s.class_name || ''),
      status: normalizeAttendanceStatus(a.status),
      date: a.date
    };
  });
  const label = mode === 'present' ? 'có mặt' : mode === 'absent' ? 'vắng' : 'điểm danh';
  return {
    answer: out.length
      ? 'Ngày ' + date + ' có ' + out.length + ' bản ghi ' + label + ':\n' + out.slice(0, 20).map((r) => '- ' + (r.name || 'Không rõ') + (r.class_name ? ' - ' + r.class_name : '') + (mode ? '' : ' - ' + r.status)).join('\n')
      : 'Chưa thấy dữ liệu ' + label + ' ngày ' + date + '.',
    intent: 'attendance',
    date,
    mode: mode || 'all',
    rows: out
  };
}

function paymentAmount(row) {
  return money(row.amount_vnd || row.amount || row.total || row.value || row.paid_amount || row.payment_amount);
}

function paymentDate(row) {
  return String(row.paid_at || row.created_at || row.date || row.payment_date || '').slice(0, 10);
}

function attendanceRevenueForDate(snapshot, date) {
  const fees = feeMap(snapshot.classFees);
  const byClass = {};
  asArray(snapshot.attendance).forEach((a) => {
    if (String(a.date || '').slice(0, 10) !== date) return;
    if (normalizeAttendanceStatus(a.status) !== 'present') return;
    const rawClass = String(a.class_name || '').trim();
    const display = cleanClassName(rawClass) || rawClass || 'Chưa rõ lớp';
    const key = norm(rawClass || display);
    if (!byClass[key]) {
      byClass[key] = {
        class_name: display,
        raw_class_name: rawClass,
        present_count: 0,
        fee_per_session: getFeeForClass(fees, rawClass) || getFeeForClass(fees, display),
        amount_vnd: 0
      };
    }
    byClass[key].present_count += 1;
  });
  Object.keys(byClass).forEach((key) => {
    byClass[key].amount_vnd = byClass[key].present_count * Number(byClass[key].fee_per_session || 0);
  });
  const rows = Object.values(byClass).sort((a, b) => b.amount_vnd - a.amount_vnd || a.class_name.localeCompare(b.class_name));
  return {
    date,
    rows,
    present_count: rows.reduce((sum, r) => sum + Number(r.present_count || 0), 0),
    amount_vnd: rows.reduce((sum, r) => sum + Number(r.amount_vnd || 0), 0),
    missing_fee_count: rows.filter((r) => Number(r.present_count || 0) > 0 && !Number(r.fee_per_session || 0)).length
  };
}

function revenueAnswer(snapshot, question) {
  const n = norm(question);
  const date = dateFromQuestion(question);
  const wantsPaymentRevenue = /(giao dich|da thu|thuc thu|chuyen khoan|payment|bank|ngan hang|da dong)/.test(n);
  if (!wantsPaymentRevenue) {
    const rev = attendanceRevenueForDate(snapshot, date);
    const detail = rev.rows.length
      ? rev.rows.slice(0, 12).map((r) => '- ' + r.class_name + ': ' + r.present_count + ' lượt × ' + formatVnd(r.fee_per_session) + ' = ' + formatVnd(r.amount_vnd)).join('\n')
      : '';
    return {
      answer: rev.present_count
        ? 'Doanh thu vận hành ngày ' + date + ' theo điểm danh: ' + formatVnd(rev.amount_vnd) + ' từ ' + rev.present_count + ' lượt có mặt.\n' + detail + (rev.missing_fee_count ? '\nLưu ý: có ' + rev.missing_fee_count + ' lớp có lượt điểm danh nhưng chưa khớp học phí/buổi.' : '')
        : 'Ngày ' + date + ' chưa thấy lượt điểm danh có mặt, nên doanh thu vận hành theo điểm danh là ' + formatVnd(0) + '.',
      intent: 'revenue_attendance',
      date,
      calculation: 'present_attendance_count_by_class * class_fee_per_session',
      present_count: rev.present_count,
      amount_vnd: rev.amount_vnd,
      by_class: rev.rows
    };
  }
  const monthMatch = n.match(/\bthang\s*(\d{1,2})\b/);
  let rows = asArray(snapshot.payments);
  let label = 'ngày ' + date;
  if (monthMatch) {
    const nowYear = String(date).slice(0, 4) || String(new Date().getFullYear());
    const mk = nowYear + '-' + String(Math.max(1, Math.min(12, Number(monthMatch[1])))).padStart(2, '0');
    rows = rows.filter((p) => paymentDate(p).startsWith(mk));
    label = 'tháng ' + mk.slice(5) + '/' + mk.slice(0, 4);
  } else if (n.includes('thang nay')) {
    const mk = String(date).slice(0, 7);
    rows = rows.filter((p) => paymentDate(p).startsWith(mk));
    label = 'tháng này (' + mk + ')';
  } else {
    rows = rows.filter((p) => paymentDate(p) === date);
  }
  const sum = rows.reduce((acc, p) => acc + paymentAmount(p), 0);
  return {
    answer: 'Doanh thu ' + label + ': ' + formatVnd(sum) + ' · ' + rows.length + ' giao dịch.',
    intent: 'revenue',
    count: rows.length,
    amount_vnd: sum
  };
}

function debtAnswer(snapshot, question) {
  const n = norm(question);
  const limitMatch = n.match(/\btop\s*(\d{1,2})\b/);
  const limit = Math.max(1, Math.min(30, Number(limitMatch && limitMatch[1]) || (n.includes('nhieu nhat') || n.includes('cao nhat') ? 10 : 20)));
  const rows = computeDebts(snapshot).slice(0, limit);
  return {
    answer: rows.length
      ? 'Các học viên đang nợ học phí nhiều nhất:\n' + rows.map((d, i) => (i + 1) + '. ' + d.name + ': ' + d.sessions_due + ' buổi' + (d.amount_due_vnd ? ' - ' + formatVnd(d.amount_due_vnd) : '') + (d.class_name ? ' (' + cleanClassName(d.class_name) + ')' : '')).join('\n')
      : 'Chưa thấy học viên nào đang nợ học phí theo dữ liệu hiện tại.',
    intent: 'debt',
    students: rows
  };
}

function classRosterAnswer(snapshot, question) {
  const cls = resolveClassName(snapshot, question, dateFromQuestion(question));
  if (cls.status !== 'single') {
    return {
      answer: cls.status === 'ambiguous'
        ? 'Em thấy nhiều lớp có thể khớp. Thầy/cô ghi rõ một lớp:\n' + cls.classes.map((c) => '- ' + cleanClassName(c)).join('\n')
        : 'Em chưa xác định được lớp. Thầy/cô gửi thêm tên lớp, ví dụ MVK_C2_N1.',
      intent: 'class_roster',
      requires_clarification: true,
      classes: cls.classes || []
    };
  }
  const rows = studentsInClass(snapshot, cls.class_name);
  const names = rows.slice(0, 40).map((s, i) => (i + 1) + '. ' + String(s.name || 'Không rõ') + (s.phone ? ' · ' + s.phone : ''));
  return {
    answer: rows.length
      ? 'Lớp ' + cleanClassName(cls.class_name) + ' có ' + rows.length + ' học viên:\n' + names.join('\n')
      : 'Em chưa thấy học viên nào thuộc lớp ' + cleanClassName(cls.class_name) + '.',
    intent: 'class_roster',
    class_name: cls.class_name,
    count: rows.length,
    students: rows.map((s) => ({ name: s.name, phone: s.phone || '', class_names: classNamesOf(s) }))
  };
}

function classFeeAnswer(snapshot, question) {
  const cls = resolveClassName(snapshot, question, dateFromQuestion(question));
  const fees = feeMap(snapshot.classFees);
  if (cls.status === 'single') {
    const amount = getFeeForClass(fees, cls.class_name);
    return {
      answer: amount ? 'Học phí lớp ' + cleanClassName(cls.class_name) + ' là ' + formatVnd(amount) + '/buổi.' : 'Em chưa thấy cấu hình học phí cho lớp ' + cleanClassName(cls.class_name) + '.',
      intent: 'class_fee',
      class_name: cls.class_name,
      fee_per_session: amount
    };
  }
  const rows = knownClassNames(snapshot)
    .map((name) => ({ name: cleanClassName(name), fee: getFeeForClass(fees, name) }))
    .filter((r) => r.fee)
    .slice(0, 30);
  return {
    answer: rows.length
      ? 'Bảng học phí theo lớp:\n' + rows.map((r) => '- ' + r.name + ': ' + formatVnd(r.fee) + '/buổi').join('\n')
      : 'Em chưa thấy dữ liệu học phí theo lớp.',
    intent: 'class_fee_list',
    classes: rows
  };
}

function studentDebtAnswer(snapshot, question) {
  const cleaned = String(question || '')
    .replace(/(cong no|công nợ|con no|còn nợ|no hoc phi|nợ học phí|hoc phi|học phí|bao nhieu|bao nhiêu|may buoi|mấy buổi|chua dong|chưa đóng|da dong|đã đóng)/gi, ' ')
    .trim();
  const st = resolveSingleStudentForWrite(snapshot, cleaned || question, '');
  if (st.status !== 'single') {
    return {
      answer: st.status === 'ambiguous'
        ? 'Em thấy nhiều học viên có thể khớp. Thầy/cô gửi thêm lớp hoặc SĐT:\n' + studentOptionLines(st.students)
        : 'Em chưa xác định được học viên cần xem học phí. Thầy/cô gửi thêm tên đầy đủ hoặc SĐT.',
      intent: 'student_debt',
      requires_clarification: true
    };
  }
  const debt = computeDebts(snapshot).find((d) => String(d.student_id) === String(st.student.id)) || null;
  if (!debt) {
    return {
      answer: st.student.name + ' hiện chưa có nợ học phí theo dữ liệu điểm danh và số buổi đã ghi nhận.',
      intent: 'student_debt',
      student_name: st.student.name,
      sessions_due: 0,
      amount_due_vnd: 0
    };
  }
  const perClass = debt.per_class && debt.per_class.length
    ? '\n' + debt.per_class.map((r) => '- ' + cleanClassName(r.class_name) + ': ' + r.sessions_due + ' buổi · ' + formatVnd(r.amount_due_vnd)).join('\n')
    : '';
  return {
    answer: debt.name + ' còn nợ ' + debt.sessions_due + ' buổi, tương ứng ' + formatVnd(debt.amount_due_vnd) + '.' + perClass,
    intent: 'student_debt',
    debt
  };
}

function classAttendanceAnswer(snapshot, question) {
  const date = dateFromQuestion(question);
  const cls = resolveClassName(snapshot, question, date);
  if (cls.status !== 'single') return attendanceAnswer(snapshot, question);
  const mode = /vang|absent/.test(norm(question)) ? 'absent' : /co mat|di hoc|present/.test(norm(question)) ? 'present' : '';
  const studentsById = new Map(asArray(snapshot.students).map((s) => [String(s.id), s]));
  const rows = asArray(snapshot.attendance)
    .filter((a) => String(a.date || '').slice(0, 10) === date)
    .filter((a) => classMatches(a.class_name || classNamesOf(studentsById.get(String(a.student_id || '')) || {})[0] || '', cls.class_name))
    .filter((a) => !mode || normalizeAttendanceStatus(a.status) === mode)
    .map((a) => {
      const s = studentsById.get(String(a.student_id || '')) || {};
      return { name: s.name || a.student_name || '', status: normalizeAttendanceStatus(a.status), class_name: cls.class_name };
    });
  const present = rows.filter((r) => r.status === 'present').length;
  const absent = rows.filter((r) => r.status === 'absent').length;
  return {
    answer: rows.length
      ? 'Điểm danh lớp ' + cleanClassName(cls.class_name) + ' ngày ' + date + ': ' + present + ' có mặt, ' + absent + ' vắng.\n' + rows.slice(0, 40).map((r) => '- ' + r.name + ': ' + (r.status === 'present' ? 'có mặt' : r.status === 'absent' ? 'vắng' : r.status)).join('\n')
      : 'Chưa thấy dữ liệu điểm danh lớp ' + cleanClassName(cls.class_name) + ' ngày ' + date + '.',
    intent: 'class_attendance',
    date,
    class_name: cls.class_name,
    present_count: present,
    absent_count: absent,
    rows
  };
}

function paymentHistoryAnswer(snapshot, question) {
  const date = dateFromQuestion(question);
  const n = norm(question);
  const studentsById = new Map(asArray(snapshot.students).map((s) => [String(s.id), s]));
  let rows = asArray(snapshot.payments);
  let title = 'Lịch sử ghi nhận học phí';
  const looksStudentSpecific = !/(hom nay|hom qua|thang|tat ca|danh sach|lich su thu|thu tien mat|da thu)/.test(n);
  if (looksStudentSpecific) {
    const cleaned = String(question || '').replace(/(lich su|đóng|dong|nop|nộp|hoc phi|học phí|thanh toan|thanh toán|thu tien|tiền mặt|cash|da dong|đã đóng)/gi, ' ');
    const st = resolveSingleStudentForWrite(snapshot, cleaned, '');
    if (st.status === 'single') {
      rows = rows.filter((p) => String(p.student_id || '') === String(st.student.id));
      title = 'Lịch sử học phí của ' + st.student.name;
    }
  } else {
    rows = rows.filter((p) => paymentDate(p) === date);
    if (/tien mat|cash|thu tien mat/.test(n)) rows = rows.filter((p) => String(p.payment_channel || '').toLowerCase() === 'cash');
    title = 'Học phí đã ghi nhận ngày ' + date;
  }
  rows = rows.sort((a, b) => String(paymentDate(b)).localeCompare(String(paymentDate(a)))).slice(0, 20);
  const lines = rows.map((p) => {
    const s = studentsById.get(String(p.student_id || '')) || {};
    const channel = String(p.payment_channel || '').toLowerCase() === 'cash' ? 'tiền mặt' : String(p.payment_channel || 'ghi nhận');
    return '- ' + paymentDate(p) + ': ' + (s.name || p.student_id || 'Không rõ học viên') + ' · ' + formatVnd(paymentAmount(p)) + ' · ' + channel + (p.class_name ? ' · ' + cleanClassName(p.class_name) : '');
  });
  return {
    answer: rows.length ? title + ':\n' + lines.join('\n') : 'Em chưa thấy dòng học phí phù hợp trong lịch sử ghi nhận.',
    intent: 'payment_history',
    count: rows.length,
    payments: rows
  };
}

function bankAnswer(snapshot, question) {
  const n = norm(question);
  const status = n.includes('pending') ? 'pending' : 'needs_review,pending';
  const rows = bankReviewRows(snapshot, status, 20);
  return {
    answer: rows.length
      ? 'Có ' + rows.length + ' giao dịch ngân hàng cần kiểm tra:\n' + rows.slice(0, 10).map((b) => '- #' + b.id + ': ' + formatVnd(b.amount_vnd) + ' · ' + (b.status || '') + (b.error_note ? ' · ' + b.error_note : '')).join('\n')
      : 'Chưa thấy giao dịch ngân hàng pending/needs_review cần kiểm tra.',
    intent: 'bank',
    transactions: rows
  };
}

function leadAnswer(snapshot) {
  const rows = asArray(snapshot.leads).filter((l) => String(l.status || 'new') === 'new').slice(0, 20);
  return {
    answer: rows.length
      ? 'Có ' + rows.length + ' lead tư vấn mới:\n' + rows.slice(0, 10).map((l) => '- ' + (l.student_name || 'Không rõ tên') + (l.parent_phone ? ' · ' + l.parent_phone : '') + (l.program_label ? ' · ' + l.program_label : '')).join('\n')
      : 'Chưa thấy lead tư vấn mới.',
    intent: 'lead',
    leads: rows
  };
}

function studentContactAnswer(snapshot, question) {
  const cleaned = String(question || '').replace(/(so dien thoai|sdt|phone|phu huynh|ba me|bo me|lien he|contact|cua|cho|em|ban|hoc sinh|hoc vien)/gi, ' ').trim();
  const st = resolveSingleStudentForWrite(snapshot, cleaned || question, '');
  if (st.status !== 'single') {
    return {
      answer: st.status === 'ambiguous'
        ? 'Em thấy nhiều học viên có thể khớp. Thầy/cô gửi thêm lớp hoặc SĐT:\n' + studentOptionLines(st.students)
        : 'Em chưa xác định được học viên cần xem liên hệ. Thầy/cô gửi thêm tên đầy đủ hoặc SĐT.',
      intent: 'student_contact',
      requires_clarification: true
    };
  }
  const s = st.student;
  return {
    answer: s.name + '\nSĐT: ' + (s.phone || 'chưa có') + '\nPhụ huynh: ' + (s.parent_name || 'chưa có') + (classNamesOf(s).length ? '\nLớp: ' + classNamesOf(s).map(cleanClassName).join(', ') : ''),
    intent: 'student_contact',
    student: { name: s.name, phone: s.phone || '', parent_name: s.parent_name || '', class_names: classNamesOf(s) }
  };
}

function studentRecentAttendanceAnswer(snapshot, question) {
  const cleaned = String(question || '').replace(/(lich su|gan day|diem danh|vắng|vang|co mat|đi học|di hoc|nghi|bao nhieu|bao nhiêu|bao nhieu buoi|may buoi|mấy buổi|cua|cho|em|ban|hoc sinh|hoc vien)/gi, ' ').trim();
  const st = resolveSingleStudentForWrite(snapshot, cleaned || question, '');
  if (st.status !== 'single') {
    return {
      answer: st.status === 'ambiguous'
        ? 'Em thấy nhiều học viên có thể khớp. Thầy/cô gửi thêm lớp hoặc SĐT:\n' + studentOptionLines(st.students)
        : 'Em chưa xác định được học viên cần xem điểm danh. Thầy/cô gửi thêm tên đầy đủ hoặc SĐT.',
      intent: 'student_recent_attendance',
      requires_clarification: true
    };
  }
  const rows = latestAttendanceForStudent(snapshot, st.student.id, 12);
  const absent = rows.filter((r) => normalizeAttendanceStatus(r.status) === 'absent').length;
  const present = rows.filter((r) => normalizeAttendanceStatus(r.status) === 'present').length;
  return {
    answer: rows.length
      ? 'Điểm danh gần đây của ' + st.student.name + ': ' + present + ' có mặt, ' + absent + ' vắng trong ' + rows.length + ' buổi gần nhất.\n' + rows.map((r) => '- ' + String(r.date || '').slice(0, 10) + ': ' + (normalizeAttendanceStatus(r.status) === 'present' ? 'có mặt' : normalizeAttendanceStatus(r.status) === 'absent' ? 'vắng' : r.status) + (r.class_name ? ' · ' + cleanClassName(r.class_name) : '')).join('\n')
      : 'Em chưa thấy lịch sử điểm danh của ' + st.student.name + '.',
    intent: 'student_recent_attendance',
    student_name: st.student.name,
    present_count: present,
    absent_count: absent,
    rows
  };
}

function classDebtAnswer(snapshot, question) {
  const cls = resolveClassName(snapshot, question, dateFromQuestion(question));
  if (cls.status !== 'single') return debtAnswer(snapshot, question);
  const rows = computeDebts(snapshot)
    .filter((d) => d.class_names.some((c) => classMatches(c, cls.class_name)))
    .slice(0, 30);
  const total = rows.reduce((sum, r) => sum + Number(r.amount_due_vnd || 0), 0);
  return {
    answer: rows.length
      ? 'Lớp ' + cleanClassName(cls.class_name) + ' có ' + rows.length + ' học viên còn nợ, tổng ' + formatVnd(total) + ':\n' + rows.slice(0, 20).map((d, i) => (i + 1) + '. ' + d.name + ': ' + d.sessions_due + ' buổi · ' + formatVnd(d.amount_due_vnd)).join('\n')
      : 'Lớp ' + cleanClassName(cls.class_name) + ' chưa có học viên nợ học phí theo dữ liệu hiện tại.',
    intent: 'class_debt',
    class_name: cls.class_name,
    count: rows.length,
    amount_due_vnd: total,
    students: rows
  };
}

function classRevenueAnswer(snapshot, question) {
  const date = dateFromQuestion(question);
  const cls = resolveClassName(snapshot, question, date);
  if (cls.status !== 'single') return revenueAnswer(snapshot, question);
  const fees = feeMap(snapshot.classFees);
  const fee = getFeeForClass(fees, cls.class_name);
  const studentsById = new Map(asArray(snapshot.students).map((s) => [String(s.id), s]));
  const presentRows = asArray(snapshot.attendance)
    .filter((a) => String(a.date || '').slice(0, 10) === date)
    .filter((a) => normalizeAttendanceStatus(a.status) === 'present')
    .filter((a) => classMatches(a.class_name || classNamesOf(studentsById.get(String(a.student_id || '')) || {})[0] || '', cls.class_name));
  const amount = presentRows.length * Number(fee || 0);
  return {
    answer: 'Doanh thu vận hành lớp ' + cleanClassName(cls.class_name) + ' ngày ' + date + ': ' + formatVnd(amount) + ' từ ' + presentRows.length + ' lượt có mặt' + (fee ? ' × ' + formatVnd(fee) + '/buổi.' : '. Lưu ý: lớp này chưa khớp học phí/buổi.'),
    intent: 'class_revenue_attendance',
    date,
    class_name: cls.class_name,
    present_count: presentRows.length,
    fee_per_session: fee,
    amount_vnd: amount
  };
}

function attendanceStatsAnswer(snapshot, question) {
  const date = dateFromQuestion(question);
  const studentsById = new Map(asArray(snapshot.students).map((s) => [String(s.id), s]));
  const rows = asArray(snapshot.attendance).filter((a) => String(a.date || '').slice(0, 10) === date);
  const present = rows.filter((a) => normalizeAttendanceStatus(a.status) === 'present').length;
  const absent = rows.filter((a) => normalizeAttendanceStatus(a.status) === 'absent').length;
  const byClass = {};
  rows.forEach((a) => {
    const s = studentsById.get(String(a.student_id || '')) || {};
    const cls = cleanClassName(a.class_name || classNamesOf(s)[0] || 'Chưa rõ lớp');
    if (!byClass[cls]) byClass[cls] = { class_name: cls, present: 0, absent: 0, total: 0 };
    byClass[cls].total += 1;
    if (normalizeAttendanceStatus(a.status) === 'present') byClass[cls].present += 1;
    if (normalizeAttendanceStatus(a.status) === 'absent') byClass[cls].absent += 1;
  });
  const detail = Object.values(byClass).sort((a, b) => b.total - a.total).slice(0, 12);
  return {
    answer: rows.length
      ? 'Tổng điểm danh ngày ' + date + ': ' + present + ' có mặt, ' + absent + ' vắng, ' + rows.length + ' bản ghi.\n' + detail.map((r) => '- ' + r.class_name + ': ' + r.present + ' có mặt, ' + r.absent + ' vắng').join('\n')
      : 'Ngày ' + date + ' chưa có bản ghi điểm danh.',
    intent: 'attendance_stats',
    date,
    present_count: present,
    absent_count: absent,
    total_count: rows.length,
    by_class: detail
  };
}

function leadFollowupAnswer(snapshot, question) {
  const date = dateFromQuestion(question);
  const rows = staleLeadRows(snapshot, date);
  return {
    answer: rows.length
      ? 'Có ' + rows.length + ' lead quá 2 ngày cần follow-up:\n' + rows.map((l, i) => (i + 1) + '. ' + (l.student_name || 'Không tên') + (l.parent_phone ? ' · ' + l.parent_phone : '') + ' · ' + l.status + ' · ' + String(l.created_at || '').slice(0, 10)).join('\n')
      : 'Chưa có lead quá 2 ngày cần follow-up.',
    intent: 'lead_followup',
    date,
    leads: rows
  };
}

function bankSummaryAnswer(snapshot, question) {
  const date = dateFromQuestion(question);
  const rows = asArray(snapshot.bank).filter((b) => String(b.occurred_at || b.created_at || '').slice(0, 10) === date);
  const needs = rows.filter((b) => /needs_review|pending/.test(String(b.status || '')));
  const total = rows.reduce((sum, b) => sum + money(b.amount_vnd), 0);
  return {
    answer: rows.length
      ? 'Ngân hàng ngày ' + date + ': ' + rows.length + ' giao dịch, tổng ' + formatVnd(total) + ', cần kiểm tra ' + needs.length + ' giao dịch.'
      : 'Ngày ' + date + ' chưa thấy giao dịch ngân hàng trong dữ liệu đang tải.',
    intent: 'bank_summary',
    date,
    count: rows.length,
    amount_vnd: total,
    needs_review_count: needs.length,
    needs_review: needs.slice(0, 10)
  };
}

function missingPhoneAnswer(snapshot, question) {
  const cls = resolveClassName(snapshot, question, dateFromQuestion(question));
  const rows = cls.status === 'single' ? studentsInClass(snapshot, cls.class_name) : asArray(snapshot.students);
  const missing = rows.filter((s) => !digits(s.phone)).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'vi'));
  const scope = cls.status === 'single' ? 'lớp ' + cleanClassName(cls.class_name) : 'toàn trung tâm';
  return {
    answer: missing.length
      ? scope + ' có ' + missing.length + ' học viên chưa có SĐT:\n' + missing.slice(0, 30).map((s, i) => (i + 1) + '. ' + String(s.name || 'Không rõ') + (classNamesOf(s).length ? ' - ' + classNamesOf(s).map(cleanClassName).join(', ') : '')).join('\n')
      : scope + ' chưa thấy học viên nào thiếu SĐT.',
    intent: 'missing_student_phone',
    count: missing.length,
    students: missing
  };
}

function absenceRankAnswer(snapshot, question) {
  const range = dateRangeFromQuestion(question);
  const cls = resolveClassName(snapshot, question, range.start);
  const studentsById = new Map(asArray(snapshot.students).map((s) => [String(s.id), s]));
  const rows = asArray(snapshot.attendance)
    .filter((a) => isDateInRange(a.date, range))
    .filter((a) => normalizeAttendanceStatus(a.status) === 'absent')
    .filter((a) => cls.status !== 'single' || classMatches(a.class_name || classNamesOf(studentsById.get(String(a.student_id || '')) || {})[0] || '', cls.class_name));
  const byStudent = {};
  rows.forEach((a) => {
    const sid = String(a.student_id || '');
    if (!sid) return;
    const s = studentsById.get(sid) || {};
    if (!byStudent[sid]) byStudent[sid] = { student_id: sid, name: s.name || a.student_name || 'Không rõ', class_names: classNamesOf(s), absent_count: 0, dates: [] };
    byStudent[sid].absent_count += 1;
    byStudent[sid].dates.push(String(a.date || '').slice(0, 10));
  });
  const out = Object.values(byStudent).sort((a, b) => b.absent_count - a.absent_count || a.name.localeCompare(b.name, 'vi')).slice(0, 20);
  const scope = cls.status === 'single' ? 'lớp ' + cleanClassName(cls.class_name) : 'trung tâm';
  return {
    answer: out.length
      ? 'Học viên vắng nhiều nhất trong ' + range.label + ' (' + range.start + ' -> ' + range.end + ') ở ' + scope + ':\n' + out.map((r, i) => (i + 1) + '. ' + r.name + ': ' + r.absent_count + ' buổi' + (r.class_names.length ? ' - ' + r.class_names.map(cleanClassName).join(', ') : '')).join('\n')
      : 'Chưa thấy học viên vắng trong ' + range.label + ' ở ' + scope + '.',
    intent: 'absence_rank',
    range,
    rows: out
  };
}

function staleStudentsAnswer(snapshot, question) {
  const today = dateFromQuestion(question);
  const threshold = /30|thang/.test(norm(question)) ? 30 : /21|3 tuan/.test(norm(question)) ? 21 : 14;
  const studentsById = new Map(asArray(snapshot.students).map((s) => [String(s.id), s]));
  const latestPresent = {};
  asArray(snapshot.attendance).forEach((a) => {
    if (normalizeAttendanceStatus(a.status) !== 'present') return;
    const sid = String(a.student_id || '');
    const d = String(a.date || '').slice(0, 10);
    if (sid && (!latestPresent[sid] || d > latestPresent[sid])) latestPresent[sid] = d;
  });
  const base = new Date(today + 'T00:00:00').getTime();
  const rows = Array.from(studentsById.values())
    .map((s) => {
      const last = latestPresent[String(s.id || '')] || '';
      const days = last ? Math.floor((base - new Date(last + 'T00:00:00').getTime()) / 86400000) : null;
      return { name: s.name || '', phone: s.phone || '', class_names: classNamesOf(s), last_present_date: last, days_since_present: days };
    })
    .filter((r) => r.days_since_present == null || r.days_since_present >= threshold)
    .sort((a, b) => (b.days_since_present == null ? 9999 : b.days_since_present) - (a.days_since_present == null ? 9999 : a.days_since_present))
    .slice(0, 20);
  return {
    answer: rows.length
      ? 'Học viên lâu rồi chưa thấy đi học (' + threshold + '+ ngày):\n' + rows.map((r, i) => (i + 1) + '. ' + r.name + ': ' + (r.last_present_date ? 'lần có mặt gần nhất ' + r.last_present_date + ' (' + r.days_since_present + ' ngày)' : 'chưa thấy buổi có mặt') + (r.class_names.length ? ' - ' + r.class_names.map(cleanClassName).join(', ') : '')).join('\n')
      : 'Chưa thấy học viên nào quá ' + threshold + ' ngày chưa có mặt.',
    intent: 'stale_students',
    threshold_days: threshold,
    students: rows
  };
}

function classSizeRankAnswer(snapshot) {
  const rows = knownClassNames(snapshot)
    .map((cls) => ({ class_name: cls, count: studentsInClass(snapshot, cls).length }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count || cleanClassName(a.class_name).localeCompare(cleanClassName(b.class_name), 'vi'))
    .slice(0, 15);
  return {
    answer: rows.length ? 'Các lớp đông học viên nhất:\n' + rows.map((r, i) => (i + 1) + '. ' + cleanClassName(r.class_name) + ': ' + r.count + ' học viên').join('\n') : 'Chưa thấy dữ liệu sĩ số lớp.',
    intent: 'class_size_rank',
    classes: rows
  };
}

function classDebtRankAnswer(snapshot) {
  const byClass = {};
  computeDebts(snapshot).forEach((d) => {
    asArray(d.per_class).forEach((r) => {
      const key = norm(r.class_name);
      if (!key) return;
      if (!byClass[key]) byClass[key] = { class_name: r.class_name, students: new Set(), sessions_due: 0, amount_due_vnd: 0 };
      byClass[key].students.add(d.student_id);
      byClass[key].sessions_due += Number(r.sessions_due || 0);
      byClass[key].amount_due_vnd += Number(r.amount_due_vnd || 0);
    });
  });
  const rows = Object.values(byClass).map((r) => ({ class_name: r.class_name, student_count: r.students.size, sessions_due: r.sessions_due, amount_due_vnd: r.amount_due_vnd }))
    .sort((a, b) => b.amount_due_vnd - a.amount_due_vnd || b.sessions_due - a.sessions_due)
    .slice(0, 15);
  return {
    answer: rows.length ? 'Các lớp đang nợ nhiều nhất:\n' + rows.map((r, i) => (i + 1) + '. ' + cleanClassName(r.class_name) + ': ' + r.student_count + ' học viên, ' + r.sessions_due + ' buổi, ' + formatVnd(r.amount_due_vnd)).join('\n') : 'Chưa thấy lớp nào có học viên nợ học phí.',
    intent: 'class_debt_rank',
    classes: rows
  };
}

function totalReceivableAnswer(snapshot) {
  const rows = computeDebts(snapshot);
  const amount = rows.reduce((sum, r) => sum + Number(r.amount_due_vnd || 0), 0);
  const sessions = rows.reduce((sum, r) => sum + Number(r.sessions_due || 0), 0);
  return {
    answer: 'Tổng tiền học phí còn phải thu hiện tại: ' + formatVnd(amount) + ' từ ' + rows.length + ' học viên, tương ứng ' + sessions + ' buổi còn nợ.',
    intent: 'total_receivable',
    amount_due_vnd: amount,
    sessions_due: sessions,
    student_count: rows.length
  };
}

function tuitionReminderListAnswer(snapshot) {
  const rows = computeDebts(snapshot).slice(0, 15);
  return {
    answer: rows.length
      ? 'Hôm nay nên nhắc phí các học viên nợ cao trước:\n' + rows.map((d, i) => (i + 1) + '. ' + d.name + ': ' + d.sessions_due + ' buổi, ' + formatVnd(d.amount_due_vnd) + (d.phone ? ' - ' + d.phone : ' - chưa có SĐT')).join('\n')
      : 'Chưa có học viên cần nhắc phí theo dữ liệu hiện tại.',
    intent: 'tuition_reminder_list',
    students: rows
  };
}

function prepaidBalanceAnswer(snapshot) {
  const studentsById = new Map(asArray(snapshot.students).map((s) => [String(s.id), s]));
  const rows = asArray(snapshot.tuitionByClass)
    .filter((r) => money(r.prepaid_balance_vnd) > 0)
    .map((r) => {
      const s = studentsById.get(String(r.student_id || '')) || {};
      return { name: s.name || 'Không rõ', class_name: r.class_name || '', amount_vnd: money(r.prepaid_balance_vnd) };
    })
    .sort((a, b) => b.amount_vnd - a.amount_vnd)
    .slice(0, 20);
  return {
    answer: rows.length ? 'Các học viên đang đóng dư/prepaid:\n' + rows.map((r, i) => (i + 1) + '. ' + r.name + ': ' + formatVnd(r.amount_vnd) + (r.class_name ? ' - ' + cleanClassName(r.class_name) : '')).join('\n') : 'Chưa thấy học viên nào có số dư học phí.',
    intent: 'prepaid_balance',
    rows
  };
}

function studentLastPaymentAnswer(snapshot, question) {
  const cleaned = String(question || '').replace(/(dong gan nhat|nop gan nhat|lan cuoi|gan day|hoc phi|thanh toan|dong|nop|tra|khi nao|bao gio|cua|cho|em|ban)/gi, ' ').trim();
  const st = resolveSingleStudentForWrite(snapshot, cleaned || question, '');
  if (st.status !== 'single') {
    return {
      answer: st.status === 'ambiguous' ? 'Em thấy nhiều học viên có thể khớp. Thầy/cô gửi thêm lớp hoặc SĐT:\n' + studentOptionLines(st.students) : 'Em chưa xác định được học viên cần xem lần đóng gần nhất.',
      intent: 'student_last_payment',
      requires_clarification: true
    };
  }
  const rows = asArray(snapshot.payments).filter((p) => String(p.student_id || '') === String(st.student.id)).sort((a, b) => String(paymentDate(b)).localeCompare(String(paymentDate(a))));
  const p = rows[0];
  return {
    answer: p ? st.student.name + ' đóng/nộp gần nhất ngày ' + paymentDate(p) + ': ' + formatVnd(paymentAmount(p)) + (p.payment_channel ? ' - ' + p.payment_channel : '') + (p.class_name ? ' - ' + cleanClassName(p.class_name) : '') + '.' : 'Em chưa thấy lịch sử học phí của ' + st.student.name + '.',
    intent: 'student_last_payment',
    payment: p || null
  };
}

function manySessionsNoPaymentAnswer(snapshot) {
  const paidIds = new Set(asArray(snapshot.payments).map((p) => String(p.student_id || '')).filter(Boolean));
  const rows = computeDebts(snapshot).filter((d) => d.sessions_due >= 4 && !paidIds.has(String(d.student_id))).slice(0, 20);
  return {
    answer: rows.length ? 'Học viên đã học nhiều buổi nhưng chưa thấy lịch sử đóng học phí:\n' + rows.map((d, i) => (i + 1) + '. ' + d.name + ': ' + d.sessions_due + ' buổi, ' + formatVnd(d.amount_due_vnd) + (d.class_name ? ' - ' + cleanClassName(d.class_name) : '')).join('\n') : 'Chưa thấy học viên nào học nhiều buổi mà chưa có lịch sử đóng học phí.',
    intent: 'many_sessions_no_payment',
    students: rows
  };
}

function revenueForRange(snapshot, range) {
  const byClass = {};
  let amount = 0;
  let present = 0;
  for (let d = range.start; d <= range.end; d = addDaysYmd(d, 1)) {
    const rev = attendanceRevenueForDate(snapshot, d);
    amount += rev.amount_vnd;
    present += rev.present_count;
    rev.rows.forEach((r) => {
      const key = norm(r.raw_class_name || r.class_name);
      if (!byClass[key]) byClass[key] = { class_name: r.class_name, present_count: 0, amount_vnd: 0 };
      byClass[key].present_count += r.present_count;
      byClass[key].amount_vnd += r.amount_vnd;
    });
  }
  return { amount_vnd: amount, present_count: present, by_class: Object.values(byClass).sort((a, b) => b.amount_vnd - a.amount_vnd) };
}

function revenueRangeAnswer(snapshot, question) {
  const range = dateRangeFromQuestion(question);
  const rev = revenueForRange(snapshot, range);
  const detail = rev.by_class.slice(0, 12).map((r) => '- ' + cleanClassName(r.class_name) + ': ' + r.present_count + ' lượt, ' + formatVnd(r.amount_vnd)).join('\n');
  return {
    answer: rev.present_count ? 'Doanh thu vận hành ' + range.label + ' (' + range.start + ' -> ' + range.end + '): ' + formatVnd(rev.amount_vnd) + ' từ ' + rev.present_count + ' lượt có mặt.\n' + detail : 'Chưa thấy lượt có mặt trong ' + range.label + ', nên doanh thu vận hành là ' + formatVnd(0) + '.',
    intent: 'revenue_range_attendance',
    range,
    revenue: rev
  };
}

function classRevenueRangeAnswer(snapshot, question) {
  const range = dateRangeFromQuestion(question);
  const cls = resolveClassName(snapshot, question, range.start);
  if (cls.status !== 'single') return revenueRangeAnswer(snapshot, question);
  const fees = feeMap(snapshot.classFees);
  const fee = getFeeForClass(fees, cls.class_name);
  const studentsById = new Map(asArray(snapshot.students).map((s) => [String(s.id), s]));
  const rows = asArray(snapshot.attendance)
    .filter((a) => isDateInRange(a.date, range))
    .filter((a) => normalizeAttendanceStatus(a.status) === 'present')
    .filter((a) => classMatches(a.class_name || classNamesOf(studentsById.get(String(a.student_id || '')) || {})[0] || '', cls.class_name));
  const amount = rows.length * Number(fee || 0);
  return {
    answer: 'Doanh thu vận hành lớp ' + cleanClassName(cls.class_name) + ' ' + range.label + ': ' + formatVnd(amount) + ' từ ' + rows.length + ' lượt có mặt' + (fee ? ' x ' + formatVnd(fee) + '/buổi.' : '. Lưu ý: lớp này chưa khớp học phí/buổi.'),
    intent: 'class_revenue_range_attendance',
    range,
    class_name: cls.class_name,
    present_count: rows.length,
    amount_vnd: amount
  };
}

function topRevenueClassAnswer(snapshot, question) {
  const range = dateRangeFromQuestion(question);
  const rows = revenueForRange(snapshot, range).by_class.slice(0, 15);
  return {
    answer: rows.length ? 'Các lớp tạo doanh thu cao nhất ' + range.label + ':\n' + rows.map((r, i) => (i + 1) + '. ' + cleanClassName(r.class_name) + ': ' + formatVnd(r.amount_vnd) + ' từ ' + r.present_count + ' lượt').join('\n') : 'Chưa có doanh thu vận hành trong ' + range.label + '.',
    intent: 'top_revenue_class',
    range,
    classes: rows
  };
}

function revenueCompareAnswer(snapshot, question) {
  const range = dateRangeFromQuestion(question);
  const ops = revenueForRange(snapshot, range);
  const payments = asArray(snapshot.payments).filter((p) => isDateInRange(paymentDate(p), range));
  const paid = payments.reduce((sum, p) => sum + paymentAmount(p), 0);
  const diff = paid - ops.amount_vnd;
  return {
    answer: 'So sánh ' + range.label + ':\n- Doanh thu theo điểm danh: ' + formatVnd(ops.amount_vnd) + ' (' + ops.present_count + ' lượt)\n- Thực thu đã ghi nhận: ' + formatVnd(paid) + ' (' + payments.length + ' dòng)\n- Chênh lệch thực thu - điểm danh: ' + formatVnd(diff) + '.',
    intent: 'revenue_compare',
    range,
    attendance_revenue_vnd: ops.amount_vnd,
    payment_revenue_vnd: paid,
    diff_vnd: diff
  };
}

function bankTransferSummaryAnswer(snapshot, question) {
  const range = dateRangeFromQuestion(question);
  const rows = asArray(snapshot.bank).filter((b) => isDateInRange(String(b.occurred_at || b.created_at || '').slice(0, 10), range));
  const total = rows.reduce((sum, b) => sum + money(b.amount_vnd), 0);
  return {
    answer: 'Chuyển khoản ngân hàng ' + range.label + ': ' + rows.length + ' giao dịch, tổng ' + formatVnd(total) + '.',
    intent: 'bank_transfer_summary',
    range,
    count: rows.length,
    amount_vnd: total
  };
}

function weirdBankAmountAnswer(snapshot) {
  const rows = asArray(snapshot.bank)
    .filter((b) => {
      const amount = money(b.amount_vnd);
      return amount > 0 && (amount < 1000 || amount % 1000 !== 0 || /needs_review|pending/.test(String(b.status || '')));
    })
    .sort((a, b) => String(b.occurred_at || b.created_at || '').localeCompare(String(a.occurred_at || a.created_at || '')))
    .slice(0, 15);
  return {
    answer: rows.length ? 'Các giao dịch có số tiền/trạng thái cần nhìn lại:\n' + rows.map((b) => '- ' + String(b.occurred_at || b.created_at || '').slice(0, 16) + ': ' + formatVnd(b.amount_vnd) + ' - ' + (b.status || 'không rõ') + (b.transfer_content ? ' - ' + String(b.transfer_content).slice(0, 60) : '')).join('\n') : 'Chưa thấy giao dịch ngân hàng có số tiền lạ hoặc trạng thái cần kiểm tra.',
    intent: 'bank_weird_amount',
    transactions: rows
  };
}

function latestBankTransactionAnswer(snapshot) {
  const row = asArray(snapshot.bank).slice().sort((a, b) => String(b.occurred_at || b.created_at || '').localeCompare(String(a.occurred_at || a.created_at || '')))[0];
  return {
    answer: row ? 'Giao dịch ngân hàng gần nhất: ' + String(row.occurred_at || row.created_at || '').slice(0, 16) + ' - ' + formatVnd(row.amount_vnd) + ' - ' + (row.status || 'không rõ') + (row.transfer_content ? ' - ' + String(row.transfer_content).slice(0, 80) : '') : 'Chưa thấy giao dịch ngân hàng nào.',
    intent: 'latest_bank_transaction',
    transaction: row || null
  };
}

function leadNewByDateAnswer(snapshot, question) {
  const range = dateRangeFromQuestion(question);
  const rows = asArray(snapshot.leads).filter((l) => isDateInRange(String(l.created_at || l.updated_at || '').slice(0, 10), range));
  return {
    answer: rows.length ? range.label + ' có ' + rows.length + ' lead mới/được tạo:\n' + rows.slice(0, 15).map((l, i) => (i + 1) + '. ' + (l.student_name || 'Không tên') + (l.parent_phone ? ' - ' + l.parent_phone : '') + ' - ' + (l.status || 'new')).join('\n') : range.label + ' chưa thấy lead mới.',
    intent: 'lead_new_by_date',
    range,
    leads: rows
  };
}

function leadContactedNotClosedAnswer(snapshot) {
  const rows = asArray(snapshot.leads).filter((l) => String(l.status || '') === 'contacted').slice(0, 20);
  return {
    answer: rows.length ? 'Lead đã liên hệ nhưng chưa chốt:\n' + rows.map((l, i) => (i + 1) + '. ' + (l.student_name || 'Không tên') + (l.parent_phone ? ' - ' + l.parent_phone : '') + (l.admin_note ? ' - ' + l.admin_note : '')).join('\n') : 'Chưa thấy lead ở trạng thái đã liên hệ nhưng chưa chốt.',
    intent: 'lead_contacted_not_closed',
    leads: rows
  };
}

function leadSourceAnswer(snapshot) {
  const bySource = {};
  asArray(snapshot.leads).forEach((l) => {
    const source = String(l.source || l.source_label || l.utm_source || l.program_label || 'Chưa rõ').trim() || 'Chưa rõ';
    if (!bySource[source]) bySource[source] = { source, count: 0, closed: 0 };
    bySource[source].count += 1;
    if (String(l.status || '') === 'closed') bySource[source].closed += 1;
  });
  const rows = Object.values(bySource).sort((a, b) => b.closed - a.closed || b.count - a.count).slice(0, 15);
  return {
    answer: rows.length ? 'Nguồn lead hiệu quả nhất theo dữ liệu hiện có:\n' + rows.map((r, i) => (i + 1) + '. ' + r.source + ': ' + r.count + ' lead, ' + r.closed + ' đã chốt').join('\n') : 'Chưa thấy dữ liệu nguồn lead.',
    intent: 'lead_source_rank',
    sources: rows
  };
}

function capabilityAnswer() {
  return {
    answer: lineJoin([
      'Em có thể hỗ trợ vận hành MV-Klass bằng dữ liệu thật trong hệ thống:',
      '- Lịch lớp hôm nay/theo ngày, lớp chưa điểm danh.',
      '- Tra cứu học viên theo tên/SĐT: lớp, ghi chú học tập, điểm danh gần đây, học phí còn nợ.',
      '- Danh sách học viên còn nợ học phí và soạn nháp tin nhắn nhắc phí.',
      '- Điểm danh: có mặt/vắng theo ngày hoặc lớp.',
      '- Thao tác cơ bản có xác nhận: chấm/sửa điểm danh, cập nhật ghi chú học viên, cập nhật trạng thái lead.',
      '- Doanh thu theo ngày/tháng và giao dịch ngân hàng cần đối soát.',
      '- Lead tư vấn mới/cần follow-up.',
      'Mọi thao tác ghi đều tạo bản nháp trước. Em chỉ thực hiện khi thầy/cô gửi đúng "XÁC NHẬN <mã>".'
    ]),
    intent: 'capabilities'
  };
}

function likelyStudentQuery(question) {
  const n = norm(question);
  if (n.includes('hoc vien') || n.includes('hoc sinh') || n.includes('thong tin') || n.includes('ho so') || n.includes('chi tiet')) return true;
  if (n.split(/\s+/).filter(Boolean).length <= 5 && !/(doanh thu|hoc phi|con no|diem danh|lich|lop|giao dich|lead|tu van)/.test(n)) return true;
  return false;
}

function defaultOpenclawStateDir() {
  if (process.platform === 'win32') return path.join(process.cwd(), '.openclaw-local');
  return '/root/.openclaw';
}

function actionQueueFile() {
  return env('MVKLASS_ACTION_QUEUE_FILE') || path.join(defaultOpenclawStateDir(), 'mvklass-action-queue.json');
}

function actionAuditFile() {
  return env('MVKLASS_ACTION_AUDIT_FILE') || path.join(defaultOpenclawStateDir(), 'mvklass-action-audit.jsonl');
}

function permissionsFile() {
  return env('MVKLASS_PERMISSIONS_FILE') || path.join(defaultOpenclawStateDir(), 'mvklass-permissions.json');
}

function ensureParentDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    return fallback;
  }
}

function writeJsonFileAtomic(file, value) {
  ensureParentDir(file);
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadActionQueue() {
  const q = readJsonFile(actionQueueFile(), { actions: [] });
  if (!q || !Array.isArray(q.actions)) return { actions: [] };
  return q;
}

function saveActionQueue(q) {
  writeJsonFileAtomic(actionQueueFile(), { actions: Array.isArray(q && q.actions) ? q.actions : [] });
}

const DEFAULT_PERMISSIONS = {
  users: {
    'telegram:7098157720': {
      name: 'Thầy Vũ',
      role: 'admin',
      class_names: ['*']
    }
  },
  roles: {
    admin: {
      can_read_all: true,
      can_prepare_write: true,
      can_confirm_write: true,
      can_view_audit: true,
      can_receive_daily_digest: true
    },
    teacher: {
      can_read_all: false,
      can_prepare_write: true,
      can_confirm_write: false,
      can_view_audit: false,
      can_receive_daily_digest: false
    }
  }
};

function loadPermissions() {
  const cfg = readJsonFile(permissionsFile(), null);
  if (!cfg || typeof cfg !== 'object') return DEFAULT_PERMISSIONS;
  return {
    users: Object.assign({}, DEFAULT_PERMISSIONS.users, cfg.users || {}),
    roles: Object.assign({}, DEFAULT_PERMISSIONS.roles, cfg.roles || {})
  };
}

function defaultActorId() {
  return env('MVKLASS_ACTOR_ID') || env('MVKLASS_TELEGRAM_ACTOR_ID') || 'telegram:7098157720';
}

function activeActorFromArgs(args) {
  const cfg = loadPermissions();
  const actorId = String((args && (args.actor_id || args.actorId || args.telegram_user_id || args.telegramUserId)) || defaultActorId()).trim();
  const user = (cfg.users || {})[actorId] || {};
  const roleName = String((args && (args.actor_role || args.actorRole)) || env('MVKLASS_ACTOR_ROLE') || user.role || 'admin').trim();
  const role = Object.assign({}, ((cfg.roles || {})[roleName] || {}));
  const actorName = String((args && (args.actor_name || args.actorName)) || env('MVKLASS_ACTOR_NAME') || user.name || 'Thầy Vũ').trim();
  const classNames = Array.isArray(user.class_names) ? user.class_names : ['*'];
  return {
    actor_id: actorId,
    actor_name: actorName,
    actor_role: roleName,
    actor_source: (args && (args.actor_id || args.actorId || args.telegram_user_id || args.telegramUserId)) ? 'tool_args' : 'fallback',
    class_names: classNames,
    permissions: role
  };
}

function actorCan(actor, permission) {
  return !!(actor && actor.permissions && actor.permissions[permission]);
}

function permissionDenied(permission) {
  return {
    answer: 'Tài khoản này chưa có quyền thực hiện thao tác: ' + permission + '.',
    changed_data: false,
    status: 'permission_denied',
    required_permission: permission
  };
}

let CURRENT_ACTOR = null;

async function withActor(args, fn) {
  const prev = CURRENT_ACTOR;
  CURRENT_ACTOR = activeActorFromArgs(args || {});
  try {
    return await fn(CURRENT_ACTOR);
  } finally {
    CURRENT_ACTOR = prev;
  }
}

function actorForCurrentAction() {
  return CURRENT_ACTOR || activeActorFromArgs({});
}

function actionClassNames(payload) {
  const out = [];
  const add = (v) => {
    const text = String(v || '').trim();
    if (text) out.push(text);
  };
  if (!payload || typeof payload !== 'object') return [];
  add(payload.class_name);
  add(payload.matched_class_name);
  asArray(payload.records).forEach((r) => add(r && r.class_name));
  asArray(payload.lines).forEach((r) => add(r && r.class_name));
  asArray(payload.restore_records).forEach((r) => add(r && r.class_name));
  asArray(payload.delete_records).forEach((r) => add(r && r.class_name));
  return uniqueByNorm(out);
}

function actorClassAllowed(actor, payload) {
  const allowed = asArray(actor && actor.class_names);
  if (!allowed.length || allowed.includes('*')) return true;
  const classes = actionClassNames(payload);
  if (!classes.length) return true;
  return classes.every((cls) => allowed.some((a) => classMatches(a, cls)));
}

function actionAuditSummary(action) {
  const payload = (action && action.payload) || {};
  const records = asArray(payload.records);
  const lines = asArray(payload.lines);
  const firstRecord = records[0] || {};
  const firstLine = lines[0] || {};
  return {
    requested_text: String((action && action.requested_text) || ''),
    preview: String((action && action.preview) || '').slice(0, 1000),
    student_id: payload.student_id || firstRecord.student_id || firstLine.student_id || '',
    student_name: payload.student_name || firstRecord.student_name || payload.lead_name || '',
    class_name: payload.class_name || firstRecord.class_name || firstLine.class_name || '',
    date: payload.date || firstRecord.date || payload.paid_date || '',
    amount_vnd: payload.amount_vnd || firstLine.amount_vnd || firstLine.tuition_amount_vnd || 0,
    lead_id: payload.lead_id || '',
    lead_name: payload.lead_name || '',
    affected_count: records.length || lines.length || Number(payload.changed_rows || 0) || 0
  };
}

function appendActionAudit(event, action, extra) {
  try {
    const file = actionAuditFile();
    ensureParentDir(file);
    const actor = (action && action.actor) || actorForCurrentAction();
    fs.appendFileSync(
      file,
      JSON.stringify({
        ts: new Date().toISOString(),
        event,
        action_id: action && action.id,
        code: action && action.code,
        type: action && action.type,
        status: action && action.status,
        actor_id: actor.actor_id,
        actor_name: actor.actor_name,
        actor_role: actor.actor_role,
        actor_source: actor.actor_source,
        summary: actionAuditSummary(action),
        extra: extra || null
      }) + '\n',
      'utf8'
    );
  } catch (_) {}
}

function makeActionId() {
  return 'act_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function normalizeCode(value) {
  const m = String(value || '').toUpperCase().match(/\b(?:MVK[\s-]*)?(\d{6})\b/);
  return m ? 'MVK-' + m[1] : '';
}

function makeConfirmationCode(existingCodes) {
  const used = new Set(existingCodes || []);
  for (let i = 0; i < 50; i += 1) {
    const code = 'MVK-' + String(Math.floor(100000 + Math.random() * 900000));
    if (!used.has(code)) return code;
  }
  return 'MVK-' + String(Date.now()).slice(-6);
}

function createPendingAction(type, requestedText, preview, payload) {
  const actor = actorForCurrentAction();
  if (!actorCan(actor, 'can_prepare_write')) {
    throw new Error('permission_denied: can_prepare_write');
  }
  if (!actorClassAllowed(actor, payload)) {
    throw new Error('permission_denied: class_scope');
  }
  const q = loadActionQueue();
  const now = new Date();
  const code = makeConfirmationCode(q.actions.filter((a) => a && a.status === 'pending').map((a) => a.code));
  const action = {
    id: makeActionId(),
    code,
    type,
    status: 'pending',
    requested_text: String(requestedText || ''),
    preview: String(preview || ''),
    payload: payload || {},
    actor: {
      actor_id: actor.actor_id,
      actor_name: actor.actor_name,
      actor_role: actor.actor_role,
      actor_source: actor.actor_source,
      class_names: actor.class_names
    },
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString()
  };
  q.actions.push(action);
  saveActionQueue(q);
  appendActionAudit('prepared', action);
  return action;
}

function pendingActionAnswer(action) {
  const shortCode = String(action.code || '').replace(/^MVK-/, '');
  return (
    action.preview +
    '\n\nMã xác nhận: ' +
    action.code +
    '\nGửi mã số: ' +
    shortCode +
    '\nMã hết hạn sau 10 phút. Nếu muốn hủy, gửi: HỦY ' +
    action.code
  );
}

function extractConfirmCode(question) {
  const raw = String(question || '');
  const exactShort = raw.trim().match(/^\d{6}$/);
  if (exactShort) return normalizeCode(exactShort[0]);
  const exactPrefixed = raw.trim().match(/^MVK[\s-]*\d{6}$/i);
  if (exactPrefixed) return normalizeCode(exactPrefixed[0]);
  const m = raw.match(/(?:^|\s)(?:xác\s*nhận|xac\s*nhan|confirm)\s+((?:MVK[\s-]*)?\d{6})\b/i);
  return m ? normalizeCode(m[1]) : '';
}

function isExactConfirmMessage(question) {
  const raw = String(question || '').trim();
  return /^\d{6}$/.test(raw) || /^MVK[\s-]*\d{6}$/i.test(raw) || /^(?:xác\s*nhận|xac\s*nhan|confirm)\s+(?:MVK[\s-]*)?\d{6}$/i.test(raw);
}

function extractCancelCode(question) {
  const raw = String(question || '');
  const m = raw.match(/(?:^|\s)(?:hủy|huy|cancel)\s+(MVK[\s-]*\d{6})\b/i);
  return m ? normalizeCode(m[1]) : '';
}

function isExactCancelMessage(question) {
  const raw = String(question || '').trim();
  return /^(?:hủy|huy|cancel)\s+MVK[\s-]*\d{6}$/i.test(raw);
}

function extractUndoCode(question) {
  const raw = String(question || '');
  const m = raw.match(/(?:^|\s)(?:hoàn\s*tác|hoan\s*tac|undo|khôi\s*phục|khoi\s*phuc)\s+(MVK[\s-]*\d{6})\b/i);
  return m ? normalizeCode(m[1]) : '';
}

function isUndoRequest(question) {
  return !!extractUndoCode(question) || /(hoan tac|undo|khoi phuc).*\bmvk\s*\d{6}\b/.test(norm(question));
}

function isWriteIntentQuestion(question) {
  const n = norm(question);
  if (extractConfirmCode(question) || extractCancelCode(question)) return true;
  if (isCashTuitionPaymentIntent(question)) return true;
  if (/(cham|cap nhat|sua|xoa|bo|huy|tat ca|ca lop|toan bo).*(diem danh|co mat|vang|di hoc|attendance|present|absent)/.test(n)) return true;
  if (/(diem danh|cham).*(tat ca|ca lop|toan bo|tru|co mat|vang|di hoc)/.test(n)) return true;
  if (/(cap nhat|sua|them|ghi|luu).*(ghi chu|nhan xet|learning note|note).*(hoc vien|hoc sinh|cho|:)/.test(n)) return true;
  if (/(ghi chu|nhan xet|learning note|note).*(hoc vien|hoc sinh|cho).*(la|thanh|:)/.test(n)) return true;
  if (/(danh dau|cap nhat|sua|doi).*(lead|tu van).*(new|moi|contacted|da lien he|lien he|closed|dong|hoan tat|archived|luu tru)/.test(n)) return true;
  if (/(lead|tu van).*(new|moi|contacted|da lien he|lien he|closed|dong|hoan tat|archived|luu tru)/.test(n) && /(danh dau|cap nhat|sua|doi)/.test(n)) return true;
  return false;
}

function uniqueByNorm(values) {
  const seen = new Set();
  const out = [];
  asArray(values).forEach((v) => {
    const text = String(v || '').trim();
    const key = norm(cleanClassName(text) || text);
    if (!text || !key || seen.has(key)) return;
    seen.add(key);
    out.push(text);
  });
  return out;
}

function knownClassNames(snapshot) {
  const rows = [];
  asArray(snapshot.classDefs).forEach((c) => {
    rows.push(c.label, c.display_name, c.class_name);
  });
  asArray(snapshot.classFees).forEach((c) => rows.push(c.class_name || c.class || c.name));
  asArray(snapshot.students).forEach((s) => classNamesOf(s).forEach((c) => rows.push(c)));
  return uniqueByNorm(rows);
}

function classMatches(a, b) {
  const na = norm(cleanClassName(a) || a);
  const nb = norm(cleanClassName(b) || b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function containsNormPhrase(haystack, phrase) {
  const h = norm(haystack);
  const p = norm(phrase);
  if (!h || !p) return false;
  const re = new RegExp('(^| )' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)');
  return re.test(h);
}

function resolveClassName(snapshot, request, dateText) {
  const q = norm(request);
  const classes = knownClassNames(snapshot);
  const rawCode = String(request || '').match(/\bMVK[\s_:-]*[A-Za-z0-9]+[\s_:-]*[A-Za-z0-9]+\b/i);
  if (rawCode) {
    const codeNorm = norm(rawCode[0]);
    const matched = classes.filter((name) => {
      const clean = cleanClassName(name);
      return norm(name).includes(codeNorm) || norm(clean).includes(codeNorm);
    });
    const distinct = uniqueByNorm(matched);
    if (distinct.length === 1) return { status: 'single', class_name: distinct[0] };
    if (distinct.length > 1) return { status: 'ambiguous', classes: distinct.slice(0, 8) };
  }
  const scored = classes
    .map((name) => {
      const clean = cleanClassName(name);
      const aliases = uniqueByNorm([name, clean]);
      let score = 0;
      aliases.forEach((a) => {
        const an = norm(a);
        if (!an) return;
        if (q === an) score = Math.max(score, 1000 + an.length);
        if (q.includes(an)) score = Math.max(score, 500 + an.length);
        if (an.includes(q) && q.length >= 4) score = Math.max(score, 200 + q.length);
      });
      return score ? { class_name: name, display_name: clean, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.display_name.length - a.display_name.length);
  if (scored.length) {
    const topScore = scored[0].score;
    const top = scored.filter((x) => x.score === topScore);
    const distinct = uniqueByNorm(top.map((x) => x.class_name));
    if (distinct.length === 1) return { status: 'single', class_name: distinct[0] };
    return { status: 'ambiguous', classes: distinct.slice(0, 8) };
  }
  const scheduled = scheduledClassesForDate(snapshot.classDefs, dateText || vnDate());
  if (scheduled.length === 1 && /(hom nay|ngay mai|hom qua|thu|t[2-7]|chu nhat|cn)/.test(q)) {
    return { status: 'single', class_name: scheduled[0].class_name || scheduled[0].display_name };
  }
  return { status: 'not_found', classes: [] };
}

function studentsInClass(snapshot, className) {
  return asArray(snapshot.students)
    .filter((s) => classNamesOf(s).some((c) => classMatches(c, className)))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'vi'));
}

function findStudentsMentioned(snapshot, text, className) {
  const q = norm(text);
  const qd = digits(text);
  const qTokens = q.split(/\s+/).filter((t) => t.length >= 3);
  const allowSingleTokenNameMatch = qTokens.length <= 1;
  const base = className ? studentsInClass(snapshot, className) : asArray(snapshot.students);
  return base
    .map((s) => {
      const full = norm(s.name);
      const phone = digits(s.phone);
      const tokens = full.split(/\s+/).filter((t) => t.length > 1);
      const last = tokens[tokens.length - 1] || '';
      const twoLast = tokens.slice(-2).join(' ');
      let score = 0;
      if (qd && phone && phone.includes(qd)) score += 1000 + qd.length;
      if (full && containsNormPhrase(q, full)) score += 800 + full.length;
      if (twoLast && containsNormPhrase(q, twoLast)) score += 220 + twoLast.length;
      if (allowSingleTokenNameMatch && last && last.length >= 3 && containsNormPhrase(q, last)) score += 80 + last.length;
      const matchedTokens = tokens.filter((t) => t.length >= 3 && containsNormPhrase(q, t)).length;
      if (matchedTokens >= Math.min(2, tokens.length)) score += 30 + matchedTokens * 10;
      if (q && full.includes(q) && (allowSingleTokenNameMatch || qTokens.length >= 2) && q.length >= 3) score += 70 + q.length;
      return score > 0 ? { student: s, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || String(a.student.name || '').localeCompare(String(b.student.name || ''), 'vi'))
    .map((x) => x.student);
}

function uniqueStudents(students) {
  const seen = new Set();
  const out = [];
  asArray(students).forEach((s) => {
    const id = String(s && s.id || '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(s);
  });
  return out;
}

function splitNameList(text) {
  return String(text || '')
    .replace(/\b(hôm nay|hom nay|ngày mai|ngay mai|hôm qua|hom qua)\b/gi, ' ')
    .split(/[,;\n]|(?:\s+và\s+)|(?:\s+va\s+)|(?:\s+and\s+)/i)
    .map((s) => s.replace(/^(em|bạn|ban|hs|hoc sinh|học sinh|hoc vien|học viên)\s+/i, '').trim())
    .filter(Boolean);
}

function resolveSingleStudentForWrite(snapshot, text, className) {
  const matches = uniqueStudents(findStudentsMentioned(snapshot, text, className)).slice(0, 8);
  if (matches.length === 1) return { status: 'single', student: matches[0] };
  if (!matches.length) return { status: 'not_found', students: [] };
  return { status: 'ambiguous', students: matches };
}

function studentOptionLines(students) {
  return asArray(students)
    .slice(0, 8)
    .map((s) => '- ' + (s.name || 'Không rõ') + (classNamesOf(s).length ? ' · ' + classNamesOf(s).map(cleanClassName).join(', ') : '') + (s.phone ? ' · ' + s.phone : ''))
    .join('\n');
}

function parseAttendanceWriteStatus(question) {
  const n = norm(question);
  if (/(xoa|bo|huy).*(diem danh|attendance)/.test(n)) return 'delete';
  if (/(vang|absent)/.test(n)) return 'absent';
  if (/(co mat|di hoc|present)/.test(n)) return 'present';
  return '';
}

function isBulkAttendanceWrite(question) {
  const n = norm(question);
  return /(tat ca|ca lop|toan bo)/.test(n) || /\btru\b/.test(n);
}

function attendanceStatusIcon(status) {
  if (status === 'present') return '✅';
  if (status === 'absent') return '❌';
  return '🗑️';
}

function attendanceStatusLabel(status) {
  if (status === 'present') return 'có mặt';
  if (status === 'absent') return 'vắng';
  return 'xóa';
}

function attendancePayloadPreview(records, actionLabel, date, className) {
  const present = records.filter((r) => r.status === 'present').length;
  const absent = records.filter((r) => r.status === 'absent').length;
  const deleted = records.filter((r) => r.status !== 'present' && r.status !== 'absent').length;
  const summary = [
    present ? '✅ ' + present + ' có mặt' : '',
    absent ? '❌ ' + absent + ' vắng' : '',
    deleted ? '🗑️ ' + deleted + ' xóa' : ''
  ].filter(Boolean).join(', ');
  const lines = records.slice(0, 25).map((r) => attendanceStatusIcon(r.status) + ' ' + r.student_name + ': ' + attendanceStatusLabel(r.status));
  const more = records.length > 25 ? '\n- ... và ' + (records.length - 25) + ' học viên khác' : '';
  return lineJoin([
    'Em đã tạo bản nháp ' + actionLabel + '.',
    'Ngày: ' + date,
    'Lớp: ' + cleanClassName(className),
    'Số học viên: ' + records.length + (summary ? ' (' + summary + ')' : ''),
    'Danh sách thay đổi:',
    lines.join('\n') + more
  ]);
}

function attendanceRecordForStudent(student, date, className, status) {
  return {
    student_id: String(student.id),
    student_name: String(student.name || ''),
    date,
    status,
    class_name: String(className || classNamesOf(student)[0] || '')
  };
}

function attendanceRowsForClassDate(snapshot, date, className) {
  const studentsById = new Map(asArray(snapshot.students).map((s) => [String(s.id), s]));
  return asArray(snapshot.attendance)
    .filter((a) => String(a.date || '').slice(0, 10) === date)
    .filter((a) => classMatches(a.class_name || classNamesOf(studentsById.get(String(a.student_id || '')) || {})[0] || '', className))
    .map((a) => {
      const student = studentsById.get(String(a.student_id || '')) || {};
      return {
        student_id: String(a.student_id || ''),
        student_name: String(student.name || a.student_name || ''),
        date,
        status: 'delete',
        old_status: normalizeAttendanceStatus(a.status),
        class_name: String(a.class_name || className || '')
      };
    })
    .filter((r) => r.student_id);
}

function attendanceRowForStudentDate(snapshot, studentId, date) {
  const row = asArray(snapshot.attendance).find((a) => String(a.student_id || '') === String(studentId || '') && String(a.date || '').slice(0, 10) === date);
  if (!row) return null;
  const student = asArray(snapshot.students).find((s) => String(s.id || '') === String(studentId || '')) || {};
  return {
    student_id: String(row.student_id || ''),
    student_name: String(student.name || row.student_name || ''),
    date,
    status: normalizeAttendanceStatus(row.status),
    class_name: String(row.class_name || classNamesOf(student)[0] || '')
  };
}

function attendanceBeforeRecords(snapshot, records) {
  return asArray(records).map((r) => ({
    key: String(r.student_id || '') + '::' + String(r.date || ''),
    before: attendanceRowForStudentDate(snapshot, r.student_id, String(r.date || '').slice(0, 10))
  }));
}

function parseVietnameseMoney(text) {
  const raw = String(text || '').toLowerCase();
  const plain = norm(raw);
  const compact = raw.replace(/\s+/g, '');
  let m = compact.match(/(\d+(?:[.,]\d+)?)\s*(?:tr|trieu|triệu)\s*(\d{1,3})?/i);
  if (m) {
    const major = Number(String(m[1] || '0').replace(',', '.'));
    if (Number.isFinite(major) && major > 0) {
      let amount = Math.round(major * 1000000);
      if (m[2] && !String(m[1]).includes('.') && !String(m[1]).includes(',')) {
        const tail = String(m[2]);
        amount += Number(tail.padEnd(3, '0').slice(0, 3)) * 1000;
      }
      return amount;
    }
  }
  m = plain.match(/(\d+)\s*trieu\s*(\d{1,3})?/i);
  if (m) {
    let amount = Number(m[1]) * 1000000;
    if (m[2]) amount += Number(String(m[2]).padEnd(3, '0').slice(0, 3)) * 1000;
    return amount;
  }
  m = compact.match(/(\d+(?:[.,]\d+)?)\s*k\b/i);
  if (m) {
    const n = Number(String(m[1]).replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
  }
  const candidates = [];
  const re = /(?:^|[^\d])(\d{1,3}(?:[.,]\d{3})+|\d+)(?:\s*(?:d|đ|vnd))?(?=$|[^\d])/gi;
  let x;
  while ((x = re.exec(raw))) {
    const token = String(x[1] || '').trim();
    if (!token) continue;
    const hasSep = /[.,]/.test(token);
    const n = Number(token.replace(/[.,]/g, ''));
    if (!Number.isFinite(n) || n <= 0) continue;
    const amount = hasSep ? n : n < 10000 ? n * 1000 : n;
    if (amount >= 1000) candidates.push(amount);
  }
  return candidates.length ? candidates[candidates.length - 1] : 0;
}

function isCashTuitionPaymentIntent(question) {
  const n = norm(question);
  if (!parseVietnameseMoney(question)) return false;
  if (/(doanh thu|revenue|giao dich|chuyen khoan|bank|doi soat)/.test(n)) return false;
  if (/(hoc phi|phi hoc|gia|bao nhieu tien|moi buoi|1 buoi).*(lop|mvk|kem)|((lop|mvk|kem).*(hoc phi|phi hoc|gia|bao nhieu|moi buoi|1 buoi))/.test(n)) return false;
  return /(dong|nop|tra|thanh toan|da dong|da nop|thu tien mat|tien mat|ghi nhan hoc phi|hoc phi)/.test(n);
}

function cashRequestStudentText(request) {
  return String(request || '')
    .replace(/\d+(?:[.,]\d+)?\s*(?:tr|triệu|trieu|k|đ|d|vnd)?/gi, ' ')
    .replace(/\b(da|đã|dong|đóng|nop|nộp|tra|trả|thanh\s*toan|thanh\s*toán|thu|tien\s*mat|tiền\s*mặt|hoc\s*phi|học\s*phí|ghi\s*nhan|ghi\s*nhận|hom\s*nay|hôm\s*nay|ngay\s*mai|ngày\s*mai|hom\s*qua|hôm\s*qua)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedClassKey(className) {
  return norm(cleanClassName(className) || className);
}

function tuitionClassRow(snapshot, studentId, className) {
  const sid = String(studentId || '');
  const nk = normalizedClassKey(className);
  return asArray(snapshot.tuitionByClass).find((r) => String(r.student_id || '') === sid && normalizedClassKey(r.class_name) === nk) || null;
}

function presentCountForStudentClass(snapshot, studentId, className) {
  const sid = String(studentId || '');
  const nk = normalizedClassKey(className);
  return asArray(snapshot.attendance).filter((a) =>
    String(a.student_id || '') === sid &&
    normalizeAttendanceStatus(a.status) === 'present' &&
    normalizedClassKey(a.class_name || '') === nk
  ).length;
}

function cashTuitionClassCandidates(snapshot, student) {
  const fees = feeMap(snapshot.classFees);
  return classNamesOf(student)
    .map((cls) => {
      const row = tuitionClassRow(snapshot, student.id, cls);
      const dbClass = String((row && row.class_name) || cls || '').trim();
      const fee = getFeeForClass(fees, dbClass || cls);
      const present = presentCountForStudentClass(snapshot, student.id, dbClass || cls);
      const charged = Math.max(0, Number((row && row.charged_sessions) || 0));
      const prepaid = Math.max(0, Number((row && row.prepaid_balance_vnd) || 0));
      return {
        class_name: dbClass || cls,
        fee,
        present_sessions: present,
        charged_sessions: charged,
        prepaid_balance_vnd: prepaid,
        sessions_due: Math.max(0, present - charged),
        row_exists: !!row
      };
    })
    .filter((r) => r.class_name && r.fee > 0)
    .sort((a, b) => b.sessions_due - a.sessions_due || a.class_name.localeCompare(b.class_name, 'vi'));
}

function buildCashTuitionLines(snapshot, student, amountVnd, preferredClass) {
  let candidates = cashTuitionClassCandidates(snapshot, student);
  if (preferredClass) {
    candidates = candidates.filter((c) => classMatches(c.class_name, preferredClass));
  }
  if (!candidates.length) {
    return { ok: false, reason: 'NO_CLASS_FEE', lines: [], leftover_vnd: amountVnd };
  }
  let remaining = Math.max(0, money(amountVnd));
  const lines = [];
  candidates.forEach((c) => {
    if (remaining < c.fee || c.sessions_due < 1) return;
    const apply = Math.min(c.sessions_due, Math.floor(remaining / c.fee));
    if (apply < 1) return;
    const appliedAmount = apply * c.fee;
    lines.push({
      student_id: String(student.id),
      student_name: String(student.name || ''),
      class_name: c.class_name,
      fee_vnd: c.fee,
      sessions_applied: apply,
      tuition_amount_vnd: appliedAmount,
      prepaid_topup_vnd: 0,
      charged_before: c.charged_sessions,
      prepaid_before: c.prepaid_balance_vnd,
      charged_after: c.charged_sessions + apply,
      prepaid_after: c.prepaid_balance_vnd,
      row_exists: c.row_exists
    });
    remaining -= appliedAmount;
  });
  if (remaining > 0) {
    const target = lines.length
      ? lines[lines.length - 1]
      : (preferredClass ? candidates[0] : (candidates.length === 1 ? candidates[0] : null));
    if (!target) return { ok: false, reason: 'PREPAID_CLASS_REQUIRED', lines, leftover_vnd: remaining };
    if (lines.length) {
      target.prepaid_topup_vnd += remaining;
      target.prepaid_after += remaining;
    } else {
      if (remaining < target.fee) return { ok: false, reason: 'AMOUNT_BELOW_ONE_SESSION', lines: [], leftover_vnd: remaining, min_fee_vnd: target.fee };
      lines.push({
        student_id: String(student.id),
        student_name: String(student.name || ''),
        class_name: target.class_name,
        fee_vnd: target.fee,
        sessions_applied: 0,
        tuition_amount_vnd: 0,
        prepaid_topup_vnd: remaining,
        charged_before: target.charged_sessions,
        prepaid_before: target.prepaid_balance_vnd,
        charged_after: target.charged_sessions,
        prepaid_after: target.prepaid_balance_vnd + remaining,
        row_exists: target.row_exists
      });
    }
    remaining = 0;
  }
  if (!lines.length) {
    const minFee = candidates.reduce((m, c) => Math.min(m, c.fee), Number.POSITIVE_INFINITY);
    return { ok: false, reason: 'AMOUNT_BELOW_ONE_SESSION', lines: [], leftover_vnd: amountVnd, min_fee_vnd: minFee };
  }
  return { ok: true, lines, leftover_vnd: remaining };
}

function cashTuitionPreview(student, amountVnd, paidDate, lines) {
  const totalApplied = lines.reduce((sum, r) => sum + Number(r.sessions_applied || 0), 0);
  const totalPrepaid = lines.reduce((sum, r) => sum + Number(r.prepaid_topup_vnd || 0), 0);
  const detail = lines.map((r) => {
    const parts = [];
    if (r.sessions_applied) parts.push(r.sessions_applied + ' buoi = ' + formatVnd(r.tuition_amount_vnd));
    if (r.prepaid_topup_vnd) parts.push('du tra truoc ' + formatVnd(r.prepaid_topup_vnd));
    return '- ' + cleanClassName(r.class_name) + ': ' + parts.join(', ');
  });
  return lineJoin([
    'Em da tao ban nhap ghi nhan hoc phi tien mat.',
    'Hoc vien: ' + (student.name || '') + (classNamesOf(student).length ? ' · ' + classNamesOf(student).map(cleanClassName).join(', ') : ''),
    'Ngay thu: ' + paidDate,
    'Tong tien: ' + formatVnd(amountVnd),
    'So buoi ap dung: ' + totalApplied + (totalPrepaid ? ' · Du tra truoc: ' + formatVnd(totalPrepaid) : ''),
    'Phan bo:',
    detail.join('\n')
  ]);
}

async function prepareCashTuitionPaymentAction(snapshot, request) {
  const amount = parseVietnameseMoney(request);
  if (!amount) {
    return { answer: 'Em chua doc duoc so tien can ghi nhan. Thay/co gui vi du: "Son dong 1tr2" hoac "Hung nop 700".', safe: true, changed_data: false, requires_clarification: true };
  }
  const date = dateFromQuestion(request);
  const cls = resolveClassName(snapshot, request, date);
  const preferredClass = cls.status === 'single' && norm(request).includes(norm(cleanClassName(cls.class_name) || cls.class_name)) ? cls.class_name : '';
  const studentText = cashRequestStudentText(request) || request;
  const st = resolveSingleStudentForWrite(snapshot, studentText, preferredClass || '');
  if (st.status !== 'single') {
    return {
      answer: st.status === 'ambiguous'
        ? 'Em thay nhieu hoc vien co the khop. Thay/co gui them lop hoac SDT:\n' + studentOptionLines(st.students)
        : 'Em chua xac dinh duoc hoc vien can ghi nhan hoc phi. Thay/co gui them ten day du, lop hoac SDT.',
      safe: true,
      changed_data: false,
      requires_clarification: true
    };
  }
  const alloc = buildCashTuitionLines(snapshot, st.student, amount, preferredClass);
  if (!alloc.ok) {
    const msg =
      alloc.reason === 'PREPAID_CLASS_REQUIRED'
        ? 'Hoc vien co nhieu lop va so tien co phan du. Thay/co gui ro lop de luu tien tra truoc.'
        : alloc.reason === 'AMOUNT_BELOW_ONE_SESSION'
          ? 'So tien nay chua du mot buoi hoc phi' + (alloc.min_fee_vnd ? ' (toi thieu ' + formatVnd(alloc.min_fee_vnd) + ')' : '') + '. Thay/co kiem tra lai so tien hoac ghi ro lop neu muon luu tra truoc.'
          : 'Em chua thay cau hinh hoc phi/lop phu hop de ghi nhan tien mat cho hoc vien nay.';
    return { answer: msg, safe: true, changed_data: false, requires_clarification: true, reason: alloc.reason };
  }
  const action = createPendingAction(
    'cash_tuition_payment',
    request,
    cashTuitionPreview(st.student, amount, date, alloc.lines),
    {
      student_id: String(st.student.id),
      student_name: String(st.student.name || ''),
      amount_vnd: amount,
      paid_date: date,
      lines: alloc.lines
    }
  );
  return { answer: pendingActionAnswer(action), action, requires_confirmation: true, changed_data: false };
}

function isClassAttendanceDeleteRequest(question) {
  const n = norm(question);
  return /(xoa|bo|huy).*(diem danh|attendance).*(cua lop|ca lop|toan bo|lop|class)/.test(n);
}

async function prepareAttendanceAction(snapshot, request) {
  const date = dateFromQuestion(request);
  const status = parseAttendanceWriteStatus(request);
  if (!status) {
    return {
      answer: 'Em chưa thấy trạng thái điểm danh cần ghi. Thầy/cô ghi rõ "có mặt" hoặc "vắng".',
      safe: true,
      changed_data: false,
      requires_clarification: true
    };
  }
  const cls = resolveClassName(snapshot, request, date);
  if (cls.status !== 'single') {
    return {
      answer: cls.status === 'ambiguous'
        ? 'Em thấy nhiều lớp có thể khớp. Thầy/cô ghi rõ một lớp:\n' + cls.classes.map((c) => '- ' + cleanClassName(c)).join('\n')
        : 'Em chưa xác định được lớp cần điểm danh. Thầy/cô gửi thêm tên lớp, ví dụ MVK_C2_N1.',
      safe: true,
      changed_data: false,
      requires_clarification: true
    };
  }
  const className = cls.class_name;
  if (status === 'delete') {
    if (isClassAttendanceDeleteRequest(request)) {
      const records = attendanceRowsForClassDate(snapshot, date, className);
      if (!records.length) {
        return {
          answer: 'Em chưa thấy bản ghi điểm danh nào của lớp ' + cleanClassName(className) + ' ngày ' + date + ' để xóa.',
          safe: true,
          changed_data: false,
          requires_clarification: false
        };
      }
      const action = createPendingAction(
        'attendance_delete',
        request,
        attendancePayloadPreview(records, 'xóa điểm danh của lớp', date, className),
        { records }
      );
      return { answer: pendingActionAnswer(action), action, requires_confirmation: true, changed_data: false };
    }
    const st = resolveSingleStudentForWrite(snapshot, request, className);
    if (st.status !== 'single') {
      return {
        answer: st.status === 'ambiguous'
          ? 'Em thấy nhiều học viên có thể khớp. Thầy/cô gửi thêm SĐT hoặc tên đầy đủ:\n' + studentOptionLines(st.students)
          : 'Em chưa xác định được học viên cần xóa điểm danh. Thầy/cô gửi thêm tên hoặc SĐT.',
        safe: true,
        changed_data: false,
        requires_clarification: true
      };
    }
    const record = attendanceRecordForStudent(st.student, date, className, 'delete');
    const existing = attendanceRowForStudentDate(snapshot, record.student_id, date);
    if (!existing) {
      return {
        answer: 'Em chưa thấy bản ghi điểm danh của ' + st.student.name + ' ngày ' + date + ' để xóa.',
        safe: true,
        changed_data: false,
        requires_clarification: false
      };
    }
    record.old_status = existing.status;
    record.class_name = existing.class_name || record.class_name;
    const action = createPendingAction(
      'attendance_delete',
      request,
      attendancePayloadPreview([record], 'xóa điểm danh', date, className),
      { records: [record] }
    );
    return { answer: pendingActionAnswer(action), action, requires_confirmation: true, changed_data: false };
  }
  let records = [];
  if (isBulkAttendanceWrite(request)) {
    const roster = studentsInClass(snapshot, className);
    if (!roster.length) {
      return {
        answer: 'Em chưa thấy học viên nào thuộc lớp ' + cleanClassName(className) + '.',
        safe: true,
        changed_data: false,
        requires_clarification: true
      };
    }
    const n = norm(request);
    const defaultStatus = /(?:tat ca|ca lop|toan bo).*(vang|absent)/.test(n) ? 'absent' : 'present';
    const exceptStatus = defaultStatus === 'present' ? 'absent' : 'present';
    const exceptMatch = String(request || '').match(/(?:trừ|tru|ngoại trừ|ngoai tru)\s+(.+)$/i);
    const exceptionIds = new Set();
    if (exceptMatch && exceptMatch[1]) {
      for (const part of splitNameList(exceptMatch[1])) {
        const st = resolveSingleStudentForWrite(snapshot, part, className);
        if (st.status !== 'single') {
          return {
            answer: st.status === 'ambiguous'
              ? 'Tên "' + part + '" đang khớp nhiều học viên. Thầy/cô gửi thêm SĐT hoặc tên đầy đủ:\n' + studentOptionLines(st.students)
              : 'Em chưa tìm thấy học viên "' + part + '" trong lớp ' + cleanClassName(className) + '.',
            safe: true,
            changed_data: false,
            requires_clarification: true
          };
        }
        exceptionIds.add(String(st.student.id));
      }
    }
    records = roster.map((s) => attendanceRecordForStudent(s, date, className, exceptionIds.has(String(s.id)) ? exceptStatus : defaultStatus));
  } else {
    const st = resolveSingleStudentForWrite(snapshot, request, className);
    if (st.status !== 'single') {
      return {
        answer: st.status === 'ambiguous'
          ? 'Em thấy nhiều học viên có thể khớp. Thầy/cô gửi thêm SĐT hoặc tên đầy đủ:\n' + studentOptionLines(st.students)
          : 'Em chưa xác định được học viên cần điểm danh. Thầy/cô gửi thêm tên hoặc SĐT.',
        safe: true,
        changed_data: false,
        requires_clarification: true
      };
    }
    records = [attendanceRecordForStudent(st.student, date, className, status)];
  }
  const action = createPendingAction(
    'attendance_upsert',
    request,
    attendancePayloadPreview(records, 'ghi điểm danh', date, className),
    { records, before_records: attendanceBeforeRecords(snapshot, records) }
  );
  return { answer: pendingActionAnswer(action), action, requires_confirmation: true, changed_data: false };
}

function parseLearningNoteText(request) {
  const raw = String(request || '').trim();
  const colon = raw.match(/[:：]\s*([\s\S]+)$/);
  if (colon && colon[1].trim()) return colon[1].trim();
  const quoted = raw.match(/[“"]([^”"]+)[”"]\s*$/);
  if (quoted && quoted[1].trim()) return quoted[1].trim();
  const m = raw.match(/(?:là|la|thành|thanh|nội dung|noi dung)\s+([\s\S]+)$/i);
  return m && m[1] ? m[1].trim() : '';
}

async function prepareStudentNoteAction(snapshot, request) {
  const note = parseLearningNoteText(request);
  if (!note) {
    return {
      answer: 'Em chưa thấy nội dung ghi chú mới. Thầy/cô dùng dạng: "Cập nhật ghi chú Sơn: nội dung ghi chú".',
      safe: true,
      changed_data: false,
      requires_clarification: true
    };
  }
  const beforeNote = String(request || '').split(/[:：]/)[0] || request;
  const st = resolveSingleStudentForWrite(snapshot, beforeNote, '');
  if (st.status !== 'single') {
    return {
      answer: st.status === 'ambiguous'
        ? 'Em thấy nhiều học viên có thể khớp. Thầy/cô gửi thêm SĐT hoặc lớp:\n' + studentOptionLines(st.students)
        : 'Em chưa xác định được học viên cần cập nhật ghi chú. Thầy/cô gửi thêm tên hoặc SĐT.',
      safe: true,
      changed_data: false,
      requires_clarification: true
    };
  }
  const student = st.student;
  const preview = lineJoin([
    'Em đã tạo bản nháp cập nhật ghi chú học viên.',
    'Học viên: ' + student.name + (classNamesOf(student).length ? ' · ' + classNamesOf(student).map(cleanClassName).join(', ') : ''),
    'Ghi chú cũ: ' + (String(student.learning_note || '').trim() || '(trống)'),
    'Ghi chú mới: ' + note
  ]);
  const action = createPendingAction('student_note_update', request, preview, {
    student_id: String(student.id),
    student_name: String(student.name || ''),
    old_note: String(student.learning_note || ''),
    new_note: note
  });
  return { answer: pendingActionAnswer(action), action, requires_confirmation: true, changed_data: false };
}

function parseLeadStatus(request) {
  const n = norm(request);
  if (/(archived|archive|luu tru)/.test(n)) return 'archived';
  if (/(closed|dong|hoan tat|chot|ket thuc)/.test(n)) return 'closed';
  if (/(contacted|da lien he|lien he|da goi|goi roi)/.test(n)) return 'contacted';
  if (/(new|moi)/.test(n)) return 'new';
  return '';
}

function parseLeadAdminNote(request) {
  const raw = String(request || '');
  const m = raw.match(/(?:ghi chú|ghi chu|note|admin note)\s*[:：-]\s*([\s\S]+)$/i);
  return m && m[1] ? m[1].trim() : '';
}

function findLeadsMentioned(snapshot, request) {
  const raw = String(request || '');
  const q = norm(raw);
  const qd = digits(raw);
  const uuid = raw.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  return asArray(snapshot.leads)
    .map((lead) => {
      let score = 0;
      if (uuid && String(lead.id || '').toLowerCase() === uuid[0].toLowerCase()) score += 1000;
      const phone = digits(lead.parent_phone);
      if (qd && phone && phone.includes(qd)) score += 500 + qd.length;
      const name = norm(lead.student_name);
      if (name && q.includes(name)) score += 250 + name.length;
      const tokens = name.split(/\s+/).filter((t) => t.length > 1);
      const last = tokens[tokens.length - 1] || '';
      if (last && q.includes(last)) score += 50 + last.length;
      if (/\b(moi nhat|gan nhat|lead moi)\b/.test(q) && String(lead.status || 'new') === 'new') score += 20;
      return score > 0 ? { lead, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || String(b.lead.created_at || '').localeCompare(String(a.lead.created_at || '')))
    .map((x) => x.lead);
}

async function prepareLeadAction(snapshot, request) {
  const status = parseLeadStatus(request);
  if (!status) {
    return {
      answer: 'Em chưa thấy trạng thái lead cần cập nhật. Các trạng thái hợp lệ: new, contacted, closed, archived.',
      safe: true,
      changed_data: false,
      requires_clarification: true
    };
  }
  let matches = findLeadsMentioned(snapshot, request).slice(0, 8);
  if (!matches.length && /\b(moi nhat|gan nhat|lead moi)\b/.test(norm(request))) {
    matches = asArray(snapshot.leads).filter((l) => String(l.status || 'new') === 'new').slice(0, 2);
  }
  if (matches.length !== 1) {
    return {
      answer: matches.length
        ? 'Em thấy nhiều lead có thể khớp. Thầy/cô gửi thêm SĐT hoặc mã lead:\n' + matches.map((l) => '- ' + (l.student_name || 'Không rõ') + (l.parent_phone ? ' · ' + l.parent_phone : '') + ' · ' + (l.status || 'new')).join('\n')
        : 'Em chưa xác định được lead cần cập nhật. Thầy/cô gửi thêm tên học viên, SĐT phụ huynh hoặc mã lead.',
      safe: true,
      changed_data: false,
      requires_clarification: true
    };
  }
  const lead = matches[0];
  const adminNote = parseLeadAdminNote(request);
  const body = { status };
  if (adminNote) body.admin_note = adminNote;
  const preview = lineJoin([
    'Em đã tạo bản nháp cập nhật lead tư vấn.',
    'Lead: ' + (lead.student_name || 'Không rõ tên') + (lead.parent_phone ? ' · ' + lead.parent_phone : ''),
    'Trạng thái cũ: ' + (lead.status || 'new'),
    'Trạng thái mới: ' + status,
    adminNote ? 'Ghi chú admin mới: ' + adminNote : ''
  ]);
  const action = createPendingAction('lead_update', request, preview, {
    lead_id: String(lead.id),
    lead_name: String(lead.student_name || ''),
    parent_phone: String(lead.parent_phone || ''),
    old_status: String(lead.status || 'new'),
    old_admin_note: String(lead.admin_note || ''),
    update: body
  });
  return { answer: pendingActionAnswer(action), action, requires_confirmation: true, changed_data: false };
}

async function prepareAction(args) {
  CURRENT_ACTOR = activeActorFromArgs(args || {});
  if (!actorCan(CURRENT_ACTOR, 'can_prepare_write')) return permissionDenied('can_prepare_write');
  const request = String((args && (args.request || args.question || args.message)) || '').trim();
  if (!request) throw new Error('request is required');
  const confirmCode = extractConfirmCode(request);
  if (confirmCode) return confirmAction({ code: confirmCode, message: request, internal_confirmed: isExactConfirmMessage(request) });
  const cancelCode = extractCancelCode(request);
  if (cancelCode) return cancelAction({ code: cancelCode, message: request, internal_confirmed: isExactCancelMessage(request) });
  const undoCode = extractUndoCode(request);
  if (undoCode) return prepareUndoAction({ code: undoCode, request });
  const snapshot = await loadSnapshot();
  const n = norm(request);
  if (isCashTuitionPaymentIntent(request)) {
    return prepareCashTuitionPaymentAction(snapshot, request);
  }
  if (/(lead|tu van)/.test(n) && /(danh dau|cap nhat|sua|doi|new|moi|contacted|da lien he|lien he|closed|dong|hoan tat|archived|luu tru)/.test(n)) {
    return prepareLeadAction(snapshot, request);
  }
  if (/(ghi chu|nhan xet|learning note|note)/.test(n) && /(cap nhat|sua|them|ghi|luu|hoc vien|hoc sinh|cho|:)/.test(n)) {
    return prepareStudentNoteAction(snapshot, request);
  }
  if (/(diem danh|cham|co mat|vang|di hoc|attendance|present|absent)/.test(n) && /(cham|cap nhat|sua|xoa|bo|huy|tat ca|ca lop|toan bo|tru|co mat|vang|di hoc)/.test(n)) {
    return prepareAttendanceAction(snapshot, request);
  }
  return {
    answer: 'Yêu cầu này chưa thuộc nhóm thao tác ghi v1. Em chỉ hỗ trợ v1: điểm danh, cập nhật ghi chú học viên, cập nhật trạng thái lead. Nhắc phí phụ huynh hiện chỉ soạn nháp, chưa gửi.',
    safe: true,
    changed_data: false,
    supported_actions: ['attendance_upsert', 'attendance_delete', 'student_note_update', 'lead_update', 'cash_tuition_payment']
  };
}

async function upsertTuitionClassAbsolute(studentId, className, chargedSessions, prepaidBalance) {
  await requestSupabase(
    'POST',
    '/rest/v1/student_tuition_by_class?on_conflict=student_id,class_name',
    {
      student_id: studentId,
      class_name: className,
      charged_sessions: Math.max(0, Number(chargedSessions || 0)),
      prepaid_balance_vnd: Math.max(0, Number(prepaidBalance || 0)),
      updated_at: new Date().toISOString()
    },
    { Prefer: 'resolution=merge-duplicates,return=representation' }
  );
}

async function deleteTuitionClassRow(studentId, className) {
  await requestSupabase(
    'DELETE',
    '/rest/v1/student_tuition_by_class?student_id=eq.' + encodeURIComponent(studentId) + '&class_name=eq.' + encodeURIComponent(className),
    null,
    { Prefer: 'return=minimal' }
  );
}

async function syncStudentTuitionTotal(studentId) {
  await requestSupabase('POST', '/rest/v1/rpc/fn_sync_student_tuition_total', { p_student_id: studentId }, { Prefer: 'return=minimal' });
}

async function executePreparedAction(action) {
  if (action.type === 'attendance_upsert') {
    const records = asArray(action.payload && action.payload.records).map((r) => ({
      student_id: r.student_id,
      date: r.date,
      status: r.status,
      class_name: r.class_name
    }));
    if (!records.length) throw new Error('Attendance action has no records.');
    await requestSupabase('POST', '/rest/v1/attendance?on_conflict=student_id,date', records, {
      Prefer: 'resolution=merge-duplicates,return=representation'
    });
    return { changed_rows: records.length };
  }
  if (action.type === 'attendance_delete') {
    const records = asArray(action.payload && action.payload.records);
    for (const r of records) {
      await requestSupabase(
        'DELETE',
        '/rest/v1/attendance?student_id=eq.' + encodeURIComponent(r.student_id) + '&date=eq.' + encodeURIComponent(r.date),
        null,
        { Prefer: 'return=minimal' }
      );
    }
    return { changed_rows: records.length };
  }
  if (action.type === 'student_note_update') {
    await requestSupabase(
      'PATCH',
      '/rest/v1/students?id=eq.' + encodeURIComponent(action.payload.student_id),
      { learning_note: action.payload.new_note || null },
      { Prefer: 'return=representation' }
    );
    return { changed_rows: 1 };
  }
  if (action.type === 'lead_update') {
    await requestSupabase(
      'PATCH',
      '/rest/v1/consultation_leads?id=eq.' + encodeURIComponent(action.payload.lead_id),
      action.payload.update || {},
      { Prefer: 'return=representation' }
    );
    return { changed_rows: 1 };
  }
  if (action.type === 'cash_tuition_payment') {
    const lines = asArray(action.payload && action.payload.lines);
    if (!lines.length) throw new Error('Cash tuition action has no lines.');
    const paymentIds = [];
    try {
      for (const r of lines) {
        await upsertTuitionClassAbsolute(r.student_id, r.class_name, r.charged_after, r.prepaid_after);
        const payment = await requestSupabase(
          'POST',
          '/rest/v1/payment_history',
          {
            student_id: r.student_id,
            sessions_paid: Math.max(1, Number(r.sessions_applied || 0)),
            sessions_applied_to_charged: Math.max(0, Number(r.sessions_applied || 0)),
            amount_vnd: Math.max(0, Number(r.tuition_amount_vnd || 0) + Number(r.prepaid_topup_vnd || 0)),
            prepaid_topup_vnd: Math.max(0, Number(r.prepaid_topup_vnd || 0)),
            paid_at: String(action.payload.paid_date || vnDate()) + 'T00:00:00+07:00',
            payment_channel: 'cash',
            class_name: r.class_name,
            reconcile_note: 'Thầy Vũ xác nhận thu tiền mặt từ Telegram - mã ' + String(action.code || '')
          },
          { Prefer: 'return=representation' }
        );
        if (Array.isArray(payment) && payment[0] && payment[0].id != null) paymentIds.push(payment[0].id);
      }
    } catch (err) {
      for (const r of lines) {
        if (r.row_exists) await upsertTuitionClassAbsolute(r.student_id, r.class_name, r.charged_before, r.prepaid_before);
        else await deleteTuitionClassRow(r.student_id, r.class_name);
      }
      for (const id of paymentIds) {
        await requestSupabase('DELETE', '/rest/v1/payment_history?id=eq.' + encodeURIComponent(id), null, { Prefer: 'return=minimal' });
      }
      await syncStudentTuitionTotal(action.payload.student_id);
      throw err;
    }
    await syncStudentTuitionTotal(action.payload.student_id);
    return { changed_rows: lines.length, payment_history_ids: paymentIds };
  }
  if (action.type === 'undo_attendance_upsert') {
    const restoreRecords = asArray(action.payload && action.payload.restore_records).map((r) => ({
      student_id: r.student_id,
      date: r.date,
      status: r.status,
      class_name: r.class_name
    }));
    const deleteRecords = asArray(action.payload && action.payload.delete_records);
    for (const r of deleteRecords) {
      await requestSupabase(
        'DELETE',
        '/rest/v1/attendance?student_id=eq.' + encodeURIComponent(r.student_id) + '&date=eq.' + encodeURIComponent(r.date),
        null,
        { Prefer: 'return=minimal' }
      );
    }
    if (restoreRecords.length) {
      await requestSupabase('POST', '/rest/v1/attendance?on_conflict=student_id,date', restoreRecords, {
        Prefer: 'resolution=merge-duplicates,return=representation'
      });
    }
    return { changed_rows: restoreRecords.length + deleteRecords.length };
  }
  if (action.type === 'undo_attendance_delete') {
    const restoreRecords = asArray(action.payload && action.payload.restore_records).map((r) => ({
      student_id: r.student_id,
      date: r.date,
      status: r.status,
      class_name: r.class_name
    }));
    if (!restoreRecords.length) throw new Error('Undo attendance delete has no restore records.');
    await requestSupabase('POST', '/rest/v1/attendance?on_conflict=student_id,date', restoreRecords, {
      Prefer: 'resolution=merge-duplicates,return=representation'
    });
    return { changed_rows: restoreRecords.length };
  }
  if (action.type === 'undo_student_note_update') {
    await requestSupabase(
      'PATCH',
      '/rest/v1/students?id=eq.' + encodeURIComponent(action.payload.student_id),
      { learning_note: action.payload.old_note || null },
      { Prefer: 'return=representation' }
    );
    return { changed_rows: 1 };
  }
  if (action.type === 'undo_lead_update') {
    const body = { status: action.payload.old_status || 'new' };
    if (Object.prototype.hasOwnProperty.call(action.payload, 'old_admin_note')) body.admin_note = action.payload.old_admin_note || null;
    await requestSupabase(
      'PATCH',
      '/rest/v1/consultation_leads?id=eq.' + encodeURIComponent(action.payload.lead_id),
      body,
      { Prefer: 'return=representation' }
    );
    return { changed_rows: 1 };
  }
  if (action.type === 'undo_cash_tuition_payment') {
    const lines = asArray(action.payload && action.payload.lines);
    for (const r of lines) {
      if (r.row_exists) await upsertTuitionClassAbsolute(r.student_id, r.class_name, r.charged_before, r.prepaid_before);
      else await deleteTuitionClassRow(r.student_id, r.class_name);
    }
    for (const id of asArray(action.payload && action.payload.payment_history_ids)) {
      await requestSupabase('DELETE', '/rest/v1/payment_history?id=eq.' + encodeURIComponent(id), null, { Prefer: 'return=minimal' });
    }
    await syncStudentTuitionTotal(action.payload.student_id);
    return { changed_rows: lines.length + asArray(action.payload && action.payload.payment_history_ids).length };
  }
  throw new Error('Unsupported action type: ' + action.type);
}

function originalActionByCode(q, code) {
  return asArray(q && q.actions).find((a) => normalizeCode(a && a.code) === normalizeCode(code));
}

function hasCompletedUndo(q, action) {
  return asArray(q && q.actions).some((a) =>
    a &&
    a.status === 'done' &&
    String(a.type || '').startsWith('undo_') &&
    String(a.payload && a.payload.original_action_id || '') === String(action && action.id || '')
  );
}

async function prepareUndoAction(args) {
  CURRENT_ACTOR = activeActorFromArgs(args || {});
  if (!actorCan(CURRENT_ACTOR, 'can_prepare_write')) return permissionDenied('can_prepare_write');
  const code = normalizeCode((args && args.code) || (args && args.request) || (args && args.message));
  if (!code) throw new Error('code is required');
  const q = loadActionQueue();
  const original = originalActionByCode(q, code);
  if (!original) {
    return { answer: 'Không tìm thấy action ' + code + ' để hoàn tác.', changed_data: false, status: 'not_found' };
  }
  if (original.status !== 'done') {
    return { answer: 'Chỉ hoàn tác được action đã thực hiện thành công. Mã ' + code + ' hiện đang ở trạng thái ' + original.status + '.', changed_data: false, status: 'not_done' };
  }
  if (String(original.type || '').startsWith('undo_')) {
    return { answer: 'Mã ' + code + ' đã là một action hoàn tác, không tạo hoàn tác lồng nhau.', changed_data: false, status: 'not_supported' };
  }
  if (hasCompletedUndo(q, original)) {
    return { answer: 'Action ' + code + ' đã từng được hoàn tác thành công rồi, nên em không tạo undo lần nữa.', changed_data: false, status: 'already_undone' };
  }

  let undoType = '';
  let payload = { original_code: original.code, original_action_id: original.id, original_type: original.type };
  let preview = '';

  if (original.type === 'cash_tuition_payment') {
    const lines = asArray(original.payload && original.payload.lines);
    const paymentIds = asArray(original.result && original.result.payment_history_ids);
    if (!lines.length) {
      return { answer: 'Action ' + code + ' khong co du thong tin thu tien mat de hoan tac an toan.', changed_data: false, status: 'missing_before_state' };
    }
    const action = createPendingAction(
      'undo_cash_tuition_payment',
      String((args && (args.request || args.message)) || 'Hoan tac ' + code),
      lineJoin([
        'Em da tao ban nhap hoan tac thu hoc phi tien mat tu ma ' + code + '.',
        'Hoc vien: ' + (original.payload.student_name || ''),
        'Se khoi phuc so buoi da thu va tien tra truoc ve trang thai truoc action.',
        'Se xoa ' + paymentIds.length + ' dong lich su thanh toan do action nay tao.',
        'Tong tien action cu: ' + formatVnd(original.payload.amount_vnd || 0)
      ]),
      {
        original_code: original.code,
        original_action_id: original.id,
        original_type: original.type,
        student_id: original.payload.student_id,
        student_name: original.payload.student_name || '',
        amount_vnd: original.payload.amount_vnd || 0,
        lines,
        payment_history_ids: paymentIds
      }
    );
    return { answer: pendingActionAnswer(action), action, requires_confirmation: true, changed_data: false };
  }

  if (original.type === 'attendance_upsert') {
    const beforeRows = asArray(original.payload && original.payload.before_records);
    const originalRows = asArray(original.payload && original.payload.records);
    if (!beforeRows.length && originalRows.length) {
      return {
        answer: 'Action ' + code + ' được tạo trước khi hệ thống lưu trạng thái cũ, nên không thể hoàn tác tự động an toàn. Thầy/cô hãy tạo action sửa/xóa điểm danh mới.',
        changed_data: false,
        status: 'missing_before_state'
      };
    }
    const restoreRecords = [];
    const deleteRecords = [];
    beforeRows.forEach((entry, idx) => {
      if (entry && entry.before) {
        restoreRecords.push(entry.before);
      } else {
        const r = originalRows[idx] || {};
        if (r.student_id && r.date) deleteRecords.push({ student_id: r.student_id, student_name: r.student_name || '', date: r.date, class_name: r.class_name || '' });
      }
    });
    undoType = 'undo_attendance_upsert';
    payload = Object.assign(payload, { restore_records: restoreRecords, delete_records: deleteRecords });
    preview = lineJoin([
      'Em đã tạo bản nháp hoàn tác điểm danh từ mã ' + code + '.',
      restoreRecords.length ? 'Sẽ khôi phục trạng thái cũ cho ' + restoreRecords.length + ' dòng.' : '',
      deleteRecords.length ? 'Sẽ xóa ' + deleteRecords.length + ' dòng đã được tạo mới bởi action cũ.' : '',
      'Tổng dòng ảnh hưởng: ' + (restoreRecords.length + deleteRecords.length)
    ]);
  } else if (original.type === 'attendance_delete') {
    const restoreRecords = asArray(original.payload && original.payload.records)
      .map((r) => ({
        student_id: r.student_id,
        student_name: r.student_name || '',
        date: r.date,
        status: r.old_status || r.status_before || '',
        class_name: r.class_name || ''
      }))
      .filter((r) => r.student_id && r.date && (r.status === 'present' || r.status === 'absent'));
    if (!restoreRecords.length) {
      return {
        answer: 'Action ' + code + ' không có đủ trạng thái điểm danh cũ để khôi phục an toàn.',
        changed_data: false,
        status: 'missing_before_state'
      };
    }
    undoType = 'undo_attendance_delete';
    payload = Object.assign(payload, { restore_records: restoreRecords });
    preview = lineJoin([
      'Em đã tạo bản nháp khôi phục điểm danh đã xóa từ mã ' + code + '.',
      'Số dòng sẽ khôi phục: ' + restoreRecords.length,
      restoreRecords.slice(0, 25).map((r) => attendanceStatusIcon(r.status) + ' ' + (r.student_name || r.student_id) + ': ' + attendanceStatusLabel(r.status)).join('\n')
    ]);
  } else if (original.type === 'student_note_update') {
    undoType = 'undo_student_note_update';
    payload = Object.assign(payload, {
      student_id: original.payload.student_id,
      student_name: original.payload.student_name || '',
      old_note: original.payload.old_note || '',
      current_note_from_action: original.payload.new_note || ''
    });
    preview = lineJoin([
      'Em đã tạo bản nháp hoàn tác ghi chú học viên từ mã ' + code + '.',
      'Học viên: ' + (original.payload.student_name || ''),
      'Sẽ khôi phục ghi chú về: ' + (original.payload.old_note || '(trống)')
    ]);
  } else if (original.type === 'lead_update') {
    undoType = 'undo_lead_update';
    payload = Object.assign(payload, {
      lead_id: original.payload.lead_id,
      lead_name: original.payload.lead_name || '',
      parent_phone: original.payload.parent_phone || '',
      old_status: original.payload.old_status || 'new',
      old_admin_note: Object.prototype.hasOwnProperty.call(original.payload, 'old_admin_note') ? original.payload.old_admin_note : ''
    });
    preview = lineJoin([
      'Em đã tạo bản nháp hoàn tác lead từ mã ' + code + '.',
      'Lead: ' + (original.payload.lead_name || 'Không rõ') + (original.payload.parent_phone ? ' · ' + original.payload.parent_phone : ''),
      'Sẽ khôi phục trạng thái về: ' + (original.payload.old_status || 'new')
    ]);
  } else {
    return { answer: 'Action loại ' + original.type + ' chưa hỗ trợ hoàn tác tự động.', changed_data: false, status: 'not_supported' };
  }

  const action = createPendingAction(undoType, String((args && (args.request || args.message)) || 'Hoàn tác ' + code), preview, payload);
  return { answer: pendingActionAnswer(action), action, requires_confirmation: true, changed_data: false };
}

async function confirmAction(args) {
  CURRENT_ACTOR = activeActorFromArgs(args || {});
  if (!actorCan(CURRENT_ACTOR, 'can_confirm_write')) return permissionDenied('can_confirm_write');
  const code = normalizeCode((args && args.code) || (args && args.confirmation_code) || (args && args.message));
  if (!code) throw new Error('code is required');
  const confirmationText = String((args && (args.message || args.original_message || args.confirmation_text)) || '').trim();
  if (!(args && args.internal_confirmed) && !isExactConfirmMessage(confirmationText)) {
    return {
      answer: 'Chưa thực hiện. Để xác nhận thao tác, thầy/cô gửi đúng mã 6 số: ' + code.replace(/^MVK-/, '') + '. Tin nhắn khác như số thứ tự, ok, hoặc được sẽ không được tính là xác nhận.',
      changed_data: false,
      status: 'confirmation_required',
      requires_exact_confirmation: true
    };
  }
  const q = loadActionQueue();
  const idx = q.actions.findIndex((a) => normalizeCode(a && a.code) === code);
  if (idx < 0) {
    return { answer: 'Không tìm thấy mã xác nhận ' + code + '. Mã có thể đã bị hủy, đã dùng hoặc nhập sai.', changed_data: false, status: 'not_found' };
  }
  const action = q.actions[idx];
  if (action.status !== 'pending') {
    return { answer: 'Mã ' + code + ' không còn hiệu lực vì trạng thái hiện tại là ' + action.status + '.', changed_data: false, status: action.status };
  }
  if (Date.now() > new Date(action.expires_at).getTime()) {
    action.status = 'expired';
    action.expired_at = new Date().toISOString();
    q.actions[idx] = action;
    saveActionQueue(q);
    appendActionAudit('expired', action);
    return { answer: 'Mã ' + code + ' đã hết hạn. Thầy/cô tạo lại yêu cầu nếu vẫn muốn thực hiện.', changed_data: false, status: 'expired' };
  }
  try {
    const result = await executePreparedAction(action);
    action.status = 'done';
    action.confirmed_at = new Date().toISOString();
    action.result = result;
    q.actions[idx] = action;
    saveActionQueue(q);
    appendActionAudit('confirmed', action, result);
    return {
      answer: 'Đã xác nhận và thực hiện thành công ' + code + '. Số dòng thay đổi: ' + Number(result.changed_rows || 0) + '.',
      changed_data: true,
      status: 'done',
      action_type: action.type,
      result
    };
  } catch (err) {
    action.status = 'failed';
    action.failed_at = new Date().toISOString();
    action.error = String((err && err.message) || err);
    q.actions[idx] = action;
    saveActionQueue(q);
    appendActionAudit('failed', action, { error: action.error });
    return { answer: 'Không thực hiện được mã ' + code + ': ' + action.error, changed_data: false, status: 'failed' };
  }
}

async function cancelAction(args) {
  CURRENT_ACTOR = activeActorFromArgs(args || {});
  const code = normalizeCode((args && args.code) || (args && args.message));
  if (!code) throw new Error('code is required');
  const cancelText = String((args && (args.message || args.original_message || args.cancel_text)) || '').trim();
  if (!(args && args.internal_confirmed) && cancelText && !isExactCancelMessage(cancelText)) {
    return { answer: 'Chưa hủy. Để hủy yêu cầu, thầy/cô gửi đúng: HỦY ' + code + '.', changed_data: false, status: 'cancel_phrase_required' };
  }
  const q = loadActionQueue();
  const idx = q.actions.findIndex((a) => normalizeCode(a && a.code) === code);
  if (idx < 0) return { answer: 'Không tìm thấy mã ' + code + ' để hủy.', changed_data: false, status: 'not_found' };
  const action = q.actions[idx];
  if (action.status !== 'pending') return { answer: 'Mã ' + code + ' không hủy được vì trạng thái hiện tại là ' + action.status + '.', changed_data: false, status: action.status };
  action.status = 'cancelled';
  action.cancelled_at = new Date().toISOString();
  q.actions[idx] = action;
  saveActionQueue(q);
  appendActionAudit('cancelled', action);
  return { answer: 'Đã hủy yêu cầu ' + code + '.', changed_data: false, status: 'cancelled' };
}

async function listPendingActions(args) {
  CURRENT_ACTOR = activeActorFromArgs(args || {});
  const limit = Math.min(50, Math.max(1, Number((args && args.limit) || 20)));
  const q = loadActionQueue();
  const now = Date.now();
  const pending = q.actions
    .filter((a) => a && a.status === 'pending')
    .map((a) => Object.assign({}, a, { expired: now > new Date(a.expires_at).getTime() }))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, limit);
  return {
    answer: pending.length
      ? 'Có ' + pending.length + ' yêu cầu đang chờ xác nhận:\n' + pending.map((a) => '- ' + a.code + ' · ' + a.type + ' · hết hạn ' + a.expires_at).join('\n')
      : 'Không có yêu cầu nào đang chờ xác nhận.',
    pending_count: pending.length,
    actions: pending,
    changed_data: false
  };
}

function readAuditJsonl() {
  const file = actionAuditFile();
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function actionStatusLabel(status) {
  const s = String(status || '').trim();
  if (s === 'done') return 'thành công';
  if (s === 'pending') return 'đang chờ xác nhận';
  if (s === 'cancelled') return 'đã hủy';
  if (s === 'failed') return 'thất bại';
  if (s === 'expired') return 'hết hạn';
  return s || 'không rõ';
}

function actionTypeLabel(type) {
  const t = String(type || '');
  if (t.includes('attendance')) return t.includes('delete') ? 'xóa điểm danh' : 'điểm danh';
  if (t === 'student_note_update') return 'ghi chú học viên';
  if (t === 'lead_update') return 'lead tư vấn';
  if (t === 'cash_tuition_payment') return 'thu tiền mặt';
  if (t.startsWith('undo_')) return 'hoàn tác';
  return t || 'thao tác';
}

function auditDateFromQuestion(text) {
  const raw = String(text || '');
  const n = norm(text);
  if (/(hom qua|hôm qua)/i.test(raw) || /hom qua/.test(n)) return addDaysYmd(vnDate(), -1);
  if (/(hom nay|hôm nay)/i.test(raw) || /hom nay/.test(n)) return vnDate();
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(raw) || /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/.test(raw)) return dateFromQuestion(raw);
  return '';
}

function actionToAuditRow(action) {
  const actor = action.actor || {};
  return {
    ts: action.confirmed_at || action.cancelled_at || action.failed_at || action.expired_at || action.created_at || '',
    event: action.status === 'done' ? 'confirmed' : action.status || 'queued',
    action_id: action.id,
    code: action.code,
    type: action.type,
    status: action.status,
    actor_id: actor.actor_id || '',
    actor_name: actor.actor_name || '',
    actor_role: actor.actor_role || '',
    actor_source: actor.actor_source || '',
    summary: actionAuditSummary(action),
    extra: action.result || null,
    from_queue: true
  };
}

function mergedAuditRows() {
  const rows = readAuditJsonl();
  const q = loadActionQueue();
  const seen = new Set(rows.map((r) => [r.event, r.action_id, r.code, r.status].join('|')));
  asArray(q.actions).forEach((a) => {
    const r = actionToAuditRow(a);
    const key = [r.event, r.action_id, r.code, r.status].join('|');
    if (!seen.has(key)) rows.push(r);
  });
  return rows;
}

function auditRowSearchText(row) {
  const s = row.summary || {};
  return norm([
    row.event,
    row.code,
    row.type,
    row.status,
    row.actor_name,
    s.requested_text,
    s.student_name,
    s.class_name,
    s.lead_name,
    s.date,
    s.amount_vnd
  ].join(' '));
}

async function listAuditLog(args) {
  return withActor(args, async (actor) => {
    if (!actorCan(actor, 'can_view_audit')) return permissionDenied('can_view_audit');
    const query = String((args && (args.query || args.question || args.message)) || '').trim();
    const code = normalizeCode((args && args.code) || query);
    const limit = Math.min(100, Math.max(1, Number((args && args.limit) || 20)));
    const typeFilter = norm(args && args.action_type);
    const statusFilter = norm(args && args.status);
    const classFilter = norm(args && args.class_name);
    const studentFilter = norm(args && args.student_query);
    const dateFrom = String((args && args.date_from) || (query ? auditDateFromQuestion(query) : '') || '').slice(0, 10);
    const dateTo = String((args && args.date_to) || dateFrom || '').slice(0, 10);
    const qn = norm(query);
    let rows = mergedAuditRows();
    if (code) rows = rows.filter((r) => normalizeCode(r.code) === code);
    if (dateFrom) rows = rows.filter((r) => String(r.ts || '').slice(0, 10) >= dateFrom);
    if (dateTo) rows = rows.filter((r) => String(r.ts || '').slice(0, 10) <= dateTo);
    if (typeFilter) rows = rows.filter((r) => norm(r.type).includes(typeFilter) || norm(actionTypeLabel(r.type)).includes(typeFilter));
    if (statusFilter) rows = rows.filter((r) => norm(r.status).includes(statusFilter) || norm(r.event).includes(statusFilter));
    if (classFilter) rows = rows.filter((r) => norm(((r.summary || {}).class_name || '')).includes(classFilter));
    if (studentFilter) rows = rows.filter((r) => norm(((r.summary || {}).student_name || '')).includes(studentFilter));
    if (qn && !code) {
      const terms = qn.split(/\s+/).filter((t) => t.length >= 3 && !/(lich|su|thao|tac|audit|hom|nay|qua|xem|ai|da|sua|ma|mvk|trong|ngay)/.test(t));
      if (terms.length) rows = rows.filter((r) => terms.some((t) => auditRowSearchText(r).includes(t)));
    }
    rows = rows.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || ''))).slice(0, limit);
    const lines = rows.map((r) => {
      const s = r.summary || {};
      const actorName = r.actor_name || 'Không rõ người thực hiện';
      const detail = [
        s.student_name ? 'học viên ' + s.student_name : '',
        s.class_name ? 'lớp ' + cleanClassName(s.class_name) : '',
        s.date ? 'ngày ' + s.date : '',
        s.amount_vnd ? formatVnd(s.amount_vnd) : ''
      ].filter(Boolean).join(' · ');
      return '- ' + (r.code || '(không mã)') + ' · ' + String(r.ts || '').replace('T', ' ').slice(0, 16) + ' · ' + actionTypeLabel(r.type) + ' · ' + actionStatusLabel(r.status || r.event) + '\n  Người thực hiện: ' + actorName + '\n  Nội dung: ' + (s.requested_text || '(log cũ chưa có đủ chi tiết)') + (detail ? '\n  Ảnh hưởng: ' + detail : '');
    });
    return {
      answer: rows.length ? 'Lịch sử thao tác:\n' + lines.join('\n') : 'Không tìm thấy lịch sử thao tác phù hợp. Lưu ý: log cũ có thể thiếu metadata để lọc chi tiết.',
      count: rows.length,
      actions: rows,
      changed_data: false
    };
  });
}

function staleLeadRows(snapshot, date) {
  const cutoff = new Date(date + 'T00:00:00+07:00').getTime() - 2 * 24 * 60 * 60 * 1000;
  return asArray(snapshot.leads)
    .filter((l) => /^(new|contacted)?$/.test(String(l.status || 'new')) || /^(new|contacted)$/.test(String(l.status || 'new')))
    .filter((l) => {
      const t = new Date(String(l.created_at || l.updated_at || '')).getTime();
      return Number.isFinite(t) && t <= cutoff;
    })
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .slice(0, 10)
    .map((l) => ({
      id: l.id,
      student_name: l.student_name || '',
      parent_phone: l.parent_phone || '',
      status: l.status || 'new',
      created_at: l.created_at || ''
    }));
}

async function opsDailyDigest(args) {
  return withActor(args, async (actor) => {
    if (!actorCan(actor, 'can_receive_daily_digest')) return permissionDenied('can_receive_daily_digest');
    const snapshot = await loadSnapshot();
    const date = String((args && args.date) || vnDate()).slice(0, 10);
    const yesterday = addDaysYmd(date, -1);
    const todayClasses = scheduledClassesForDate(snapshot.classDefs, date);
    const yesterdayClasses = scheduledClassesForDate(snapshot.classDefs, yesterday);
    const yesterdayMarked = new Set(asArray(snapshot.attendance).filter((a) => String(a.date || '').slice(0, 10) === yesterday).map((a) => norm(a.class_name)).filter(Boolean));
    const yesterdayUnmarked = yesterdayClasses.filter((c) => !yesterdayMarked.has(norm(c.class_name)) && !yesterdayMarked.has(norm(c.display_name)));
    const debts = computeDebts(snapshot).slice(0, 8);
    const absence = absenceRiskRows(snapshot).slice(0, 8);
    const leads = staleLeadRows(snapshot, date);
    const bank = bankReviewRows(snapshot, 'needs_review,pending', 8);
    const pending = (await listPendingActions({ limit: 8 })).actions || [];
    const lines = ['Báo cáo vận hành MV-Klass ' + date];
    lines.push('');
    lines.push('Lịch hôm nay: ' + (todayClasses.length ? todayClasses.map((c) => cleanClassName(c.display_name || c.class_name) + (timesForDate(c.schedule, date) ? ' (' + timesForDate(c.schedule, date) + ')' : '')).join('; ') : 'không có lớp'));
    if (yesterdayUnmarked.length) lines.push('Lớp hôm qua chưa điểm danh: ' + yesterdayUnmarked.map((c) => cleanClassName(c.display_name || c.class_name)).join('; '));
    if (absence.length) lines.push('Cảnh báo nghỉ học: ' + absence.map((r) => r.name + ' (' + (r.current_absent_streak >= 3 ? r.current_absent_streak + ' vắng liên tiếp' : r.recent_absent_count + '/' + r.recent_checked_count + ' vắng gần đây') + ')').join('; '));
    if (debts.length) lines.push('Nợ học phí cần chú ý: ' + debts.slice(0, 5).map((d) => d.name + ' ' + d.sessions_due + ' buổi / ' + formatVnd(d.amount_due_vnd)).join('; '));
    if (leads.length) lines.push('Lead quá 2 ngày chưa xử lý: ' + leads.map((l) => (l.student_name || 'Không tên') + (l.parent_phone ? ' ' + l.parent_phone : '') + ' · ' + l.status).join('; '));
    if (bank.length) lines.push('Giao dịch ngân hàng cần kiểm tra: ' + bank.length + ' giao dịch.');
    if (pending.length) lines.push('Action chờ xác nhận: ' + pending.map((a) => a.code + ' · ' + actionTypeLabel(a.type)).join('; '));
    if (lines.length <= 3) lines.push('Sáng nay chưa có việc tồn đọng quan trọng.');
    return {
      answer: lines.join('\n'),
      date,
      classes_today_count: todayClasses.length,
      unmarked_yesterday_count: yesterdayUnmarked.length,
      absence_risk_count: absence.length,
      debt_count: debts.length,
      stale_lead_count: leads.length,
      bank_needs_review_count: bank.length,
      pending_action_count: pending.length,
      changed_data: false
    };
  });
}

async function studentAnswer(snapshot, question) {
  const cleaned = String(question || '')
    .replace(/^(tra cuu|tìm|tim|thong tin|hồ sơ|ho so|chi tiet|chi tiết|học viên|hoc vien|học sinh|hoc sinh)\s+/i, '')
    .trim();
  const lookup = await studentLookup({ query: cleaned || question });
  if (lookup.match_status === 'not_found') {
    return { answer: 'Chưa tìm thấy học viên khớp "' + (cleaned || question) + '". Thầy/cô gửi thêm SĐT hoặc tên đầy đủ giúp em.', intent: 'student_lookup', match_status: 'not_found' };
  }
  if (lookup.match_status === 'ambiguous') {
    return {
      answer: 'Em thấy nhiều học viên có thể khớp. Thầy/cô xác nhận thêm lớp hoặc SĐT:\n' + lookup.students.map((s) => '- ' + s.name + (s.class_names.length ? ' · ' + s.class_names.map(cleanClassName).join(', ') : '') + (s.phone ? ' · ' + s.phone : '')).join('\n'),
      intent: 'student_lookup',
      match_status: 'ambiguous',
      students: lookup.students
    };
  }
  const s = lookup.students[0];
  const debt = s.debt || {};
  const lines = [
    s.name + (s.class_names.length ? ' · lớp ' + s.class_names.map(cleanClassName).join(', ') : ''),
    s.phone ? 'SĐT: ' + s.phone : '',
    s.birth_year ? 'Năm sinh: ' + s.birth_year : '',
    s.learning_note ? 'Ghi chú học tập: ' + s.learning_note : '',
    debt.sessions_due ? 'Học phí còn nợ: ' + debt.sessions_due + ' buổi' + (debt.amount_due_vnd ? ' - ' + formatVnd(debt.amount_due_vnd) : '') : 'Chưa thấy nợ học phí.',
    s.recent_attendance && s.recent_attendance.length ? 'Điểm danh gần đây: ' + s.recent_attendance.slice(0, 5).map((a) => String(a.date).slice(0, 10) + ' ' + normalizeAttendanceStatus(a.status) + (a.class_name ? ' (' + cleanClassName(a.class_name) + ')' : '')).join('; ') : ''
  ];
  return { answer: lineJoin(lines), intent: 'student_lookup', match_status: 'single', student: s };
}

async function opsQuery(args) {
  CURRENT_ACTOR = activeActorFromArgs(args || {});
  const question = String((args && (args.question || args.query || args.message)) || '').trim();
  const n = norm(question);
  const confirmCode = extractConfirmCode(question);
  if (confirmCode && isExactConfirmMessage(question)) return confirmAction(Object.assign({}, args || {}, { code: confirmCode, message: question, internal_confirmed: true }));
  const cancelCode = extractCancelCode(question);
  if (cancelCode) return cancelAction(Object.assign({}, args || {}, { code: cancelCode, message: question, internal_confirmed: isExactCancelMessage(question) }));
  const undoCode = extractUndoCode(question);
  if (undoCode) return prepareUndoAction(Object.assign({}, args || {}, { code: undoCode, request: question }));
  if (/(lich su thao tac|audit|ai da sua|ai sua|ai da ghi nhan|ai ghi nhan|toi da thuc hien|da thuc hien nhung thao tac|ma mvk|mvk \d|mvk-\d|da lam gi)/.test(n)) return listAuditLog(Object.assign({}, args || {}, { query: question }));
  if (/(viec can lam|bao cao sang|tong ket sang|bao cao hang ngay|daily digest|bao cao ngay|hom nay can lam gi)/.test(n)) return opsDailyDigest(Object.assign({}, args || {}, { date: dateFromQuestion(question) }));
  if (isWriteIntentQuestion(question)) return prepareAction(Object.assign({}, args || {}, { request: question }));
  const snapshot = await loadSnapshot();
  if (!question || /(ban lam duoc gi|ho tro gi|giup duoc gi|chuc nang|help|faq|cau hoi thuong gap|hoi duoc gi|hoi gi duoc|menu|huong dan|danh sach cau hoi|mau cau hoi)/.test(n)) return faqCatalogAnswer();
  if (/(chua co|thieu|khong co).*(sdt|so dien thoai|phone)|((sdt|so dien thoai|phone).*(chua co|thieu|khong co))/.test(n)) return missingPhoneAnswer(snapshot, question);
  if (/(sdt|so dien thoai|phone|phu huynh|ba me|bo me|lien he).*(hoc sinh|hoc vien|cua|ten)|((hoc sinh|hoc vien).*(sdt|so dien thoai|phu huynh|lien he))/.test(n)) return studentContactAnswer(snapshot, question);
  if (/(can nhac phi|nen nhac phi|nhac phi cho ai|can thu phi|can thu hoc phi)/.test(n)) return tuitionReminderListAnswer(snapshot);
  if (/(soan|nhac phi|nhac hoc phi|zalo|phu huynh)/.test(n)) {
    const name = question.replace(/^(soan|soạn|nhac|nhắc|nhac phi|nhắc phí|nhac hoc phi|nhắc học phí|cho|cho phu huynh|phụ huynh)\s+/i, '').trim();
    const draft = await draftParentTuitionMessage({ query: name || question });
    if (draft.match_status !== 'single') {
      return {
        answer: 'Em chưa xác định duy nhất học viên để soạn nháp. Thầy/cô gửi thêm lớp hoặc SĐT.',
        intent: 'tuition_reminder',
        draft
      };
    }
    return {
      answer: 'Bản nháp, chưa gửi cho phụ huynh:\n' + draft.draft_message + (draft.zalo_link ? '\nZalo: ' + draft.zalo_link : ''),
      intent: 'tuition_reminder',
      draft
    };
  }
  if (/(dang cho xac nhan|cho xac nhan|cho duyet|pending action|action nao|ma nao dang cho|can xac nhan)/.test(n)) return listPendingActions(Object.assign({}, args || {}, { limit: 20 }));
  if (/chua diem danh/.test(n) && /(lop|ca|hom nay|hom qua|ngay|tuan)/.test(n)) return unmarkedAttendanceAnswer(snapshot, question);
  if (/(tuan|7 ngay|bay ngay|\d+\s*ngay)/.test(n) && /(lich|lich day|day|lop|ca hoc)/.test(n) && !/(doanh thu|revenue|hoc phi|con no|no hoc phi)/.test(n)) return weeklyScheduleAnswer(snapshot, question);
  if (/(canh bao|rui ro|nguy co|nghi hoc|bo hoc|vang lien tiep|sap vao lop|truoc 30|truoc 10|chua diem danh|tre diem danh|nhac vao lop)/.test(n)) return opsAlerts({ kind: 'all' }, snapshot);
  if (/(vang nhieu|nghi nhieu|ai vang|ai nghi).*(tuan|thang|gan day|nhieu nhat)|((tuan|thang|gan day).*(ai vang|vang nhieu|nghi nhieu))/.test(n)) return absenceRankAnswer(snapshot, question);
  if (/(lau roi chua di hoc|lâu rồi chưa đi học|qua lau chua di hoc|khong thay di hoc|khong di hoc lau|mat tich)/i.test(question) || /(lau roi chua di hoc|qua lau chua di hoc|khong thay di hoc|khong di hoc lau|mat tich)/.test(n)) return staleStudentsAnswer(snapshot, question);
  if (/(lich su|gan day|bao nhieu buoi|may buoi).*(diem danh|vang|co mat|di hoc|nghi)|((diem danh|vang|co mat|di hoc|nghi).*(gan day|lich su|bao nhieu buoi|may buoi))/.test(n) && !/(lop|mvk|kem)/.test(n)) return studentRecentAttendanceAnswer(snapshot, question);
  if (/(lop nao).*(dong hoc sinh|si so cao|nhieu hoc sinh nhat|dong nhat)/.test(n)) return classSizeRankAnswer(snapshot);
  if (/(lop nao).*(no nhieu|no cao|nhieu hoc sinh no|dang no nhieu)|((no nhieu nhat|dang no nhieu).*(lop nao|lop))/.test(n)) return classDebtRankAnswer(snapshot);
  if (/(si so|danh sach hoc sinh|danh sach hoc vien|hoc sinh lop|hoc vien lop|lop .*co bao nhieu|bao nhieu hoc sinh|bao nhieu hoc vien)/.test(n)) return classRosterAnswer(snapshot, question);
  if (/(hoc phi|phi hoc|gia|bao nhieu tien|moi buoi|1 buoi).*(lop|mvk|kem)|((lop|mvk|kem).*(hoc phi|phi hoc|moi buoi|1 buoi))/.test(n)) return classFeeAnswer(snapshot, question);
  if (/(ai vang nhieu nhat|vang nhieu nhat|nghi nhieu nhat).*(lop|mvk|kem)|((lop|mvk|kem).*(ai vang nhieu|vang nhieu nhat|nghi nhieu nhat))/.test(n)) return absenceRankAnswer(snapshot, question);
  if (/(cong no|con no|no hoc phi|chua dong|no nhieu|no cao).*(lop|mvk|kem)|((lop|mvk|kem).*(cong no|con no|no hoc phi|chua dong))/.test(n)) return classDebtAnswer(snapshot, question);
  if (/(lop nao).*(doanh thu cao|tao doanh thu|thu cao nhat)|((doanh thu cao nhat|tao doanh thu cao).*(lop nao|lop))/.test(n)) return topRevenueClassAnswer(snapshot, question);
  if (/(doanh thu|revenue).*(lop|mvk|kem)|((lop|mvk|kem).*(doanh thu|revenue))/.test(n)) {
    if (/(tuan|thang|7 ngay|bay ngay)/.test(n)) return classRevenueRangeAnswer(snapshot, question);
    return classRevenueAnswer(snapshot, question);
  }
  if (/(doanh thu).*(diem danh).*(thuc thu|da thu|chenh)|((thuc thu|da thu).*(diem danh).*(chenh|khac))/.test(n)) return revenueCompareAnswer(snapshot, question);
  if (/(doanh thu|revenue).*(tuan|thang|7 ngay|bay ngay)|((tuan|thang).*(doanh thu|revenue))/.test(n)) return revenueRangeAnswer(snapshot, question);
  if (/(hom nay|hom qua|tuan nay|thang nay).*(bao nhieu luot hoc|luot hoc)|((bao nhieu luot hoc|luot hoc).*(hom nay|hom qua|tuan|thang))/.test(n)) return revenueRangeAnswer(snapshot, question);
  if (/(dong gan nhat|nop gan nhat|tra gan nhat|lan cuoi).*(khi nao|bao gio|hoc phi|dong|nop|tra)|((khi nao|bao gio).*(dong gan nhat|nop gan nhat|hoc phi))/.test(n)) return studentLastPaymentAnswer(snapshot, question);
  if (/(hoc nhieu buoi|hoc nhieu).*(chua dong|chua nop|chua tra)|((chua dong|chua nop|chua tra).*(hoc nhieu buoi|hoc nhieu))/.test(n)) return manySessionsNoPaymentAnswer(snapshot);
  if (/(tong tien).*(con phai thu|can thu|chua thu)|((con phai thu|can thu|phai thu).*(tong tien|bao nhieu))/.test(n)) return totalReceivableAnswer(snapshot);
  if (/(dong du|nop du|tra du|prepaid|so du hoc phi|du tien)/.test(n)) return prepaidBalanceAnswer(snapshot);
  if (/(lich su|da dong|da nop|da thu|thu tien mat|payment|thanh toan).*(hoc phi|tien|cash|dong|nop|thu)/.test(n)) return paymentHistoryAnswer(snapshot, question);
  if (/(cong no|con no|no hoc phi|hoc phi.*no|no bao nhieu|con no bao nhieu|chua dong bao nhieu|no may buoi|con may buoi)/.test(n) && !/(ai|danh sach|top|nhieu nhat|cao nhat|tat ca)/.test(n)) return studentDebtAnswer(snapshot, question);
  if (/(diem danh|vang|co mat|attendance|present|absent)/.test(n) && /(lop|mvk|kem)/.test(n)) return classAttendanceAnswer(snapshot, question);
  if (/(tong diem danh|thong ke diem danh|bao nhieu vang|bao nhieu co mat|ti le vang|ty le vang)/.test(n)) return attendanceStatsAnswer(snapshot, question);
  if (/(lead).*(qua han|qua 2 ngay|chua lien he|can follow|follow up|can goi)|((qua han|qua 2 ngay|chua lien he).*(lead|tu van))/.test(n)) return leadFollowupAnswer(snapshot, question);
  if (/(lead).*(da lien he|contacted).*(chua chot|chua dong|chua closed)|((da lien he|contacted).*(lead).*(chua chot|chua dong))/.test(n)) return leadContactedNotClosedAnswer(snapshot);
  if (/(lead moi|lead).*(hom nay|hom qua|tuan nay|thang nay)|((hom nay|hom qua|tuan nay|thang nay).*(lead moi|lead))/.test(n)) return leadNewByDateAnswer(snapshot, question);
  if (/(nguon lead|source lead|kenh lead).*(hieu qua|tot nhat|nhieu nhat)|((hieu qua nhat|tot nhat).*(nguon lead|kenh lead))/.test(n)) return leadSourceAnswer(snapshot);
  if (/(lead nao can goi|lead can goi|can goi lai|goi lai)/.test(n)) return leadFollowupAnswer(snapshot, question);
  if (/(tong tien chuyen khoan|tong chuyen khoan|chuyen khoan hom nay|bank transfer|tien ngan hang)/.test(n)) return bankTransferSummaryAnswer(snapshot, question);
  if (/(so tien la|tien la|giao dich la|bat thuong|khong match|khong khop).*(giao dich|ngan hang|bank|chuyen khoan)|((giao dich|ngan hang|bank).*(so tien la|bat thuong|khong match|khong khop))/.test(n)) return weirdBankAmountAnswer(snapshot);
  if (/(giao dich gan nhat|chuyen khoan gan nhat|ngan hang gan nhat|bank gan nhat)/.test(n)) return latestBankTransactionAnswer(snapshot);
  if (/(tong quan ngan hang|ngan hang hom nay|bank hom nay|bao nhieu giao dich|tong giao dich)/.test(n)) return bankSummaryAnswer(snapshot, question);
  if (/(lich|lich day|lop nao|co lop|ca hoc|hom nay.*lop|ngay mai.*lop|thu\s*[2-7]|t[2-7])/.test(n)) return classScheduleAnswer(snapshot, question);
  if (/(diem danh|vang|co mat|di hoc|attendance|present|absent)/.test(n)) return attendanceAnswer(snapshot, question);
  if (/(doanh thu|revenue|thu hoc phi|thu tien)/.test(n)) return revenueAnswer(snapshot, question);
  if (/(cong no|con no|no hoc phi|chua dong|no buoi|hoc phi.*no|no nhieu|no cao)/.test(n)) return debtAnswer(snapshot, question);
  if (/(giao dich|chuyen khoan|doi soat|ngan hang|bank|pending|needs_review)/.test(n)) return bankAnswer(snapshot, question);
  if (/(lead|tu van|phu huynh moi)/.test(n)) return leadAnswer(snapshot);
  if (likelyStudentQuery(question)) return studentAnswer(snapshot, question);
  const overview = await todayOverview({ date: dateFromQuestion(question) });
  return {
    answer: overview.answer + '\n\nNếu thầy/cô cần, em có thể xem thêm học viên nợ phí, điểm danh, doanh thu, giao dịch ngân hàng hoặc lead tư vấn.',
    intent: 'general',
    overview
  };
}

async function draftParentTuitionMessage(args) {
  const lookup = await studentLookup({ query: args && args.query, class_name: args && args.class_name });
  if (lookup.match_status !== 'single') {
    return {
      match_status: lookup.match_status,
      students: lookup.students.map((s) => ({ name: s.name, class_names: s.class_names, phone: s.phone })),
      requires_clarification: true,
      note: 'Chua gui cho phu huynh. Can xac dinh dung hoc vien truoc khi soan nhap.'
    };
  }
  const s = lookup.students[0];
  const debt = s.debt || { sessions_due: 0, amount_due_vnd: 0, class_name: s.class_name };
  const amountText = debt.amount_due_vnd > 0 ? ' tương ứng ' + formatVnd(debt.amount_due_vnd) : '';
  const message =
    'Phụ huynh cho thầy Vũ nhắc nhẹ: em ' +
    s.name +
    (debt.class_name ? ' lớp ' + debt.class_name : '') +
    ' hiện còn ' +
    Number(debt.sessions_due || 0) +
    ' buổi học phí chưa thanh toán' +
    amountText +
    '. Phụ huynh kiểm tra và hỗ trợ thanh toán giúp thầy nhé.';
  const phone = digits(s.phone);
  return {
    match_status: 'single',
    name: s.name,
    phone: s.phone || '',
    zalo_link: phone ? 'https://zalo.me/' + phone : '',
    debt,
    draft_message: message,
    requires_confirmation: true,
    sent: false,
    note: 'Chua gui cho phu huynh. Day chi la ban nhap de admin duyet/copy.'
  };
}

function formatVnd(n) {
  return new Intl.NumberFormat('vi-VN').format(Number(n || 0)) + 'đ';
}

const tools = {
  ops_query: {
    description: 'Primary MV-Klass operations router. Use this first for any natural-language admin question. Read queries return grounded answers. Write requests are routed to prepare_action and require admin confirmation before changing data.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Original admin question in Vietnamese.' }
      },
      required: ['question']
    },
    run: opsQuery
  },
  faq_catalog: {
    description: 'Return common MV-Klass Telegram questions and the standard answer structure.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    run: faqCatalogAnswer
  },
  prepare_action: {
    description: 'Create a pending MV-Klass write action from a natural-language admin request. Does not write to Supabase. Returns preview and a short confirmation code.',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'Natural-language write request in Vietnamese.' },
        actor_id: { type: 'string', description: 'Optional future permission actor id, such as telegram:<id>.' }
      },
      required: ['request']
    },
    run: prepareAction
  },
  confirm_action: {
    description: 'Execute a pending MV-Klass write action only when the admin message is exactly the 6-digit confirmation code, the MVK-prefixed code, or XÁC NHẬN <code>. Short selection numbers, ok, and implicit approval must be rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Confirmation code such as MVK-482913.' },
        message: { type: 'string', description: 'The original admin message. Must be exactly the 6-digit code, MVK-prefixed code, or XÁC NHẬN <code>.' },
        actor_id: { type: 'string' }
      },
      required: ['code']
    },
    run: confirmAction
  },
  cancel_action: {
    description: 'Cancel a pending MV-Klass write action by confirmation code.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Confirmation code such as MVK-482913.' },
        actor_id: { type: 'string' }
      },
      required: ['code']
    },
    run: cancelAction
  },
  prepare_undo_action: {
    description: 'Create a pending undo action for a previously completed MV-Klass action code. Does not write until the new undo code is confirmed exactly.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Completed action code to undo, such as MVK-482913.' },
        request: { type: 'string', description: 'Original admin undo request.' },
        actor_id: { type: 'string' }
      },
      required: ['code']
    },
    run: prepareUndoAction
  },
  list_pending_actions: {
    description: 'List pending MV-Klass write actions waiting for admin confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        actor_id: { type: 'string' }
      }
    },
    run: listPendingActions
  },
  list_audit_log: {
    description: 'Read MV-Klass Telegram/OpenClaw action audit log by code, date, student, class, status, or natural-language query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        code: { type: 'string' },
        date_from: { type: 'string' },
        date_to: { type: 'string' },
        action_type: { type: 'string' },
        status: { type: 'string' },
        student_query: { type: 'string' },
        class_name: { type: 'string' },
        limit: { type: 'number' },
        actor_id: { type: 'string' }
      }
    },
    run: listAuditLog
  },
  today_overview: {
    description: 'MV-Klass read-only overview for today: classes, unmarked attendance, tuition debt, bank review, and new leads.',
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'Optional YYYY-MM-DD date. Defaults to today on the server.' } }
    },
    run: todayOverview
  },
  student_lookup: {
    description: 'Find a student by name or phone and return class, recent attendance, debt, phone, and notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        class_name: { type: 'string' }
      },
      required: ['query']
    },
    run: studentLookup
  },
  tuition_debt_list: {
    description: 'List students with estimated unpaid tuition sessions. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        class_name: { type: 'string' },
        min_sessions_due: { type: 'number' },
        limit: { type: 'number' }
      }
    },
    run: tuitionDebtList
  },
  bank_review_list: {
    description: 'List bank transactions in needs_review/pending status. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Comma-separated statuses. Defaults to needs_review,pending.' },
        limit: { type: 'number' }
      }
    },
    run: bankReviewList
  },
  ops_alerts: {
    description: 'Read-only MV-Klass alerts: students absent 3+ consecutive sessions or high recent absence rate, class start reminders at 30/10 minutes, and classes started 30+ minutes without attendance.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'all, absence, class, attendance, reminder.' },
        date: { type: 'string', description: 'Optional YYYY-MM-DD date for class reminders.' },
        now: { type: 'string', description: 'Optional ISO timestamp for testing reminder windows.' },
        minutes_of_day: { type: 'number', description: 'Optional current local minutes after midnight for testing.' },
        window_minutes: { type: 'number', description: 'Reminder matching tolerance. Defaults to 5.' },
        limit: { type: 'number' }
      }
    },
    run: opsAlerts
  },
  ops_daily_digest: {
    description: 'Read-only MV-Klass daily operations digest for Telegram: today classes, yesterday unmarked attendance, absence risks, tuition debt, stale leads, bank review, and pending actions.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Optional YYYY-MM-DD date. Defaults to Vietnam today.' },
        actor_id: { type: 'string' }
      }
    },
    run: opsDailyDigest
  },
  draft_parent_tuition_message: {
    description: 'Draft a parent tuition reminder message. Does not send anything.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        class_name: { type: 'string' }
      },
      required: ['query']
    },
    run: draftParentTuitionMessage
  }
};

function makeResult(obj) {
  if (obj && typeof obj.answer === 'string' && obj.answer.trim()) {
    return {
      content: [{ type: 'text', text: obj.answer.trim() + '\n\nDữ liệu chi tiết:\n' + JSON.stringify(obj, null, 2) }]
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }]
  };
}

async function handleRpc(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mvklass-openclaw-mcp', version: '1.0.0' }
      }
    };
  }
  if (msg.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: Object.entries(tools).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      }
    };
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const tool = tools[name];
    if (!tool) {
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool: ' + name } };
    }
    try {
      const result = await tool.run((msg.params && msg.params.arguments) || {});
      return { jsonrpc: '2.0', id: msg.id, result: makeResult(result) };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: makeResult({ error: String((err && err.message) || err), safe: true, changed_data: false })
      };
    }
  }
  if (msg.id == null) return null;
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } };
}

let buffer = Buffer.alloc(0);
let transportMode = null;

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain().catch(() => {});
});

async function drain() {
  while (true) {
    const first = firstNonWhitespaceByte(buffer);
    if (first === 0x7b || first === 0x5b) {
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd < 0) return;
      transportMode = transportMode || 'jsonl';
      const line = buffer.slice(0, lineEnd).toString('utf8').trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const res = await handleRpc(msg);
      if (res) send(res);
      continue;
    }

    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    transportMode = transportMode || 'headers';
    const header = buffer.slice(0, headerEnd).toString('utf8');
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const len = Number(m[1]);
    const total = headerEnd + 4 + len;
    if (buffer.length < total) return;
    const body = buffer.slice(headerEnd + 4, total).toString('utf8');
    buffer = buffer.slice(total);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch (_) {
      continue;
    }
    const res = await handleRpc(msg);
    if (res) send(res);
  }
}

function firstNonWhitespaceByte(buf) {
  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i];
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return b;
  }
  return 0;
}

function send(obj) {
  const body = JSON.stringify(obj);
  if (transportMode === 'jsonl') {
    process.stdout.write(body + '\n');
    return;
  }
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n\r\n' + body);
}
