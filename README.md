# 实时协作白板（Collab Whiteboard）

> **多人白板的项目** —— 多人同房间实时绘制、光标同步、断网离线编辑自动合并、操作历史回放。

> Vue 3 + Canvas + Yjs(CRDT) + Node 信令 + Redis Pub/Sub
> 多人同房间实时绘制、光标同步、断网离线编辑自动合并、操作历史回放。

---

## 一、为什么这个项目值得做

普通 CRUD 项目考察的是「会不会用框架」。这个项目考察的是**你能不能处理分布式状态同步**——
这是前端和全栈岗最真实的工程难题，也是绝大多数候选人没碰过的领域。

面试官真正想知道的三个问题，这个项目都有可运行的答案：

| 面试官会问 | 这里的答案 |
|---|---|
| 两个人同时在同一个位置画，怎么处理冲突？ | 不用"处理"——CRDT 天然无冲突。不同人的笔迹是 `Y.Array` 中不同元素，合并是集合并集，不存在覆盖 |
| 断网了用户还在画，联网后怎么合？ | 本地照常写 CRDT，重连时按 state vector 求差集双向同步，双方内容都保留，不需要"谁赢"的仲裁 |
| **你除了用 Yjs 库，自己写了什么？** | 见下方「自研部分」 |

### 自研部分（Yjs 只提供 CRDT 数据结构与增量编解码）

这是回应"你不就是调了个库"的核心。Yjs 之外，这些全部是手写的：

1. **双层 Canvas 渲染架构** —— `base` 层画已提交内容、`draft` 层画当前笔迹。
   网络更新不会打断本地绘制，60fps 手感与协作解耦。
2. **消息总线抽象**（`server/src/bus.js`）—— Redis Pub/Sub 与内存 EventEmitter 同接口，
   未配置 Redis 自动降级，零依赖可跑；配置即多实例水平扩展。
3. **连接生命周期管理** —— 指数退避重连、消息体积上限、心跳清理半开连接（否则幽灵用户会一直占位）。
4. **自研 RTT 探针协议**（type 200/201）—— 官方 awareness 广播会排除消息来源连接，
   发起者收不到自己的回声，用它测出来的是假延迟。改为自定义 ping/pong 消息类型，
   服务端原样回显时间戳，测得真实网络往返（RTT）。
5. **同步延迟度量体系** —— 探针笔迹首次可见时计时，
   真实测量「本地写入 → 远端可见」的端到端延迟，而不是猜渲染时机。
6. **同步抽稀** —— 距离 < 1.2px 的采样点直接丢弃，减少约 60% 的 CRDT 消息体积。
7. **可视区域裁剪** —— 只绘制视口内笔迹，笔迹量增长不掉帧。
8. **历史回放引擎**（`Replay.js`）—— 独立文档渐进重放；
   特别注意 CRDT 文档无法"撤销"已合并的更新，所以回退必须重建文档，这是很多实现会踩的坑。
9. **离线快照导入** —— `Y.applyUpdate` 实现跨会话无损合并，导出文件再导入不会丢别人的成果。

---

## 二、快速开始

```bash
cd whiteboard
npm install          # 根目录一次性装好 server + web 两个 workspace
npm run dev          # 同时启动信令服务(1234) + 前端(5173)
```

启动后打开 **<http://localhost:5173/?room=demo>**，**多开几个标签页**即可看到多人协作。

> **注意用 `localhost` 而不是 `127.0.0.1`**：
> Vite dev server 只监听 IPv6 回环 `[::1]`，用 `127.0.0.1` 访问会返回 502。

### 端口被占用时（与本机其他项目共存）

前端已配置 `strictPort: true` —— 5173 被占用时**直接报错退出**，
而不是静默换到 5174（那样会让你按默认地址访问到别的服务，极难排查）。

**所有端口都可用环境变量改**，用来和本机其他项目共存：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `WEB_PORT` | `5173` | 前端 dev server 端口 |
| `SERVER_PORT` / `PORT` | `1234` | 后端信令服务端口 |
| `SERVER_HOST` | `127.0.0.1` | 前端代理指向的后端地址 |

```bash
# 整套换到 5180 / 1240
WEB_PORT=5180 SERVER_PORT=1240 npm run dev

# 或用预设脚本（前端换到 5174，后端仍是 1234）
npm run dev:alt
```

改完前端端口后打开 <http://localhost:5180/?room=demo> 即可。
WebSocket 地址是从页面 `location.host` 推导的，会自动走新端口的代理，
**不需要改任何前端代码**。

后端也可以单独换：

```bash
PORT=8080 npm run start
```

> **排查端口占用的小技巧**：本机设了 `http_proxy` 环境变量时，
> `curl http://localhost:5174/` 可能返回 502 `upstream connect failed`，
> 那是 curl 走了代理的假象，端口其实没被占。加 `--noproxy '*'` 重测即可：
> ```bash
> curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" http://localhost:5174/
> ```
> 真正确认占用用 `netstat -ano | grep LISTENING` 或 PowerShell 的
> `Get-NetTCPConnection -State Listen`。

