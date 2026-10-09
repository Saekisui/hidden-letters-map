// 页面到 server.js 的几个调用。没登录（401）就回登录页。
async function req(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401) { window.location.href = "/login.html"; throw new Error("请先登录"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  travelMap: () => req("/api/travel-map"),
  openLetter: (id, pos = {}) => req(`/api/travel-map/letters/${encodeURIComponent(id)}/open`, { method: "POST", body: pos }),
  addMark: (mark) => req("/api/travel-map/marks", { method: "POST", body: mark }),
  removeMark: (id) => req(`/api/travel-map/${encodeURIComponent(id)}`, { method: "DELETE" }),
  vapidKey: () => req("/api/push/vapid-public-key"),
  subscribePush: (sub) => req("/api/push/subscribe", { method: "POST", body: sub }),
};
