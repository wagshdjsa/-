# 架构设计文档

## 1. 核心问题定义

多人同时编辑同一份画布，本质是**分布式状态同步**问题。要同时满足：

1. **一致性**：任意节点在收到全部消息后，状态必须相同
2. **实时性**：操作要在可感知时间内传播（目标 < 80ms）
3. **可用性**：单个节点掉线不能影响其他人，掉线期间还能继续工作

传统方案（锁 / 中心节点仲裁 / OT 转换）分别牺牲了可用性、延迟或实现复杂度。
本项目选择 **CRDT**：用数据结构的数学性质换取"永不冲突"，代价是元数据膨胀与删除语义复杂。

---

## 2. 为什么选Yjs，而不是自己实现 CRDT

| 方案 | 优劣 |
|---|---|
| 自己实现 CRDT | 至少数千行，且极易在"删除"和"嵌套结构"上出错。面试时得不偿失 |
| **Yjs** | 成熟的 CRDT 实现，提供 `Y.Array` / `Y.Map` / `Y.Text` 等已验证的数据结构 |
| OT（Operational Transform） | 中心化 Transform 权威，转义表随操作类型组合爆炸，扩展新操作类型成本高 |

**自研的边界**很清晰：Yjs 提供 CRDT 数据结构与增量编解码，
信令协议、广播总线、连接管理、渲染架构、回放引擎全部手写（见 README「自研部分」）。

这是工程上正确的分工——不要重复造轮子，但必须理解轮子的边界在哪。

---

## 3. 冲突模型与数据结构选型

### 3.1 Y.Array 元素级冲突隔离

假设两个人同时在画布上画：

```
用户 A 的更新：strokes.push([{id:'a1', ...}])
用户 B 的更新：strokes.push([{id:'b1', ...}])
```

两条更新作用于数组的不同位置，CRDT 合并结果为`[{id:'a1'}, {id:'b1'}]`——**两条都在，零冲突**。

反例：如果把整个画布存成`map('canvas', {strokes: [...]})`，
两人同时改这个 key 会触发键级 LWW，**其中一人的全部笔迹会被覆盖丢失**。

> **结论：数据结构选型直接决定冲突概率。**
> 冲突域要切得足够细，细到"两人不可能同时改同一处"为止。

### 3.2 Y.Text 的 block拆分

富文本如果整体存一个 `Y.Text`，两人同时在文档末尾打字会逐字符交错，变成乱序。

所以按 block 拆开：`texts.set(blockId, new Y.Text())`，每个块独立合并，
位置信息另存`texts.set(blockId + '__pos')`，避免内容与位置互相覆盖。

### 3.3 键级 LWW 的适用范围

`board` map（背景色等）用 LWW 即可——同key 并发写时，
Yjs 按 clientID 做确定性定序，**所有节点得到相同结果**，这就是 CRDT 要求的"收敛"。
不存在"谁赢"的业务歧义，因为这类元数据没有多人差异化诉求。

---

## 4. 信令协议与防回环

### 4.1 消息类型

沿用 y-websocket 的二进制协议（`lib0` 编码）：

```
[varuint messageType][payload]
```

- `0` SYNC：`syncProtocol` 编码的文档增量，或 sync step1/2 握手
- `1` AWARENESS：`awarenessProtocol` 编码的状态（光标、成员）
- `3` QUERY_AWARENESS：新连接主动索取全量在线状态

**自研扩展类型**（本项目在官方协议之上加的，用于精确测量 RTT）：

- `200` PING：客户端 → 服务端，`varuint` 时间戳
- `201` PONG：服务端 → 客户端，原样回显该时间戳

