import { readFileSync } from 'node:fs'
import { parseScoreText, toTimeline } from '../lib/notation.js'
import { createEngine } from '../lib/engine.js'

const text = readFileSync(process.argv[2], 'utf8')
const parsed = parseScoreText(text)
const timeline = toTimeline(parsed, { tempo: parsed.tempo })

const engine = createEngine()
const r = engine.schedule(timeline, { label: 'test', tempo: parsed.tempo })
console.log('音符数', timeline.length)
console.log('排入队列', r.count, '| spanMs', r.spanMs, '=', (r.spanMs / 1000).toFixed(1), '秒')
const st = engine.status()
console.log('队列剩余', st.queued)
console.log('理论时长', ((parsed.beats * 60000) / parsed.tempo / 1000).toFixed(1), '秒')
console.log(r.count === timeline.length ? '✓ 全曲排入，无截断' : `✗ 截断了 ${timeline.length - r.count} 个音`)
