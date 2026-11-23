/**
 * 简谱解析。
 *
 * 这是这个插件的核心：一份乐谱文本 → 一条能弹的绝对时间轴。
 *
 * 支持的写法（对着纸上那种简谱抄就行）：
 *
 *   tempo 100            每分钟拍数
 *   key 1=B3             调号：数字 1 对应哪个键；省略八度时取 C4 附近那个
 *   unit 0.5             这一声部每个记号默认占几拍（八分音符就写 0.5）
 *   dyn 0.7              默认力度 0–1
 *
 *   [RH]                 右手声部
 *   3 2 6' 2' | 3 2 6' 2'
 *
 *   [LH]                 左手声部
 *   4, 1, 4, 5, 6, r | 5, 2, 5, 6, 7, r
 *
 * 记号规则：
 *   1–7        级数（do re mi …），可带 # 或 b，例如 #5、b7
 *   '          高八度，可以叠：6'' 高两个八度
 *   ,          低八度，可以叠：4,, 低两个八度
 *   :n         这个记号占 n 拍，例如 3:2（两拍）、3:0.5（半拍）
 *   @v         这个记号的力度 0–1，例如 3:1@0.9
 *   +          同时按（和弦），例如 1+3+5
 *   -          延长前一个音一拍（简谱里那条横线）
 *   r 或 0     休止
 *   |          小节线，只是视觉分隔，不影响时间
 *
 * 也认音名写法（C4 / Db4 / A#3），和简谱可以混着写。
 */

import { MIDI_MAX, MIDI_MIN, NoteError, noteName } from './notes.js'

/** 1–7 对应的半音数（大调音阶）。 */
const DEGREE_SEMITONE = [0, 2, 4, 5, 7, 9, 11]

/**
 * 力度记号 → MIDI velocity（0–127）。
 * 采用 MuseScore / Apple 那套标准值：ppp 16、pp 33、p 49、mp 64、mf 80、f 96、ff 112、fff 126。
 * 播放时按 MIDI 惯例取振幅与 velocity 的平方成正比，所以谱上写 mf 就是 mf。
 */
const DYNAMIC_VELOCITY = {
  pppp: 10,
  ppp: 16,
  pp: 33,
  p: 49,
  mp: 64,
  mf: 80,
  f: 96,
  ff: 112,
  fff: 126,
}

/**
 * 解析一个力度值：既认 p/mf/ff 这种音乐记号，也认 0–1 的归一化数字。
 * @param {string} raw
 * @returns {number|null} 0–1 的归一化力度（未除以 127，交给播放侧做平方律）
 */
function parseDynamic(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) return null
  if (DYNAMIC_VELOCITY[s] !== undefined) return DYNAMIC_VELOCITY[s] / 127
  const n = Number(s)
  if (Number.isFinite(n)) {
    // 大于 1 的按 MIDI velocity 理解，否则按 0–1 归一化
    return n > 1 ? Math.min(1, n / 127) : Math.max(0, Math.min(1, n))
  }
  return null
}

/** 音名字母的音级。 */
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/** 升号那套音名，用来把 MIDI 号说成话。 */
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** 一行里允许出现的分隔符（小节线在这里被吃掉）。
 *  注意：英文逗号**不能**当分隔符 —— 它是降八度记号（4, 1, 4）。 */
const SEPARATORS = /[\s|;]+/

/**
 * 解析调号，返回「数字 1」对应的 MIDI 号。
 * @param {string} raw 例如 "1=B3"、"1=C"、"B3"
 * @returns {number}
 */