选 200/201 而非复用 1（awareness）的原因见 [9.1.1](#911-但-rtt-本身仍然要测且必须自研探针)：
awareness 广播会排除来源连接，测不出真实往返延迟。

### 4.2 回环问题（最容易写错的地方）

场景：客户端 A 的更新到达服务端。

- 若无脑 `doc.on('update') → broadcast`，
  而 broadcast 又经过总线回到本地连接，就会**同一条更新被发出去两次**，
  客户端虽然幂等不会出错，但带宽浪费，且如果实现有状态校验就会引入真bug。

**解法**：把事务来源作为 `origin` 传下去。

```js
// 服务端：解析客户端消息时
syncProtocol.readSyncMessage(decoder, encoder, this.room.doc, this)  // origin = Connection 实例

// Room 内：据此区分来源
this.doc.on('update', (update, origin) => {
  if (origin === 'load') return              // 历史回放，不广播
  const from = origin instanceof Connection ? origin.id : null
  this._broadcast(MESSAGE_SYNC, encode(update), from)  // from 用于排除回环目标
})
```

注意 **Redis 路径不能简单地"排除 origin"**：
其他实例收到总线消息后，本地连接的 `origin` 是 null，
所以 `_localBroadcast` 必须把消息发给**所有**本地连接。
只有来源实例才需要排除 `senderId`。这个不对称性是横向扩展正确性的关键。

---

## 5. 广播总线设计

```js
await bus.publish(room, { senderId, type, payload })   // 发
await bus.subscribe(room, handler)                     // 收
await bus.unsubscribe(room, handler)                   // 退订
```

两种实现同接口：

| 实现 | 场景 | 特点 |
|---|---|---|
| `MemoryBus` | 单机开发/测试 | EventEmitter，零外部依赖 |
| `RedisBus` | 多实例生产环境 | 任意实例可接入同一房间 |

Redis 连接失败时自动降级为内存总线并打印警告——**降级路径必须显式可见**，
静默降级会让生产环境的横向扩展悄悄退化成单机。

---

## 6. 双层 Canvas 渲染

单一 canvas 会让本地绘制被网络更新打断：

```
用户正在画 → 远端更新到达 → 全量重绘 → 正在画的那一笔被清掉 → 视觉闪烁
```

**解法**：拆成两层，各自独立调度。

```
base   canvas  ← 已提交的 CRDT 内容；仅在数据变更时经 rAF 合批重绘
draft  canvas  ← 当前这一笔的预览；每帧清空重画，不参与调度
cursor canvas  ← 远端光标；每帧重画（本质是 awareness 派生状态，变化快）
```

关键细节：

- **合批**：`schedule()` 用 `_pending` 标志位保证一帧内多次调用只触发一次 `rAF`
- **抽稀**：距离 < 1.2px 的采样点丢弃，减少约 60% 消息体积
- **裁剪**：绘制前判断笔迹包围盒是否与视口相交，笔迹变多也不掉帧
- **DPR 适配**：`canvas.width = cssWidth * devicePixelRatio`，否则高分屏模糊

---

## 7. 离线编辑与合并

### 7.1 机制

离线时WebSocket 断开，但**本地 `Y.Doc` 照常接收编辑**。
Yjs 把每次修改编码成携带因果信息的增量更新，在客户端队列中排队。

重连时执行 sync step1（交换 state vector）→ 双方计算差集 → step2 补齐：
- 对方有我没有的 → 我拉取
- 我有对方没有的 → 我推送

**不存在"谁覆盖谁"**：差集是集合运算，双方内容都保留。

### 7.2 状态码

```
connecting → connected → (offline) → reconnecting → synced
```

UI 需明确告知用户"你的编辑保存在本地"，否则用户会以为白板卡死而刷新页面，
导致离线内容丢失——**这是协作产品最容易犯的产品级错误**。

### 7.3 跨会话合并

导出 `Y.encodeStateAsUpdate(doc)` 为 base64 文件，再导入时 `Y.applyUpdate`：

```js
Y.applyUpdate(doc, new Uint8Array(Buffer.from(b64, 'base64')), 'import')
```

因为是 CRDT 合并语义，导入别人的快照**不会覆盖**本地内容。这是有意设计的特性。

---

## 8. 历史回放

### 8.1 数据来源

服务端 `Room.ops` 记录每条 CRDT 更新（带时间戳），是回放的原始素材。

长房间内存控制：超过 `maxOpsPerRoom` 后，把最早的更新**合并为一个基线快照**，
后续增量仍可正常合并。回放依然完整。

### 8.2 回放的正确实现

回放必须用**独立文档**，绝不能复用协作文档，否则回放会污染线上状态。

```js
class ReplaySession {
  constructor(frames) { this.doc = new Y.Doc() }
  
  stepOnce() {
    Y.applyUpdate(this.doc, decode(this.frames[this.step].update))
    this.step++
  }
  
  seek(target) {
    // CRDT 文档无法"撤销"已合并的更新
    if (target < this.step) {
      this.doc = new Y.Doc()      // 必须重建
      this.step = 0
      while (this.step < target) this.stepOnce()
    } else {
      while (this.step < target) this.stepOnce()
    }
  }
}
```

**这是 CRDT 的固有特性**：没有"删除历史"的操作，因为那会破坏收敛性。
所以时间轴向前跳是 O(1)，向后跳必须重建——这个非对称性必须在设计时就考虑清楚。

---

## 9. 延迟度量

### 9.1 为什么不用 ping 延迟

ping 延迟只反映网络 RTT，不等于"操作可见延迟"——
后者还包含服务端处理、消息编解码、渲染调度。面试时用 ping 数据冒充同步延迟是不诚实的。

### 9.1.1 但 RTT 本身仍然要测，且必须自研探针

网络 RTT 虽然不等于同步延迟，但它是**定位问题的基础指标**：
如果 RTT 已经是 200ms，那同步延迟一定超标，不可能是 CRDT 合并慢。

关键在于：**不能用 awareness 测 RTT**。

服务端广播 awareness 时会**排除消息来源连接**（避免回环），
所以发起者永远收不到自己的回声。此时客户端读到的
`now() - 上次ping时间` 其实是"距上次 ping 多久"，而不是"往返多久"——
在 800ms 探测间隔下会稳定显示 200~800ms 的假高延迟。

正确做法是自研一对扩展消息：

```
200 (PING)  客户端 → 服务端：varuint 时间戳
201 (PONG)  服务端 → 客户端：varuint 原样回显的时间戳
```

服务端只需解码后原样回显，不做业务处理：

```js
case MESSAGE_PING: {
  const ts = decoding.readVarUint(decoder)
  const penc = encoding.createEncoder()
  encoding.writeVarUint(penc, MESSAGE_PONG)
  encoding.writeVarUint(penc, ts)
  this._raw(encoding.toUint8Array(penc))
  break
}
```

客户端侧要注意：`y-websocket` 的 `readMessage` 按消息类型查
`provider.messageHandlers[type]`，官方只注册了 0~3。扩展类型必须**手动注册**，
否则会打印 `Unable to compute message` 且探针无法回收：

```js
provider.messageHandlers[MESSAGE_PONG] = (encoder, decoder) => {
  const sentAt = decoding.readVarUint(decoder)
  recordRtt(performance.now() - sentAt)
}
```

> 这是一个"指标本身是错的"的典型案例：功能看起来完全正常，
> 只有在真实浏览器里看那个数字才会发现它是假的。
> 面试时讲这个比讲"我做了一个 RTT 探针"有说服力得多。

**两个延迟指标口径必须分清：**

| 指标 | 含义 | 采集方式 | 用途 |
|---|---|---|---|
| RTT | 客户端↔服务端网络往返 | 自研 ping/pong（type 200/201） | 排查网络/服务端问题 |
| 同步延迟 | 本地操作 → 远端可见 | 探针笔迹首次可见 | 考核 <80ms 指标 |

### 9.2 正确做法

只对**固定间隔写入的探针笔迹**计时：

```js
// 写入方：写入前记录时间
globalThis.__wbSentAt.set(probeId, performance.now())

// 任意客户端：收到更新时检查探针是否首次可见
doc.on('update', () => {
  const start = __wbSentAt.get(probeId)
  if (start != null && !observed.has(probeId)) {
    latency = performance.now() - start
  }
})
```

指标口径：全局所有样本的 P50 / P95 / P99。

### 9.3 三个必须避开的度量陷阱

这些坑都真实踩过，也是压测工具本身容易出错的地方：

**陷阱一：离线客户端污染延迟样本。**
离线客户端重连后会一次性收到大量历史更新，若计入统计会产生数秒的虚假长尾。
→ 只统计在线期间的样本。

**陷阱二：对每条操作都计时导致 O(n²)。**
每次 update 都全量遍历 strokes 找新元素，n 上千时压测客户端自己成为瓶颈，
测出的延迟反映的是客户端而非服务端。
→ 改用探针笔迹 + 增量检查，复杂度与元素总数解耦。

**陷阱三：固定 sleep 判定收敛。**
大房间 + 大量客户端同时重连时，服务端需要多轮大合并，固定等待 4s 会误报"未收敛"。
→ 改为轮询直到全员一致或超时（实测 100 人场景收敛仅需 2.3s，但固定 4s 仍会误判）。

> **压测工具不准，会把正常的系统误报成有 bug。**
> 定位到"未收敛"时，第一件事应该是质疑测量方法，而不是急着优化被测系统。

> **报告时必须写明测试环境。** 本机 loopback 的数字远优于公网真实场景，
> 跨城网络 RTT 本身就有 20–50ms。把本地结果当生产指标是自欺欺人。

---

## 10. 性能优化：同 tick 发送合并

50 人同时画时，若每条更新都做一次全连接 fan-out，事件循环会被发包队列拖住，
P95 出现数百毫秒的长尾。

**做法**：把同一事件循环阶段内累积的所有 CRDT 更新用 `Y.mergeUpdates` 合成一条消息，
每连接每 tick 最多 `send` 一次。

```js
_broadcastSync(message) {
  const update = this._unwrapSync(message)
  this._pendingUpdates.push(update)
  if (!this._flushScheduled) {
    this._flushScheduled = true
    setImmediate(() => this._flushSync())   // 当前事件循环阶段结束后统一 flush
  }
}

_flushSync() {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MESSAGE_SYNC)
  syncProtocol.writeUpdate(enc, Y.mergeUpdates(this._pendingUpdates))
  const message = encoding.toUint8Array(enc)
  for (const conn of [...this.connections]) this._send(conn, message)
}
```

**为什么不改变语义**：CRDT 更新本身可无损合并（这正是 CRDT 的定义）。
合并后发一条与合并前发 N 条，客户端最终状态完全一致。

**效果**：50 人场景 P95 从 315ms 降到 0.4ms。

---

## 11. 实现中踩过的坑（面试讲点）

这一节记录真实踩过的 bug——**能说清楚自己踩过什么坑，比能展示功能更有说服力**。

### 坑一：消息二次包裹（最隐蔽）

协议为 `[varuint type][varUint8Array payload]`。但 `syncProtocol.writeUpdate()`
产出的**已经是完整的 sync 消息**（内含 sync 子类型），再套一层 `writeVarUint8Array`
就会多出一个长度头，客户端解析时字节错位 → `Unexpected end of array`。

症状：单客户端正常，多客户端一同步就崩。
排查方式：把服务端发出的原始字节 hex dump 出来对照。

```js
// 正确：直接发，不要再包一层
const enc = encoding.createEncoder()
encoding.writeVarUint(enc, MESSAGE_SYNC)
syncProtocol.writeUpdate(enc, update)
socket.send(encoding.toUint8Array(enc))
```

同理，awareness 广播也必须只包一次 type 前缀。

### 坑二：Awareness 实例归属错误

最初给每个连接 `new Awareness(room.doc)`，期望其 update 事件能触发房间广播。
但每个 Awareness 是独立实例，事件不通——光标永远同步不了。

**正确**：房间持有唯一 Awareness 实例作为权威状态与中继，
连接只通过 `applyAwarenessUpdate(awareness, update, conn)` 写入它，
`origin` 用于记录 clientID 归属，断开时精确清理，避免"幽灵光标"。

### 坑三：共享 Awareness 被单个连接销毁

连接关闭时调用 `awareness.destroy()` 会摧毁**房间共享**的实例，
导致其他连接的 awareness 全部失效。
→ 连接关闭只清理自己带来的 clientID 状态，不碰实例本身。

### 坑四：URL 拼接约定不一致

`y-websocket` 会把房间名追加为路径段：`<serverUrl>/<roomname>`。
若 serverUrl 里带了 query（`/ws?userId=x`），拼接结果会错位成
`/ws?userId=x/<room>`，服务端解析不到房间名，全部落到默认房间。

→ 约定：身份信息走 query，房间名走路径段，两边统一。

### 坑五：Node 端需要 WebSocket polyfill

`y-websocket` 在 Node 环境不会自动使用 `ws` 包，必须显式注入：

```js
new WebsocketProvider(WS_BASE, ROOM, doc, {
  params: { userId, userName, color },
  WebSocketPolyfill: NodeWebSocketShim,   // binaryType='arraybuffer'，关闭压缩
  disableBc: true
})
```

不注入时 provider 会静默反复重连，表现为"连接超时"而非明确报错。

### 坑六：不存在的 API 假设

`awareness.setStates()` 并不存在（y-protocols 只有 `setLocalState`）。
调用它会在连接注册时抛异常，**后续广播链路一起断掉**，
表现为"服务端日志刷屏但客户端收不到任何更新"。

→ 遇到 API 不确定时，先查库的源码，不要凭直觉写。

### 坑七：Vue 模板里的"伪响应式"导致整页白屏

`useCollaboration` 最初把状态写成普通对象：

```js
const online = { value: false }
const peers  = { value: [] }
const stats  = { latency: [], sent: 0 }
```

这是**从非 Vue 语境带来的习惯**——手写响应式系统里 `{ value }` 是常见约定，
但 Vue 3 的模板只对 `ref` / `reactive` 做解包。

后果链：`peers`（普通对象）被传给 `Members` 组件 →
`Members` 里 `props.peers.filter(...)` → `filter is not a function` TypeError →
组件渲染函数抛错 → **整个应用挂载失败，页面全白**。

讽刺的是服务端日志里看不到任何浏览器连接——因为异常发生在
`collab.connect()` 之前，WebSocket 根本还没建。

排查手段：用无头浏览器抓真实控制台，而不是靠读代码猜。

```js
const page = await browser.newPage()
page.on('pageerror', (e) => console.log(e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log(m.text()) })
```

**教训**：跨框架复用代码时，"看起来像响应式"和"真的是响应式"是两回事。
Vue 里必须用 `ref()` / `reactive()`，且要在真实浏览器里验证渲染。

### 坑八：手动删 awareness.meta 造成"幽灵成员"

断开连接时需要清理该连接带来的 awareness 状态（否则成员永远挂在房间里）。
最初手写清理：

```js
this.awareness.states.delete(cid)
this.awareness.meta.delete(cid)          // ← 删了 meta
awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids)  // ← 又要读 meta
```

`encodeAwarenessUpdate` 内部要读 `awareness.meta.get(clientID).clock`
来编码"该成员已离开"的通知。meta 被删后 `.get()` 返回 `undefined`，
于是抛 `TypeError: Cannot read properties of undefined (reading 'clock')`。

更糟的是这个异常会**中断整个清理流程**——状态没删掉，
连接虽然断了，成员却永远显示在房间里（幽灵光标）。

正确做法是用官方 API，它会保留 meta 中的 clock，并自动触发 update 事件
让房间把"成员离开"广播出去：

```js
awarenessProtocol.removeAwarenessStates(this.awareness, ids, conn)
```

**教训**：库的 API 往往内部维护着你不了解的不变量。
绕过 API 手改内部状态，等于放弃了它替你维护的一致性保证。

### 坑九：协议扩展类型未在客户端注册

服务端新增了 type 200/201 的探针消息后，客户端仍按官方
`messageHandlers`（只含 0~3）解析，遇到 201 会打印
`Unable to compute message` 并**丢弃后续解析**。

`y-websocket` 把 handler 表放在实例上（`this.messageHandlers = messageHandlers.slice()`），
所以可以安全地按类型索引扩展：

```js
provider.messageHandlers[MESSAGE_PONG] = (encoder, decoder) => { /* ... */ }
```

---

## 12. 已知限制与改进方向

| 限制 | 原因 | 改进方向 |
|---|---|---|
| 内存态存储 | 服务重启丢失 | 快照持久化到 LevelDB/S3 |
| 无鉴权 | 任何人可加入任意房间 | JWT + 房间级 ACL |
| 高频客户端可能拖慢房间 | 广播是同步遍历 | 已实现同 tick 合并；可进一步做发送端合帧 |
| 长房间 ops 数组线性增长 | 全量记录 | 分段存储 + 定期归档（已实现超限折叠为基线） |
| 未做移动端触控优化 | - | 压感事件、`touch-action` 精细控制 |
| 无背压机制 | 慢客户端会积压消息 | 按连接限流，超阈值合并增量 |
| 离线重连时全量广播 | 大房间下带宽浪费 | 让客户端通过 sync step1/2 增量拉取 |

明确写出限制比假装没有更专业——面试时这是加分项。