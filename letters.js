// letters.js — 藏宝地图的纯逻辑：距离、模糊圈、信 / 站点 / 成就 / 图钉的创建、到访判定、给寻宝人看的脱敏视图。
// 不读写文件、不发推送，那些都在 server.js。
//
// 玩法：藏宝人把东西藏在真实的地方（信 / 一段语音 / 成就），寻宝人的地图上只露一片模糊的圈和一句谜语；
// 人走进信的半径里才拿得到——手机上报的位置落进圈里（见 server.js 的 /api/location），或者在页面上点「我就在这附近」当场定位。

const EARTH_R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

export function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

// 地图上露出来的那片圈：半径是信的 3 倍（至少 300m），圆心随机偏开最多半个圈。
// 偏移 ≤ r/2、信半径 ≤ r/3 → 信的整个触发范围一定落在圈里，但圆心不会正好压在信上。
export function makeHintArea({ lat, lon, radiusM }, rand = Math.random) {
  const r = Math.max(300, radiusM * 3);
  const d = (rand() * r) / 2;
  const theta = rand() * 2 * Math.PI;
  return {
    lat: lat + ((d * Math.cos(theta)) / EARTH_R) * (180 / Math.PI),
    lon: lon + ((d * Math.sin(theta)) / (EARTH_R * Math.cos(toRad(lat)))) * (180 / Math.PI),
    r: Math.round(r),
  };
}

function coords(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) throw new Error("坐标不对");
  return { lat: la, lon: lo };
}

const newId = (prefix, now, rand) => `${prefix}_${now.toString(36)}${Math.floor(rand() * 1e6).toString(36)}`;

// 成就：名字 + 一个 emoji + 一句话。藏在地点上的走到了才解锁；也能直接发。
function normalizeBadge(b) {
  if (!b) return null;
  const name = String(b.name || "").trim().slice(0, 20);
  if (!name) return null;
  return { name, emoji: String(b.emoji || "🏅").trim().slice(0, 8) || "🏅", note: String(b.note || "").trim().slice(0, 120) };
}

// 一个地点能藏的：信（body）/ 语音（voice = { url, text }，自己准备好的音频地址）/ 成就（badge），至少一样
export function createLetter({ place, lat, lon, radiusM, hint, body, voice, badge, visitsNeeded }, { now = Date.now(), rand = Math.random } = {}) {
  const pos = coords(lat, lon);
  const text = { place: String(place || "").trim(), hint: String(hint || "").trim(), body: String(body || "").trim() };
  if (!text.place || !text.hint) throw new Error("place / hint 都要有");
  const b = normalizeBadge(badge);
  const v = voice?.url ? { url: String(voice.url), text: String(voice.text || "") } : null;
  if (!text.body && !v && !b) throw new Error("信、语音、成就至少藏一样");
  const r = Math.min(20000, Math.max(50, Math.round(Number(radiusM) || 200)));
  return {
    id: newId("letter", now, rand),
    ...text,
    voice: v,
    badge: b,
    ...pos,
    radiusM: r,
    visitsNeeded: Math.min(100, Math.max(1, Math.round(Number(visitsNeeded) || 1))), // 要来几天才解锁（健身房 5 次那种）
    visitDays: [],
    area: makeHintArea({ ...pos, radiusM: r }, rand),
    status: "sealed", // sealed → found（走到了 / 点了我在这）→ opened（拆开）
    createdAt: new Date(now).toISOString(),
    foundAt: null,
    foundBy: null,
    openedAt: null,
  };
}

export function createBadge(badge, { now = Date.now(), rand = Math.random } = {}) {
  const b = normalizeBadge(badge);
  if (!b) throw new Error("成就要有名字");
  return { id: newId("badge", now, rand), ...b, awardedAt: new Date(now).toISOString() };
}

