/**
 * 标准 MIDI 文件解析。
 *
 * 为什么要有这一层：
 *   乐谱文本（简谱 / .score）本质是「单声部时间轴 + 和弦」，一个音的长度会被
 *   下一个音截断，写不出「长音拖着、同时另一只手在跑」的真复调。
 *   MIDI 里每个音都有自己的开始和结束，tick 精度，音高精确 —— 拿它当输入，
 *   弹出来的东西和原曲一致，不用猜。
 *
 * 支持：
 *   - SMF format 0 / 1 / 2（format 0 单轨、format 1 多轨同步，这两种最常见）
 *   - running status（很多文件省掉重复的状态字节）
 *   - tempo map（0x51）：整首曲子变速也能还原真实时间
 *   - note on / note off / note on velocity 0（当成 note off）
 *   - 拍号（0x58）仅记录，不影响时间换算
 *
 * 不支持（遇到就跳过，不影响其它轨）：sysex、RPN/NRPN、MIDI 2.0 UMP。
 */

import { MIDI_MAX, MIDI_MIN, NoteError, noteName } from './notes.js'

/** 每个字节最多 4 个（0xFF 0x58 0x04 dd nn …）。 */
function readVarLen(data, pos) {
  let value = 0
  for (let i = 0; i < 4; i++) {
    if (pos >= data.length) throw new NoteError('MIDI 文件被截断了（读变长整数时越界）。')
    const byte = data[pos++]
    value = (value << 7) | (byte & 0x7f)
    if (!(byte & 0x80)) return [value, pos]
  }
  throw new NoteError('MIDI 变长整数超过 4 字节，文件可能损坏。')
}

/** 读 ASCII 标签。 */
function readTag(data, pos) {
  return String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3])
}

/**
 * 解析整个文件。
 * @param {Buffer|Uint8Array} input
 * @returns {{
 *   format: number, division: number, trackCount: number,
 *   tracks: { name: string, notes: {tick:number,durTick:number,pitch:number,velocity:number,channel:number}[] }[],
 *   tempoMap: {tick:number, usPerQuarter:number}[],
 *   timeSignature: {numerator:number, denominator:number}|null,
 *   keySignature: {sf:number, mi:number, name:string}|null,   // sf: -7..7 升降号数，mi: 0 大调 1 小调
 *   endTick: number,
 * }}
 */
