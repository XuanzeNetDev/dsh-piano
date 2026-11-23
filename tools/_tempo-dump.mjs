import { readFileSync } from 'node:fs'
import { parseMidi } from '../lib/midi.js'

const midi = parseMidi(readFileSync(process.argv[2]))
console.log('tempo 段数:', midi.tempoMap.length)
for (const t of midi.tempoMap) {
  console.log(`  tick ${t.tick}  ${t.usPerQuarter} us/四分音符  = ${(60_000_000 / t.usPerQuarter).toFixed(2)} BPM`)
}
console.log('拍号:', midi.timeSignature)
console.log('division:', midi.division, 'PPQ')
console.log('endTick:', midi.endTick)
console.log('轨数:', midi.tracks.length, midi.tracks.map((t) => t.notes.length))

// 如果只有默认值，说明文件里没有 tempo 事件
if (midi.tempoMap.length === 1 && midi.tempoMap[0].tick === 0 && midi.tempoMap[0].usPerQuarter === 500000) {
  console.log('\n>> 文件里没有 tempo 事件，当前按解析器默认 120 BPM 换算。')
}
