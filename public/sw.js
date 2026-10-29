/* eslint-disable no-restricted-globals */
/**
 * ===========================================================
 * Service Worker — Web Push cho METANOIA
 * ===========================================================
 *
 * Nhận payload push từ server: `{ "title", "body", "action" }`.
 * `action` là 1 trong các `actionType` (PRE_START_REMINDER, START_PROMPT,
 * NOT_STARTED, NEAR_END, OVERRUN, AUTO_TIMEOUT, CHECK_IN, MISSED_SLOT).
 *
 * Hành vi:
 *  - Hiện notification của hệ điều hành (kể cả khi tab đã đóng).
 *  - Click vào notification → mở app, và báo lại `action` qua query param
 *    để FE xử lý (VD: bấm Start).
 */

/** Ánh xạ actionType → icon + màu badge. */
const ACTION_META = {
  PRE_START_REMINDER: { icon: "schedule", tag: "pre-start" },
  START_PROMPT: { icon: "play_circle", tag: "start-prompt" },
  NOT_STARTED: { icon: "schedule", tag: "not-started" },
  NEAR_END: { icon: "timer", tag: "near-end" },
  OVERRUN: { icon: "timer_off", tag: "overrun" },
  AUTO_TIMEOUT: { icon: "timer_off", tag: "auto-timeout" },
  CHECK_IN: { icon: "sentiment_satisfied", tag: "check-in" },
  MISSED_SLOT: { icon: "event_busy", tag: "missed" },
};

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Click vào notification → focus tab đang mở (nếu có) hoặc mở tab mới,
 * kèm query param để app biết đó là action nào.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const action = event.notification.data && event.notification.data.action;
  const slotId = event.notification.data && event.notification.data.slotId;
  const target = action
    ? `/schedule?focusAction=${encodeURIComponent(action)}${
        slotId ? `&slotId=${encodeURIComponent(slotId)}` : ""
      }`
    : "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        // Ưu tiên tab đang mở trong cùng app.
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.postMessage({ type: "notification-click", action, slotId });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

/** Nhận push từ server. */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }

  const action = payload.action || "Unknown";
  const meta = ACTION_META[action] || { icon: "notifications", tag: "default" };

  const title = payload.title || "METANOIA";
  const options = {
    body: payload.body || "",
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    tag: meta.tag,
    renotify: true,
    requireInteraction: action === "START_PROMPT" || action === "OVERRUN",
    vibrate: [80, 40, 80],
    data: { action, slotId: payload.slotId || null },
    actions: [
      { action: "open", title: "Mở METANOIA" },
      { action: "dismiss", title: "Bỏ qua" },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/** Click vào action button của notification. */
self.addEventListener("notificationclose", () => {
  // Không cần làm gì — giữ chỗ cho logic tương lai (VD: ghi nhận đã đọc).
});
