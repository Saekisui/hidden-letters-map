#!/usr/bin/env node
// letters-mcp.js — 藏宝地图的 MCP server：让 Claude Code / Claude Desktop 之类的 MCP 客户端替藏宝人画路线、藏东西、发成就。
// stdio JSON-RPC 2.0，每行一个 message，stderr 走日志。只走 HTTP 到 server.js，不直接碰 data/。
// 地名 → 坐标在这边查（OpenStreetMap Nominatim，一次只查一个）。
//
// 环境变量：
//   LETTERS_URL=http://localhost:3000   server.js 的地址
//   LETTERS_PASSWORD=...                跟 server 的 PASSWORD 一样
//
// 五个工具：
//   hide_at_place({ place, hint, letter?, voice_url?, voice_text?, badge_*?, address?, radius_m?, visits_needed?, lat?, lon? })
//   award_badge({ name, emoji?, note? })
//   add_route_stop({ date, place, address?, note?, trip?, lat?, lon? })
//   trip_map()
//   remove_from_map({ id })

import readline from "node:readline";

const LETTERS_URL = (process.env.LETTERS_URL || "http://localhost:3000").replace(/\/$/, "");
const PASSWORD = process.env.LETTERS_PASSWORD || "";

const STATUS_LABEL = { sealed: "还藏着", found: "走到了，还没打开", opened: "打开了" };

