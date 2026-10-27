import puppeteer from 'puppeteer'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const URL = `http://localhost:${process.env.WEB_PORT || 5173}/?room=final`

const browser = await puppeteer.launch({
  headless: true,
  executablePath: EDGE,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
})

async function open(name) {
  const p = await browser.newPage()
  await p.setViewport({ width: 1280, height: 820 })
  p.on('pageerror', (e) => console.log(`[${name} ERR] ${e.message}`))
  p.on('console', (m) => { if (m.type() === 'error') console.log(`[${name} console.error] ${m.text()}`) })
  await p.goto(URL, { waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 1500))
  return p
}

const a = await open('A')
const b = await open('B')
const c = await open('C')
await new Promise((r) => setTimeout(r, 2000))

// 三人各画一笔（不同颜色）
const draw = async (page, x, y, color) => {
  await page.evaluate((col, px, py) => { window.__wb.collab.doc.transact(() => {
    window.__wb.collab.strokes.push([{
      id: 's' + Math.random().toString(36).slice(2),
      type: 'pen', color: col, width: 4,
      points: [{x: 100, y: 100}, {x: px, y: py}]
    }])
  }, 'local') }, color, x, y)
  await page.mouse.move(x, y)
}
await draw(a, 300, 300, '#4f8cff')
await draw(b, 500, 250, '#f2545b')
await draw(c, 700, 400, '#2fb96b')
// 移动光标
await a.mouse.move(400, 350)
await b.mouse.move(650, 300)
await new Promise((r) => setTimeout(r, 2000))

const stat = await a.evaluate(() => ({
  strokes: window.__wb.collab.strokes.length,
  peers: window.__wb.collab.peers.value.length,
  latency: window.__wb.collab.stats.latency.slice(-5),
  sent: window.__wb.collab.stats.sent,
  received: window.__wb.collab.stats.received
}))
console.log('A 端状态:', JSON.stringify(stat))
console.log(stat.strokes === 3 ? '✅ 三人笔迹全部同步' : `❌ 只同步了 ${stat.strokes}/3`)
console.log(stat.peers === 3 ? '✅ 成员列表含 3 人（含自己）' : `❌ peers=${stat.peers}`)

const lat = stat.latency
console.log('最近 RTT 样本(ms):', lat.map((x) => x.toFixed(1)).join(', '))

await a.screenshot({ path: 'tools/_final-a.png' })
await browser.close()
