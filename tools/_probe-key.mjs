import { parseScoreText, summarizeTimeline } from '../lib/notation.js'

const t = [
  'tempo 100',
  'key 1=B3',
  'unit 0.5',
  '[RH]',
  "3 2 6' 2'",
  '[LH]',
  '4, 1, 4 5 6 0',
].join('\n')

const p = parseScoreText(t)
console.log('key =', p.key, ' tempo =', p.tempo, ' beats =', p.beats)
for (const n of p.notes) {
  console.log(n.voice, 'pos=' + n.pos, 'midi=' + n.midi, summarizeTimeline([n], 1))
}
console.log('warnings:', p.warnings)

// 逐个音验证 B 大调映射
const deg = '1 2 3 4 5 6 7 1\''
const pp = parseScoreText('key 1=B3\nunit 1\n' + deg)
console.log('\nB 大调 1=B3 各音级:')
console.log(deg)
console.log(pp.notes.map((n) => summarizeTimeline([n], 1)).join(' '))
