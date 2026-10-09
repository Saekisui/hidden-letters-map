// LettersPage.jsx — 找信人看的那一页：旅行路线 + 藏在真实地方的东西（信 / 语音 / 徽章）。
// 封着的信只露一片模糊的圈和谜语；手机上报的位置落进信的半径（server 收 /api/location），或者点「我就在这附近」让手机当场定位，信才到手。
// 地图用 Leaflet 直接挂（不引 react-leaflet），底图 OpenStreetMap 官方瓦片染成很浅的烟粉。
// 还有：自己在地图上的位置（最后一次上报 + 「定位我」实时）、真实足迹线、「我来过」小图钉、徽章墙、第一次拆开的封蜡仪式和详情页。
import { useEffect, useId, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Bell, Calendar, ChevronDown, ChevronLeft, LocateFixed, MapPin, Navigation, Pause, Play, Route, X } from "lucide-react";
import { api } from "./api.js";
import { getPushState, subscribeToPush } from "./push.js";
import "./letters.css";

const FLIGHT_KM = 300; // 两站之间超过这么远算飞过去的，画虚线
const FRESH_MS = 36 * 3600e3; // 手机最后一次上报超过这么久就不当「人在这」画了
// 两个人怎么称呼：server 随 /api/travel-map 给（HIDER_NAME / FINDER_NAME），拿到以后整页都读这里
const NAMES = { hider: "TA", finder: "YOU" };
const TRACK_GAP_MS = 6 * 3600e3; // 足迹两点之间隔这么久（睡觉 / 飞机）就断开，不连成一条直线
const CONTENT_LABEL = { letter: "信", voice: "语音讲解", badge: "徽章" };
const CONTENT_CLASS = { letter: "t-letter", voice: "t-voice", badge: "t-badge" };
const TILE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180; // 展开过的经度收回 -180…180 给人看
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const md = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : "");
const mdAt = (iso) => { if (!iso) return ""; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; }; // 按手机本地时区
const M = (a, b) => L.latLng(a.lat, a.lon).distanceTo(L.latLng(b.lat, b.lon));
// 度分：19°21′N
function dm(v, pos, neg) {
  const a = Math.abs(v); let d = Math.floor(a); let m = Math.round((a - d) * 60);
  if (m === 60) { d += 1; m = 0; }
  return `${d}°${String(m).padStart(2, "0")}′${v >= 0 ? pos : neg}`;
}
function awayText(m) {
  if (m >= 1000) return `还差 ${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} 公里`;
  return `还差 ${Math.max(10, Math.round(m / 10) * 10)} 米`;
}
const distText = (m) => awayText(m).replace("还差 ", "");
// 跨太平洋那段（东京 139° → 洛杉矶 -118°）直接连会绕地球反方向一整圈：按顺序把经度展开，每一站离上一站不超过 180°
function unwrapStops(stops) {
  let prev = null;
  return stops.map((s) => {
    let lon = s.lon;
    if (prev != null) while (lon - prev > 180) lon -= 360;
    if (prev != null) while (prev - lon > 180) lon += 360;
    prev = lon;
    return { ...s, lon };
  });
}
// 信的经度挪到离最近那一站同一个「世界副本」里，免得画在另一边
function nearLon(lon, refs) {
  if (!refs.length) return lon;
  const cost = (c) => Math.min(...refs.map((r) => Math.abs(c - r)));
  return [lon - 360, lon, lon + 360].reduce((a, b) => (cost(b) < cost(a) ? b : a));
}
function locateMe() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("这台设备拿不到定位"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? "要允许定位，才知道你到了没有" : "定位没拿到，再试一次")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}

