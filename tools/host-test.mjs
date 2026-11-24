import { pathToFileURL } from 'node:url'
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 没有参数时从本文件位置推包根（`npm run test:host` 不传参）
const dir = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { apply } = await import(pathToFileURL(join(dir, 'index.js')).href)

const tools = []
const routes = []
const ctx = {
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  get: () => undefined,
  inject(deps, cb) {
    if (deps.includes('tools')) cb({ tools: { register: (def) => { tools.push(def); return () => {} } } })
    if (deps.includes('webServer')) cb({ webServer: { register: (r) => { routes.push(r); return () => {} } } })
  },
}
apply(ctx, { leadMs: 400 })

let bad = 0
const check = (cond, msg, extra) => {
  if (cond) console.log('  OK    ' + msg)
  else { bad++; console.log('  FAIL  ' + msg + (extra ? '  << ' + extra : '')) }
}
const T = (n) => tools.find((t) => t.name === n)

console.log('=== 工具注册 ===')
check(['piano_score', 'piano_play', 'piano_piece', 'piano_stop', 'piano_status'].every((n) => !!T(n)),
  '工具都注册了：' + tools.map((t) => t.name).join(', '))

console.log('=== piano_score：写谱 + 演奏 ===')
const tmp = dir + '/scores/__smoke.score'
if (existsSync(tmp)) unlinkSync(tmp)
const scoreText = readFileSync(dir + '/scores/flower-dance-prelude.score', 'utf8')
const r1 = await T('piano_score').execute({ path: tmp, text: scoreText })
check(r1.ok, '写谱并演奏成功', r1.text)
check(existsSync(tmp), '谱文件真的落盘了')
console.log('       ' + r1.text.split('\n').slice(0, 3).join('\n       '))

console.log('=== piano_score：只给 path 再弹一次 ===')
const r2 = await T('piano_score').execute({ path: tmp, tempo: 120 })
check(r2.ok && r2.text.includes('120 BPM'), '读出文件并用 120 BPM 演奏', r2.text.split('\n')[0])

console.log('=== piano_score：save 只存不弹 ===')
const before = (await T('piano_status').execute({})).text
const r3 = await T('piano_score').execute({ path: tmp + '.2', text: '[RH]\n1:4', save: true })
check(r3.ok, 'save:true 只写不排', r3.text.split('\n')[1])

console.log('=== piano_play：简谱当场弹 ===')
const r4 = await T('piano_play').execute({ score: 'tempo 120\nunit 0.5\nkey 1=C4\n1 2 3 4 5 6 7 1\'' })
check(r4.ok && r4.text.includes('8 个音'), '简谱当场弹 8 个音', r4.text)
check(!r4.text.includes('提示'), '没有解析警告（不该有"提示："）', r4.text)

console.log('=== 错误路径 ===')
const r5 = await T('piano_score').execute({ path: tmp + '.missing' })
check(!r5.ok && r5.text.includes('找不到'), '读不存在的谱文件会说清楚', r5.text)
const r6 = await T('piano_play').execute({ score: 'key 1=C4\n3 9 x' })
check(r6.ok, '坏记号只警告不中断', r6.text.split('\n').pop())
const r7 = await T('piano_play').execute({ score: '' })
check(!r7.ok, '空谱报错', r7.text)

console.log('=== HTTP 路由 ===')
const route = routes[0]
check(route && route.path === '/api/dsh-piano-xz', '路由前缀', route && route.path)
const captured = []
const mk = () => ({ statusCode: 0, headers: {}, setHeader() {}, end(b) { captured.push(b) } })
// /events 按 User-Agent 前 40 字符分桶记游标 —— 假请求必须带 UA，
// 否则 handler 里读 req.headers['user-agent'] 会抛异常，返回 {ok:false,error:...}
const req = {
  method: 'GET',
  url: '/api/dsh-piano-xz/events?since=0',
  headers: { 'user-agent': 'dsh-piano-selftest/1.0' },
}
await route.handler(req, mk())
const ev = JSON.parse(captured[0])
check(ev.ok && Array.isArray(ev.events) && ev.events.length > 0,
      '事件队列有货', ev.ok ? 'events=' + (ev.events || []).length : ev.error)
if (!ev.ok) { console.log('       响应: ' + String(captured[0]).slice(0, 160)) }
const ev0 = (ev.events || [])[0]
check(ev0 && typeof ev0.m === 'number' && typeof ev0.t === 'number', '事件带 midi 和时刻')
check(typeof ev.events[0].m === 'number' && typeof ev.events[0].t === 'number', '事件带 midi 和时刻')
await route.handler({ method: 'GET', url: '/api/dsh-piano-xz/info' }, mk())
const info = JSON.parse(captured[1])
const pkgVersion = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
check(info.ok && info.version === pkgVersion, '/info 正常', 'version=' + info.version)

for (const f of [tmp, tmp + '.2']) if (existsSync(f)) unlinkSync(f)

console.log('')
console.log(bad === 0 ? '全部通过' : bad + ' 项没过')
process.exit(bad ? 1 : 0)
