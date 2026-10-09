#!/usr/bin/env node
// server.js — 藏信地图的服务端：存地图、收手机上报的位置、判定到访、推送、给页面和 MCP 提供接口。
// 逻辑在 letters.js；这里只管文件、HTTP 和推送。数据全是 data/ 下的几个 JSON 文件，没有数据库。
//
// 环境变量见 .env.example：PASSWORD（必填）、PORT、DATA_DIR、HIDER_NAME、FINDER_NAME、TZ、VAPID_*。

import express from "express";
import webpush from "web-push";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBadge, createLetter, createMark, createStop, distanceM, lettersInReach, publicLetter, shouldRecordFrame, sortStops, visitAt } from "./letters.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PASSWORD = process.env.PASSWORD;
if (!PASSWORD) { console.error("PASSWORD 没设：复制 .env.example 成 .env 填上再启动"); process.exit(1); }
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
const NAMES = { hider: process.env.HIDER_NAME || "TA", finder: process.env.FINDER_NAME || "YOU" };
mkdirSync(DATA_DIR, { recursive: true });

// ── 文件 ──────────────────────────────────────────────────────────────────────
const MAP_FILE = join(DATA_DIR, "map.json"); // 站点 / 信 / 徽章 / 图钉
const TRACK_FILE = join(DATA_DIR, "track.jsonl"); // 足迹，一行一个点
const SEEN_FILE = join(DATA_DIR, "last-seen.json"); // 手机最后一次上报的位置
const SUBS_FILE = join(DATA_DIR, "push-subscriptions.json");

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf-8")); } catch { return fallback; } };
const writeJson = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
function readMap() {
  const j = readJson(MAP_FILE, {});
  return { stops: j.stops || [], letters: j.letters || [], badges: j.badges || [], marks: j.marks || [] };
}
const writeMap = (map) => writeJson(MAP_FILE, map);

function readTrack(sinceMs = 0) {
  try {
    return readFileSync(TRACK_FILE, "utf-8").split("\n").filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((p) => p && Date.parse(p.t) >= sinceMs);
  } catch { return []; }
}
let lastTrackPoint; // undefined = 还没从文件里读过最后一点
function recordTrack(frame) {
  if (lastTrackPoint === undefined) lastTrackPoint = readTrack().at(-1) || null;
  if (!shouldRecordFrame(lastTrackPoint, frame)) return;
  const point = { t: frame.t, lat: frame.lat, lon: frame.lon, acc: Math.round(frame.acc) };
  appendFileSync(TRACK_FILE, JSON.stringify(point) + "\n");
  lastTrackPoint = point;
}

// ── 推送（可选：没配 VAPID 就只在日志里说一声）──────────────────────────────────
let pushReady = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@localhost", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  pushReady = true;
} else {
  console.warn("[push] 没配 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY，走到附近不会推送（npx web-push generate-vapid-keys 生成一对填进 .env）");
}
async function pushAll(title, body, url = "/") {
  if (!pushReady) return;
  const subs = readJson(SUBS_FILE, []);
  const keep = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify({ title, body, url }));
      keep.push(sub);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) console.log("[push] 清掉一个失效订阅");
      else { keep.push(sub); console.warn("[push] 发送失败:", e.statusCode || e.message); }
    }
  }
  if (keep.length !== subs.length) writeJson(SUBS_FILE, keep);
}

// ── 位置：手机上报的一帧 → 记足迹、记最后位置、看落没落进哪封信的圈里 ─────────────
function ingestFrame({ lat, lon, acc, t }) {
  const frame = { lat: Number(lat), lon: Number(lon), acc: Math.max(0, Number(acc) || 0), t: new Date(t || Date.now()).toISOString() };
  if (!Number.isFinite(frame.lat) || !Number.isFinite(frame.lon) || Math.abs(frame.lat) > 90 || Math.abs(frame.lon) > 180) throw new Error("坐标不对");
  recordTrack(frame);
  writeJson(SEEN_FILE, { lat: frame.lat, lon: frame.lon, acc: frame.acc, at: frame.t });
  const map = readMap();
  const changes = visitAt(map.letters, frame, { now: Date.parse(frame.t) });
  if (!changes.length) return;
  for (const { letter, event } of changes) {
    if (event === "visit") { console.log(`[letters] 今天来过「${letter.place}」（${letter.visitDays.length}/${letter.visitsNeeded}）`); continue; }
    letter.foundBy = "track";
    console.log(`[letters] 走到了「${letter.place}」，到手`);
    pushAll(`📮 ${NAMES.hider}藏的东西`, `你走到了${letter.place}附近，这里有${NAMES.hider}留给你的东西`).catch(() => {});
  }
  writeMap(map);
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "2mb" })); // Overland 一次能攒几百帧

