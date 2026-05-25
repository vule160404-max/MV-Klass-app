#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function loadEnvFile() {
  [path.join(__dirname, '..', '.env.local'), path.join(process.cwd(), '.env.local')].forEach((file) => {
    try {
      if (!fs.existsSync(file)) return;
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
        const m = String(line || '').match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m || process.env[m[1]] != null) return;
        let v = String(m[2] || '').trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      });
    } catch (_) {}
  });
}

function openclawConfig() {
  return readJson(process.env.OPENCLAW_CONFIG || '/root/.openclaw/openclaw.json', {});
}

function telegramConfig() {
  const cfg = openclawConfig();
  const token = process.env.MVKLASS_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || (((cfg.channels || {}).telegram || {}).botToken || '');
  const chatId =
    process.env.MVKLASS_TELEGRAM_CHAT_ID ||
    process.env.TELEGRAM_CHAT_ID ||
    String((((cfg.commands || {}).ownerAllowFrom || []).find((x) => String(x).startsWith('telegram:')) || '').replace(/^telegram:/, ''));
  return { token: String(token || '').trim(), chatId: String(chatId || '').trim() };
}

function callMcpAlerts() {
  const mcp = process.env.MVKLASS_MCP_SCRIPT || path.join(__dirname, 'mvklass-openclaw-mcp.js');
  const req = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'ops_alerts',
      arguments: {
        kind: 'all',
        now: process.env.MVKLASS_ALERT_NOW || undefined,
        date: process.env.MVKLASS_ALERT_DATE || undefined,
        window_minutes: Number(process.env.MVKLASS_ALERT_WINDOW_MINUTES || 5),
        limit: Number(process.env.MVKLASS_ALERT_LIMIT || 20)
      }
    }
  };
  const child = spawnSync(process.execPath, [mcp], {
    input: JSON.stringify(req) + '\n',
    encoding: 'utf8',
    timeout: Number(process.env.MVKLASS_ALERT_MCP_TIMEOUT_MS || 45000)
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(String(child.stderr || child.stdout || 'MCP exited with ' + child.status).slice(0, 1000));
  const line = String(child.stdout || '').split(/\r?\n/).find((x) => x.trim().startsWith('{'));
  const msg = JSON.parse(line);
  const text = (((msg.result || {}).content || [])[0] || {}).text || '';
  const marker = '\n\nDu lieu chi tiet:';
  const marker2 = '\n\nDữ liệu chi tiết:';
  const answer = String(text).split(marker)[0].split(marker2)[0].trim();
  const detailText = String(text).includes(marker2) ? String(text).split(marker2)[1] : String(text).split(marker)[1];
  let detail = {};
  try {
    detail = detailText ? JSON.parse(detailText) : {};
  } catch (_) {}
  return { answer, detail };
}

function callMcpDailyDigest() {
  const mcp = process.env.MVKLASS_MCP_SCRIPT || path.join(__dirname, 'mvklass-openclaw-mcp.js');
  const req = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'ops_daily_digest',
      arguments: {
        date: process.env.MVKLASS_DAILY_DATE || undefined,
        actor_id: process.env.MVKLASS_ACTOR_ID || undefined
      }
    }
  };
  const child = spawnSync(process.execPath, [mcp], {
    input: JSON.stringify(req) + '\n',
    encoding: 'utf8',
    timeout: Number(process.env.MVKLASS_DAILY_MCP_TIMEOUT_MS || 60000)
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(String(child.stderr || child.stdout || 'MCP exited with ' + child.status).slice(0, 1000));
  const line = String(child.stdout || '').split(/\r?\n/).find((x) => x.trim().startsWith('{'));
  const msg = JSON.parse(line);
  const text = (((msg.result || {}).content || [])[0] || {}).text || '';
  const marker = '\n\nDu lieu chi tiet:';
  const marker2 = '\n\nDữ liệu chi tiết:';
  const answer = String(text).split(marker)[0].split(marker2)[0].trim();
  const detailText = String(text).includes(marker2) ? String(text).split(marker2)[1] : String(text).split(marker)[1];
  let detail = {};
  try {
    detail = detailText ? JSON.parse(detailText) : {};
  } catch (_) {}
  return { answer, detail };
}

function alertEvents(detail) {
  const out = [];
  (detail.absence_risks || []).forEach((r) => {
    out.push({
      group: 'absence',
      key: ['absence', r.student_id, r.reason || 'risk'].join(':'),
      studentId: String(r.student_id || ''),
      reason: String(r.reason || 'risk'),
      latestDate: String(r.latest_date || ''),
      latestPresentDate: String(r.latest_present_date || '')
    });
  });
  (detail.class_alerts || []).forEach((r) => {
    out.push({
      group: 'class',
      key: ['class', r.kind, r.date, r.class_name].join(':')
    });
  });
  return out;
}

function filterDuplicate(events) {
  const stateFile = process.env.MVKLASS_ALERT_STATE_FILE || '/root/.openclaw/mvklass-alert-state.json';
  const ttlMs = Number(process.env.MVKLASS_ALERT_DEDUPE_HOURS || 16) * 60 * 60 * 1000;
  const now = Date.now();
  const state = readJson(stateFile, { sent: {}, absence: {} });
  state.sent = state.sent || {};
  state.absence = state.absence || {};
  Object.keys(state.sent).forEach((k) => {
    if (now - Number(state.sent[k] || 0) > ttlMs) delete state.sent[k];
  });
  const fresh = [];
  events.forEach((ev) => {
    if (ev.group === 'absence') {
      const prev = state.absence[ev.key];
      if (prev && ev.latestPresentDate && String(ev.latestPresentDate) > String(prev.latestDate || '')) {
        delete state.absence[ev.key];
      }
      if (!state.absence[ev.key]) {
        fresh.push(ev);
      }
      return;
    }
    if (!state.sent[ev.key]) {
      fresh.push(ev);
    }
  });
  return { fresh, state, stateFile, now };
}

function commitFreshEvents(result) {
  const state = result.state || { sent: {}, absence: {} };
  state.sent = state.sent || {};
  state.absence = state.absence || {};
  (result.fresh || []).forEach((ev) => {
    if (ev.group === 'absence') {
      state.absence[ev.key] = {
        sentAt: result.now,
        latestDate: ev.latestDate,
        latestPresentDate: ev.latestPresentDate
      };
      return;
    }
    state.sent[ev.key] = result.now;
  });
  writeJson(result.stateFile, state);
}

function eventKeyForAbsence(row) {
  return ['absence', row.student_id, row.reason || 'risk'].join(':');
}

function eventKeyForClass(row) {
  return ['class', row.kind, row.date, row.class_name].join(':');
}

function formatFreshAnswer(detail, freshEvents) {
  const freshKeys = new Set(freshEvents.map((ev) => ev.key));
  const absence = (detail.absence_risks || []).filter((r) => freshKeys.has(eventKeyForAbsence(r)));
  const classAlerts = (detail.class_alerts || []).filter((r) => freshKeys.has(eventKeyForClass(r)));
  const lines = [];
  if (absence.length) {
    lines.push('Canh bao hoc vien nghi hoc:');
    absence.slice(0, 10).forEach((r) => {
      const reason = Number(r.current_absent_streak || 0) >= 3
        ? Number(r.current_absent_streak || 0) + ' buoi vang lien tiep'
        : Number(r.recent_absent_count || 0) + '/' + Number(r.recent_checked_count || 0) + ' buoi gan day vang';
      lines.push('- ' + (r.name || 'Hoc vien') + (Array.isArray(r.class_names) && r.class_names.length ? ' · ' + r.class_names.join(', ') : '') + ': ' + reason);
    });
  }
  if (classAlerts.length) {
    if (lines.length) lines.push('');
    lines.push('Nhac viec lop/diem danh:');
    classAlerts.slice(0, 10).forEach((r) => {
      const label =
        r.kind === 'class_starts_in_30m' ? 'sap vao lop trong 30 phut' :
        r.kind === 'class_starts_in_10m' ? 'sap vao lop trong 10 phut' :
        'da bat dau hon 30 phut nhung chua diem danh';
      lines.push('- ' + (r.name || r.class_name || 'Lop') + (r.time ? ' (' + r.time + ')' : '') + ': ' + label);
    });
  }
  return lines.join('\n').trim();
}

function sendTelegram(token, chatId, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: '/bot' + encodeURIComponent(token) + '/sendMessage',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) reject(new Error('Telegram HTTP ' + res.statusCode + ': ' + body.slice(0, 500)));
          else resolve(body);
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  loadEnvFile();
  const mode = String(process.env.MVKLASS_RUNNER_MODE || 'alerts').trim().toLowerCase();
  if (mode === 'daily' || mode === 'digest') {
    const stateFile = process.env.MVKLASS_DAILY_STATE_FILE || '/root/.openclaw/mvklass-daily-state.json';
    const { answer, detail } = callMcpDailyDigest();
    const date = String(detail.date || process.env.MVKLASS_DAILY_DATE || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const state = readJson(stateFile, { sent: {} });
    state.sent = state.sent || {};
    if (state.sent[date]) {
      console.log('Daily digest already sent for ' + date + '.');
      return;
    }
    if (/^(1|true|yes)$/i.test(String(process.env.MVKLASS_ALERT_DRY_RUN || process.env.MVKLASS_DAILY_DRY_RUN || ''))) {
      console.log(answer);
      return;
    }
    const tg = telegramConfig();
    if (!tg.token || !tg.chatId) {
      console.log(answer);
      throw new Error('Missing Telegram token/chat id. Set MVKLASS_TELEGRAM_BOT_TOKEN and MVKLASS_TELEGRAM_CHAT_ID or use /root/.openclaw/openclaw.json.');
    }
    await sendTelegram(tg.token, tg.chatId, 'MV-Klass báo cáo ngày\n\n' + answer);
    state.sent[date] = Date.now();
    writeJson(stateFile, state);
    console.log('Sent MV-Klass daily digest to Telegram.');
    return;
  }
  const { answer, detail } = callMcpAlerts();
  const events = alertEvents(detail);
  if (!events.length) {
    console.log('No MV-Klass alerts.');
    return;
  }
  const dedupe = filterDuplicate(events);
  const freshEvents = dedupe.fresh || [];
  if (!freshEvents.length) {
    console.log('Alerts already sent recently.');
    return;
  }
  const freshAnswer = formatFreshAnswer(detail, freshEvents) || answer;
  if (/^(1|true|yes)$/i.test(String(process.env.MVKLASS_ALERT_DRY_RUN || ''))) {
    console.log(freshAnswer);
    commitFreshEvents(dedupe);
    return;
  }
  const tg = telegramConfig();
  if (!tg.token || !tg.chatId) {
    console.log(freshAnswer);
    throw new Error('Missing Telegram token/chat id. Set MVKLASS_TELEGRAM_BOT_TOKEN and MVKLASS_TELEGRAM_CHAT_ID or use /root/.openclaw/openclaw.json.');
  }
  await sendTelegram(tg.token, tg.chatId, 'MV-Klass cảnh báo\n\n' + freshAnswer);
  commitFreshEvents(dedupe);
  console.log('Sent MV-Klass alerts to Telegram.');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