// 这个地点藏了哪几样（封着的时候寻宝人也能看到，只知道有、不知道是什么）
export const contentsOf = (l) => [l.body && "letter", l.voice && "voice", l.badge && "badge"].filter(Boolean);

export function createStop({ trip, date, name, lat, lon, note }, { now = Date.now(), rand = Math.random } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new Error("date 要写成 YYYY-MM-DD");
  const label = String(name || "").trim();
  if (!label) throw new Error("name 要有");
  return {
    id: newId("stop", now, rand),
    trip: String(trip || "").trim(),
    date,
    name: label,
    ...coords(lat, lon),
    note: String(note || "").trim(),
    createdAt: new Date(now).toISOString(),
  };
}

export const sortStops = (stops) => [...stops].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));

// 寻宝人的「我来过」小图钉——在地图上按一下，钉在手机当场定位的位置，可以留一句话
export function createMark({ lat, lon, acc, note }, { now = Date.now(), rand = Math.random } = {}) {
  return {
    id: newId("mark", now, rand),
    ...coords(lat, lon),
    acc: Math.max(0, Math.round(Number(acc) || 0)),
    note: String(note || "").trim().slice(0, 200),
    createdAt: new Date(now).toISOString(),
  };
}

// 足迹：手机上报的每一帧只记「挪动了」的——在家每帧抖 2–3 米不记，走出 30 米才算一个点
export const TRACK_STEP_M = 30;
export const shouldRecordFrame = (last, frame) => !last || distanceM(last, frame) > TRACK_STEP_M;

// 在 pos（acc = 定位误差，米）时拿得到的信：还封着、离信不超过信的半径（误差最多让 50m）
export function lettersInReach(letters, pos) {
  const slack = Math.min(Number(pos.acc) || 0, 50);
  return letters.filter((l) => l.status === "sealed" && distanceM(l, pos) <= l.radiusM + slack);
}

// 某一刻是哪一天（YYYY-MM-DD）：按 tz 算，不传就按进程的时区（TZ 环境变量 / 系统）
export const dayOf = (ms, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

// 寻宝人此刻在 pos：还封着、在半径里的，今天记一次到访（一天最多一次——在一个地方待一小时会来好几帧定位）；
// 攒够 visitsNeeded 天就算找到。原地改这些信，返回有变化的 [{ letter, event: "visit" | "found" }]。
export function visitAt(letters, pos, { now = Date.now(), tz } = {}) {
  const day = dayOf(now, tz);
  const out = [];
  for (const l of lettersInReach(letters, pos)) {
    const days = l.visitDays || [];
    const fresh = !days.includes(day);
    if (fresh) l.visitDays = [...days, day];
    if (l.visitDays.length >= (l.visitsNeeded || 1)) {
      Object.assign(l, { status: "found", foundAt: new Date(now).toISOString() });
      out.push({ letter: l, event: "found" });
    } else if (fresh) out.push({ letter: l, event: "visit" });
  }
  return out;
}

// 寻宝人的页面拿到的样子：还封着的只给模糊圈、谜语、藏了哪几样——没有地名、坐标、内容，开发者工具里也偷看不到；
// 找到了才给地名和真实位置；拆开了才给信、语音、成就、街景。
export function publicLetter(l) {
  const base = { id: l.id, status: l.status, hint: l.hint, area: l.area, contents: contentsOf(l), createdAt: l.createdAt };
  if ((l.visitsNeeded || 1) > 1) Object.assign(base, { visits: (l.visitDays || []).length, visitsNeeded: l.visitsNeeded });
  if (l.status === "sealed") return base;
  const found = { ...base, place: l.place, lat: l.lat, lon: l.lon, foundAt: l.foundAt };
  if (l.status === "found") return found;
  const streetView = l.streetView ? { url: `/api/travel-map/letters/${l.id}/streetview.jpg`, date: l.streetView.date || null } : null;
  return { ...found, body: l.body, voice: l.voice || null, badge: l.badge || null, streetView, openedAt: l.openedAt };
}
