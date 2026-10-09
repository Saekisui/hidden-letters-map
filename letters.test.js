import assert from "node:assert/strict";
import test from "node:test";
import { contentsOf, createBadge, createLetter, createMark, createStop, dayOf, distanceM, lettersInReach, makeHintArea, publicLetter, shouldRecordFrame, sortStops, visitAt } from "./letters.js";

// 蓝房子（Casa Azul）附近
const CASA_AZUL = { lat: 19.3551, lon: -99.1624 };

function seeded(seed = 1) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

test("distanceM：东京站到大阪站约 400km", () => {
  const d = distanceM({ lat: 35.6812, lon: 139.7671 }, { lat: 34.7025, lon: 135.4959 });
  assert.ok(d > 395000 && d < 405000, `got ${d}`);
});

test("模糊圈：信的整个触发范围都在圈里，但圆心偏开了", () => {
  const rand = seeded(7);
  let offCenter = 0;
  for (let i = 0; i < 500; i++) {
    const radiusM = 50 + Math.floor(rand() * 5000);
    const area = makeHintArea({ ...CASA_AZUL, radiusM }, rand);
    const d = distanceM(area, CASA_AZUL);
    assert.ok(area.r >= 300);
    assert.ok(d + radiusM <= area.r, `letter circle leaks out: d=${d} radius=${radiusM} r=${area.r}`);
    if (d > area.r * 0.05) offCenter++;
  }
  assert.ok(offCenter > 400, "圆心大多数时候都应该偏开");
});

test("createLetter：半径夹在 50–20000，默认 200，缺字段报错", () => {
  const base = { place: "蓝房子", ...CASA_AZUL, hint: "蓝色的墙里住过一个画自己的人", body: "你到了。" };
  assert.equal(createLetter(base).radiusM, 200);
  assert.equal(createLetter({ ...base, radiusM: 5 }).radiusM, 50);
  assert.equal(createLetter({ ...base, radiusM: 99999 }).radiusM, 20000);
  assert.equal(createLetter(base).status, "sealed");
  assert.throws(() => createLetter({ ...base, hint: " " }));
  assert.throws(() => createLetter({ ...base, lat: 200 }));
});

test("一个地点可以只藏语音或只藏成就，但不能什么都不藏", () => {
  const base = { place: "蓝房子", ...CASA_AZUL, hint: "h" };
  const voiceOnly = createLetter({ ...base, voice: { url: "https://example.com/x.m4a", text: "hi" } });
  assert.deepEqual(contentsOf(voiceOnly), ["voice"]);
  const badgeOnly = createLetter({ ...base, badge: { name: "蓝房子探险家", emoji: "💙" } });
  assert.deepEqual(badgeOnly.badge, { name: "蓝房子探险家", emoji: "💙", note: "" });
  assert.deepEqual(contentsOf(createLetter({ ...base, body: "b", voice: { url: "/a" }, badge: { name: "n" } })), ["letter", "voice", "badge"]);
  assert.throws(() => createLetter(base), /至少藏一样/);
  assert.throws(() => createLetter({ ...base, badge: { name: " " } }), /至少藏一样/);
});

test("createBadge：要有名字，emoji 缺省 🏅", () => {
  const b = createBadge({ name: "飞越太平洋" });
  assert.equal(b.emoji, "🏅");
  assert.ok(b.id.startsWith("badge_") && b.awardedAt);
  assert.throws(() => createBadge({ emoji: "✈️" }));
});

test("lettersInReach：只认还封着的、半径内的；定位误差最多让 50m", () => {
  const letter = createLetter({ place: "蓝房子", ...CASA_AZUL, radiusM: 200, hint: "h", body: "b" });
  const at = (m) => ({ lat: CASA_AZUL.lat + m / 111320, lon: CASA_AZUL.lon });
  assert.equal(lettersInReach([letter], { ...at(190), acc: 5 }).length, 1);
  assert.equal(lettersInReach([letter], { ...at(240), acc: 5 }).length, 0);
  assert.equal(lettersInReach([letter], { ...at(240), acc: 500 }).length, 1); // 200 + 50
  assert.equal(lettersInReach([letter], { ...at(260), acc: 500 }).length, 0);
  assert.equal(lettersInReach([{ ...letter, status: "found" }], { ...at(0), acc: 5 }).length, 0);
});

test("dayOf：同一刻在不同时区是不同的一天", () => {
  const t = Date.parse("2026-10-01T20:00:00Z");
  assert.equal(dayOf(t, "Asia/Tokyo"), "2026-10-02");
  assert.equal(dayOf(t, "America/Mexico_City"), "2026-10-01");
  assert.match(dayOf(t), /^\d{4}-\d{2}-\d{2}$/, "不传 tz 就按进程时区");
});