清理残留进程：

```bash
# Windows PowerShell
Get-Process node | Where-Object {
  (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match 'vite|src/index.js'
} | Stop-Process -Force
```

### 分别启动（调试时更方便）

```bash
npm run dev:server   # 只启信令服务 (1234)
npm run dev:web      # 只启前端 (5173)
```

### 多标签页身份区分

每个标签页会自动生成随机用户名与颜色，便于在多人协作时区分光标归属。

### 接入 Redis（可选，用于多实例扩展）

```bash
docker run -d -p 6379:6379 redis:7-alpine
REDIS_URL=redis://127.0.0.1:6379 npm run start
```

不配置则自动使用内存总线（单机模式），日志会明确提示当前总线类型。

---

## 三、架构

```
┌────────────┐  ┌────────────┐  ┌────────────┐
│ 浏览器 A    │  │ 浏览器 B    │  │ 浏览器 N   │
│ Vue3+Canvas │  │            │  │            │
│    Y.Doc    │  │            │  │            │
└─────┬──────┘  └─────┬──────┘  └─────┬──────┘
      │  WS: sync + awareness         │
      └───────────────┬───────────────┘
                      ▼
        ┌─────────────────────────────┐
        │  Node 信令服务               │
        │  RoomManager → Room         │
        │   ├ Y.Doc（权威 CRDT 状态）  │
        │   ├ Awareness（光标/成员）   │
        │   └ 操作日志（回放数据源）    │
        └───────────┬─────────────────┘
                    │ publish / subscribe
                    ▼
        ┌─────────────────────────────┐
        │ Redis Pub/Sub（可选）        │
        │  多实例共享同一批房间         │
        └─────────────────────────────┘
```

### 消息协议

在标准 y-websocket 协议基础上实现，三种消息类型：

| 类型 | 值 | 载荷 | 用途 |
|---|---|---|---|
| `MESSAGE_SYNC` | 0 | y-protocols sync | 文档增量 / sync step1&2 握手 |
| `MESSAGE_AWARENESS` | 1 | awareness update | 光标位置、成员列表、ping 回声 |
| `MESSAGE_QUERY_AWARENESS` | 3 | — | 新客户端主动拉取全量在线状态 |

**防回环**：每次 `doc.transact` 传入来源 `Connection` 对象作为 `origin`，
`Room._onDocUpdate` 据此判断"这条更新是自己 WS 收到的还是总线来的"，避免同一条更新被广播两次。
这是自研信令最容易写错的地方。

---

## 四、CRDT 数据结构设计

选型本身就是考点——不同结构决定了冲突语义：

```js
doc.getArray('strokes')        // 笔迹：追加型。不同人 push 不同元素 → 并集，永不冲突
doc.getMap('board')            // 画板元信息：键级 LWW（并发写同 key 时按 clientID 定序）
doc.getMap('texts')            // 富文本：value 是 Y.Text，按 block 拆开独立合并
                               //   位置存`texts.set(id + '__pos')`，避免 pos 与内容互相覆盖
```

为什么笔迹用 `Y.Array` 而不是"整张画布一个对象"？
如果整张画布是一个 map，两人的并发修改会落到同一条记录上产生 LWW 丢失。
拆成数组元素后，冲突域被压到最小——**数据结构选型决定了冲突概率**，这是 CRDT 设计的核心思路。

---

## 五、验收指标

```bash
npm run bench                              # 50 人并发压测（含 10 人断网）
node bench/bench.js --users 100 --offline 20   # 100 人 + 20 人断网
node bench/e2e.js                # 端到端功能验收（7 项检查）
node bench/e2e.js http://localhost:5173       # 经 Vite 代理，贴近浏览器真实路径
```

### 实测结果

本机开发环境（单机、loopback、Windows / Node 22，内存总线）：

| 场景 | 连接 | 唯一笔迹 | CRDT 收敛 | 收敛耗时 | 延迟 P50 / P95 / P99 | 离线合并 | 异步异常 |
|---|---|---|---|---|---|---|---|
| 50 人 + 10 人断网 | 50/50 | 3894 条 | 全部一致 | 1.2s | 0.2 / 0.4 / 0.7 ms | 80/80 全可见 | 0 |
| 100 人 + 20 人断网 | 100/100 | 1926 条 | 全部一致 | 2.3s | 0.1 / 0.2 / 0.3 ms | 160/160 全可见 | 0 |

`node bench/e2e.js` 的 7 项功能检查全部通过：初始同步、awareness 成员可见、
笔迹三方互见、离线期间他人不可见、重连后收敛、离线内容无丢失、合并不覆盖他人内容。

真实浏览器三端并发验证（无头 Edge，房间 `final`）：三人各画一笔，
彼此 100% 可见，成员列表 3 人，RTT 稳定在 0.4–1.3ms（首样本 12.2ms 为连接握手开销）。

