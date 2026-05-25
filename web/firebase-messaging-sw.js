importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBpUFOhB2oVVBlOeVNiiYSY3aoTy5PxFb0",
  authDomain: "mv-klass-push.firebaseapp.com",
  projectId: "mv-klass-push",
  storageBucket: "mv-klass-push.firebasestorage.app",
  messagingSenderId: "151582445851",
  appId: "1:151582445851:web:24aa525986133c297b43be",
  measurementId: "G-HJ1ESS8FG4",
});

const messaging = firebase.messaging();

function text(v) {
  return String(v == null ? "" : v).trim();
}

function decodeB64Utf8(v) {
  try {
    const raw = atob(String(v || ""));
    const bytes = Uint8Array.from(raw.split("").map((c) => c.charCodeAt(0)));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch (_) {
    return "";
  }
}

function repairUtf8Mojibake(input) {
  const s = String(input || "");
  if (!s) return s;
  if (!/[ÃƒÃ‚Ã„Ã…Ã†Ã‡ÃˆÃ‰ÃŠÃ‹ÃŒÃÃŽÃÃÃ‘Ã’Ã“Ã”Ã•Ã–Ã™ÃšÃ›ÃœÃÃžÃŸï¿½]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from(Array.from(s).map((ch) => ch.charCodeAt(0) & 0xff));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch (_) {
    return s;
  }
}

function pickPayloadParts(payload) {
  const root = payload || {};
  const data = (root && root.data) || root || {};
  const nested = (data && data.data) || {};
  const title =
    text(data.title_b64 ? decodeB64Utf8(data.title_b64) : "") ||
    text(nested.title_b64 ? decodeB64Utf8(nested.title_b64) : "") ||
    repairUtf8Mojibake(text(data.title)) ||
    repairUtf8Mojibake(text(nested.title)) ||
    repairUtf8Mojibake(text(payload && payload.notification && payload.notification.title));
  const body =
    text(data.body_b64 ? decodeB64Utf8(data.body_b64) : "") ||
    text(nested.body_b64 ? decodeB64Utf8(nested.body_b64) : "") ||
    repairUtf8Mojibake(text(data.body)) ||
    repairUtf8Mojibake(text(nested.body)) ||
    repairUtf8Mojibake(text(payload && payload.notification && payload.notification.body));
  return { title, body, data: data && Object.keys(data).length ? data : nested };
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

messaging.onBackgroundMessage(() => {});

self.addEventListener("push", (event) => {
  if (!event) return;
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    try {
      const rawText = event.data ? event.data.text() : "";
      try {
        data = JSON.parse(rawText || "{}");
      } catch (__json) {
        data = { body: rawText };
      }
    } catch (__){
      data = {};
    }
  }
  // If payload already contains notification object, let OS/browser render it.
  if (data && data.notification && (data.notification.title || data.notification.body)) return;
  const picked = pickPayloadParts(data);
  const title = picked.title || "MV Klass";
  const body = picked.body;
  if (!text(title) && !text(body)) return;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "./assets/brand/Center-logo.png",
      data: picked.data,
      tag: text(picked.data && picked.data.event) || "mvk-notif",
      renotify: false,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/"));
});