// ───────── 手画插画（SVG 字符串，给 Leaflet 的 divIcon 和卡片插画区用）：钉子里是现存实物——米白信封 + 腮红粉封蜡、线描小玫瑰、旧金币、小图钉 ─────────
const INK = "#6e3148"; // 梅子红只当线描的墨
// 强调色跟 letters.css 的 --lm-accent 同步改（钉子的环、封蜡渐变、插画里的点在 SVG 里）
const ACCENT = "#a86b77"; const ACCENT_DEEP = "#8f5562"; const ACCENT_LIGHT = "#d9b0ba";
const HEART = "M0 4.2C-1.6 3.1-5 .9-5-1.6c0-1.4 1.1-2.6 2.5-2.6.9 0 1.9.5 2.5 1.4.6-.9 1.6-1.4 2.5-1.4 1.4 0 2.5 1.2 2.5 2.6C5 .9 1.6 3.1 0 4.2Z";
const star = (x, y, s, c) => `<path transform="translate(${x} ${y})" d="M0 ${-s}Q0 0 ${s} 0Q0 0 0 ${s}Q0 0 ${-s} 0Q0 0 0 ${-s}Z" fill="${c}"/>`;
const f2 = (v) => v.toFixed(2);
const waxCache = {};
function waxPath(r) { // 封蜡的波浪边：一圈 12 个起伏 + 一点不规则
  if (waxCache[r]) return waxCache[r];
  let d = "";
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2; const rr = r * (1 + 0.06 * Math.sin(a * 12) + 0.03 * Math.sin(a * 5 + 1));
    d += `${i ? "L" : "M"}${f2(Math.cos(a) * rr)} ${f2(Math.sin(a) * rr)}`;
  }
  return (waxCache[r] = `${d}Z`);
}
const wax = (x, y, r, grad = "lmWax") => `<g transform="translate(${x} ${y})"><path d="${waxPath(r)}" fill="url(#${grad})"/><circle r="${f2(r * 0.68)}" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width="${f2(r * 0.09)}"/><path d="${HEART}" transform="translate(0 ${f2(r * 0.05)}) scale(${(r * 0.1).toFixed(3)})" fill="#fff" fill-opacity=".66"/></g>`;
const envSmall = (grad = "lmWax") => `<g transform="rotate(-6)"><rect x="-11" y="-7.6" width="22" height="15.2" rx="1.6" fill="#fcf8f1" stroke="${INK}" stroke-opacity=".72" stroke-width="1"/><path d="M-10.3-6.7 0 1.2 10.3-6.7" fill="none" stroke="${INK}" stroke-opacity=".72" stroke-width=".9" stroke-linejoin="round"/>${wax(0, 1.6, 4.4, grad)}</g>`;
const ROSE_PATHS = '<path d="M20 11c-4.4 0-8 3.4-8 7.8s3.6 7.6 8 7.6 8-3.2 8-7.6"/><path d="M20 14.6c-2.4 0-4.4 1.9-4.4 4.2s2 4 4.4 4 4.2-1.7 4.2-4"/><path d="M20 17.6c-.9 0-1.5.6-1.5 1.3s.6 1.2 1.4 1.2"/><path d="M12.5 15.5c1.5-3 4.3-4.5 7.5-4.5 3 0 5.8 1.6 7.4 4.3"/><path d="M20 26.4V35"/><path d="M20 31.2c-3.4-.4-5.6-2.3-6.4-4.8 3.1-.1 5.4 1.6 6.4 4.8Z"/><path d="M20 32.4c3-.8 4.8-2.8 5.2-5.3-2.9.4-4.7 2.3-5.2 5.3Z"/>';
const rose = (x, y, s, c = "#c27c87", w = 1.15) => `<g transform="translate(${x} ${y}) scale(${s}) translate(-20 -23)" fill="none" stroke="${c}" stroke-width="${(w / s).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">${ROSE_PATHS}</g>`;
const pushpin = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s}) rotate(14) translate(-12 -16)"><path d="M12 17v12" stroke="${INK}" stroke-width="1.3" stroke-linecap="round"/><ellipse cx="12" cy="16" rx="4.2" ry="1.7" fill="#c27c87"/><circle cx="12" cy="9" r="7.5" fill="url(#lmWax)" stroke="#c27c87" stroke-width=".8"/><circle cx="9.4" cy="6.4" r="2.1" fill="#fff" fill-opacity=".6"/></g>`;
const coin = (r, emoji) => `<circle r="${r}" fill="url(#lmGold)"/><circle r="${f2(r * 0.9)}" fill="none" stroke="#4d3818" stroke-opacity=".45" stroke-width="${f2(r * 0.14)}" stroke-dasharray="${f2(r * 0.05)} ${f2(r * 0.1)}"/><circle r="${f2(r * 0.66)}" fill="url(#lmGold)"/><circle r="${f2(r * 0.58)}" fill="url(#lmEnamel)"/><text y="${f2(r * 0.23)}" font-size="${f2(r * 0.62)}" text-anchor="middle" filter="url(#lmSepia)">${esc(emoji)}</text><path d="M${f2(-r * 0.75)} ${f2(-r * 0.4)}A${f2(r * 0.85)} ${f2(r * 0.85)} 0 0 1 ${f2(-r * 0.27)} ${f2(-r * 0.8)}" stroke="#fff6dc" stroke-opacity=".75" stroke-width="${f2(r * 0.1)}" fill="none" stroke-linecap="round"/>`;
// 暖白纸泪滴气泡：一条 path（圆 + 小尖角）+ 发丝线，里面一圈底色 + 纸纹 + 实物
const TEAR = "M24 57Q22.2 52 17 42.8A21 21 0 1 1 31 42.8Q25.8 52 24 57Z";
const HAIR = ' stroke="#dfd0ca" stroke-width="1"';
function bubble(inner, o = {}) {
  const ring = o.ring || "#fffaf4"; const bg = o.bg || "#f5e3e1";
  const style = o.delay != null ? ` style="--d:${o.delay}s"` : "";
  return `<span class="lm-bp ${o.cls || ""}"${style}>${o.pulse ? '<i class="lm-bp-pulse"></i>' : ""}<svg viewBox="0 0 48 60" aria-hidden="true"><path d="${TEAR}" fill="${ring}"${o.stroke != null ? o.stroke : HAIR}/><circle cx="24" cy="23" r="17" fill="${bg}"/><circle cx="24" cy="23" r="17" fill="url(#lmGrainP)" stroke="${o.inner || "#e6d6cf"}" stroke-width=".8"/><g transform="translate(24 23)">${inner}</g></svg></span>`;
}
const PIN = {
  sealed: (o = {}) => bubble(envSmall(), { bg: "#f5e3e1", ...o }),
  nearest: (o = {}) => bubble(envSmall("lmWaxAccent"), { ...o, ring: ACCENT, stroke: "", bg: "#fffaf4", inner: "#fffaf4", cls: `lg ${o.cls || ""}` }),
  found: (o = {}) => bubble(`${envSmall()}<circle cx="10.5" cy="-9" r="5" fill="#b8995e" stroke="#fffaf4" stroke-width="1.4"/><path d="M10.5-11.4v2.9M10.5-6.6v.1" stroke="#fffaf4" stroke-width="1.5" stroke-linecap="round"/>`, { bg: "#f2e9d4", pulse: true, ...o }),
  medal: (emoji, o = {}) => bubble(coin(11.5, emoji), { bg: "#f2e9d4", ...o }),
  opened: (o = {}) => bubble(rose(0, -1, 0.8, "#c27c87", 1.2), { bg: "#f5e3e1", ...o }),
  mark: (o = {}) => bubble(pushpin(0, 0, 0.82), { bg: "#f4eee5", ...o, cls: `sm ${o.cls || ""}` }),
  pending: () => bubble(pushpin(0, 0, 0.82), { bg: "#fbe4ea", cls: "sm pending", stroke: ` stroke="${ACCENT}" stroke-width="1.4" stroke-dasharray="3 3"` }),
};
const PLANE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>';
// 卡片 / 大卡的插画区（144×92）：纸底 + 几道淡淡的经纬线 + 一枚小指南针
const GRAT = '<path d="M0 30Q72 22 144 30M0 64Q72 56 144 64M44 0Q40 46 44 92M100 0Q104 46 100 92" fill="none" stroke="#9d8085" stroke-opacity=".2" stroke-width=".7"/>';
const compassTiny = (x, y) => `<g transform="translate(${x} ${y})" fill="none" stroke="#b8995e" stroke-width=".8"><circle r="7.5"/><path d="M0-9.5 1.3-1.3 9.5 0 1.3 1.3 0 9.5-1.3 1.3-9.5 0-1.3-1.3Z" fill="#b8995e" fill-opacity=".25"/></g>`;
const bigEnv = (x, y, rot, grad = "lmWax") => `<g transform="translate(${x} ${y}) rotate(${rot})"><rect x="-23" y="-15.5" width="46" height="31" rx="2.4" fill="#fcf8f1" stroke="${INK}" stroke-opacity=".7" stroke-width="1.1"/><path d="M-21.6 13.8-6 2M21.6 13.8 6 2" stroke="${INK}" stroke-opacity=".25" stroke-width=".8"/><path d="M-21.6-13.8 0 3 21.6-13.8" fill="none" stroke="${INK}" stroke-opacity=".7" stroke-width="1" stroke-linejoin="round"/>${wax(0, 3.4, 7.4, grad)}</g>`;
const bigEnvOpen = (x, y) => `<g transform="translate(${x} ${y})"><path d="M-24-4 0-22 24-4Z" fill="#ece1d3" stroke="${INK}" stroke-opacity=".55" stroke-width="1" stroke-linejoin="round"/><rect x="-17" y="-20" width="34" height="26" rx="1.4" fill="#fffdf8" stroke="#dfd0ca" stroke-width=".8"/><path d="M-12-13H12M-12-8H12M-12-3H6" stroke="#e8d8d2" stroke-width="1.3" stroke-linecap="round"/><path d="M-24-4V15Q-24 17-22 17H22Q24 17 24 15V-4L0 9Z" fill="#fbf6ee" stroke="${INK}" stroke-opacity=".7" stroke-width="1.1" stroke-linejoin="round"/></g>`;
const pdotsSvg = (v, n, x, y) => Array.from({ length: n }, (_, i) => `<circle cx="${x + i * 11}" cy="${y}" r="3.2" fill="${i < v ? "#c27c87" : "#fffaf4"}" stroke="#c27c87" stroke-width="1.1"/>`).join("");
function illSealed(l, nearest) {
  const multi = l.visitsNeeded > 1;
  return `<svg viewBox="0 0 144 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="144" height="92" fill="url(#${nearest ? "lmCgAccent" : "lmCgBlush"})"/>${GRAT}
    <circle cx="72" cy="48" r="32" fill="url(#lmFogGrad)" stroke="#c27c87" stroke-width="1.1" stroke-dasharray="1.2 4.6" stroke-linecap="round"/>
    ${bigEnv(72, 46, -8, nearest ? "lmWaxAccent" : "lmWax")}${compassTiny(122, 20)}${star(24, 22, 4.5, "#fffaf4")}${star(112, 74, 3, "#fffaf4")}${star(26, 68, 3, "#dc9aa3")}
    ${nearest ? `<circle cx="98" cy="66" r="10" fill="${ACCENT}" fill-opacity=".2"/><circle cx="98" cy="66" r="4.6" fill="${ACCENT}" stroke="#fffaf4" stroke-width="2"/>` : ""}
    ${multi ? `<rect x="${72 - (l.visitsNeeded * 11) / 2 - 4}" y="76" width="${l.visitsNeeded * 11 + 8}" height="12" rx="6" fill="#fffaf4" fill-opacity=".9"/>${pdotsSvg(l.visits || 0, l.visitsNeeded, 72 - ((l.visitsNeeded - 1) * 11) / 2, 82)}` : ""}</svg>`;
}
// 插画用的旧金勋章（静态版：罗纹缎带折 V + 小金环 + 滚花边 + 酒红珐琅）；徽章墙 / 证书用下面的 3D Medal
const medalSvg = (emoji) => `<g><path d="M23 0H41V18.5L32 25 23 18.5Z" fill="url(#lmRibbon)"/><path d="M23 0H41V18.5L32 25 23 18.5Z" fill="url(#lmRibbonShade)"/><ellipse cx="32" cy="27.5" rx="3" ry="3.6" fill="none" stroke="#a8884c" stroke-width="1.5"/><circle cx="32" cy="51" r="21.5" fill="url(#lmGold)"/><circle cx="32" cy="51" r="20.2" fill="none" stroke="#4d3818" stroke-opacity=".45" stroke-width="2" stroke-dasharray=".55 1.1"/><circle cx="32" cy="51" r="18.4" fill="none" stroke="#4d3818" stroke-opacity=".35" stroke-width=".5"/><circle cx="32" cy="51" r="13.4" fill="url(#lmGold)"/><circle cx="32" cy="51" r="12.2" fill="url(#lmEnamel)"/><text x="32" y="55" font-size="12" text-anchor="middle" filter="url(#lmSepia)">${esc(emoji)}</text><path d="M15.6 43.5a18 18 0 0 1 9.4-10" stroke="#fff6dc" stroke-opacity=".7" stroke-width="1.6" fill="none" stroke-linecap="round"/></g>`;
function illOpened(l) {
  if (l.badge) return `<svg viewBox="0 0 144 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="144" height="92" fill="url(#lmCgGold)"/>${GRAT}<circle cx="72" cy="52" r="33" fill="#fffaf4" fill-opacity=".55"/><g transform="translate(41.6 10) scale(.95)">${medalSvg(l.badge.emoji)}</g>${compassTiny(122, 20)}${star(26, 24, 4.5, "#fffaf4")}${star(112, 72, 3.4, "#dc9aa3")}</svg>`;
  return `<svg viewBox="0 0 144 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="144" height="92" fill="url(#lmCgBlush)"/>${GRAT}${bigEnvOpen(66, 52)}${rose(104, 46, 0.95, "#c27c87", 1.3)}${star(28, 24, 4.5, "#fffaf4")}${star(116, 74, 3, "#b8995e")}</svg>`;
}
const illMark = () => `<svg viewBox="0 0 144 92" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="144" height="92" fill="url(#lmCgPaper)"/>${GRAT}<ellipse cx="70" cy="78" rx="14" ry="3.4" fill="#c27c87" fill-opacity=".18"/>${pushpin(64, 46, 2.2)}<g transform="translate(102 26)"><rect x="-17" y="-11" width="34" height="21" rx="6" fill="#fffaf4" stroke="#dfd0ca" stroke-width=".8"/><path d="M-7 9.6-10 16-2 9.8Z" fill="#fffaf4"/><path d="${HEART}" transform="translate(0 -.4) scale(1.05)" fill="#dc9aa3"/></g>${star(26, 26, 4.5, "#fffaf4")}${star(118, 72, 3.4, "#b8995e")}</svg>`;
const illStop = (n) => `<svg viewBox="0 0 76 76" aria-hidden="true"><rect width="76" height="76" fill="url(#lmCgGold)"/><path d="M8 60C24 52 22 30 38 38S58 22 70 14" fill="none" stroke="#a27b85" stroke-width="2" stroke-linecap="round" stroke-dasharray=".1 6"/><circle cx="38" cy="38" r="17.5" fill="#fffaf4" stroke="#b8995e" stroke-opacity=".55" stroke-width="1"/><circle cx="38" cy="38" r="14" fill="#fffaf4" stroke="#b8995e" stroke-width="1.6"/><text x="38" y="44" font-size="17" font-weight="600" text-anchor="middle" fill="#7e6233" font-family="Cormorant Garamond, Georgia, serif">${n}</text>${star(62, 58, 3.6, "#fffaf4")}</svg>`;
const Art = ({ html }) => <span className="art" dangerouslySetInnerHTML={{ __html: html }} />;

