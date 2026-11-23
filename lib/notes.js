/**
 * 标准钢琴的音符表。
 *
 * 按国际惯例（也是所有 MIDI 设备的那一套）：
 *   - 88 键：A0（MIDI 21）到 C8（MIDI 108），白键 52 个、黑键 36 个
 *   - 中央 C 记作 C4 = MIDI 60 ≈ 261.63 Hz
 *   - A4 = MIDI 69 = 440 Hz，十二平均律从它往上往下推
 *
 * 音名写法：C / D / E / F / G / A / B 七个字母，加 #（升）或 b（降），
 * 后面跟八度数字。同一个键有多种写法（C#4 = Db4），解析时统一归到升号那套。
 */

/** 最低键：A0。 */
export const MIDI_MIN = 21
/** 最高键：C8。 */
export const MIDI_MAX = 108
/** 88 键。 */
export const KEY_COUNT = MIDI_MAX - MIDI_MIN + 1
/** 中央 C。 */
export const MIDDLE_C = 60
/** 调音基准。 */
export const A4_HZ = 440

/** 升号那套音名。 */
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
/** 七个字母到半音数的映射（以 C 为 0）。 */
const LETTER_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
/** 白键的半音位置。 */
const WHITE_PITCH_CLASSES = [0, 2, 4, 5, 7, 9, 11]
const WHITE_SET = new Set(WHITE_PITCH_CLASSES)

/** 音符写错时抛这个，宿主侧会把它翻成一句人话回给模型。 */
export class NoteError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'NoteError'
  }
}

/**
 * 这个 MIDI 号是黑键吗。
 * @param {number} midi
 * @returns {boolean}
 */
export function isBlackKey(midi) {
  return !WHITE_SET.has(((midi % 12) + 12) % 12)
}

/**
 * MIDI 号转频率（十二平均律，A4 = 440Hz）。
 * @param {number} midi
 * @returns {number}
 */
export function frequencyOf(midi) {
  return A4_HZ * Math.pow(2, (midi - 69) / 12)
}

/**
 * MIDI 号转标准音名，例如 60 → "C4"、70 → "A#4"。
 * @param {number} midi
 * @returns {string}
 */
export function noteName(midi) {
  const n = Math.round(midi)
  const pc = ((n % 12) + 12) % 12
  return SHARP_NAMES[pc] + String(Math.floor(n / 12) - 1)
}

/**
 * 音名里的降号写法转成升号写法（Db → C#）。
 * @param {string} accidental
 * @returns {string}
 */
function normalizeAccidental(accidental) {
  if (!accidental) return ''
  if (accidental === '#' || accidental === '♯') return '#'
  if (accidental === 'b' || accidental === '♭') return 'b'
  return ambiguous(accidental)
}

/** 不认识的升降号。 */
function ambiguous(accidental) {
  throw new NoteError(`不认识的升降号「${accidental}」，用 # 或 b。`)
}

/**
 * 解析一个音符记号。
 *
 * 认这些写法：
 *   C4  C#4  Db4  C♯4  Cb4   —— 音名 + 可选升降号 + 八度
 *   C                        —— 省略八度时按 defaultOctave（默认 4，即中央 C 那一组）
 *   60                       —— 直接给 MIDI 号
 *
 * @param {string} token 模型或用户给的记号
 * @param {{ defaultOctave?: number }} [options]
 * @returns {number} MIDI 号
 */
export function parseNote(token, options = {}) {
  const raw = String(token ?? '').trim()
  if (!raw) throw new NoteError('音符是空的。')
  const defaultOctave = Number.isFinite(options.defaultOctave) ? options.defaultOctave : 4

  if (/^\d+$/.test(raw)) {
    const midi = Number(raw)
    return clampMidi(midi, raw)
  }

  const m = /^([A-Ga-g])([#♯b♭]?)(-?\d{1,2})?$/.exec(raw)
  if (!m) {
    throw new NoteError(
      `看不懂音符「${raw}」。标准写法是音名+升降号+八度，比如 C4、C#4、Db4、A0、C8（C4 是中央 C，范围 A0–C8）。`,
    )
  }

  const letter = m[1].toUpperCase()
  let accidental = normalizeAccidental(m[2])
  let octave = m[3] === undefined ? defaultOctave : Number(m[3])

  // Cb / B# / E# / Fb 这类跨组的写法：先挪到相邻字母，再修正八度
  if (accidental === 'b' && (letter === 'C' || letter === 'F')) {
    if (letter === 'C') {
      // Cb4 = B3
      return clampMidi((octave - 1 + 1) * 12 + LETTER_SEMITONE.B, raw)
    }
    // Fb4 = E4
    return clampMidi(octave * 12 + 12 + LETTER_SEMITONE.E, raw)
  }
  if (accidental === '#' && (letter === 'B' || letter === 'E')) {
    if (letter === 'B') {
      // B#4 = C5
      return clampMidi((octave + 1) * 12 + 12 + LETTER_SEMITONE.C, raw)
    }
    // E#4 = F4
    return clampMidi(octave * 12 + 12 + LETTER_SEMITONE.F, raw)
  }

  const semitone = LETTER_SEMITONE[letter] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0)
  const midi = (octave + 1) * 12 + semitone
  return clampMidi(midi, raw)
}

/**
 * 落到 88 键范围内，越界就报错（不偷偷移八度，免得听出来不对）。
 * @param {number} midi
 * @param {string} raw
 * @returns {number}
 */
function clampMidi(midi, raw) {
  if (!Number.isFinite(midi) || Math.round(midi) !== midi) {
    throw new NoteError(`音符「${raw}」不是整数 MIDI 号。`)
  }
  if (midi < MIDI_MIN || midi > MIDI_MAX) {
    throw new NoteError(
      `音符「${raw}」超出这台钢琴的键位范围（${noteName(MIDI_MIN)}–${noteName(MIDI_MAX)}），换个八度试试。`,
    )
  }
  return midi
}

/**
 * 88 键的物理排布：白键从左到右 52 个，黑键压在相邻白键的缝上。
 *
 * 返回值里 black 键的 boundary 表示「它左边有几个白键」，
 * 浏览器半侧据此算出黑键的绝对位置，省得两处各写一份几何。
 *
 * @returns {{ midi: number, black: boolean, index: number, boundary: number, octaveC: boolean }[]}
 */
export function keyboardLayout() {
  const out = []
  let whiteCount = 0
  for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
    const black = isBlackKey(midi)
    if (black) {
      out.push({ midi, black: true, index: -1, boundary: whiteCount, octaveC: false })
    } else {
      out.push({
        midi,
        black: false,
        index: whiteCount,
        boundary: whiteCount,
        octaveC: ((midi % 12) + 12) % 12 === 0,
      })
      whiteCount++
    }
  }
  return out
}

/** 白键总数，浏览器半侧排版要用。 */
export const WHITE_KEY_COUNT = keyboardLayout().filter((k) => !k.black).length

/**
 * 一句话描述这台钢琴的范围，给工具回执用。
 * @returns {string}
 */
export function rangeText() {
  return `${noteName(MIDI_MIN)}–${noteName(MIDI_MAX)}，共 ${KEY_COUNT} 键（中央 C = C4）`
}