// 三种带密码的方式：页面的 cookie、MCP / Overland 的 Bearer、OwnTracks 的 HTTP Basic（用户名随便，密码对就行）
function authed(req) {
  const h = String(req.headers.authorization || "");
  if (h.startsWith("Bearer ") && h.slice(7) === PASSWORD) return true;
  if (h.startsWith("Basic ")) {
    const pw = Buffer.from(h.slice(6), "base64").toString("utf-8").split(":").slice(1).join(":");
    if (pw === PASSWORD) return true;
  }
  return String(req.headers.cookie || "").split(/;\s*/).includes(`auth=${PASSWORD}`);
}

app.use(express.static(join(__dirname, "public"))); // 登录页、sw.js、manifest、图标不用登录
app.post("/login", (req, res) => {
  if (req.body?.password !== PASSWORD) return res.status(401).json({ error: "密码不对" });
  res.setHeader("Set-Cookie", `auth=${PASSWORD}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  res.json({ ok: true });
});
app.use((req, res, next) => {
  if (authed(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
  res.redirect("/login.html");
});
app.use(express.static(join(__dirname, "dist"))); // npm run build 的产物
app.get("/", (_req, res) => res.status(503).type("text/plain").send("还没 build：先 npm run build"));

// 找信人的页面：封着的信只有模糊圈 + 谜语 + 藏了哪几样（publicLetter），外加最后位置和最近 60 天的足迹
app.get("/api/travel-map", (_req, res) => {
  const { stops, letters, badges, marks } = readMap();
  const track = readTrack(Date.now() - 60 * 86400e3).map(({ t, lat, lon }) => ({ t, lat, lon }));
  res.json({ names: NAMES, stops: sortStops(stops), letters: letters.map(publicLetter), badges, marks, seen: readJson(SEEN_FILE, null), track });
});

// 藏信人（MCP / curl）看全貌：藏过哪些、写了什么、拆没拆
app.get("/api/travel-map/full", (_req, res) => {
  const map = readMap();
  res.json({ ...map, stops: sortStops(map.stops) });
});

app.post("/api/travel-map/stops", (req, res) => {
  try {
    const stop = createStop(req.body || {});
    const map = readMap();
    map.stops.push(stop);
    writeMap(map);
    res.json({ ok: true, stop });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 藏东西：body = 信的正文，voice = { url, text } 自己准备好的音频，badge = { name, emoji, note }
app.post("/api/travel-map/letters", (req, res) => {
  try {
    const letter = createLetter(req.body || {});
    const map = readMap();
    map.letters.push(letter);
    writeMap(map);
    console.log(`[letters] 在「${letter.place}」藏了东西（半径 ${letter.radiusM}m）`);
    res.json({ ok: true, letter });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 直接发一枚徽章（不藏在地点上）
app.post("/api/travel-map/badges", (req, res) => {
  try {
    const badge = createBadge(req.body || {});
    const map = readMap();
    map.badges.push(badge);
    writeMap(map);
    res.json({ ok: true, badge });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 找信人钉一枚「我来过」：手机当场定位的位置 + 一句话（可空）
app.post("/api/travel-map/marks", (req, res) => {
  try {
    const mark = createMark(req.body || {});
    const map = readMap();
    map.marks.push(mark);
    writeMap(map);
    console.log(`[letters] 钉了一枚「我来过」${mark.note ? `：${mark.note}` : ""}`);
    res.json({ ok: true, mark });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 删站点 / 收回还封着的信 / 拔掉图钉；找到或拆开的信收不回
app.delete("/api/travel-map/:id", (req, res) => {
  const map = readMap();
  const id = req.params.id;
  const letter = map.letters.find((l) => l.id === id);
  if (letter && letter.status !== "sealed") return res.status(409).json({ error: "这封信已经被找到了，收不回" });
  const before = map.stops.length + map.letters.length + map.marks.length;
  map.stops = map.stops.filter((s) => s.id !== id);
  map.letters = map.letters.filter((l) => l.id !== id);
  map.marks = map.marks.filter((m) => m.id !== id);
  if (map.stops.length + map.letters.length + map.marks.length === before) return res.status(404).json({ error: "没有这个 id" });
  writeMap(map);
  res.json({ ok: true });
});

// 拆信。还封着的要带手机当场定位（不够近就告诉还差多远）；已经找到的直接拆
app.post("/api/travel-map/letters/:id/open", (req, res) => {
  const map = readMap();
  const letter = map.letters.find((l) => l.id === req.params.id);
  if (!letter) return res.status(404).json({ error: "没有这封信" });
  if (letter.status === "sealed") {
    const pos = { lat: Number(req.body?.lat), lon: Number(req.body?.lon), acc: Number(req.body?.acc) || 0 };
    if (!Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) return res.status(400).json({ error: "需要手机当前的位置" });
    if (!lettersInReach([letter], pos).length) {
      return res.json({ ok: false, awayM: Math.max(0, Math.round(distanceM(letter, pos) - letter.radiusM)) });
    }
    const [change] = visitAt([letter], pos);
    if (letter.status === "sealed") {
      writeMap(map);
      return res.json({ ok: false, counted: change?.event === "visit", visits: letter.visitDays.length, visitsNeeded: letter.visitsNeeded });
    }
    letter.foundBy = "tap";
  }
  if (letter.status === "found") {
    Object.assign(letter, { status: "opened", openedAt: new Date().toISOString() });
    console.log(`[letters] 拆开了「${letter.place}」`);
  }
  writeMap(map);
  res.json({ ok: true, letter: publicLetter(letter) });
});

// ── 位置上报：三个入口，都落到 ingestFrame ──────────────────────────────────────
// 通用：{ lat, lon, acc?, t? }——iOS 快捷指令、自己写的脚本都能喂
app.post("/api/location", (req, res) => {
  try { ingestFrame(req.body || {}); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});

// Overland（iOS）：{ locations: [ { geometry: { coordinates: [lon, lat] }, properties: { timestamp, horizontal_accuracy } } ] }
// 必须回 {"result":"ok"}，不然它会一直重发这批
app.post("/api/location/overland", (req, res) => {
  const list = Array.isArray(req.body?.locations) ? req.body.locations : [];
  let used = 0;
  for (const f of list) {
    const [lon, lat] = f?.geometry?.coordinates || [];
    const p = f?.properties || {};
    try { ingestFrame({ lat, lon, acc: p.horizontal_accuracy, t: p.timestamp }); used++; } catch (e) { console.warn("[overland] 跳过一帧:", e.message); }
  }
  if (list.length) console.log(`[overland] 收到 ${list.length} 帧，用了 ${used}`);
  res.json({ result: "ok" });
});

// OwnTracks（iOS / Android，HTTP 模式）：{ _type: "location", lat, lon, acc, tst }，回空数组就行
app.post("/api/location/owntracks", (req, res) => {
  const b = req.body || {};
  if (b._type === "location") {
    try { ingestFrame({ lat: b.lat, lon: b.lon, acc: b.acc, t: Number(b.tst) * 1000 }); } catch (e) { console.warn("[owntracks] 跳过:", e.message); }
  }
  res.json([]);
});

// ── Web Push 订阅 ──────────────────────────────────────────────────────────────
app.get("/api/push/vapid-public-key", (_req, res) => res.json({ key: process.env.VAPID_PUBLIC_KEY || null }));
app.post("/api/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: "subscription required" });
  const subs = readJson(SUBS_FILE, []).filter((s) => s.endpoint !== sub.endpoint);
  subs.push(sub);
  writeJson(SUBS_FILE, subs);
  res.json({ ok: true });
});
app.post("/api/push/unsubscribe", (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) writeJson(SUBS_FILE, readJson(SUBS_FILE, []).filter((s) => s.endpoint !== endpoint));
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[letters] http://localhost:${PORT}  数据在 ${DATA_DIR}${existsSync(join(__dirname, "dist")) ? "" : "（页面还没 build）"}`);
});
