# 藏宝地图 · hidden-letters-map

<p align="center"><img src="docs/cover.png" alt="藏宝地图：把信、语音、成就藏在真实的地方，对方走到附近才拿得到" width="100%"></p>

<p align="center"><a href="https://saekisui.github.io/hidden-letters-map/demo/"><b>手机上试玩 ↗</b></a>（假数据，不用装任何东西）</p>

把信、一段语音、一个成就藏在真实的地方。对方的地图上只看得到一片模糊的圈和一句谜语，人走到附近才拿得到。

- **藏宝人**：在某个地方藏东西、画旅行路线、直接发成就。用 Claude Code / Claude Desktop 之类的 MCP 客户端操作，或者直接 curl。
- **寻宝人**：手机上开一个网页（加到主屏幕当 app 用）。地图上有计划路线、自己的位置和足迹、雾圈和谜语；走进圈里，信封就能拆；拆开过的进详情页；拿到的成就挂在成就墙上；还能在自己站的地方钉一枚「我来过」留一句话。

封着的信，页面拿到的数据里没有地名、坐标、正文，开发者工具里也偷看不到。

---

## 跑起来

需要 Node 20.6 以上。

```bash
npm install
cp .env.example .env     # 至少把 PASSWORD 改掉，两个人的称呼也填一下
npm run build            # 页面打到 dist/
npm start                # 默认 http://localhost:3000
```

浏览器打开，输密码进去。寻宝人的手机要能从外面访问这个地址——放在一台有公网地址的机器上，或者用 Cloudflare Tunnel / Tailscale Funnel 之类把家里的机器露出去。**位置上报和推送都要求 https。**

iPhone 上：Safari 打开 → 分享 → 添加到主屏幕。从主屏幕打开才是全屏、才能收推送。

`.env` 里能配的：

| 变量 | 说明 |
|---|---|
| `PASSWORD` | 必填。页面登录、MCP、定位 App 上报都用它 |
| `PORT` | 默认 3000 |
| `DATA_DIR` | 数据目录，默认 `./data` |
| `HIDER_NAME` / `FINDER_NAME` | 页面上怎么称呼两个人：信的落款「—— 阿笙」、成就上一圈「FOR 小满 · WITH LOVE」 |
| `TZ` | 「来过几天才解锁」按哪个时区算一天，不填按系统时区 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | 推送用，可选，见下面 |
| `GOOGLE_MAPS_API_KEY` | 街景用，可选，见下面 |

---

## 怎么藏东西

### 用 MCP（推荐）

`mcp/letters-mcp.js` 是一个 stdio MCP server，五个工具：

| 工具 | 干什么 |
|---|---|
| `hide_at_place` | 在一个地方藏东西：信 `letter`、语音 `voice_url` + `voice_text`、成就 `badge_*`，至少一样。`radius_m` 走进多少米算到；`visits_needed` 要来几天才解锁（健身房 5 次那种） |
| `award_badge` | 直接发一个成就，不藏 |
| `add_route_stop` | 路线上加一站（按天） |
| `trip_map` | 看全貌：路线、藏了什么、拆没拆、发过的成就、对方钉的图钉 |
| `remove_from_map` | 删站点 / 收回还没被找到的 |

地名 → 坐标走 OpenStreetMap Nominatim。**地址用英文或当地语言、带上城市**（`Museo Frida Kahlo, Coyoacán, Mexico City`），纯中文地名经常查到别的国家去。查错了就 `remove_from_map` 收回，带 `lat` / `lon` 重藏。

Claude Code 里加：

```bash
claude mcp add letters -e LETTERS_URL=http://localhost:3000 -e LETTERS_PASSWORD=你的密码 -- node /绝对路径/hidden-letters-map/mcp/letters-mcp.js
```

或者写进 MCP 配置：

```json
{
  "mcpServers": {
    "letters": {
      "command": "node",
      "args": ["/绝对路径/hidden-letters-map/mcp/letters-mcp.js"],
      "env": { "LETTERS_URL": "http://localhost:3000", "LETTERS_PASSWORD": "你的密码" }
    }
  }
}
```

然后跟它说「她下周去墨西哥城，在蓝房子给她藏一封信」就行。

### 用 curl

所有写接口都认 `Authorization: Bearer <PASSWORD>`：

```bash
curl -H "Authorization: Bearer 你的密码" -H "content-type: application/json" \
  -d '{"place":"蓝房子","hint":"墙是蓝的，里面住过一个一直在画自己的人","body":"你到了。","badge":{"name":"蓝房子探险家","emoji":"💙"},"lat":19.3551,"lon":-99.1624,"radiusM":200}' \
  http://localhost:3000/api/travel-map/letters
```

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/travel-map/full` | 全貌（藏宝人看的，含正文） |
| `POST` | `/api/travel-map/letters` | 藏东西：`place` `hint` 必填；`body` / `voice: {url, text}` / `badge: {name, emoji, note}` 至少一样；`lat` `lon` `radiusM` `visitsNeeded` |
| `POST` | `/api/travel-map/stops` | 加站：`date`（YYYY-MM-DD）`name` `lat` `lon` `note` `trip` |
| `POST` | `/api/travel-map/badges` | 发成就：`name` `emoji` `note` |
| `DELETE` | `/api/travel-map/:id` | 删站点 / 收回封着的信 / 拔图钉。已经被找到的信收不回 |

语音这一项只收一个**现成的音频地址**（https 的 mp3 / m4a），这边不合成。

---

## 定位：从哪来，自己选

这是整个东西里唯一要你做取舍的地方。「走到附近信就到手」靠的是 server 知道寻宝人在哪，而**手机上的位置怎么到 server，不止一种做法，各有代价**：

| 做法 | 要装什么 | 后台能跑吗 | 代价 |
|---|---|---|---|
| **A. 只用页面** | 不用装 | 不能。锁屏、切走就停 | 得自己打开地图，走到了点「我就在这附近」才拆 |
| **B. Overland**（iOS） | 免费开源 App | 能，按移动距离自动上报 | 要装个 App、填一个地址和一串 token；耗一点电 |
| **C. OwnTracks**（iOS / Android） | 免费开源 App | 能 | 同上；安卓只有这条 |
| **D. 通用接口** | 自己搭 | 看你怎么搭 | iOS 快捷指令、自己写的脚本、别的追踪器都能喂 |

**只想试试**：A 就够了。页面底栏「定位我」用浏览器定位，封着的卡片会写离那片圈还差多远。

**想要「走到附近自动推送，不用点开 app」**：B 或 C，再加下面的推送。

无论哪种，位置只发到你自己的 server，落在 `data/track.jsonl`（足迹，只记挪动超过 30 米的点，最近 60 天画在地图上）和 `data/last-seen.json`（最后一帧）。

### B. Overland

[Overland](https://github.com/aaronpk/Overland-iOS) 是 iOS 上的位置记录 App，攒一批位置往一个地址 POST。

- Receiver Endpoint：`https://你的域名/api/location/overland`
- Access Token：`.env` 里的 `PASSWORD`