// 共用渐变 / 滤镜（宽高 0 但不 display:none，别的 SVG 才引用得到）
const Defs = () => (
  <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
    <defs>
      <radialGradient id="lmFogGrad" cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="#E3A2AC" stopOpacity=".42" /><stop offset=".62" stopColor="#DC9AA3" stopOpacity=".24" /><stop offset="1" stopColor="#DC9AA3" stopOpacity=".07" /></radialGradient>
      <linearGradient id="lmGold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f3e5bf" /><stop offset=".3" stopColor="#cdb074" /><stop offset=".52" stopColor="#957340" /><stop offset=".74" stopColor="#dcc48c" /><stop offset="1" stopColor="#6f532a" /></linearGradient>
      <radialGradient id="lmEnamel" cx=".38" cy=".32" r=".8"><stop offset="0" stopColor="#8f2d46" /><stop offset=".55" stopColor="#5d1729" /><stop offset="1" stopColor="#360a17" /></radialGradient>
      <radialGradient id="lmWax" cx=".36" cy=".3" r=".78"><stop offset="0" stopColor="#f4d0d4" /><stop offset=".55" stopColor="#dc9aa3" /><stop offset="1" stopColor="#bf7782" /></radialGradient>
      <radialGradient id="lmWaxAccent" cx=".36" cy=".3" r=".78"><stop offset="0" stopColor={ACCENT_LIGHT} /><stop offset=".55" stopColor={ACCENT} /><stop offset="1" stopColor={ACCENT_DEEP} /></radialGradient>
      <linearGradient id="lmRibbon" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#4a1222" /><stop offset=".14" stopColor="#4a1222" /><stop offset=".14" stopColor="#eadfc4" /><stop offset=".21" stopColor="#eadfc4" />
        <stop offset=".21" stopColor="#b0904f" /><stop offset=".25" stopColor="#b0904f" /><stop offset=".25" stopColor="#6b1d33" /><stop offset=".75" stopColor="#6b1d33" />
        <stop offset=".75" stopColor="#b0904f" /><stop offset=".79" stopColor="#b0904f" /><stop offset=".79" stopColor="#eadfc4" /><stop offset=".86" stopColor="#eadfc4" /><stop offset=".86" stopColor="#4a1222" /><stop offset="1" stopColor="#4a1222" />
      </linearGradient>
      <linearGradient id="lmRibbonShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".16" /><stop offset=".35" stopColor="#fff" stopOpacity="0" /><stop offset="1" stopColor="#000" stopOpacity=".22" /></linearGradient>
      <linearGradient id="lmCgBlush" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f3dfdc" /><stop offset="1" stopColor="#f8f1ea" /></linearGradient>
      <linearGradient id="lmCgAccent" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={ACCENT_LIGHT} stopOpacity=".45" /><stop offset="1" stopColor="#f8efec" /></linearGradient>
      <linearGradient id="lmCgGold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#efe3c6" /><stop offset="1" stopColor="#f8f2e6" /></linearGradient>
      <linearGradient id="lmCgPaper" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ece2d6" /><stop offset="1" stopColor="#f8f3ec" /></linearGradient>
      <filter id="lmSepia" colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values=".43 .85 .21 0 0  .38 .75 .18 0 0  .3 .58 .14 0 0  0 0 0 1 0" /></filter>
      <filter id="lmGrainF" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch" /><feColorMatrix values="0 0 0 0 .45  0 0 0 0 .35  0 0 0 0 .32  0 0 0 .09 0" /></filter>
      <pattern id="lmGrainP" width="140" height="140" patternUnits="userSpaceOnUse"><rect width="140" height="140" filter="url(#lmGrainF)" /></pattern>
    </defs>
  </svg>
);
const Tags = ({ list = [], className = "" }) => (list.length ? <div className={`lm-tags ${className}`}>{list.map((c) => <span key={c} className={`lm-tag ${CONTENT_CLASS[c]}`}>{CONTENT_LABEL[c]}</span>)}</div> : null);
const Pdots = ({ visits = 0, needed }) => <span className="lm-pdots" aria-hidden="true">{Array.from({ length: needed }, (_, i) => <i key={i} className={i < visits ? "on" : ""} />)}</span>;

const tearIcon = (html, big) => L.divIcon({ className: "", html, iconSize: big ? [56, 70] : [48, 60], iconAnchor: big ? [28, 66.5] : [24, 57] });
const smIcon = (html) => L.divIcon({ className: "", html, iconSize: [40, 50], iconAnchor: [20, 47.5] });
const PAD_SHEET = { paddingTopLeft: [30, 250], paddingBottomRight: [30, 470], maxZoom: 16, duration: 0.8 };

