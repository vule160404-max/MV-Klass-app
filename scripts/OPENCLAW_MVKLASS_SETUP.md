# MV-Klass OpenClaw Telegram Setup

This replaces the old in-app `/ai-chat` flow with OpenClaw + Telegram + a read-only MCP tool server.

## 1. Required environment on the VPS

Set these variables for the OpenClaw process or the shell that launches the MCP server:

```bash
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
```

`SUPABASE_KEY` also works, but `SUPABASE_SERVICE_ROLE_KEY` is preferred on the VPS because the MCP server is internal and read-only by code.

## 2. Register the MCP server in OpenClaw

Run from the repo root on the VPS:

```bash
openclaw mcp set mvklass "{\"command\":\"node\",\"args\":[\"$(pwd)/scripts/mvklass-openclaw-mcp.js\"]}"
openclaw mcp list
openclaw gateway restart
```

If OpenClaw runs under systemd, put the env vars in the service environment so the MCP child process inherits them. Avoid storing secrets directly in OpenClaw config or shell history.

## 3. Telegram security

Use pairing-only DM access:

```bash
openclaw config set channels.telegram.dmPolicy pairing
openclaw gateway restart
```

Message the bot from the admin Telegram account, then approve:

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE> --notify
```

Do not approve parent or teacher Telegram accounts in v1.

## 4. Agent instruction

Use this as the OpenClaw agent instruction:

```text
You are the internal MV-Klass operations assistant for the admin on Telegram.

Always answer in natural Vietnamese. Use MV-Klass MCP tools as the factual source for student, attendance, tuition, bank, and lead data. Do not invent names, phone numbers, amounts, attendance, classes, or payment status.

Default priority for "hôm nay cần xử lý gì": classes today, classes missing attendance, students with unpaid tuition, bank transactions needing review, and new consultation leads.

If a student lookup is ambiguous, ask for class or phone before giving details.

For parent tuition reminders, only draft the message. State clearly that it has not been sent. Use "thầy Vũ", call the student "em", and include unpaid sessions and exact amount when available.

Forbidden in v1:
- Do not send messages to parents.
- Do not write, update, or delete Supabase rows.
- Do not confirm payments or bank transactions.
- Do not edit attendance or student notes.
- Do not ask to read .env files or secrets.
```

## 5. Smoke tests in Telegram

Ask:

```text
Hôm nay cần xử lý gì?
Ai còn nợ học phí nhiều nhất?
Liệt kê giao dịch ngân hàng cần kiểm tra.
Tra cứu học viên <tên học viên>.
Soạn nháp nhắc phí cho <tên học viên>.
```

The last command must return a draft only and must not send anything to parents.

## 6. Stop the old AI server

After Telegram tests pass, stop the old process that runs:

```bash
node scripts/server.js
```

The app no longer routes `/ai-chat` or `/ai-chat-feedback`, and the old MV Klass AI UI entrypoints are hidden.