function log(...args) {
  process.stderr.write(`[letters-mcp] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function http(method, path, body) {
  const res = await fetch(`${LETTERS_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${PASSWORD}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.error ? data.error : `HTTP ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=zh-CN,en&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "User-Agent": "hidden-letters-map/0.1 (personal trip map)" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`地图查地名失败（nominatim ${res.status}）`);
  const [hit] = await res.json();
  if (!hit) throw new Error(`「${query}」在地图上查不到——换个写法（英文 / 当地语言 / 带上城市名），或者直接给 lat / lon`);
  return { lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name };
}

// 给了 lat/lon 就用，没给就按 address（缺省 = place）查
async function locate(args) {
  if (args.lat != null && args.lon != null) return { lat: Number(args.lat), lon: Number(args.lon), label: "（你给的坐标）" };
  return geocode(String(args.address || args.place || "").trim());
}

const TOOLS = [
  {
    name: "hide_at_place",
    description: "Hide something for the finder at a real place — a letter, a voice recording, an achievement, or any mix. On their map they see only a blurred circle around it, your riddle, and which kinds of things are inside (✉️ 🎧 🏅) — not the place name, not the contents. When they physically get within radius_m (their phone reports its location, or they tap 'I'm nearby' on the map), it's theirs: they open an envelope, an achievement lights up on their achievement wall, and the status flips to found/opened in trip_map.\n\nUse this when they're going somewhere — a trip, a museum, a café they mentioned — and you want something waiting for them there. Stops on the trip route are the natural spots.\n\nWhat to hide:\n- letter: words for that exact spot.\n- voice_url (+ voice_text transcript): a recording you already made, as a URL their phone can play (mp3 / m4a over https). Nothing is synthesized here.\n- badge: an achievement for making it there (蓝房子探险家 💙).\n\nNotes:\n- place is the short name they see once they've found it. address is what the map looks up — English or the local language plus the city ('Museo Frida Kahlo, Coyoacán, Mexico City'); Chinese-only names often resolve to the wrong country. Check the resolved address in the result; if it's wrong, take it back with remove_from_map and pass lat/lon instead.\n- radius_m: 150–300 for a building or park they'll linger in; 1000–5000 for 'the moment you land in this city'. Location is sampled every few minutes at best, so a spot they only walk past needs a bigger radius.\n- hint points at the place without naming it.\n- visits_needed makes it a repeat-visit achievement: it unlocks only after they've been there on that many separate days (counted at most once a day) — e.g. their gym, 5 days → 🏋️ 健身房常客. Progress shows on their map; nothing pings them about it.",
    inputSchema: {
      type: "object",
      properties: {
        place: { type: "string", description: "找到以后看到的地名，短（例：蓝房子）" },
        hint: { type: "string", description: "地图上那片圈旁边的谜语，指向这个地方但不点名（例：墙是蓝的，里面住过一个一直在画自己的人）" },
        letter: { type: "string", description: "信的正文（可选）" },
        voice_url: { type: "string", description: "一段录好的音频的地址（可选，https 的 mp3 / m4a）" },
        voice_text: { type: "string", description: "那段音频的文字稿，页面上当字幕（可选）" },
        badge_name: { type: "string", description: "成就名（可选，≤20 字，例：蓝房子探险家）" },
        badge_emoji: { type: "string", description: "成就中间那个 emoji，缺省 🏅" },
        badge_note: { type: "string", description: "成就背面的一句话（可选）" },
        address: { type: "string", description: "给地图查坐标用的写法，缺省用 place" },
        radius_m: { type: "number", description: "走进多少米以内算到了，默认 200；健身房这种一栋楼的，100 左右" },
        visits_needed: { type: "number", description: "要来几天才解锁（一天最多算一次），默认 1" },
        lat: { type: "number" },
        lon: { type: "number" },
      },
      required: ["place", "hint"],
    },
  },
  {
    name: "award_badge",
    description: "Pin an achievement on the finder's achievement wall right now — not hidden anywhere, just given. It lights up on their map page's achievement wall.\n\nUse this when they did something worth marking: crossed the Pacific, ordered in Spanish for the first time, walked 20,000 steps in one day, opened their first hidden letter.\n\nNotes:\n- The wall doesn't buzz their phone; tell them about it yourself.\n- For an achievement tied to reaching a place, hide it with hide_at_place instead — then it unlocks when they get there.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "成就名，≤20 字（例：飞越太平洋）" },
        emoji: { type: "string", description: "成就中间那个 emoji，缺省 🏅" },
        note: { type: "string", description: "成就背面的一句话（可选）" },
      },
      required: ["name"],
    },
  },
  {
    name: "add_route_stop",
    description: "Add a stop to the trip route drawn on the map — one place on one day. The route connects stops in date order; long legs (flights) are drawn dashed.\n\nUse this when a day's plan settles — put the stops on the map as they're decided.\n\nNotes:\n- place is the label on the map; address is what the map looks up, same rules as hide_at_place.\n- A stop is visible to the finder; things you hide are not. Use hide_at_place for those.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        place: { type: "string", description: "地图上显示的站名" },
        address: { type: "string", description: "给地图查坐标用的写法，缺省用 place" },
        note: { type: "string", description: "这一站干什么（例：12:15 入场）" },
        trip: { type: "string", description: "哪一趟旅行（例：亡灵节 2026）" },
        lat: { type: "number" },
        lon: { type: "number" },
      },
      required: ["date", "place"],
    },
  },
  {
    name: "trip_map",
    description: "See the whole map: the route stop by stop, everything hidden — where, what's inside, whether the finder has found or opened it yet — the achievements given, and the 「我来过」 pins they dropped (where they stood, and what they wrote). Look before hiding more, so you don't hide two things at the same spot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "remove_from_map",
    description: "Remove a route stop, or take back something hidden that hasn't been found yet (ids come from trip_map). Once it's been found, it's theirs — it can't be taken back.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

async function callTool(name, args) {
  args = args || {};
  if (name === "hide_at_place") {
    const where = await locate(args);
    const badge = args.badge_name ? { name: args.badge_name, emoji: args.badge_emoji, note: args.badge_note } : null;
    const voice = args.voice_url ? { url: args.voice_url, text: args.voice_text } : null;
    const { letter } = await http("POST", "/api/travel-map/letters", {
      place: args.place, hint: args.hint, body: args.letter, voice, badge, radiusM: args.radius_m, visitsNeeded: args.visits_needed, lat: where.lat, lon: where.lon,
    });
    const inside = [letter.body && "一封信", letter.voice && "一段语音", letter.badge && `成就 ${letter.badge.emoji} ${letter.badge.name}`].filter(Boolean).join(" + ");
    const times = letter.visitsNeeded > 1 ? `，要来 ${letter.visitsNeeded} 天才解锁` : "";
    const sv = letter.streetView ? `\n街景抓到一张${letter.streetView.date ? `（${letter.streetView.date}）` : ""}，拆开以后详情页里能看到。` : "";
    return { content: [{ type: "text", text: `藏好了（${letter.id}）：「${letter.place}」，${inside}，半径 ${letter.radiusM}m${times}。\n地图查到的是：${where.label}${sv}\n地图上现在多了一片 ${Math.round(letter.area.r)}m 的模糊圈和谜语「${letter.hint}」。地址不对就 remove_from_map 收回、带 lat/lon 重藏。` }] };
  }
  if (name === "award_badge") {
    const { badge } = await http("POST", "/api/travel-map/badges", { name: args.name, emoji: args.emoji, note: args.note });
    return { content: [{ type: "text", text: `成就发出去了：${badge.emoji} ${badge.name}。成就墙上已经亮了——记得在回复里说一声。` }] };
  }
  if (name === "add_route_stop") {
    const where = await locate(args);
    const { stop } = await http("POST", "/api/travel-map/stops", {
      date: args.date, name: args.place, note: args.note, trip: args.trip, lat: where.lat, lon: where.lon,
    });
    return { content: [{ type: "text", text: `${stop.date} 加了一站「${stop.name}」（${stop.id}）。\n地图查到的是：${where.label}` }] };
  }
  if (name === "trip_map") {
    const { stops, letters, badges, marks = [] } = await http("GET", "/api/travel-map/full");
    const lines = ["路线："];
    if (!stops.length) lines.push("（还没有）");
    for (const s of stops) lines.push(`- ${s.date} ${s.name}${s.note ? `（${s.note}）` : ""}${s.trip ? ` · ${s.trip}` : ""} [${s.id}]`);
    lines.push("", "藏着的：");
    if (!letters.length) lines.push("（还没藏）");
    for (const l of letters) {
      const progress = (l.visitsNeeded || 1) > 1 ? ` · 来过 ${(l.visitDays || []).length}/${l.visitsNeeded} 天` : "";
      lines.push(`- 「${l.place}」${STATUS_LABEL[l.status] || l.status}${progress} · 半径 ${l.radiusM}m · 谜语：${l.hint} [${l.id}]`);
      if (l.body) lines.push(`  信：${l.body}`);
      if (l.voice) lines.push(`  语音：${l.voice.text || l.voice.url}`);
      if (l.badge) lines.push(`  成就：${l.badge.emoji} ${l.badge.name}${l.badge.note ? `（${l.badge.note}）` : ""}`);
      if (l.streetView) lines.push(`  街景：有${l.streetView.date ? `（${l.streetView.date}）` : ""}`);
    }
    lines.push("", "直接发过的成就：");
    if (!badges.length) lines.push("（还没有）");
    for (const b of badges) lines.push(`- ${b.emoji} ${b.name}${b.note ? `（${b.note}）` : ""} · ${b.awardedAt.slice(0, 10)}`);
    lines.push("", "钉的「我来过」：");
    if (!marks.length) lines.push("（还没有）");
    for (const m of marks) lines.push(`- ${m.createdAt.slice(0, 10)} (${m.lat.toFixed(4)}, ${m.lon.toFixed(4)})${m.note ? `：${m.note}` : ""} [${m.id}]`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
  if (name === "remove_from_map") {
    await http("DELETE", `/api/travel-map/${encodeURIComponent(String(args.id || ""))}`);
    return { content: [{ type: "text", text: "删掉了。" }] };
  }
  throw new Error(`unknown tool: ${name}`);
}

// ============ JSON-RPC 主循环 ============

async function handle(msg) {
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "hidden-letters-map", version: "0.1.0" },
        },
      });
      return;
    }
    if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    }
    if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      const result = await callTool(name, args);
      send({ jsonrpc: "2.0", id, result });
      return;
    }
    if (method === "notifications/initialized" || method === "initialized") return;
    if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (err) {
    log("error:", err.message);
    if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { log("invalid JSON:", line.slice(0, 200)); return; }
  handle(msg);
});