export default function LettersPage() {
  const { data, mutate } = useSWR("travel-map", api.travelMap);
  if (data?.names) Object.assign(NAMES, data.names);
  const [push, setPush] = useState("default"); // 推送：unsupported / denied / default / subscribed
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const meLayerRef = useRef(null);
  const fittedRef = useRef(false);
  const firstDrawRef = useRef(true);
  const cardsRef = useRef(null);
  const [selected, setSelected] = useState(null); // { kind: "letter" | "stop" | "mark", id }
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [reading, setReading] = useState(null); // 拆开的那封 { letter, fresh }
  const [wall, setWall] = useState(false);
  const [me, setMe] = useState(null); // 点了「定位我」之后手机实时的位置 { lat, lon, acc }
  const watchRef = useRef(null); // geolocation.watchPosition 的句柄
  const flownRef = useRef(false); // 第一次拿到实时定位飞过去一次
  const [marking, setMarking] = useState(null); // 正在钉「我来过」：手机当场定位的 { lat, lon, acc }
  const [markNote, setMarkNote] = useState("");
  const [day, setDay] = useState(null); // 选中的站点胶囊（按天）
  const [page, setPage] = useState(0); // 横滑卡翻到第几页（三个小点）
  const [nearOpen, setNearOpen] = useState(true); // 「附近藏着的」收起 / 展开

  const stops = useMemo(() => unwrapStops(data?.stops || []), [data]);
  const refs = useMemo(() => stops.map((s) => s.lon), [stops]);
  const letters = useMemo(() => (data?.letters || []).map((l) => ({
    ...l,
    area: l.area && { ...l.area, lon: nearLon(l.area.lon, refs) },
    lon: l.lon != null ? nearLon(l.lon, refs) : l.lon,
  })), [data, refs]);
  const marks = useMemo(() => (data?.marks || []).map((m) => ({ ...m, lon: nearLon(m.lon, refs) })), [data, refs]);
  // 人在哪：实时定位优先，没开就用手机最后一次上报的位置（太久以前的不画）
  const her = useMemo(() => {
    const h = me || (data?.seen && Date.now() - Date.parse(data.seen.at) < FRESH_MS ? data.seen : null);
    return h && { ...h, lon: nearLon(h.lon, refs) };
  }, [me, data, refs]);
  // 足迹：按时间连成线，隔太久或跳太远（飞机）就断开
  const trackSegs = useMemo(() => {
    const segs = []; let cur = []; let prev = null;
    for (const p of data?.track || []) {
      const pt = { t: Date.parse(p.t), lat: p.lat, lon: nearLon(p.lon, refs) };
      if (prev && (pt.t - prev.t > TRACK_GAP_MS || M(pt, prev) > FLIGHT_KM * 1000)) { if (cur.length > 1) segs.push(cur); cur = []; }
      cur.push([pt.lat, pt.lon]); prev = pt;
    }
    if (cur.length > 1) segs.push(cur);
    return segs;
  }, [data, refs]);
  const days = useMemo(() => {
    const out = [];
    for (const s of stops) { const last = out[out.length - 1]; if (last?.date === s.date) last.stops.push(s); else out.push({ date: s.date, stops: [s] }); }
    return out;
  }, [stops]);
  // 附近藏着的：按离她多远排（圈：到圈边；点：到点）；不知道她在哪就按藏的时间倒着排
  const nearby = useMemo(() => {
    const arr = [];
    for (const l of letters) {
      const sealed = l.status === "sealed"; const p = sealed ? l.area : l; if (!p) continue;
      const raw = her ? M(her, p) : null;
      arr.push({ kind: "letter", id: l.id, obj: l, raw, d: raw == null ? null : sealed ? raw - l.area.r : raw, at: l.createdAt });
    }
    for (const m of marks) { const raw = her ? M(her, m) : null; arr.push({ kind: "mark", id: m.id, obj: m, raw, d: raw, at: m.createdAt }); }
    return her ? arr.sort((a, b) => Math.max(a.d, 0) - Math.max(b.d, 0) || a.raw - b.raw) : arr.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  }, [letters, marks, her]);
  const nearestId = her ? (nearby.find((i) => i.kind === "letter" && i.obj.status === "sealed") || {}).id : null;
  const sealedCount = letters.filter((l) => l.status === "sealed").length;
  const foundCount = letters.length - sealedCount;
  // 徽章墙：直接发的 + 打开过的地点里藏的；还没打开的地点里的算「还在地图上」
  const earned = useMemo(() => [
    ...(data?.badges || []).map((b) => ({ ...b, at: b.awardedAt })),
    ...letters.filter((l) => l.status === "opened" && l.badge).map((l) => ({ id: l.id, ...l.badge, place: l.place, at: l.openedAt })),
  ].sort((a, b) => (b.at || "").localeCompare(a.at || "")), [data, letters]);
  const lockedBadges = letters.filter((l) => l.status !== "opened" && l.contents?.includes("badge"));
  // 默认选中的胶囊：她离哪一站最近就哪天；不知道她在哪就第一天
  useEffect(() => {
    if (day != null || !days.length) return;
    if (!her) { setDay(0); return; }
    const ns = stops.reduce((a, b) => (M(her, b) < M(her, a) ? b : a));
    setDay(Math.max(0, days.findIndex((d) => d.stops.includes(ns))));
  }, [day, days, stops, her]);

  // 地图只建一次
  useEffect(() => {
    const map = L.map(elRef.current, { zoomControl: false, attributionControl: false }).setView([35.68, 139.76], 3);
    L.tileLayer(TILE, { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
    L.control.attribution({ position: "topright", prefix: false }).addTo(map); // 底下有卡片，署名挪到右上
    layerRef.current = L.layerGroup().addTo(map);
    meLayerRef.current = L.layerGroup().addTo(map);
    map.on("click", () => { setSelected(null); setNote(""); });
    map.on("zoomend", () => elRef.current?.classList.toggle("far", map.getZoom() < 13)); // 拉远了钉子跟着缩小
    mapRef.current = map;
    // 进页有上滑动画，容器尺寸会变——跟着重算，不然瓦片只铺一半
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(elRef.current);
    return () => { ro.disconnect(); map.remove(); mapRef.current = null; };
  }, []);
  useEffect(() => () => { if (watchRef.current != null) navigator.geolocation?.clearWatch(watchRef.current); }, []);
  useEffect(() => { getPushState().then(setPush).catch(() => {}); }, []);

  // 数据 / 选中变了重画：足迹 → 路线 → 雾圈 → 站点 → 气泡钉 → 她的图钉
  useEffect(() => {
    const map = mapRef.current; const layer = layerRef.current;
    if (!map || !data) return;
    layer.clearLayers();
    const on = (k, id) => (selected && selected.kind === k && selected.id === id ? " on" : "");
    let n = 0; const first = firstDrawRef.current;
    const delay = () => (first ? +(0.25 + n++ * 0.08).toFixed(2) : null);
    const dropCls = first ? " drop" : "";
    const pick = (kind, id, o) => (e) => { L.DomEvent.stopPropagation(e); select(kind, id, o); };

    for (const seg of trackSegs) {
      L.polyline(seg, { className: "lm-track-case", interactive: false }).addTo(layer);
      L.polyline(seg, { className: "lm-track", interactive: false }).addTo(layer);
    }
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1]; const b = stops[i];
      const flight = M(a, b) > FLIGHT_KM * 1000;
      L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { className: `lm-route${flight ? " flight" : ""}`, interactive: false }).addTo(layer);
      if (flight) {
        // 飞的那段中间放一架小飞机，机头朝下一站（✈️ 本身朝右上 45°）
        const deg = (Math.atan2(-(b.lat - a.lat), b.lon - a.lon) * 180) / Math.PI + 45;
        L.marker([(a.lat + b.lat) / 2, (a.lon + b.lon) / 2], {
          icon: L.divIcon({ className: "", html: `<span class="lm-plane"><span style="display:grid;transform:rotate(${deg.toFixed(0)}deg)">${PLANE}</span></span>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
          interactive: false,
        }).addTo(layer);
      }
    }
    // 封着的：腮红粉柔光雾圈（大圈画在小圈下面，不然 9 公里那片会吃掉科约阿坎那片的点击）
    [...letters].filter((l) => l.status === "sealed" && l.area).sort((a, b) => b.area.r - a.area.r).forEach((l) => {
      L.circle([l.area.lat, l.area.lon], { radius: l.area.r, className: `lm-fog${on("letter", l.id)}` }).on("click", pick("letter", l.id, l)).addTo(layer);
    });
    stops.forEach((s, i) => {
      L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", html: `<span class="lm-stop${on("stop", s.id)}">${i + 1}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 100 }).on("click", pick("stop", s.id, s)).addTo(layer);
    });
    for (const l of letters) {
      const sel = on("letter", l.id); const o = { cls: sel + dropCls, delay: delay() };
      let html; let pos; let z = 400; let big = false;
      if (l.status === "sealed") {
        if (!l.area) continue;
        pos = [l.area.lat, l.area.lon];
        if (l.id === nearestId) { html = PIN.nearest(o); z = 900; big = true; } else html = PIN.sealed(o);
      } else {
        pos = [l.lat, l.lon]; z = 500;
        html = l.status === "found" ? PIN.found(o) : l.badge ? PIN.medal(l.badge.emoji, o) : PIN.opened(o);
      }
      L.marker(pos, { icon: tearIcon(html, big), zIndexOffset: sel ? 1400 : z }).on("click", pick("letter", l.id, l)).addTo(layer);
    }
    for (const m of marks) {
      const sel = on("mark", m.id);
      L.marker([m.lat, m.lon], { icon: smIcon(PIN.mark({ cls: sel + dropCls, delay: delay() })), zIndexOffset: sel ? 1400 : 450 }).on("click", pick("mark", m.id, m)).addTo(layer);
    }
    if (marking) L.marker([marking.lat, nearLon(marking.lon, refs)], { icon: smIcon(PIN.pending()), zIndexOffset: 1600, interactive: false }).addTo(layer);
    firstDrawRef.current = false;

    if (!fittedRef.current) {
      // 开页框在她身边：2.5 公里内的东西 + 她自己；不知道她在哪就全图
      if (her) {
        const b = L.latLngBounds([[her.lat, her.lon], [her.lat, her.lon]]);
        for (const it of nearby) {
          if (it.raw == null || it.raw > 2500) continue;
          const o = it.obj;
          if (it.kind === "letter" && o.status === "sealed") b.extend(L.latLng(o.area.lat, o.area.lon).toBounds(o.area.r * 2)); else b.extend([o.lat, o.lon]);
        }
        map.fitBounds(b, { paddingTopLeft: [24, 250], paddingBottomRight: [24, 380], maxZoom: 16, animate: false });
      } else {
        const pts = [...stops.map((s) => [s.lat, s.lon]), ...letters.map((l) => (l.status === "sealed" ? [l.area.lat, l.area.lon] : [l.lat, l.lon])), ...marks.map((m) => [m.lat, m.lon])];
        if (pts.length) map.fitBounds(pts, { paddingTopLeft: [24, 250], paddingBottomRight: [24, 380], maxZoom: 14 });
      }
      fittedRef.current = true;
    }
  }, [data, refs, stops, letters, marks, trackSegs, selected, marking, nearestId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 她自己：马卡龙粉圆点 + 呼吸光 + 误差圈
  useEffect(() => {
    const layer = meLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!her) return;
    if (her.acc > 25) L.circle([her.lat, her.lon], { radius: her.acc, className: "lm-me-acc", interactive: false }).addTo(layer);
    L.marker([her.lat, her.lon], { icon: L.divIcon({ className: "", html: '<span class="lm-me"></span>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false, zIndexOffset: 1500 }).addTo(layer);
  }, [her]);

  function select(kind, id, o) {
    setSelected({ kind, id }); setMarking(null); setNote("");
    const map = mapRef.current; if (!map || !o) return;
    if (kind === "letter" && o.status === "sealed") map.flyToBounds(L.latLng(o.area.lat, o.area.lon).toBounds(o.area.r * 2.2), PAD_SHEET);
    else if (kind === "stop") map.flyToBounds(L.latLng(o.lat, o.lon).toBounds(30000), PAD_SHEET);
    else map.flyToBounds(L.latLng(o.lat, o.lon).toBounds(500), PAD_SHEET);
  }
  const sel = selected && (selected.kind === "letter" ? letters.find((l) => l.id === selected.id) : selected.kind === "mark" ? marks.find((m) => m.id === selected.id) : stops.find((s) => s.id === selected.id));
  // 封着的那片圈离她多远（圈心到她，减掉圈的半径——不比圈本身多露什么）
  const nearText = (area) => {
    if (!her || !area) return "";
    const d = M(her, area) - area.r;
    return d <= 0 ? "你就在这片圈里" : `离这片圈${awayText(d)}`;
  };
  const inCircle = (area) => !!her && !!area && M(her, area) - area.r <= 0;

  // 「定位我」：第一次开始实时定位、飞过去；之后再点就是回到她身上
  function startLocate() {
    const map = mapRef.current;
    if (watchRef.current != null) { if (her) map?.flyTo([her.lat, her.lon], Math.max(map.getZoom(), 15), { duration: 0.8 }); return; }
    if (!navigator.geolocation) { setNote("这台设备拿不到定位"); return; }
    watchRef.current = navigator.geolocation.watchPosition(
      (p) => {
        const pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
        setMe(pos);
        if (!flownRef.current) { flownRef.current = true; mapRef.current?.flyTo([pos.lat, nearLon(pos.lon, refs)], Math.max(mapRef.current.getZoom(), 15), { duration: 0.8 }); }
      },
      (e) => { navigator.geolocation.clearWatch(watchRef.current); watchRef.current = null; setNote(e.code === 1 ? "要允许定位，才看得到你自己在哪" : "定位没拿到，再试一次"); },
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
  }
  // 「开通知」：订阅 Web Push；不支持 / 没给权限就在底下说一句
  async function enablePush() {
    setNote("");
    try { setPush(await subscribeToPush()); setNote("走到藏东西的附近会推送提醒你"); } catch (e) { setNote(e.message); }
  }
  // 「我来过」：手机当场定位 → 底下出一张抽屉留一句话 → 钉下
  async function pinHere() {
    setBusy("pin"); setNote("");
    try {
      const pos = await locateMe();
      setSelected(null); setMarking(pos); setMarkNote("");
      mapRef.current?.flyToBounds(L.latLng(pos.lat, nearLon(pos.lon, refs)).toBounds(250), { paddingTopLeft: [30, 250], paddingBottomRight: [30, 380], maxZoom: 16, duration: 0.8 });
    } catch (e) { setNote(e.message); } finally { setBusy(false); }
  }
  async function dropMark() {
    setBusy(true); setNote("");
    try {
      const r = await api.addMark({ ...marking, note: markNote });
      setMarking(null);
      await mutate();
      setSelected({ kind: "mark", id: r.mark.id });
    } catch (e) { setNote(e.message || "没钉上，再试一次"); } finally { setBusy(false); }
  }
  async function removeMark(id) {
    setBusy(true); setNote("");
    try { await api.removeMark(id); setSelected(null); mutate(); } catch (e) { setNote(e.message || "没拔掉，再试一次"); } finally { setBusy(false); }
  }
  async function open(letter) {
    setBusy(true); setNote("");
    try {
      const pos = letter.status === "sealed" ? await locateMe() : {};
      const r = await api.openLetter(letter.id, pos);
      if (!r.ok && r.visitsNeeded) { // 要来好几天的：今天记上一次
        setNote(r.counted ? `今天这次记上了 ✓ ${r.visits}/${r.visitsNeeded}` : `今天已经记过了 · ${r.visits}/${r.visitsNeeded}`);
        mutate();
        return;
      }
      if (!r.ok) { setNote(`${awayText(r.awayM)}——走近一点再试`); return; }
      setReading({ letter: r.letter, fresh: letter.status !== "opened" });
      mutate();
    } catch (e) {
      setNote(e.message || "没拆开，再试一次");
    } finally {
      setBusy(false);
    }
  }
  const onCardsScroll = () => {
    const c = cardsRef.current; if (!c) return;
    const max = c.scrollWidth - c.clientWidth;
    setPage(max > 0 ? Math.round((c.scrollLeft / max) * 2) : 0);
  };

  return (
    <div className="lm-page">
      <Defs />
      <div ref={elRef} className="lm-map" />
      <div className="lm-grain-veil" /><div className="lm-veil-top" /><div className="lm-veil-bot" />

      <header className="lm-head">
        <div>
          <div className="en">Letters along the way</div>
          <div className="row">
            <h1>藏信地图</h1>
            <p className="sub">{letters.length ? <><b>{sealedCount}</b> 处还藏着<i /><b>{foundCount}</b> 处找到了</> : `${NAMES.hider}还没开始藏东西`}</p>
          </div>
        </div>
        <button type="button" className="lm-wall-btn" aria-label="徽章墙" onClick={() => setWall(true)}>
          <span className="lm-mini-coin">★</span>{earned.length > 0 && <b>{earned.length}</b>}
        </button>
      </header>
      {days.length > 0 && (
        <nav className="lm-chips" aria-label="旅程站点">
          {days.map((d, i) => (
            <button key={d.date} type="button" className={`lm-chip${i === day ? " on" : ""}`} onClick={() => {
              setDay(i); setSelected(null); setNote("");
              const s = d.stops[0]; mapRef.current?.flyTo([s.lat, s.lon], 12, { duration: 0.9 });
            }}>{d.stops.map((s) => s.name).join(" · ")}<small>{md(d.date)}</small></button>
          ))}
        </nav>
      )}

      {/* 附近藏着的：横滑卡（没选中、没在钉图钉时） */}
      <section className={`lm-near${sel || marking ? " hide" : ""}${nearOpen ? "" : " closed"}`}>
        <div className="lm-near-head">
          <h3><button type="button" aria-expanded={nearOpen} onClick={() => setNearOpen((v) => !v)}>附近藏着的<ChevronDown className="lm-ic" /></button></h3>
          <div className="lm-dots" aria-hidden="true">{[0, 1, 2].map((i) => <i key={i} className={i === page ? "on" : ""} />)}</div>
        </div>
        <div className="lm-cards" ref={cardsRef} onScroll={onCardsScroll}>
          {nearby.map((it, i) => {
            const o = it.obj; const style = { animationDelay: `${(0.2 + i * 0.06).toFixed(2)}s` };
            if (it.kind === "mark") return (
              <button key={o.id} type="button" className="lm-card" style={style} onClick={() => select("mark", o.id, o)}>
                <div className="lm-ill"><Art html={illMark()} /><span className="lm-kick k-mark">I WAS HERE</span></div>
                <h4>{o.note || "我来过。"}</h4><p className="tg">{mdAt(o.createdAt)} 钉的</p>
                <p className="ad"><MapPin className="lm-ic" />{dm(o.lat, "N", "S")} · {dm(wrapLon(o.lon), "E", "W")}</p>
                {it.raw != null && <p className="ft"><Route className="lm-ic" />{distText(it.raw)}</p>}
              </button>
            );
            if (o.status === "sealed") return (
              <button key={o.id} type="button" className="lm-card" style={style} onClick={() => select("letter", o.id, o)}>
                <div className="lm-ill"><Art html={illSealed(o, o.id === nearestId)} /><span className="lm-kick k-sealed">SEALED</span></div>
                <h4>{o.hint}</h4><p className="tg">{(o.contents || []).map((c) => CONTENT_LABEL[c]).join(" · ")}</p>
                <p className="ad"><MapPin className="lm-ic" />{mdAt(o.createdAt)} 藏的</p>
                {o.visitsNeeded > 1 ? <p className="ft"><Pdots visits={o.visits} needed={o.visitsNeeded} />来过 {o.visits || 0} 天 · 满 {o.visitsNeeded} 天解锁</p>
                  : her ? <p className="ft">{it.d <= 0 ? <span className="lm-medot" /> : <Route className="lm-ic" />}{nearText(o.area)}</p> : null}
              </button>
            );
            const opened = o.status === "opened";
            return (
              <button key={o.id} type="button" className="lm-card" style={style} onClick={() => select("letter", o.id, o)}>
                <div className="lm-ill"><Art html={illOpened(o)} /><span className={`lm-kick ${opened ? "k-opened" : "k-found"}`}>{opened ? "OPENED" : "FOUND"}</span></div>
                <h4 className="place">{o.place}</h4><p className="tg">{(o.contents || []).map((c) => CONTENT_LABEL[c]).join(" · ")}</p>
                <p className="ad"><MapPin className="lm-ic" />{opened ? `${mdAt(o.openedAt)} 打开的` : "你走到了，东西在这里"}</p>
                {it.raw != null && <p className="ft"><Route className="lm-ic" />{distText(it.raw)}</p>}
              </button>
            );
          })}
        </div>
      </section>

      {/* 大卡：点开一张 */}
      {sel && !marking && (
        <section className="lm-sheet" key={`${selected.kind}:${selected.id}`}>
          <button type="button" className="lm-x" aria-label="收起" onClick={() => { setSelected(null); setNote(""); }}><X size={17} strokeWidth={1.5} /></button>
          {selected.kind === "stop" ? (
            <>
              <div className="lm-krow"><span className="lm-kick k-stop">STOP</span>{md(sel.date)}{sel.trip ? ` · ${sel.trip}` : ""}</div>
              <div className="lm-sh-main"><div className="lm-sh-ill"><Art html={illStop(stops.indexOf(sel) + 1)} /></div><div><p className="lm-sh-title place">{sel.name}</p>{sel.note && <p className="lm-sh-sub mix">{sel.note}</p>}</div></div>
            </>
          ) : selected.kind === "mark" ? (
            <>
              <div className="lm-krow"><span className="lm-kick k-mark">I WAS HERE</span>{mdAt(sel.createdAt)} 钉的 · {dm(sel.lat, "N", "S")} · {dm(wrapLon(sel.lon), "E", "W")}</div>
              <div className="lm-sh-main"><div className="lm-sh-ill"><Art html={illMark()} /></div><p className="lm-sh-title">{sel.note || "我来过。"}</p></div>
              <button type="button" className="lm-go ghost" disabled={!!busy} onClick={() => removeMark(sel.id)}>拔掉这枚图钉</button>
              {note && <p className="lm-note">{note}</p>}
            </>
          ) : sel.status === "sealed" ? (
            <>
              <div className="lm-krow"><span className="lm-kick k-sealed">SEALED</span>这附近藏着东西 · {mdAt(sel.createdAt)} 藏的</div>
              <div className="lm-sh-main"><div className="lm-sh-ill"><Art html={illSealed(sel, sel.id === nearestId)} /></div><div>
                <p className="lm-sh-title">{sel.hint}</p>
                {her && <p className="lm-near-line">{inCircle(sel.area) ? <span className="lm-medot" /> : <Route className="lm-ic" />}{nearText(sel.area)}</p>}
              </div></div>
              <Tags list={sel.contents} />
              {sel.visitsNeeded > 1 && <div className="lm-progress"><Pdots visits={sel.visits} needed={sel.visitsNeeded} />来过 {sel.visits || 0} 天 · 满 {sel.visitsNeeded} 天解锁</div>}
              <button type="button" className="lm-go" disabled={!!busy} onClick={() => open(sel)}>
                <LocateFixed className="lm-ic" strokeWidth={1.7} /> {busy ? "看看你在哪…" : sel.visitsNeeded > 1 ? "我今天来了" : "我就在这附近"}
              </button>
              {note && <p className="lm-note">{note}</p>}
            </>
          ) : (
            <>
              <div className="lm-krow"><span className={`lm-kick ${sel.status === "opened" ? "k-opened" : "k-found"}`}>{sel.status === "opened" ? "OPENED" : "FOUND"}</span>{sel.status === "opened" ? `${mdAt(sel.openedAt)} 打开的` : "你走到了，东西在这里"}</div>
              <div className="lm-sh-main"><div className="lm-sh-ill"><Art html={illOpened(sel)} /></div><div><p className="lm-sh-title place">{sel.place}</p><p className="lm-sh-sub">{sel.hint}</p></div></div>
              <Tags list={sel.contents} />
              <button type="button" className="lm-go" disabled={!!busy} onClick={() => open(sel)}>{sel.status === "opened" ? "再看一遍" : "打开看看"}</button>
              {note && <p className="lm-note">{note}</p>}
            </>
          )}
        </section>
      )}
      {!sel && !marking && note && (
        <section className="lm-sheet">
          <button type="button" className="lm-x" aria-label="收起" onClick={() => setNote("")}><X size={17} strokeWidth={1.5} /></button>
          <p className="lm-note">{note}</p>
        </section>
      )}

      {/* 底栏：悬浮小纸胶囊 + 旧玫瑰大圆钮 */}
      <nav className="lm-bar">
        <button type="button" className="lm-bar-btn l" disabled={push === "subscribed"} onClick={enablePush}><Bell className="lm-ic" strokeWidth={1.5} />{push === "subscribed" ? "通知已开" : "开通知"}</button>
        <button type="button" className={`lm-fab${me ? " on" : ""}`} aria-label="定位我" onClick={startLocate}><Navigation className="lm-ic" strokeWidth={1.7} /></button>
        <button type="button" className="lm-bar-btn r" disabled={busy === "pin"} onClick={pinHere}><MapPin className="lm-ic" strokeWidth={1.5} />我来过</button>
      </nav>

      {/* HERE 留言抽屉 */}
      {marking && (
        <section className="lm-drawer">
          <div className="lm-grab" />
          <button type="button" className="lm-x" aria-label="收起" onClick={() => setMarking(null)}><X size={17} strokeWidth={1.5} /></button>
          <div className="lm-krow"><span className="lm-kick k-here">HERE</span>钉在你现在站的地方 · {dm(marking.lat, "N", "S")} · {dm(marking.lon, "E", "W")}</div>
          <textarea className="lm-mark-input" rows={3} maxLength={200} placeholder={`留一句话给${NAMES.hider}，不写也行`} value={markNote} onChange={(e) => setMarkNote(e.target.value)} />
          <button type="button" className="lm-go" disabled={!!busy} onClick={dropMark}><MapPin className="lm-ic" strokeWidth={1.7} /> {busy ? "钉着…" : "我来过"}</button>
          {note && <p className="lm-note">{note}</p>}
        </section>
      )}

      {reading && <Reading letter={reading.letter} fresh={reading.fresh} onClose={() => setReading(null)} />}
      {wall && <BadgeWall earned={earned} locked={lockedBadges} onClose={() => setWall(false)} />}
    </div>
  );
}

// 复古旧金奖牌：上面一段罗纹缎带折成 V、小金环挂着；奖牌本身是 SVG——滚花边、刻字一圈、酒红机刻珐琅心、旧金浮雕图案；
// 后面三层金边 translateZ 叠出厚度，平时轻轻左右摇。drop = 刚解锁（转着落下、星点散开）；locked = 还没拿到的旧锡「?」
const GUILLOCHE = Array.from({ length: 11 }, (_, i) => 4 + i * 2.2);
const SUNBURST = Array.from({ length: 36 }, (_, i) => (i * Math.PI) / 18);
function Medal({ emoji, locked = false, drop = false, spinKey = 0, size = 62 }) {
  const uid = useId().replace(/:/g, "");
  const gold = `lmg${uid}`; const enamel = `lme${uid}`; const ring = `lmr${uid}`;
  const motto = `FOR ${NAMES.finder.toUpperCase()} · WITH LOVE · `;
  return (
    <span className={`lm-medal${locked ? " locked" : ""}${drop ? " drop" : ""}`} style={{ "--m": `${size}px` }}>
      <span className="lm-medal-ribbon" aria-hidden="true" />
      <span className="lm-medal-ring" aria-hidden="true" />
      <span key={spinKey} className={`lm-medal-coin${spinKey ? " spin" : ""}`}>
        <span className="lm-medal-edge e3" />
        <span className="lm-medal-edge e2" />
        <span className="lm-medal-edge" />
        <svg className="lm-medal-svg" viewBox="0 0 100 100" aria-hidden="true">
          <defs>
            <linearGradient id={gold} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#f3e5bf" /><stop offset=".3" stopColor="#cdb074" /><stop offset=".52" stopColor="#957340" /><stop offset=".74" stopColor="#dcc48c" /><stop offset="1" stopColor="#6f532a" />
            </linearGradient>
            <radialGradient id={enamel} cx=".38" cy=".32" r=".8"><stop offset="0" stopColor="#8f2d46" /><stop offset=".55" stopColor="#5d1729" /><stop offset="1" stopColor="#360a17" /></radialGradient>
            <path id={ring} d="M50,50 m-37.5,0 a37.5,37.5 0 1,1 75,0 a37.5,37.5 0 1,1 -75,0" />
          </defs>
          <circle cx="50" cy="50" r="49.5" fill={`url(#${gold})`} />
          <circle cx="50" cy="50" r="48.2" fill="none" stroke="#4d3818" strokeOpacity=".5" strokeWidth="2.4" strokeDasharray=".6 1.05" />
          <circle cx="50" cy="50" r="45.6" fill="none" stroke="#4d3818" strokeOpacity=".45" strokeWidth=".7" />
          <circle cx="50" cy="50" r="45" fill="none" stroke="#fff6dc" strokeOpacity=".55" strokeWidth=".5" />
          {GUILLOCHE.map((r) => <circle key={`o${r}`} cx="50" cy="50" r={r + 22} fill="none" stroke="#4d3818" strokeOpacity=".05" strokeWidth=".4" />)}
          <text className="lm-medal-motto" fill="#fff4d6" fillOpacity=".5" transform="translate(0 .45)"><textPath href={`#${ring}`} textLength="231" lengthAdjust="spacing">{motto}</textPath></text>
          <text className="lm-medal-motto" fill="#4d3818" fillOpacity=".85"><textPath href={`#${ring}`} textLength="231" lengthAdjust="spacing">{motto}</textPath></text>
          <circle cx="50" cy="50" r="29.5" fill={`url(#${gold})`} />
          <circle cx="50" cy="50" r="29.5" fill="none" stroke="#4d3818" strokeOpacity=".5" strokeWidth=".5" />
          <circle cx="50" cy="50" r="27" fill={`url(#${enamel})`} />
          {GUILLOCHE.map((r) => <circle key={r} cx="50" cy="50" r={r} fill="none" stroke="#fff" strokeOpacity=".07" strokeWidth=".35" />)}
          {SUNBURST.map((a, i) => <line key={i} x1="50" y1="50" x2={50 + 27 * Math.cos(a)} y2={50 + 27 * Math.sin(a)} stroke="#fff" strokeOpacity=".045" strokeWidth=".5" />)}
          <ellipse cx="42" cy="39" rx="15" ry="9" fill="#fff" fillOpacity=".08" />
        </svg>
        <span className="lm-medal-icon"><i>{emoji}</i></span>
        <span className="lm-medal-shine" />
      </span>
      {drop && <span className="lm-medal-sparks" aria-hidden="true">{Array.from({ length: 8 }, (_, i) => <b key={i} style={{ "--a": `${i * 45}deg` }}>✦</b>)}</span>}
    </span>
  );
}

// 徽章墙：米白纸半屏抽屉
function BadgeWall({ earned, locked, onClose }) {
  const [peek, setPeek] = useState(null);
  const [spins, setSpins] = useState({}); // 点一下转一圈：每点一次 key +1 重放动画
  const peeked = earned.find((b) => b.id === peek);
  return (
    <div className="lm-wall-bg" role="dialog" aria-label="徽章墙" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="lm-wall">
        <div className="lm-grab" />
        <button type="button" className="lm-x" aria-label="收起" onClick={onClose}><X size={17} strokeWidth={1.5} /></button>
        <h3>徽章 <em>Médailles</em></h3>
        <p className="sub">{earned.length} 枚亮着{locked.length ? ` · 还有 ${locked.length} 枚在地图上等你` : ""}</p>
        {earned.length || locked.length ? (
          <div className="lm-wall-grid">
            {earned.map((b) => (
              <button key={b.id} type="button" className={`lm-cell${peek === b.id ? " on" : ""}`} onClick={() => {
                setPeek(peek === b.id ? null : b.id);
                setSpins((m) => ({ ...m, [b.id]: (m[b.id] || 0) + 1 }));
              }}>
                <Medal emoji={b.emoji} spinKey={spins[b.id] || 0} />
                <b>{b.name}</b>
                <small>{mdAt(b.at)}{b.place ? ` · ${b.place}` : ""}</small>
              </button>
            ))}
            {locked.map((l) => (
              <div key={l.id} className="lm-cell locked">
                <Medal emoji="?" locked />
                <b>还在地图上</b>
                <small>{l.visitsNeeded > 1 ? `来过 ${l.visits}/${l.visitsNeeded} 天` : "走到那儿就亮"}</small>
              </div>
            ))}
          </div>
        ) : <p className="lm-wall-empty">{`还没有徽章，${NAMES.hider}会慢慢给你攒`}</p>}
        {peeked?.note && <p className="lm-wall-note">{peeked.note}</p>}
      </section>
    </div>
  );
}

// 语音讲解：拆封那一下就开始播（点封蜡是手势，iOS 放行）；这里是暂停 / 重听 / 字幕
function VoicePlayer({ audio, text }) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState({ cur: 0, dur: 0 });
  const [showText, setShowText] = useState(false);
  useEffect(() => {
    const a = audio.current;
    if (!a) return undefined;
    const sync = () => {
      setPlaying(!a.paused && !a.ended);
      setTime({ cur: a.currentTime || 0, dur: Number.isFinite(a.duration) ? a.duration : 0 });
    };
    const events = ["play", "pause", "ended", "timeupdate", "loadedmetadata"];
    events.forEach((e) => a.addEventListener(e, sync));
    sync();
    return () => events.forEach((e) => a.removeEventListener(e, sync));
  }, [audio]);
  const toggle = () => { const a = audio.current; if (a) (a.paused ? a.play().catch(() => {}) : a.pause()); };
  return (
    <div className="lm-voice">
      <button type="button" className="lm-voice-btn" onClick={toggle} aria-label={playing ? "暂停" : "播放"}>
        {playing ? <Pause size={15} fill="currentColor" strokeWidth={0} /> : <Play size={15} fill="currentColor" strokeWidth={0} />}
      </button>
      <div className="lm-voice-main">
        <div className="lm-voice-label">{NAMES.hider}的语音 <em>audio guide</em><span>{mmss(time.dur ? time.dur - time.cur : 0)}</span></div>
        <div className="lm-voice-bar"><i style={{ width: `${time.dur ? (time.cur / time.dur) * 100 : 0}%` }} /></div>
      </div>
      <button type="button" className={`lm-voice-cc${showText ? " on" : ""}`} onClick={() => setShowText((v) => !v)}>字幕</button>
      {showText && <p className="lm-voice-text">{text}</p>}
    </div>
  );
}

// 封蜡：图形只管「高度」（fill-opacity 越大越高：蜡边 < 压下去的圆 < 圈线 < 心），颜色和光影全在滤镜里——
// 先按形状铺腮红粉，再用漫反射 + 高光按高度图打光，蜡的厚边、压痕、凸起的心就出来了。
function WaxSeal() {
  const f = `wax${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <filter id={f} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
          <feComponentTransfer in="SourceAlpha" result="mask"><feFuncA type="discrete" tableValues="0 1 1 1 1 1 1 1 1 1" /></feComponentTransfer>
          <feFlood floodColor="#dfa0a8" result="tint" />
          <feComposite in="tint" in2="mask" operator="in" result="base" />
          <feGaussianBlur in="SourceAlpha" stdDeviation="1.3" result="height" />
          <feDiffuseLighting in="height" surfaceScale="5" diffuseConstant="1.1" lightingColor="#ffffff" result="diffuseRaw">
            <feDistantLight azimuth="225" elevation="58" />
          </feDiffuseLighting>
          {/* 背光面别黑成一圈描边：明暗压到 0.5–1 之间，最暗也只是深一点的粉 */}
          <feComponentTransfer in="diffuseRaw" result="diffuse">
            <feFuncR type="linear" slope=".52" intercept=".5" /><feFuncG type="linear" slope=".52" intercept=".5" /><feFuncB type="linear" slope=".52" intercept=".5" />
          </feComponentTransfer>
          <feComposite in="diffuse" in2="mask" operator="in" result="diffuseIn" />
          <feBlend in="base" in2="diffuseIn" mode="multiply" result="shaded" />
          <feSpecularLighting in="height" surfaceScale="5" specularConstant="0.5" specularExponent="26" lightingColor="#fff6f6" result="spec">
            <feDistantLight azimuth="225" elevation="52" />
          </feSpecularLighting>
          <feComposite in="spec" in2="mask" operator="in" result="specIn" />
          <feComposite in="shaded" in2="specIn" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" />
        </filter>
      </defs>
      <g filter={`url(#${f})`}>
        {/* 蜡边是个中间挖空的环（透明度只会越叠越高，压下去的圆得单独画才比蜡边低） */}
        <path fillOpacity=".55" fillRule="evenodd" d="M50 6c7 0 11 3 16 5s11 2 14 7 2 10 5 15 5 9 4 15-5 9-6 14-1 11-6 15-10 3-15 6-8 7-14 7-10-4-15-6-11-2-15-6-3-10-6-14-6-8-5-14 4-10 5-15 0-11 4-15 10-4 15-7 8-7 14-7Z M81 50a31 31 0 1 0 -62 0a31 31 0 1 0 62 0Z" />
        <circle fillOpacity=".34" cx="50" cy="50" r="31" />
        <circle fillOpacity=".62" cx="50" cy="50" r="31" fill="none" stroke="#000" strokeOpacity=".62" strokeWidth="2.4" />
        <circle fillOpacity="0" cx="50" cy="50" r="25.5" fill="none" stroke="#000" strokeOpacity=".5" strokeWidth=".9" />
        <path fillOpacity=".8" d="M50 64s-15-8.6-15-18.4c0-4.8 3.6-8.4 8.1-8.4 3 0 5.5 1.6 6.9 4 1.4-2.4 3.9-4 6.9-4 4.5 0 8.1 3.6 8.1 8.4C65 55.4 50 64 50 64Z" />
      </g>
    </svg>
  );
}

// 拆开的那封：第一次走封蜡仪式（封口翻开、信纸抽出），拆完接到详情页；重读直接是详情页
function Reading({ letter, fresh, onClose }) {
  const [stage, setStage] = useState(fresh ? "closed" : "read"); // closed → opening → read
  const audioRef = useRef(null);
  useEffect(() => {
    if (stage !== "opening") return undefined;
    const t = window.setTimeout(() => setStage("read"), 1750);
    return () => window.clearTimeout(t);
  }, [stage]);
  const hasPoint = Number.isFinite(letter.lat) && Number.isFinite(letter.lon);
  return (
    <>
      {letter.voice && <audio ref={audioRef} src={letter.voice.url} preload="auto" playsInline />}
      {stage !== "read" ? (
        <div className={`lm-env-overlay ${stage}`} role="dialog" aria-label={`藏在${letter.place}的东西`}>
          <button type="button" className="lm-env" onClick={() => { setStage("opening"); audioRef.current?.play().catch(() => {}); }} aria-label="拆开">
            <span className="lm-env-inside" />
            <span className="lm-env-paper" />
            <span className="lm-env-panel side-l"><i /></span>
            <span className="lm-env-panel side-r"><i /></span>
            <span className="lm-env-panel bottom"><i /></span>
            {hasPoint && <span className="lm-env-emboss"><b>{letter.place}</b>{dm(letter.lat, "N", "S")} · {dm(wrapLon(letter.lon), "E", "W")}</span>}
            <span className="lm-env-panel flap"><i /><em>you found it</em></span>
            <span className="lm-env-seal"><WaxSeal /></span>
          </button>
          <span className="lm-env-tip">{stage === "closed" ? "轻点封蜡" : ""}</span>
        </div>
      ) : (
        <DetailPage letter={letter} fresh={fresh} audioRef={audioRef} onClose={onClose} />
      )}
    </>
  );
}

// 详情页：地图快照打底 + 拆开的信封（封口翻上去、信纸抽出来、封蜡还压在底片上）+ 胶囊 + 地名 + 坐标 + 日期 + 谜语 + 信纸 + 语音条 + 证书
function DetailPage({ letter, fresh, audioRef, onClose }) {
  const heroRef = useRef(null);
  const certRef = useRef(null);
  const [spin, setSpin] = useState(0);
  const hasPoint = Number.isFinite(letter.lat) && Number.isFinite(letter.lon);
  useEffect(() => {
    if (!hasPoint || !heroRef.current) return undefined;
    const m = L.map(heroRef.current, { zoomControl: false, attributionControl: false, dragging: false, touchZoom: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false });
    L.tileLayer(TILE, { maxZoom: 19 }).addTo(m);
    m.setView([letter.lat, letter.lon], 16, { animate: false });
    const t = window.setTimeout(() => m.invalidateSize(), 500);
    return () => { window.clearTimeout(t); m.remove(); };
  }, [hasPoint, letter.lat, letter.lon]);
  const date = mdAt(letter.openedAt);
  const coords = hasPoint ? `${dm(letter.lat, "N", "S")} · ${dm(wrapLon(letter.lon), "E", "W")}` : "";
  return (
    <section className="lm-detail" role="dialog" aria-label={`藏在${letter.place}的东西`}>
      <div className="lm-dt-hero">
        <div ref={heroRef} className="lm-hero-map" />
        <div className="lm-dt-veil" />
        <div className="lm-he" aria-hidden="true">
          <span className="lm-he-shadow" /><span className="lm-he-flap"><i /></span><span className="lm-he-inside" />
          <span className="lm-he-paper"><em>you found it</em></span>
          <span className="lm-he-panel side-l"><i /></span><span className="lm-he-panel side-r"><i /></span><span className="lm-he-panel bottom"><i /></span>
          <span className="lm-he-emboss"><b>{letter.place}</b>{coords}</span>
          <span className="lm-he-seal"><WaxSeal /></span>
          {letter.badge && <span className="lm-he-medal"><Medal emoji={letter.badge.emoji} size={40} /></span>}
        </div>
        <button type="button" className="lm-dt-back" aria-label="返回" onClick={onClose}><ChevronLeft size={22} strokeWidth={1.5} /></button>
      </div>
      <div className="lm-dt-body">
        <div className="lm-eyebrow">藏了哪几样</div>
        <Tags list={letter.badge || letter.voice || letter.body ? ["letter", "voice", "badge"].filter((c) => (c === "letter" ? letter.body : c === "voice" ? letter.voice : letter.badge)) : []} />
        <div className="lm-dt-title">
          <h2>{letter.place}</h2>
          {letter.badge && <button type="button" className="lm-dt-medal" aria-label="徽章" onClick={() => { certRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); setSpin((n) => n + 1); }}><span className="lm-mini-coin lg"><i>{letter.badge.emoji}</i></span></button>}
        </div>
        {hasPoint && <p className="lm-dt-meta"><MapPin className="lm-ic" /><b>{coords}</b></p>}
        <p className="lm-dt-meta"><Calendar className="lm-ic" />{date} 拆开</p>
        <p className="lm-dt-quote">{letter.hint}</p>
        <div className="lm-dt-sec">
          {letter.body && (
            <>
              <div className="lm-eyebrow en">HIDDEN AT · 信</div>
              {/* 信纸只留正文和落款：地名 / 坐标 / 日期上面已经各有一次 */}
              <article className="lm-letter">
                <div className="lm-letter-body">{letter.body}</div>
                <div className="lm-letter-sign">—— {NAMES.hider}</div>
              </article>
            </>
          )}
          {letter.voice && <VoicePlayer audio={audioRef} text={letter.voice.text} />}
          {letter.badge && (
            <div className="lm-unlock" ref={certRef}>
              <Medal emoji={letter.badge.emoji} drop={fresh} spinKey={spin} size={58} />
              <div><small>MÉDAILLE · 解锁徽章</small><b>{letter.badge.name}</b>{letter.badge.note && <p>{letter.badge.note}</p>}</div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
