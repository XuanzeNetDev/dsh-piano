import { readFileSync } from 'node:fs'
import { parseScoreText, summarizeTimeline } from '../lib/notation.js'

const path = process.argv[2]
const text = readFileSync(path, 'utf8')
const p = parseScoreText(text)
console.log('调', p.key, '| tempo', p.tempo, '| 声部', p.voices.join('+'))
console.log('音符', p.notes.length, '| 总拍', p.beats.toFixed(2), '| 约', (p.beats * 0.6).toFixed(1), '秒')
console.log('warnings', p.warnings.length)
for (const w of p.warnings.slice(0, 20)) console.log('  !', w)

// 音域
const midis = p.notes.map((n) => n.midi)
const lo = Math.min(...midis), hi = Math.max(...midis)
console.log('音域', summarizeTimeline([{ midi: lo }], 1), '-', summarizeTimeline([{ midi: hi }], 1))

// 每个声部的首尾
for (const v of p.voices) {
  const ns = p.notes.filter((n) => n.voice === v)
  console.log(v, ns.length, '音', '首:', summarizeTimeline(ns.slice(0, 4), 4), '尾:', summarizeTimeline(ns.slice(-4), 4))
}

// 检查是否有同一 pos 重叠相同 midi（重复音）
const seen = new Set()
let dup = 0
for (const n of p.notes) {
  const k = n.voice + '|' + n.pos + '|' + n.midi
  if (seen.has(k)) dup++
  seen.add(k)
}
console.log('重复音', dup)
