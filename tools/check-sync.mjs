import puppeteer from 'puppeteer'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const URL = `http://localhost:${process.env.WEB_PORT || 5173}/?room=testsync`

const browser = await puppeteer.launch({
  headless: true,
  executablePath: EDGE,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
})

async function open(name) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 800 })
  page.on('pageerror', (e) => console.log(`[${name} pageerror] ${e.message}`))
  page.on('requestfailed', (r) => console.log(`[${name} reqfail] ${r.url()}`))
  page.on('response', (r) => {
    if (r.status() >= 400) console.log(`[${name} http${r.status()}] ${r.url()}`)
  })
  await page.goto(URL, { waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 1500))
  return page
}

const a = await open('A')
const b = await open('B')
await new Promise((r) => setTimeout(r, 1500))

// A 在画布上画一笔
await a.mouse.move(300, 300)
await a.mouse.down()
for (let i = 0; i < 20; i++) {
  await a.mouse.move(300 + i * 8, 300 + Math.sin(i / 3) * 30)
  await new Promise((r) => setTimeout(r, 8))
}
await a.mouse.up()
await new Promise((r) => setTimeout(r, 1500))

const res = await b.evaluate(() => {
  const c = window.__wb.collab
  return {
    strokes: c.strokes.length,
    sent: c.stats.sent,
    received: c.stats.received,
    peers: c.peers.value.length,
    online: c.online.value
  }
})
const resA = await a.evaluate(() => ({
  strokes: window.__wb.collab.strokes.length,
  sent: window.__wb.collab.stats.sent
}))

console.log('--- 协作验证 ---')
console.log('B 端收到:', JSON.stringify(res))
console.log('A 端:', JSON.stringify(resA))
console.log(res.strokes === 1 && resA.strokes === 1 ? '✅ 笔迹已同步' : '❌ 同步失败')

await a.screenshot({ path: 'tools/_sync-a.png' })
await b.screenshot({ path: 'tools/_sync-b.png' })
await browser.close()
