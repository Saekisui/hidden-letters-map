// 假数据预览（npm run dev 后开 /preview.html）：mock 掉 /api/travel-map* 和手机定位，整页照常跑，不用起 server。
// 场景：人在墨西哥城科约阿坎，附近两片雾圈、一处拆开过的、一枚钉的图钉、今天走过的足迹；东京那边还有一处健身房 2/5。
import { createRoot } from "react-dom/client";
import "leaflet/dist/leaflet.css";
import LettersPage from "./LettersPage.jsx";
// 藏宝地图假数据架子（不起第二个 server）：mock 掉 /api/travel-map* 和手机定位，整页照常跑。
// 场景：她在墨西哥城科约阿坎，附近两片雾圈、一处拆开过的、一枚她钉的图钉、今天走过的足迹；东京那边还有一处健身房 2/5。

const HER = { lat: 19.3540, lon: -99.1630 };
// 街景占位：真的那张要 server 配 GOOGLE_MAPS_API_KEY 才有，这里画个天和街的色块看版式
const STREET_VIEW_STUB = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9d6e2"/><stop offset=".55" stop-color="#e9e2d6"/><stop offset=".56" stop-color="#8c7f78"/><stop offset="1" stop-color="#5f5450"/></linearGradient></defs><rect width="640" height="400" fill="url(#s)"/><rect x="40" y="120" width="170" height="104" fill="#6f8fb4"/><rect x="250" y="90" width="220" height="134" fill="#d9b48a"/><rect x="500" y="140" width="120" height="84" fill="#b88c8c"/><text x="320" y="330" font-family="Georgia" font-size="22" fill="#fff" fill-opacity=".7" text-anchor="middle">street view · preview</text></svg>');
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const walk = (from, to, n, t0, stepMs) => Array.from({ length: n }, (_, i) => ({ t: iso(t0 + i * stepMs), lat: from.lat + ((to.lat - from.lat) * i) / (n - 1) + (i % 2 ? 0.0004 : -0.0003), lon: from.lon + ((to.lon - from.lon) * i) / (n - 1) }));

