import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getMessaging, getToken, isSupported, onMessage } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging.js";

const firebaseConfig = {
  apiKey: "AIzaSyBpUFOhB2oVVBlOeVNiiYSY3aoTy5PxFb0",
  authDomain: "mv-klass-push.firebaseapp.com",
  projectId: "mv-klass-push",
  storageBucket: "mv-klass-push.firebasestorage.app",
  messagingSenderId: "151582445851",
  appId: "1:151582445851:web:24aa525986133c297b43be",
  measurementId: "G-HJ1ESS8FG4",
};

// Ưu tiên dùng window.MVK_VAPID_PUBLIC từ attendance-app.html (cùng response, không phụ thuộc cache file .js).
const vapidKey =
  (typeof globalThis !== "undefined" && String(globalThis.MVK_VAPID_PUBLIC || "").trim()) ||
  "BCSUFpG1o8fbeadcMbeubdrKnhI2UoD-Zw7ITnwlipmbHyTnxSumzrzRDU4tQNAGIsrK08wLKa1-cN0D4NxbBf4";

const app = initializeApp(firebaseConfig);

window.MVKFirebaseMessaging = {
  app,
  firebaseConfig,
  vapidKey,
  getMessaging,
  getToken,
  isSupported,
  onMessage,
};