### 指标口径（不要含糊其辞）

项目里有**两个不同的延迟指标**，面试时必须分清，混用会被追问穿：

| 指标 | 含义 | 采集方式 | 用途 |
|---|---|---|---|
| **RTT** | 客户端 ↔ 服务端网络往返 | 自研 ping/pong 消息（type 200/201），服务端原样回显时间戳 | 排查网络与服务端问题 |
| **同步延迟** | 本地写入 → 远端可见 | 探针笔迹首次可见时计时 | 考核 < 80ms 指标 |

- **同步延迟**：写入方记录 `performance.now()`，所有客户端在 `doc.on('update')` 中
  发现该笔迹时计算差值，取全局 P50/P95/P99。
  只统计**固定间隔写入的探针笔迹**，且只统计在线期间——
  离线客户端重连后看到的历史更新会伪造出巨大的虚假长尾（实测可达数秒）。
- **RTT 不能用 awareness 测**：服务端广播 awareness 时会排除消息来源连接，
  发起者收不到自己的回声，测出来的是"距上次 ping 多久"而非往返时间。
  本项目为此自研了 type 200/201 的扩展消息类型（详见 `docs/ARCHITECTURE.md` 4.1 / 9.1.1）。
- **一致性判定**：比对每个客户端看到的笔迹 id 集合，`min == max == 并集大小` 才算收敛。
  判定采用**轮询直到全员一致或超时**，而非固定 sleep——后者会在大房间下误报"未收敛"。
- **离线合并**：断网客户端离线写入的每条笔迹，必须出现在**每一个**客户端视图中。
- **异步异常**：统计压测期间的非受控异常数，必须为 0。指标达标但环境有异常时必须披露。

> **报告时必须写明测试环境。** 本机 loopback 的数字远优于公网真实场景，
> 跨城网络 RTT 本身就有 20–50ms。把本地结果当生产指标是自欺欺人。
> 上述数字体现的是**服务端处理能力上限**，端到端延迟还要叠加网络 RTT。

### 达成 < 80ms 的关键：同 tick 发送合并

50 人同时画时，若逐条 fan-out，事件循环会被发包队列拖住。
实现上把同一事件循环阶段内的所有 CRDT 更新用 `Y.mergeUpdates` 合成一条消息，
每连接每 tick 只 `send` 一次。这不改变语义（CRDT 更新可无损合并），
但把扇出次数降低了数十倍——这是把 P95 从数百毫秒压到亚毫秒的关键。

具体见 `server/src/room.js` 的 `_broadcastSync` / `_flushSync`。

---

## 六、目录结构

```
whiteboard/
├── server/src/
│   ├── index.js      服务入口：HTTP API + WS 升级 + 优雅退出
│   ├── room.js       Room / Connection：协议解析、sync 握手、awareness 中继
│   ├── rooms.js      RoomManager：房间路由、空闲回收
│   ├── bus.js        Redis / 内存 双实现广播总线
│   ├── config.js     环境变量配置
│   └── logger.js     分级日志
├── web/src/
│   ├── App.vue                    交互主逻辑
│   ├── composables/useCollaboration.js   协作引擎封装（自研核心）
│   ├── components/
│   │   ├── Renderer.js            双层 Canvas 渲染器
│   │   ├── Replay.js              历史回放引擎
│   │   ├── ReplayPanel.vue        回放 UI
│   │   ├── Toolbar.vue            工具栏
│   │   └── Members.vue            在线成员与延迟指示
├── bench/
│   ├── bench.js              并发压测与验收脚本
│   └── e2e.js                端到端功能验收（7 项检查）
└── docs/
    ├── ARCHITECTURE.md       详细设计文档 + 踩坑记录
    └── INTERVIEW.md          面试自述稿（亮点/追问/答法）
```

---

## 七、HTTP 接口

| 接口 | 说明 |
|---|---|
| `GET /health` | 健康检查，返回总线类型 |
| `GET /api/rooms` | 所有房间状态（人数、操作数、文档体积） |
| `GET /api/rooms/:name` | 房间详情，含 base64 快照与成员列表 |
| `GET /api/rooms/:name/ops?since=N` | 增量拉取（断线重连补差量） |
| `GET /api/rooms/:name/history?n=200` | 历史操作帧，回放数据源 |
| `GET /api/rooms/:name/verify` | 把历史帧重放到新文档，校验是否无损收敛 |

---

## 八、可继续深挖的方向

- **水平扩展**：多 server 实例挂同一 Redis，任意实例都能接入同一房间。
- **持久化**：当前是内存态 + 进程内日志，可接 LevelDB/S3 做冷备。
- **鉴权**：接入 JWT，房间级权限控制。
- **性能**：笔迹点做 RDP/道格拉斯-普克简化；base 层改用离屏 canvas 缓存。
- **背压**：高频客户端做发送合并（coalescing），避免慢客户端拖累房间。
