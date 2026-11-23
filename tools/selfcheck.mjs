import { createRequire } from 'node:module'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
const req = createRequire('C:/Users/海冥乐/.dsh/profiles/desktop/package.json')
const yaml = req('js-yaml')

let failures = 0
function ok(msg) { console.log('  OK    ' + msg) }
function bad(msg) { failures++; console.log('  FAIL  ' + msg) }
function check(cond, msg) { if (cond) { ok(msg) } else { bad(msg) } }

// 1. JSON 合法性
let pkg = null
try {
  pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  ok('package.json 是合法 JSON')
} catch (e) {
  bad('package.json: ' + e.message)
}
for (const f of ['locale/zh.json', 'locale/en.json']) {
  try {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    check(!!(j.meta && j.meta.title && j.meta.description), f + ' 有 title/description')
  } catch (e) {
    bad(f + ': ' + e.message)
  }
}

if (!pkg) { console.log('package.json 都读不了，后面跳过'); process.exit(1) }

// 2. exports 指向的文件存在
for (const [key, value] of Object.entries(pkg.exports || {})) {
  if (key.includes('*')) continue
  const target = typeof value === 'string' ? value : (value.default || '')
  if (!target) continue
  check(existsSync(join(dir, target)), 'exports[' + key + '] -> ' + target)
}

// 3. files 覆盖运行期文件
const runtimeFiles = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'lib/notes.js', 'lib/score.js', 'lib/engine.js']
const globs = pkg.files || []
function covered(rel) {
  return globs.some((g) => {
    if (g === rel) return true
    if (g.endsWith('*')) return rel.startsWith(g.replace(/\*+$/, ''))
    if (!g.includes('/')) return rel.startsWith(g + '/')
    return false
  })
}
for (const rel of runtimeFiles) check(covered(rel), 'files 覆盖 ' + rel)

// 4. dsh 声明
check(!!(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch), 'dsh.bundle.patch 已声明')
check(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', 'dsh.client.platform = web')
console.log('  INFO  client.inject = ' + JSON.stringify(pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject))

// 5. patch YAML
try {
  const patch = yaml.load(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'))
  const row = patch && patch[0] && patch[0].insert && patch[0].insert[0]
  check(!!(row && row.id && row.name), 'patch 结构：insert[0] 有 id/name')
  check(row && row.name === pkg.name, 'patch.name 与包名一致 (' + (row && row.name) + ')')
} catch (e) {
  bad('cordis.patch.yml: ' + e.message)
}

// 6. icon
const iconPath = join(dir, 'icon.svg')
if (!existsSync(iconPath)) {
  bad('缺 icon.svg')
} else {
  const svg = readFileSync(iconPath, 'utf8')
  const size = statSync(iconPath).size
  check(size < 256 * 1024, 'icon.svg ' + size + ' 字节（上限 256KB）')
  const forbidden = ['<script', 'onload=', 'onclick=', '<style', '<text', '<foreignObject', '<image']
  const hits = forbidden.filter((t) => svg.includes(t))
  check(hits.length === 0, 'icon 无脚本/样式/文字/外链' + (hits.length ? '（命中 ' + hits.join(',') + '）' : ''))
  check(svg.includes('viewBox="0 0 36 36"'), 'icon viewBox 是 36x36')
}

// 7. 客户端 bundle 形态
const client = readFileSync(join(dir, 'client.js'), 'utf8')
check(client.includes('window.__ModuleLoader__.load('), 'client 是 __ModuleLoader__ 自注册脚本')
check(client.includes("id: '" + pkg.name + "'"), 'client id 与包名一致')
check(!/^\s*import\s/m.test(client), 'client 无 import 语句（不是 ESM 形态）')
check(!client.includes('dsh-client-ui-primitives'), 'client 不引用 Harness Client 组件包')

// 8. 依赖与生命周期脚本
check(Object.keys(pkg.dependencies || {}).length === 0, '零 dependencies')
const lifecycles = Object.keys(pkg.scripts || {}).filter((s) => /^(pre|post)?install$|^prepare$/.test(s))
check(lifecycles.length === 0, '无 install 类生命周期脚本' + (lifecycles.length ? '（有 ' + lifecycles.join(',') + '）' : ''))

console.log('')
if (failures === 0) {
  console.log('自检全部通过')
  process.exit(0)
}
console.log('自检有 ' + failures + ' 项没过')
process.exit(1)