export function parseMidi(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (data.length < 14) throw new NoteError('这不是一个 MIDI 文件（太短）。')
  if (readTag(data, 0) !== 'MThd') {
    throw new NoteError('这不是标准 MIDI 文件（开头不是 MThd）。')
  }
  const headerLen = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]
  const format = (data[8] << 8) | data[9]
  const trackCount = (data[10] << 8) | data[11]
  const division = (data[12] << 8) | data[13]
  if (division & 0x8000) {
    throw new NoteError('这个 MIDI 用的是 SMPTE 时间码，不支持。请另存为 PPQ 格式。')
  }
  if (!division) throw new NoteError('MIDI 头里的 PPQ 是 0，文件损坏。')

  let pos = 8 + headerLen
  const tracks = []
  const tempoMap = [{ tick: 0, usPerQuarter: 500000 }]
  let timeSignature = null
  let keySignature = null
  let endTick = 0

  for (let ti = 0; ti < trackCount; ti++) {
    if (pos + 8 > data.length) break
    if (readTag(data, pos) !== 'MTrk') break
    const len = (data[pos + 4] << 24) | (data[pos + 5] << 16) | (data[pos + 6] << 8) | data[pos + 7]
    const end = pos + 8 + len
    let p = pos + 8
    pos = end

    let tick = 0
    let running = 0
    let trackName = ''
    const notes = []
    /** 还没松开的音：key = `${channel}:${pitch}` → [tick…] */
    const open = new Map()

    while (p < end) {
      let delta
      ;[delta, p] = readVarLen(data, p)
      tick += delta

      let status = data[p]
      if (status & 0x80) {
        p++
        running = status
      } else {
        // running status：复用上一个状态字节
        status = running
        if (!status) throw new NoteError('MIDI 事件缺少状态字节。')
      }

      if (status === 0xff) {
        const type = data[p++]
        let mlen
        ;[mlen, p] = readVarLen(data, p)
        if (type === 0x51 && mlen >= 3) {
          const us = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2]
          tempoMap.push({ tick, usPerQuarter: us })
        } else if (type === 0x58 && mlen >= 2) {
          timeSignature = { numerator: data[p], denominator: 2 ** data[p + 1] }
        } else if (type === 0x59 && mlen >= 2) {
          // sf 是有符号字节：-7..7 表示 7b..7#
          const raw = data[p]
          const sf = raw > 127 ? raw - 256 : raw
          const mi = data[p + 1]
          keySignature = { sf, mi, name: keySignatureName(sf, mi) }
        } else if (type === 0x03 && mlen > 0) {
          trackName = ''
          for (let i = 0; i < mlen; i++) {
            const c = data[p + i]
            trackName += c >= 32 && c < 127 ? String.fromCharCode(c) : ''
          }
        }
        p += mlen
        if (type === 0x2f) break
        continue
      }

      if (status === 0xf0 || status === 0xf7) {
        let mlen
        ;[mlen, p] = readVarLen(data, p)
        p += mlen
        continue
      }

      const kind = status & 0xf0
      const channel = status & 0x0f

      if (kind === 0x80 || kind === 0x90) {
        const pitch = data[p]
        const velocity = data[p + 1]
        p += 2
        const key = channel + ':' + pitch
        if (kind === 0x90 && velocity > 0) {
          if (!open.has(key)) open.set(key, [])
          open.get(key).push({ tick, velocity })
        } else {
          const stack = open.get(key)
          if (stack && stack.length) {
            const on = stack.shift()
            notes.push({
              tick: on.tick,
              durTick: Math.max(1, tick - on.tick),
              pitch,
              velocity: on.velocity,
              channel,
            })
          }
        }
      } else if (kind === 0xa0 || kind === 0xb0 || kind === 0xe0) {
        p += 2
      } else if (kind === 0xc0 || kind === 0xd0) {
        p += 1
      } else {
        // 认不出来的状态：这条轨剩余部分放弃，免得越界乱读
        break
      }
    }

    // 没收尾的音（文件末尾没写 note off）：按最后一个 tick 结束
    for (const [key, stack] of open) {
      const pitch = Number(key.split(':')[1])
      for (const on of stack) {
        notes.push({
          tick: on.tick,
          durTick: Math.max(1, tick - on.tick),
          pitch,
          velocity: on.velocity,
          channel: Number(key.split(':')[0]),
        })
      }
    }

    notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
    if (notes.length) {
      endTick = Math.max(endTick, notes[notes.length - 1].tick + notes[notes.length - 1].durTick)
    }
    tracks.push({ name: trackName, notes })
  }

  tempoMap.sort((a, b) => a.tick - b.tick)
  // 同一个 tick 有多条速度（多轨各写一份）：以后出现的为准
  const dedup = []
  for (const t of tempoMap) {
    if (dedup.length && dedup[dedup.length - 1].tick === t.tick) dedup[dedup.length - 1] = t
    else dedup.push(t)
  }

  return { format, division, trackCount, tracks, tempoMap: dedup, timeSignature, keySignature, endTick }
}

/**
 * tick → 秒。按 tempo map 分段积分。
 * @param {number} tick
 * @param {{tick:number, usPerQuarter:number}[]} tempoMap
 * @param {number} division
 */
export function tickToSeconds(tick, tempoMap, division) {
  let seconds = 0
  for (let i = 0; i < tempoMap.length; i++) {
    const from = tempoMap[i]
    const to = i + 1 < tempoMap.length ? tempoMap[i + 1].tick : Infinity
    if (tick <= from.tick) break
    const span = Math.min(tick, to) - from.tick
    seconds += (span / division) * (from.usPerQuarter / 1e6)
    if (tick <= to) break
  }
  return seconds
}

/**
 * MIDI → 播放时间轴（毫秒），直接交给 engine.schedule。
 *
 * 每个音保留自己的时长 —— 这是和乐谱文本最大的区别，长音不会被下一个音截断。
 *
 * @param {ReturnType<typeof parseMidi>} midi
 * @param {{
 *   tempoScale?: number,     速度倍率（1 = 原速，0.5 = 半速）
 *   transpose?: number,      整体移调（半音）
 *   minVelocity?: number,    力度下限，太轻的音抬到这儿
 *   trackFilter?: number[],  只弹这几条轨（按序号）
 * }} [options]
 * @returns {{ timeline: {midi:number,at:number,dur:number,velocity:number}[], seconds:number, dropped:number, clipped:number }}
 */
