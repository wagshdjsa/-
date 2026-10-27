import puppeteer from 'puppeteer'

const url = process.argv[2] || `http://localhost:${process.env.WEB_PORT || 5173}/?room=demo`
const browser = await puppeteer.launch({
  headless: true,
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args: ['--no-sandbox', '--disable-setuid-sandbox']
})
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`))
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`))

await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
await new Promise((r) => setTimeout(r, 2500))

const info = await page.evaluate(() => {
  const app = document.querySelector('#app')
  return {
    appChildren: app ? app.children.length : -1,
    appHTMLLen: app ? app.innerHTML.length : -1,
    bodyText: (document.body.innerText || '').slice(0, 300),
    hasToolbar: !!document.querySelector('.toolbar'),
    hasCanvas: !!document.querySelector('canvas.base'),
    hasTopbar: !!document.querySelector('.topbar'),
    wsRoom: window.__wb ? 'exposed' : 'missing'
  }
})
console.log('--- PAGE INFO ---')
console.log(JSON.stringify(info, null, 2))
console.log('--- CONSOLE ---')
console.log(logs.join('\n') || '(no console output)')
await page.screenshot({ path: 'tools/_shot.png' })
await browser.close()
