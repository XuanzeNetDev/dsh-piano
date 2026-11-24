/**
 * 演奏队列。
 *
 * 宿主不发声（服务端没有扬声器），它只负责把「什么时候该响哪个键」排好队；
 * 浏览器每隔一小段来取一次新事件，按自己的 AudioContext 时间轴排进去。
 *
 * 每个事件是 { i, t, m, d, v }：
 *   i 自增序号（浏览器用它做 since 游标，不会重复播放）
 *   t 该响的绝对时刻（宿主 Date.now() 毫秒，和浏览器同一台机器，不需要对钟）
 *   m MIDI 键号
 *   d 按住多久（毫秒）
 *   v 力度 0–1
 *
 * stop 计数器每次「停」加一：浏览器发现它变了就清掉残留的高亮。
 */

/** 事件留多久，够浏览器补取一次就够。 */
const RETENTION_MS = 45000
/**
 * 一次最多排多少事件。
 * 原来是 600 —— 一首四五分钟的钢琴曲动辄两千多个音，600 之后的音根本不会响，
 * 长曲会被悄悄截断（听感就是「弹到一半停了」）。按整曲规模放到 5 万，
 * 真到极限也还有上限兜着；限制的意义是防止内存失控，不是限制曲子长度。
 */
const MAX_BATCH = 50000

/**
 * 建一个演奏队列。
 * @param {{ leadMs?: number, maxVoices?: number }} [options]
 */
