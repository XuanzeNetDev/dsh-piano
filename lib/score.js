/**
 * 曲库 + 对外入口。
 *
 * 真正的解析在 notation.js（简谱那一套），这里只负责：
 *   - 内置曲目
 *   - 拍速收口
 *   - 把 notation 的解析函数转出去，让工具层只认一个模块
 */

export {
  parseScoreText as parseScore,
  toTimeline,
  summarizeTimeline as summarizeNotes,
  parseKey,
} from './notation.js'

/**
 * 拍速夹到能听的范围。
 * @param {unknown} value
 * @returns {number}
 */
export function clampTempo(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 100
  return Math.max(30, Math.min(280, n))
}

/**
 * 内置曲子。score 用音名写（等价于简谱，写法更直观），tempo 是默认拍速。
 */
export const MELODIES = [
  {
    id: 'twinkle',
    title: '小星星',
    aliases: ['twinkle', '小星星', '一闪一闪亮晶晶', '星星'],
    tempo: 120,
    score:
      'C4 C4 G4 G4 A4 A4 G4:2 F4 F4 E4 E4 D4 D4 C4:2 '
      + 'G4 G4 F4 F4 E4 E4 D4:2 G4 G4 F4 F4 E4 E4 D4:2 '
      + 'C4 C4 G4 G4 A4 A4 G4:2 F4 F4 E4 E4 D4 D4 C4:2',
  },
  {
    id: 'two-tigers',
    title: '两只老虎',
    aliases: ['two-tigers', '两只老虎', '雅克兄弟', 'frere'],
    tempo: 126,
    score:
      'C4 D4 E4 C4 C4 D4 E4 C4 E4 F4 G4:2 E4 F4 G4:2 '
      + 'G4 A4 G4 F4 E4 C4 G4 A4 G4 F4 E4 C4 '
      + 'C4 G3 C4:2 C4 G3 C4:2',
  },
  {
    id: 'ode-to-joy',
    title: '欢乐颂',
    aliases: ['ode-to-joy', '欢乐颂', '贝多芬', '第九'],
    tempo: 116,
    score:
      'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4:1.5 D4:0.5 D4:2 '
      + 'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4:1.5 C4:0.5 C4:2',
  },
  {
    id: 'birthday',
    title: '生日快乐',
    aliases: ['birthday', '生日快乐', 'happy birthday'],
    tempo: 112,
    score:
      'G4:0.5 G4:0.5 A4 G4 C5 B4:2 G4:0.5 G4:0.5 A4 G4 D5 C5:2 '
      + 'G4:0.5 G4:0.5 G5 E5 C5 B4 A4:2 F5:0.5 F5:0.5 E5 C5 D5 C5:2',
  },
  {
    id: 'elise',
    title: '致爱丽丝（开头）',
    aliases: ['elise', '致爱丽丝', 'für elise', 'fur elise', '贝多芬'],
    tempo: 132,
    score:
      'E5 D#5 E5 D#5 E5 B4 D5 C5 A4:2 C4 E4 A4 B4:2 E4 G#4 B4 C5:2 '
      + 'E4 E5 D#5 E5 D#5 E5 B4 D5 C5 A4:2 C4 E4 A4 B4:2 E4 C5 B4 A4:2',
  },
  {
    id: 'jingle',
    title: '铃儿响叮当',
    aliases: ['jingle', '铃儿响叮当', 'jingle bells'],
    tempo: 140,
    score:
      'E4 E4 E4:2 E4 E4 E4:2 E4 G4 C4 D4 E4:4 '
      + 'F4 F4 F4:1.5 F4 F4 E4 E4 E4:0.5 E4 D4 D4 E4 D4:2 G4:2',
  },
  {
    id: 'canon-chords',
    title: '卡农和弦',
    aliases: ['canon', '卡农', '卡农和弦', '和弦'],
    tempo: 92,
    score:
      'C4+E4+G4 G3+B3+D4 A3+C4+E4 E3+G3+B3 '
      + 'F3+A3+C4 C4+E4+G4 F3+A3+C4 G3+B3+D4',
  },
  {
    id: 'jasmine',
    title: '茉莉花（片段）',
    aliases: ['jasmine', '茉莉花', '民歌'],
    tempo: 96,
    score:
      'E4 E4 G4 A4 C5:1.5 C5:0.5 A4 G4:2 '
      + 'G4 A4 G4 E4 D4 E4:2',
  },
]

/**
 * 按 id / 标题 / 别名 / 模糊关键词找一首曲子。
 * @param {string} query
 * @returns {typeof MELODIES[number] | undefined}
 */
export function findMelody(query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return undefined
  const exact = MELODIES.find(
    (m) => m.id === q || m.title.toLowerCase() === q || (m.aliases ?? []).some((a) => a.toLowerCase() === q),
  )
  if (exact) return exact
  return MELODIES.find(
    (m) => m.id.includes(q) || m.title.includes(q) || (m.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
  )
}

/**
 * 曲目清单。
 * @returns {{ id: string, title: string, tempo: number }[]}
 */
export function melodyCatalog() {
  return MELODIES.map((m) => ({ id: m.id, title: m.title, tempo: m.tempo }))
}
