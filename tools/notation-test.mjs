import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 同 selfcheck：没有参数时从本文件位置推包根
const dir = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { parseScore, toTimeline } = await import(pathToFileURL(join(dir, 'lib', 'score.js')).href)
const { noteName } = await import(pathToFileURL(join(dir, 'lib', 'notes.js')).href)

let bad = 0
const check = (cond, msg, extra) => {
  if (cond) console.log('  OK    ' + msg)
  else { bad++; console.log('  FAIL  ' + msg + (extra ? '  << ' + extra : '')) }
}

console.log('=== 1. 简谱基本解析 ===')
const p1 = parseScore('tempo 100\nkey 1=B3\nunit 0.5\n[RH]\n3 2 6\' 2\'', {})
const midis = p1.notes.map((n) => n.midi)
check(midis.join(',') === '63,61,80,73', '3 2 6\' 2\' -> D#4 C#4 G#5 C#5', midis.map(noteName).join(' '))
check(Math.abs(p1.notes[0].beats - 0.5) < 1e-9, 'unit 0.5 生效（每记号半拍）')
check(p1.tempo === 100, 'tempo 生效')
check(p1.key === '1=B3', 'key 生效')

console.log('=== 2. 和弦 / 时值 / 休止 / 延长 ===')
const p2 = parseScore('key 1=C4\n1+3+5 1:2 r:2 5 - -', {})
check(p2.notes.length === 5, '和弦 3 个音 + 1:2 + 5 = 5 个音', p2.notes.length)
const chord = p2.notes.filter((n) => n.pos === 0).map((n) => n.midi)
check(chord.join(',') === '60,64,67', 'C 大三和弦 = C4 E4 G4', chord.map(noteName).join(' '))
const long = p2.notes.find((n) => n.midi === 60 && n.pos === 1)
check(long && Math.abs(long.beats - 2) < 1e-9, '1:2 是两拍', long && long.beats)
const held = p2.notes.find((n) => n.midi === 67 && n.pos === 0)
check(held && Math.abs(held.beats - 1) < 1e-9, '和弦里的音没有被误延长', held && held.beats)
const longLast = p2.notes.find((n) => n.midi === 67 && n.pos === 5)
check(longLast && Math.abs(longLast.beats - 3) < 1e-9, '5 - - 延长到三拍', longLast && longLast.beats)

console.log('=== 3. 双手声部对齐 ===')
const p3 = parseScore('[RH]\n3:4\n[LH]\n1:2 5:2', {})
check(p3.notes.length === 3, '两个声部都进来了', p3.notes.length)
check(p3.voices.length === 2, '识别出声部：RH + LH', p3.voices.join('+'))
check(Math.abs(p3.beats - 4) < 1e-9, '总长 4 拍', p3.beats)

console.log('=== 4. 越界与错误 ===')
const tryBad = (text, want) => {
  try { parseScore(text, {}); check(false, want + '（本该报错）') }
  catch (e) { check(e.message.includes(want) || e.name === 'NoteError', want + ' -> ' + e.message.slice(0, 46)) }
}
tryBad('key 1=C4\n9', '9')
tryBad('key 1=C4\nC10', 'C10')
tryBad('', '空')

console.log('=== 5. 真实谱文件 ===')
const text = readFileSync(dir + '/scores/flower-dance-prelude.score', 'utf8')
const fl = parseScore(text, {})
const tl = toTimeline(fl, { tempo: fl.tempo })
const lo = Math.min(...tl.map((n) => n.midi))
const hi = Math.max(...tl.map((n) => n.midi))
check(fl.notes.length === 87, '87 个音（与上一版手工版一致）', fl.notes.length)
check(fl.warnings.length === 0, '没有解析警告', fl.warnings.join(';'))
check(fl.voices.join('+') === 'rh+lh', '双手声部', fl.voices.join('+'))
console.log('       音域 ' + noteName(lo) + ' – ' + noteName(hi) + '，' + fl.beats + ' 拍，' + (Math.max(...tl.map(n=>n.at+n.dur))/1000).toFixed(1) + ' 秒')
console.log('       前 8 个音：' + tl.slice(0, 8).map((n) => noteName(n.midi)).join(' '))
console.log('       按拍对齐：' + fl.notes.slice(0, 6).map((n) => noteName(n.midi) + '@' + n.pos).join(' '))

console.log('=== 6. 内置曲目全部可解析（音名含 # 的尤其要查）===')
const { MELODIES } = await import(pathToFileURL(dir + '/lib/score.js').href)
for (const m of MELODIES) {
  const p = parseScore(m.score, { tempo: m.tempo })
  const sharpCount = (m.score.match(/#/g) || []).length
  const okCount = p.notes.length > 5
  const okWarn = p.warnings.length === 0
  if (!okCount || !okWarn) {
    bad++
    console.log('  FAIL  ' + m.id + ' -> ' + p.notes.length + ' 个音，警告：' + p.warnings.join(';'))
  } else {
    console.log('  OK    ' + m.title + '：' + p.notes.length + ' 个音（谱里 ' + sharpCount + ' 个 #）')
  }
}

console.log('')
console.log(bad === 0 ? '全部通过' : bad + ' 项没过')
process.exit(bad ? 1 : 0)
