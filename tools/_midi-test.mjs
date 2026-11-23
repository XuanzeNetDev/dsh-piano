import { readFileSync } from 'node:fs'
import { describeMidi, midiToTimeline, parseMidi } from '../lib/midi.js'
import { noteName } from '../lib/notes.js'

for (const f of process.argv.slice(2)) {
  const midi = parseMidi(readFileSync(f))
  console.log('\n=== ' + f.split(/[\\/]/).pop())
  console.log(describeMidi(midi))
  for (let i = 0; i < midi.tracks.length; i++) {
    const t = midi.tracks[i]
    if (!t.notes.length) continue
    const ps = t.notes.map((n) => n.pitch)
    console.log(`  [${i}] ${t.name || '(无名)'} ${t.notes.length} 音  ${noteName(Math.min(...ps))}-${noteName(Math.max(...ps))}`)
  }
  const { timeline, seconds, dropped, clipped } = midiToTimeline(midi, {})
  console.log(`时间轴: ${timeline.length} 音, ${seconds.toFixed(1)} 秒, 丢弃 ${dropped}, 移八度 ${clipped}`)
  console.log('前 8 个:', timeline.slice(0, 8).map((n) => `${noteName(n.midi)}@${n.at}ms/${n.dur}ms`).join(' '))
  const maxDur = Math.max(...timeline.map((n) => n.dur))
  console.log('最长音', maxDur, 'ms')
}