export function parseKey(raw) {
  const s = String(raw ?? '').trim().replace(/^1\s*=\s*/, '')
  if (!s) return 60
  const m = /^([#b♯♭]?)\s*([A-Ga-g])(-?\d{1,2})?$/.exec(s)
  if (!m) throw new NoteError(`调号看不懂：「${raw}」。写成 1=C、1=B3、1=F# 这样。`)
  const accidental = m[1] === '#' || m[1] === '♯' ? 1 : m[1] === 'b' || m[1] === '♭' ? -1 : 0
  const pc = LETTER_PC[m[2].toUpperCase()] + accidental
  if (m[3] === undefined) {
    // 没写八度：取 C4 往上最近的那个同名音（C=60 … B=71）
    return 60 + (((pc % 12) + 12) % 12)
  }
  return (Number(m[3]) + 1) * 12 + pc
}

/**
 * 把记号后缀（:拍数 和 @力度）切下来，剩下的才是音高本体。
 * 和弦写法「1+3+5:2@0.9」里，后缀作用于整个和弦。
 * @param {string} raw
 * @returns {{ body: string, beats: number|null, velocity: number|null }}
 */
function splitSuffix(raw) {
  let body = String(raw ?? '').trim()
  let beats = null
  let velocity = null
  const at = /^(.*?)@(\d*\.?\d+)$/.exec(body)
  if (at) {
    body = at[1]
    velocity = Number(at[2])
  }
  const colon = /^(.*?):(\d*\.?\d+)$/.exec(body)
  if (colon) {
    body = colon[1]
    beats = Number(colon[2])
  }
  return { body, beats, velocity }
}

/**
 * 认一个孤立记号（不含 :拍 @力度 后缀）是什么。
 * @param {string} raw
 * @returns {{ kind: 'degree'|'letter'|'rest'|'hold'|'unknown', accidental?: number, value?: number, octave?: number }}
 */
function classify(raw) {
  const token = String(raw ?? '').trim()
  if (!token) return { kind: 'unknown' }
  if (token === '-' || token === '–' || token === '_') return { kind: 'hold' }
  if (token === 'r' || token === 'R' || token === '0' || token === '休止') return { kind: 'rest' }

  const degree = /^(#|b|♯|♭)?([1-7])(['’,\uFF0C]*)$/.exec(token)
  if (degree) {
    const marks = degree[3] || ''
    const up = (marks.match(/['’]/g) || []).length
    const down = (marks.match(/[,\uFF0C]/g) || []).length
    return {
      kind: 'degree',
      accidental: degree[1] === '#' || degree[1] === '♯' ? 1 : degree[1] ? -1 : 0,
      value: Number(degree[2]),
      octave: up - down,
    }
  }

  const letter = /^([A-Ga-g])(#|b|♯|♭)?(-?\d{1,2})?$/.exec(token)
  if (letter) {
    const accidental = letter[2] === '#' || letter[2] === '♯' ? 1 : letter[2] ? -1 : 0
    const pc = LETTER_PC[letter[1].toUpperCase()] + accidental
    const octave = letter[3] === undefined ? 4 : Number(letter[3])
    return { kind: 'letter', value: (octave + 1) * 12 + pc }
  }

  return { kind: 'unknown' }
}

/**
 * 把一个记号变成 MIDI 号。
 * @param {ReturnType<typeof classify>} info
 * @param {number} tonic 「数字 1」对应的 MIDI 号
 * @param {string} raw 原记号，报错时用
 * @returns {number}
 */
function toMidi(info, tonic, raw) {
  if (info.kind === 'letter') return info.value
  const step = DEGREE_SEMITONE[info.value - 1] + info.accidental
  return tonic + step + (info.octave || 0) * 12
}

/**
 * 落在 88 键里，越界直接说清楚（不偷偷移八度）。
 * @param {number} midi
 * @param {string} raw
 * @returns {number}
 */
function insideKeyboard(midi, raw) {
  if (!Number.isFinite(midi) || Math.round(midi) !== midi) {
    throw new NoteError(`记号「${raw}」不是一个音高。`)
  }
  if (midi < MIDI_MIN || midi > MIDI_MAX) {
    throw new NoteError(
      `「${raw}」超出了这台钢琴（${noteName(MIDI_MIN)}–${noteName(MIDI_MAX)}）。`
      + '往八度记号上找找：加 \u0027 是升八度，加 , 是降八度。',
    )
  }
  return midi
}

/**
 * 解析一整份乐谱文本。
 *
 * @param {string} text
 * @param {{ tempo?: number, velocity?: number }} [options]
 * @returns {{
 *   notes: { midi: number, pos: number, beats: number, velocity: number, voice: string }[],
 *   beats: number,
 *   tempo: number,
 *   key: string,
 *   voices: string[],
 *   warnings: string[]
 * }}
 */
export function parseScoreText(text, options = {}) {
  const source = String(text ?? '')
  if (!source.trim()) throw new NoteError('谱子是空的。')

  // 调用方显式给的 tempo / 力度优先级高于谱内声明：改拍速听一下，不该被谱里的
  // `tempo 100` 顶回去。
  const tempoOverride = Number.isFinite(options.tempo) ? Number(options.tempo) : null
  const velocityOverride = Number.isFinite(options.velocity) ? Number(options.velocity) : null

  let tempo = tempoOverride === null ? 100 : Math.max(20, Math.min(320, tempoOverride))
  let tonic = 60
  let keyText = '1=C'
  let unit = 1
  const defaultDyn = velocityOverride === null ? 80 / 127 : Math.max(0, Math.min(1, velocityOverride))
  /**
   * 力度按声部各记各的。
   * 单手写一个 dyn，另一只手不会跟着变 —— 右手旋律和左手伴奏本来就该不一样重，
   * 一个全局力度会让两只手糊成一片，听感就是"没有层次、像电子琴自动伴奏"。
   */
  const dynByVoice = new Map()
  const dynOf = (v) => (dynByVoice.has(v) ? dynByVoice.get(v) : defaultDyn)

  /** @type {{ midi: number, pos: number, beats: number, velocity: number, voice: string }[]} */
  const notes = []
  const warnings = []
  const voices = []

  /** 每个声部自己的游标。 */
  const cursors = new Map()

  function cursorOf(voice) {
    if (!cursors.has(voice)) cursors.set(voice, { pos: 0, lastStarts: [], lastBeats: unit })
    return cursors.get(voice)
  }

  let voice = 'main'
  cursorOf(voice)

  for (const rawLine of source.split(/\r?\n/)) {
    const trimmedLine = rawLine.trim()
    if (!trimmedLine) continue
    // 注释只在**行首**：# 开头或 // 开头。
    // 行内的 # 是升号（D#5），绝不能被当成注释吃掉 —— 这个坑踩过一次。
    if (trimmedLine.startsWith('#') || trimmedLine.startsWith('//')) continue
    const line = trimmedLine.replace(/\s+\/\/.*$/, '').trim()
    if (!line) continue

    // 声部标记 [RH] / [LH] / [Coda] ……
    const section = /^\[([^\]]+)\]$/.exec(line)
    if (section) {
      voice = section[1].trim().toLowerCase() || 'main'
      if (!voices.includes(voice)) voices.push(voice)
      cursorOf(voice)
      continue
    }

    // 全局设定
    const setting = /^([a-zA-Z]+)\s+(.+)$/.exec(line)
    if (setting) {
      const name = setting[1].toLowerCase()
      const value = setting[2].trim()
      if (name === 'tempo') {
        const n = Number(value)
        if (!Number.isFinite(n) || n <= 0) throw new NoteError(`tempo 看不懂：「${value}」。`)
        // 显式传进来的拍速优先，谱内的只当默认值
        if (tempoOverride === null) tempo = Math.max(20, Math.min(320, n))
        continue
      }
      if (name === 'key') {
        tonic = parseKey(value)
        keyText = value
        continue
      }
      if (name === 'unit') {
        const n = Number(value)
        if (!Number.isFinite(n) || n <= 0) throw new NoteError(`unit 看不懂：「${value}」。`)
        unit = Math.max(0.0625, Math.min(16, n))
        for (const c of cursors.values()) c.lastBeats = unit
        continue
      }
      if (name === 'dyn' || name === 'velocity') {
        const parsed = parseDynamic(value)
        if (parsed === null) {
          throw new NoteError(
            `力度记号看不懂：「${value}」。用 ppp/pp/p/mp/mf/f/ff/fff，或 0–1 的数字。`,
          )
        }
        if (velocityOverride === null) dynByVoice.set(voice, parsed)
        continue
      }
      // 不认识的设定当注释放过，但记一笔
      warnings.push(`不认识的设定「${name} ${value}」，已忽略`)
      continue
    }

    // 音符行
    const cursor = cursorOf(voice)
    for (const token of line.split(SEPARATORS).filter(Boolean)) {
      const { body, beats: rawBeats, velocity: rawVelocity } = splitSuffix(token)
      const step = rawBeats === null ? unit : Math.max(0.0625, rawBeats)
      const isChord = body.includes('+')

      // 单记号才可能是休止或延长；和弦一律当音高处理
      if (!isChord) {
        const alone = classify(body)
        if (alone.kind === 'unknown') {
          warnings.push(`看不懂「${token}」，已跳过`)
          continue
        }
        if (alone.kind === 'rest') {
          cursor.pos += step
          continue
        }
        if (alone.kind === 'hold') {
          // 延长：把这一声部上一个音（可能是和弦里好几个）都拉长
          for (const note of cursor.lastStarts) note.beats += step
          cursor.pos += step
          continue
        }
      }

      const velocity = rawVelocity === null ? dynOf(voice) : Math.max(0, Math.min(1, rawVelocity))
      const starts = []
      for (const part of body.split('+').filter(Boolean)) {
        const info = classify(part)
        if (info.kind !== 'degree' && info.kind !== 'letter') {
          warnings.push(`和弦里的「${part}」看不懂，已跳过`)
          continue
        }
        const midi = insideKeyboard(toMidi(info, tonic, part), part)
        const note = { midi, pos: cursor.pos, beats: step, velocity, voice }
        notes.push(note)
        starts.push(note)
      }
      if (starts.length === 0) {
        warnings.push(`「${token}」里没有能弹的音，已跳过`)
        continue
      }
      cursor.lastStarts = starts
      cursor.pos += step
    }
  }

  if (notes.length === 0) throw new NoteError('这份谱里没有能弹的音符。')

  notes.sort((a, b) => a.pos - b.pos || a.midi - b.midi)
  const beats = Math.max(...notes.map((n) => n.pos + n.beats), 0)

  return { notes, beats, tempo, key: keyText, voices: voices.length ? voices : ['main'], warnings }
}

/**
 * 把任意一拍数换成毫秒时刻表，力度也一并带上。
 * @param {{ notes: { midi: number, pos: number, beats: number, velocity: number }[] }} parsed
 * @param {{ tempo?: number, gapRatio?: number }} [options]
 * @returns {{ midi: number, at: number, dur: number, velocity: number }[]}
 */
export function toTimeline(parsed, options = {}) {
  const tempo = Math.max(20, Math.min(320, Number(options.tempo) || 100))
  const beatMs = 60000 / tempo
  const gapRatio = Number.isFinite(options.gapRatio) ? options.gapRatio : 0.96
  return parsed.notes.map((n) => ({
    midi: n.midi,
    at: Math.round(n.pos * beatMs),
    // 至少留 80ms，不然短音会变成"咔"一声
    dur: Math.max(80, Math.round(n.beats * beatMs * gapRatio)),
    velocity: Math.max(0.02, Math.min(1, n.velocity)),
  }))
}

/** 给人看的音名串。 */
export function summarizeTimeline(timeline, limit = 16) {
  const head = timeline.slice(0, limit).map((n) => SHARP_NAMES[n.midi % 12] + (Math.floor(n.midi / 12) - 1)).join(' ')
  return timeline.length > limit ? `${head} …（共 ${timeline.length} 个音）` : head
}