export function createEngine(options = {}) {
  const leadMs = clampInt(options.leadMs, 420, 80, 3000)
  const maxVoices = clampInt(options.maxVoices, 48, 4, 200)

  let seq = 0
  let stopTick = 0
  /** @type {{ i: number, t: number, m: number, d: number, v: number, h?: number, pg?: number, ch?: number }[]} */
  let events = []
  let last = null

  /**
   * 最近一次 schedule 的原始时间轴（相对时刻，at 从 0 起）。
   *
   * 为什么不从 events 里取：trim() 会按 RETENTION_MS（45 秒）删旧事件，
   * 一首放完一分钟 events 就空了 —— 想导出反而导不出来。
   * 单独留一份原始输入，和播放进度无关，随时可导出。
   */
  let lastTimeline = []

  /**
   * 排一段已经算好毫秒时间轴的音符。
   * @param {{ midi: number, at: number, dur: number, velocity: number }[]} timeline
   * @param {{ label?: string, tempo?: number }} [meta]
   * @returns {{ count: number, spanMs: number, first: number, last: number }}
   */
  function schedule(timeline, meta = {}) {
    const list = Array.isArray(timeline) ? timeline : []
    if (list.length === 0) return { count: 0, spanMs: 0, first: 0, last: 0 }

    // 留一份原始时间轴给导出用（和播放进度、trim 都无关）
    lastTimeline = list.map((n) => ({
      midi: n.midi,
      at: Math.max(0, Math.round(n.at)),
      dur: Math.max(70, Math.round(n.dur)),
      velocity: n.velocity,
      program: Number.isFinite(n.program) ? n.program : 0,
      channel: Number.isFinite(n.channel) ? n.channel : 0,
    }))

    // 上一段还没放完就接着排，不打断 —— 但也不能无限叠，超过 maxVoices 就把最老的扔掉
    const base = Math.max(Date.now() + leadMs, last ? last.t : 0)
    let span = 0
    let added = 0

    for (const note of list) {
      const t = base + Math.max(0, Math.round(note.at))
      const d = Math.max(70, Math.round(note.dur))
      // pg = GM 音色号（0-127）。EXE 收到后切乐器。
    // ch = MIDI 通道（9 是鼓组）。老版本的事件没有这两个字段，
    // EXE 那边按"缺省 = 沿用当前音色"处理，不会因为少字段而崩。
    events.push({
      i: ++seq, t, m: note.midi, d,
      v: round2(note.velocity),
      h: note.hand ?? 0,
      pg: note.program ?? 0,
      ch: note.channel ?? 0,
    })
      span = Math.max(span, t - base + d)
      added++
      if (added >= MAX_BATCH) break
    }

    last = {
      t: base + span,
      at: Date.now(),
      label: meta.label ?? '',
      tempo: meta.tempo ?? null,
      count: added,
      // 曲子的固有信息：调号、拍号、当前速度。窗口顶栏要显示，用户还要能改。
      score: meta.score ?? null,
    }
    trim()
    return { count: added, spanMs: span, first: base, last: base + span }
  }

  /** 丢掉太老的。未来还没响的音一律留着 —— 不能按「并发上限」砍队列。 */
  function trim() {
    const cutoff = Date.now() - RETENTION_MS
    if (events.length && events[0].t < cutoff) {
      events = events.filter((e) => e.t >= cutoff)
    }
  }

  /**
   * 取 since 之后的新事件。
   * @param {number} since
   */
  function drain(since) {
    trim()
    const cursor = Number.isFinite(since) ? since : 0
    return {
      now: Date.now(),
      seq,
      stop: stopTick,
      events: events.filter((e) => e.i > cursor),
      label: last ? last.label : '',
      score: last ? last.score : null,
    }
  }

  /** 停：清空队列，浏览器那边下一次轮询就知道要清高亮。 */
  function stop() {
    events = []
    last = null
    stopTick++
    return stopTick
  }

  /**
   * 立刻排一个音（手动点键盘用）。
   *
   * 不走 schedule 的 leadMs：那个提前量是给"整首曲子提前排"用的，
   * 手动点键要的是马上出声。这里直接把 t 设成当前时刻，
   * 浏览器下一次轮询（140ms 内）拿到的 dueSec 就是负数，
   * onEvents 里 Math.max(0.004, dueSec) 会把它按"立刻"处理。
   * @param {number} midi
   * @param {number} [velocity] 0–1
   * @param {number} [durMs]
   */
  function playNow(midi, velocity = 0.8, durMs = 900) {
    const m = Math.round(Number(midi))
    if (!Number.isFinite(m) || m < 0 || m > 127) return { count: 0 }
    const now = Date.now()
    const d = Math.max(80, Math.round(durMs))
    events.push({
      i: ++seq,
      t: now,
      m,
      d,
      v: Math.max(0.02, Math.min(1, Number(velocity) || 0.8)),
    })
    last = { t: now + d, at: now, label: '', tempo: null, count: 1 }
    trim()
    return { count: 1 }
  }

  /** 当前状态，给 piano_status 和 /info 用。 */
  function status() {
    trim()
    const now = Date.now()
    const pending = events.filter((e) => e.t + e.d >= now)
    const next = pending.length ? pending[0].t - now : 0
    return {
      queued: pending.length,
      nextInMs: Math.max(0, next),
      stopTick,
      seq,
      leadMs,
      maxVoices,
      last: last ? { label: last.label, tempo: last.tempo, count: last.count, agoMs: now - last.at } : null,
    }
  }

  /**
   * 把当前队列导出成"可离线渲染"的时间轴。
   *
   * 和 drain() 的区别：drain 会推进游标（等于消费掉），
   * 这个只拍一张快照，不影响正在播放的东西。
   *
   * 时间归零到第一个音 —— 队列里的 t 是绝对时刻，直接拿去渲染，
   * 开头就是一大段静音。
   */
  function snapshotForRender() {
    // 优先用 schedule 时留下的原始时间轴 —— 不受 trim / 播放进度影响
    if (lastTimeline.length) {
      let spanMs = 0
      for (const n of lastTimeline) {
        if (n.at + n.dur > spanMs) spanMs = n.at + n.dur
      }
      return { timeline: lastTimeline.slice(), spanMs, count: lastTimeline.length }
    }

    // 没有 schedule 过（只有手动点键）才回退到 events
    trim()
    const list = events.slice().sort((a, b) => a.t - b.t || a.m - b.m)
    if (!list.length) return { timeline: [], spanMs: 0, count: 0 }
    const base = list[0].t
    let spanMs = 0
    const timeline = list.map((e) => {
      const at = e.t - base
      const dur = e.d
      if (at + dur > spanMs) spanMs = at + dur
      return {
        midi: e.m,
        at,
        dur,
        velocity: e.v,
        program: Number.isFinite(e.pg) ? e.pg : 0,
        channel: Number.isFinite(e.ch) ? e.ch : 0,
      }
    })
    return { timeline, spanMs, count: timeline.length }
  }

  return { schedule, playNow, drain, stop, status, snapshotForRender }
}

/**
 * 整数夹取。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

/**
 * 两位小数就够，事件体积小一点。
 * @param {number} v
 */
function round2(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0.8
  return Math.round(Math.max(0, Math.min(1, n)) * 100) / 100
}