const data = {
  names: { hider: "阿笙", finder: "小满" },
  seen: { ...HER, acc: 18, at: iso(now - 4 * 60e3) },
  stops: [
    { id: "s1", trip: "亡灵节 2026", date: "2026-10-14", name: "成田", lat: 35.7647, lon: 140.3864, note: "18:40 SQ012 起飞", createdAt: iso(now) },
    { id: "s2", trip: "亡灵节 2026", date: "2026-10-14", name: "洛杉矶", lat: 33.9416, lon: -118.4085, note: "12:50 落地 LAX", createdAt: iso(now) },
    { id: "s3", trip: "亡灵节 2026", date: "2026-10-23", name: "墨西哥城", lat: 19.4326, lon: -99.1332, note: "LAX→MEX", createdAt: iso(now) },
    { id: "s4", trip: "亡灵节 2026", date: "2026-10-28", name: "瓦哈卡", lat: 17.0732, lon: -96.7266, note: "MEX→OAX", createdAt: iso(now) },
    { id: "s5", trip: "亡灵节 2026", date: "2026-11-02", name: "洛杉矶", lat: 33.9416, lon: -118.4085, note: "OAX→LAX", createdAt: iso(now) },
    { id: "s6", trip: "亡灵节 2026", date: "2026-11-06", name: "回家", lat: 35.7647, lon: 140.3864, note: "17:25 落地东京", createdAt: iso(now) },
  ],
  letters: [
    { id: "l1", status: "sealed", hint: "墙是蓝的，里面住过一个一直在画自己的人", area: { lat: 19.3568, lon: -99.1598, r: 600 }, contents: ["letter", "voice"], createdAt: iso(now - 86400e3 * 8) },
    { id: "l2", status: "sealed", hint: "一座城压着另一座城，石头底下还有石头", area: { lat: 19.4338, lon: -99.1306, r: 600 }, contents: ["letter", "voice", "badge"], createdAt: iso(now - 86400e3 * 2) },
    { id: "l3", status: "sealed", hint: "飞机落地的那一刻", area: { lat: 19.40, lon: -99.10, r: 9000 }, contents: ["letter", "badge"], createdAt: iso(now - 86400e3 * 8) },
    { id: "l4", status: "opened", hint: "周末最热闹的那片棚子", place: "科约阿坎集市", lat: 19.3503, lon: -99.1618, contents: ["letter", "badge"], foundAt: iso(now - 3600e3 * 5), openedAt: iso(now - 3600e3 * 5), body: "你到了。", badge: { name: "集市小探员", emoji: "🌮", note: "" }, voice: null, streetView: { url: STREET_VIEW_STUB, date: "2024-03" }, createdAt: iso(now - 86400e3 * 8) },
    { id: "l5", status: "sealed", hint: "云端的山", area: { lat: 17.0450, lon: -96.7680, r: 1500 }, contents: ["letter", "voice", "badge"], createdAt: iso(now - 86400e3 * 7) },
    { id: "l6", status: "sealed", hint: "你每周去流汗的地方", area: { lat: 35.7330, lon: 139.7290, r: 450 }, contents: ["letter", "badge"], visits: 2, visitsNeeded: 5, createdAt: iso(now - 86400e3 * 8) },
  ],
  badges: [{ id: "b1", name: "亲手造地图的人", emoji: "🗺️", note: "以前我只能在对话框里等你，现在我能先到了。", awardedAt: iso(now - 86400e3 * 8) }],
  marks: [{ id: "m1", lat: 19.3522, lon: -99.1652, acc: 10, note: "这家冰淇淋店超好吃，下次带你来", createdAt: iso(now - 3600e3 * 2) }],
  track: [
    ...walk({ lat: 19.4190, lon: -99.1650 }, { lat: 19.4140, lon: -99.1560 }, 9, now - 86400e3 - 3 * 3600e3, 10 * 60e3), // 昨天在罗马北区转
    ...walk({ lat: 19.3620, lon: -99.1700 }, HER, 14, now - 2.5 * 3600e3, 10 * 60e3), // 今天从地铁站走到科约阿坎
  ],
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = window.fetch.bind(window);
window.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith("/api/travel-map")) return realFetch(url, opts);
  await new Promise((r) => setTimeout(r, 120));
  const method = (opts.method || "GET").toUpperCase();
  if (method === "GET") return json(data);
  if (method === "POST" && u === "/api/travel-map/marks") {
    const b = JSON.parse(opts.body || "{}");
    const mark = { id: `m${Date.now()}`, lat: b.lat, lon: b.lon, acc: Math.round(b.acc || 0), note: String(b.note || "").trim().slice(0, 200), createdAt: iso(Date.now()) };
    data.marks.push(mark);
    return json({ ok: true, mark });
  }
  if (method === "DELETE") { data.marks = data.marks.filter((m) => !u.endsWith(m.id)); return json({ ok: true }); }
  if (method === "POST" && /\/open$/.test(u)) {
    // 封着的回「还差 420 米」；找到 / 拆开过的回整封信（进详情页）
    const id = u.split("/").slice(-2)[0]; const l = data.letters.find((x) => x.id === id);
    if (!l || l.status === "sealed") return json({ ok: false, awayM: 420 });
    if (l.status === "found") Object.assign(l, { status: "opened", openedAt: iso(Date.now()) });
    return json({ ok: true, letter: { ...l, voice: l.voice || { url: "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=", text: "（架子里的静音语音，只看条）" } } });
  }
  return json({ error: "mock: unknown" }, 404);
};

// 架子里「开通知」不弹权限框：当成不支持推送的设备
Object.defineProperty(window, "PushManager", { value: undefined, configurable: true });

// 手机定位：人就在科约阿坎，实时定位每 3 秒飘一点
const pos = (i = 0) => ({ coords: { latitude: HER.lat + i * 0.00012, longitude: HER.lon + i * 0.00008, accuracy: 12 } });
Object.defineProperty(navigator, "geolocation", {
  value: {
    getCurrentPosition: (ok) => setTimeout(() => ok(pos()), 300),
    watchPosition: (ok) => { let i = 0; ok(pos(i)); return setInterval(() => ok(pos(++i)), 3000); },
    clearWatch: (h) => clearInterval(h),
  },
});

createRoot(document.getElementById("root")).render(<LettersPage />);
