import puppeteer from 'puppeteer'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const URL = `http://localhost:${process.env.WEB_PORT || 5173}/?room=ghost`
const API = `http://localhost:${process.env.SERVER_PORT || 1234}`

const browser = await puppeteer.launch({
  headless: true,
  executablePath: EDGE,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
})

const page = await browser.newPage()
await page.setViewport({ width: 1200, height: 800 })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(URL, { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 1500))

const s1 = await (await fetch(`${API}/api/rooms/ghost`)).json()
console.log('连接中:', JSON.stringify({ clientCount: s1.clientCount, users: s1.users.length }))

await page.close()
await new Promise((r) => setTimeout(r, 1500))

const s2 = await (await fetch(`${API}/api/rooms/ghost`)).json()
console.log('关闭后:', JSON.stringify({ clientCount: s2.clientCount, users: s2.users.length }))
console.log(s2.clientCount === 0 && s2.users.length === 0
  ? '✅ 断开后无幽灵成员'
  : '❌ 仍有残留')

console.log('页面错误:', errs.length ? errs.join(' | ') : '(无)')
await browser.close()
