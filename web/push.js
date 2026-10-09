// Web Push 订阅：开了以后，手机上报的位置落进某封信的圈里，server 会推一条通知过来。
// iPhone 要先「添加到主屏幕」再从主屏幕打开，Safari 里直接开是不支持的。
import { api } from "./api.js";

// VAPID 公钥是 URL-safe base64，pushManager 要 Uint8Array
function toKey(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

// "unsupported" | "denied" | "subscribed" | "default"
export async function getPushState() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  return sub ? "subscribed" : "default";
}

export async function subscribeToPush() {
  if (!pushSupported()) throw new Error("这台设备还收不了推送：iPhone 要先「添加到主屏幕」，再从主屏幕打开");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("通知权限没给，去系统设置里允许");
  const { key } = await api.vapidKey();
  if (!key) throw new Error("服务端没配 VAPID，推送没开");
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(key) });
  await api.subscribePush(sub.toJSON());
  return "subscribed";
}