它要求 server 回 `{"result":"ok"}` 才算送到，这边回的就是这个。上报节奏在 App 里调；路过一栋楼的 150 米圈只要几分钟，节奏太慢会错过，藏东西时半径给大一点更稳。

### C. OwnTracks

[OwnTracks](https://owntracks.org/) iOS / Android 都有，选 **HTTP 模式**：

- URL：`https://你的域名/api/location/owntracks`
- 用户名随便，密码填 `.env` 里的 `PASSWORD`（它走 HTTP Basic）

### D. 通用接口

```bash
curl -H "Authorization: Bearer 你的密码" -H "content-type: application/json" \
  -d '{"lat":19.3551,"lon":-99.1624,"acc":12,"t":"2026-10-09T10:10:00Z"}' \
  https://你的域名/api/location
```

`acc`（米）和 `t`（ISO 时间）可选。iOS 快捷指令「获取当前位置」+「获取 URL 内容」就能拼出这一条，但快捷指令的自动化触发粗糙，当备用。

### 为什么不接「查找」/ 家人共享

能从别人的 Apple ID 拉位置的办法都要对方把账号和二次验证交出来，而且走的是非官方接口，Apple 一改就断。这个项目不做这条，模型反过来：**寻宝人在自己手机上装一个 App、选择把位置推到哪，随时能关。**

---

## 推送（可选）

走到圈里时 server 推一条通知到寻宝人的手机。不配也能用，只是没有这一下。

```bash
npx web-push generate-vapid-keys
```

把两串 key 填进 `.env` 的 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`，重启。寻宝人在页面底栏点「开通知」，允许一次就行。

iPhone 上要先把页面加到主屏幕、从主屏幕打开，Safari 里直接开是不支持 Web Push 的。推送内容只有一句「你走到了 xx 附近」，信的内容不进推送。

---

## 街景（可选）

配了 Google Maps 的钥匙，藏东西的时候 server 会抓一张那个地点附近的街景存下来，拆开以后详情页里谜语下面贴着。不配也能用，只是少这一张。

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 开 **Street View Static API**，建一把钥匙。
2. 填进 `.env` 的 `GOOGLE_MAPS_API_KEY`，重启。

细节：

- 抓之前先走一次 metadata 接口问那里有没有覆盖（这一步不计费），没有就跳过。一封信只抓一张，走免费额度绰绰有余。
- 钥匙只在你的 server 上，寻宝人的手机不碰 Google。图片存在 `data/streetview/`，接口只给拆开了的信，拿着封着的信的 id 也取不到。
- 藏的时候坐标会发给 Google 一次，这是这个功能唯一多出去的一条请求。
- 收回还没被找到的信时，那张图一起删。

---

## 数据与隐私

- 全部数据在 `data/` 下，没有数据库：`map.json`（站点 / 信 / 成就 / 图钉）、`track.jsonl`、`last-seen.json`、`push-subscriptions.json`，还有 `streetview/` 里的图。备份就是拷这个目录。
- 寻宝人的页面只拿 `/api/travel-map`，封着的信只有模糊圈（半径是信的 3 倍、圆心随机偏开）、谜语、藏了哪几样。
- 地图瓦片来自 OpenStreetMap 官方服务器，字体来自 Google Fonts 和 jsDelivr（霞鹜文楷）。不想出网就把 `web/letters.css` 顶上两行 `@import` 换成自己的。

---

## 开发

```
letters.js            纯逻辑：距离、模糊圈、创建、到访判定、脱敏视图（有测试）
server.js             Express：文件读写、鉴权、位置入口、推送
mcp/letters-mcp.js    MCP server，只走 HTTP 到 server.js
web/LettersPage.jsx   寻宝人的页面（React + Leaflet）
web/letters.css
web/preview.jsx       假数据预览：npm run dev 后开 http://localhost:5173/preview.html?phone，不用起 server；npm run build:demo 打成 docs/demo/ 当线上试玩
public/               登录页、sw.js、manifest、图标
docs/cover.html       仓库封面的源文件（无头 Chrome 出 PNG，命令在文件头）
```

```bash
npm test        # letters.js 的单元测试
npm run dev     # Vite 开发服务器，/api 代理到 3000
```

---

## 来历

这是从一个私人项目里抽出来的功能。原来的版本接的是作者自己的定位链路、语音合成和聊天记录，抽出来时把这些都换成了上面的通用接口，页面和玩法没动。

MIT License。