export function midiToTimeline(midi, options = {}) {
  const scale = Number.isFinite(options.tempoScale) && options.tempoScale > 0 ? options.tempoScale : 1
  const transpose = Number.isFinite(options.transpose) ? Math.round(options.transpose) : 0
  const minVel = Number.isFinite(options.minVelocity) ? Math.max(0.02, Math.min(1, options.minVelocity)) : 0.2
  const only = Array.isArray(options.trackFilter) && options.trackFilter.length ? new Set(options.trackFilter) : null

  const timeline = []
  let dropped = 0
  let clipped = 0
  let endSec = 0

  for (let ti = 0; ti < midi.tracks.length; ti++) {
    if (only && !only.has(ti)) continue
    for (const n of midi.tracks[ti].notes) {
      let pitch = n.pitch + transpose
      // 越界的音：先试着移八度回到键盘上，实在不行丢掉（不静默变调）
      while (pitch < MIDI_MIN) {
        pitch += 12
        clipped++
      }
      while (pitch > MIDI_MAX) {
        pitch -= 12
        clipped++
      }
      if (pitch < MIDI_MIN || pitch > MIDI_MAX) {
        dropped++
        continue
      }
      const atSec = tickToSeconds(n.tick, midi.tempoMap, midi.division) / scale
      const durSec = (n.durTick / midi.division) * (midi.tempoMap[0].usPerQuarter / 1e6) / scale
      // 时长按「这个音所在段落」的实际速度算，不能用开头的速度
      const endOfNote = tickToSeconds(n.tick + n.durTick, midi.tempoMap, midi.division) / scale
      const realDur = Math.max(0.05, endOfNote - atSec)
      timeline.push({
        midi: pitch,
        at: Math.round(atSec * 1000),
        dur: Math.round(Math.max(realDur, durSec) * 1000),
        velocity: Math.max(minVel, Math.min(1, n.velocity / 127)),
        // 左右手：按 MIDI 轨道序号。
        // 这份谱是 [1]=右手(B3-G#7)、[2]=左手(G#1-B5)，窗口据此上色
        // （左手蓝、右手绿），而不是按黑白键分。
        hand: ti,
      })
      endSec = Math.max(endSec, atSec + realDur)
    }
  }

  timeline.sort((a, b) => a.at - b.at || a.midi - b.midi)
  return { timeline, seconds: endSec, dropped, clipped }
}

/** 一句话说这份 MIDI 是什么（给工具回执用）。 */

/** 调号 → 人类可读名（如「B 大调」「F# 小调」）。sf 为升降号数量。 */
function keySignatureName(sf, mi) {
  const majors = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#']
  const minors = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#']
  const idx = Math.max(0, Math.min(14, sf + 7))
  const root = mi === 1 ? minors[idx] : majors[idx]
  return root + (mi === 1 ? ' 小调' : ' 大调')
}

export function describeMidi(midi, options = {}) {
  const all = midi.tracks.reduce((sum, t) => sum + t.notes.length, 0)
  const pitches = []
  for (const t of midi.tracks) for (const n of t.notes) pitches.push(n.pitch)
  const lo = pitches.length ? Math.min(...pitches) : 0
  const hi = pitches.length ? Math.max(...pitches) : 0
  const seconds = tickToSeconds(midi.endTick, midi.tempoMap, midi.division)
  const sig = midi.timeSignature ? `${midi.timeSignature.numerator}/${midi.timeSignature.denominator}` : '未知'
  const keyText = midi.keySignature ? midi.keySignature.name : ''

  // 速度必须写出来：只写「N 段速度」等于没说，看的人会以为文件里没定义 tempo。
  const bpms = midi.tempoMap.map((t) => {
    const bpm = 60_000_000 / t.usPerQuarter
    return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(2)
  })
  const uniq = [...new Set(bpms)]
  const tempoText = uniq.length === 1
    ? `♩=${uniq[0]}`
    : `♩=${uniq.slice(0, 6).join('→')}${uniq.length > 6 ? `…（共 ${uniq.length} 段）` : ''}`

  const beats = midi.endTick / midi.division
  const parts = [
    `format ${midi.format}`,
    `${midi.division} PPQ`,
    `${sig} 拍`,
    tempoText,
    `${midi.tracks.length} 轨 / ${all} 音`,
    `音域 ${noteName(lo)}–${noteName(hi)}`,
    `${beats.toFixed(0)} 拍 / ${seconds.toFixed(1)} 秒`,
  ]
  return parts.join(' · ')
}