test("visitAt：普通的走到就找到；健身房那种一天记一次，攒够天数才解锁", () => {
  const DAY = 24 * 3600e3;
  const tz = "Asia/Tokyo";
  const t0 = Date.parse("2026-10-01T10:00:00+09:00");
  const here = { ...CASA_AZUL, acc: 5 };
  const once = createLetter({ place: "p", ...CASA_AZUL, hint: "h", body: "b" });
  assert.deepEqual(visitAt([once], here, { now: t0, tz }).map((x) => x.event), ["found"]);
  assert.equal(once.status, "found");

  const gym = createLetter({ place: "健身房", ...CASA_AZUL, hint: "h", badge: { name: "健身房常客" }, visitsNeeded: 3 });
  assert.deepEqual(visitAt([gym], here, { now: t0, tz }).map((x) => x.event), ["visit"]);
  assert.deepEqual(visitAt([gym], here, { now: t0 + 3600e3, tz }), [], "同一天练一小时的后面几帧不再算");
  assert.equal(publicLetter(gym).visits, 1);
  assert.deepEqual(visitAt([gym], { lat: 35.68, lon: 139.76, acc: 5 }, { now: t0 + DAY, tz }), [], "不在附近不算");
  assert.deepEqual(visitAt([gym], here, { now: t0 + 2 * DAY, tz }).map((x) => x.event), ["visit"]);
  assert.equal(gym.status, "sealed");
  assert.deepEqual(visitAt([gym], here, { now: t0 + 3 * DAY, tz }).map((x) => x.event), ["found"]);
  assert.equal(gym.status, "found");
  assert.deepEqual(gym.visitDays, ["2026-10-01", "2026-10-03", "2026-10-04"]);
  assert.equal(publicLetter(once).visitsNeeded, undefined, "普通的不带进度");
});

test("publicLetter：封着的只说藏了哪几样，找到给位置，拆开才给信 / 语音 / 成就", () => {
  const letter = { ...createLetter({ place: "蓝房子", ...CASA_AZUL, hint: "谜语", body: "正文", voice: { url: "/v.m4a", text: "t" }, badge: { name: "成就" } }), streetView: { file: "x.jpg", date: "2024-03" } };
  const sealed = publicLetter(letter);
  for (const k of ["place", "lat", "lon", "body", "radiusM", "voice", "badge", "streetView"]) assert.ok(!(k in sealed), `sealed leaks ${k}`);
  assert.equal(sealed.hint, "谜语");
  assert.deepEqual(sealed.contents, ["letter", "voice", "badge"]);
  const found = publicLetter({ ...letter, status: "found" });
  assert.equal(found.place, "蓝房子");
  for (const k of ["body", "voice", "badge", "streetView"]) assert.ok(!(k in found), `found leaks ${k}`);
  const opened = publicLetter({ ...letter, status: "opened" });
  assert.equal(opened.body, "正文");
  assert.equal(opened.voice.url, "/v.m4a");
  assert.equal(opened.badge.name, "成就");
  assert.deepEqual(opened.streetView, { url: `/api/travel-map/letters/${letter.id}/streetview.jpg`, date: "2024-03" });
  assert.equal(publicLetter({ ...letter, status: "opened", streetView: null }).streetView, null, "没抓到街景就是 null");
});

test("createStop / sortStops：按日期、同日按加入顺序", () => {
  let t = 1000;
  const mk = (date, name) => createStop({ date, name, ...CASA_AZUL }, { now: t++ });
  const s = sortStops([mk("2026-10-24", "B"), mk("2026-10-23", "A"), mk("2026-10-24", "C")]);
  assert.deepEqual(s.map((x) => x.name), ["A", "B", "C"]);
  assert.throws(() => createStop({ date: "10/24", name: "x", ...CASA_AZUL }));
});

test("createMark：钉在坐标上，留言最多 200 字，坐标不对报错", () => {
  const m = createMark({ ...CASA_AZUL, acc: 12.7, note: "  我来过  " }, { now: Date.parse("2026-10-25T10:00:00Z") });
  assert.ok(m.id.startsWith("mark_"));
  assert.deepEqual([m.lat, m.lon, m.acc, m.note, m.createdAt], [CASA_AZUL.lat, CASA_AZUL.lon, 13, "我来过", "2026-10-25T10:00:00.000Z"]);
  assert.equal(createMark({ ...CASA_AZUL, note: "x".repeat(300) }).note.length, 200);
  assert.equal(createMark(CASA_AZUL).note, "");
  assert.throws(() => createMark({ lat: 91, lon: 0 }));
});

test("shouldRecordFrame：第一帧记；在家抖 3 米不记；挪了 30 米以上才记", () => {
  const at = (m) => ({ lat: CASA_AZUL.lat + m / 111320, lon: CASA_AZUL.lon, acc: 5 });
  assert.equal(shouldRecordFrame(null, at(0)), true);
  assert.equal(shouldRecordFrame(at(0), at(3)), false);
  assert.equal(shouldRecordFrame(at(0), at(29)), false);
  assert.equal(shouldRecordFrame(at(0), at(31)), true);
});
