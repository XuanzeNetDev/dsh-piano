/**
 * dsh-piano-xz —— 浏览器半侧：工具栏（开关/乐器选择/MIDI 导入）+ 88 键渲染
 *
 * 三件事：
 *   1. 标准 88 键（A0–C8）：52 白键等宽，黑键按真钢琴的比例压在白键缝上
 *   2. 钢琴音色：每个泛音独立衰减（高次泛音衰减快），力度决定亮度，
 *      不用噪声、不用混响 —— 混响是"声音不纯"的主要来源
 *   3. 演奏：轮询宿主的乐谱时间轴，按 AudioContext 的时刻表排音，同时点亮琴键
 *
 * client bundle 不是 ESM，是自注册脚本：window.__ModuleLoader__.load({ id, factory })
 */
window.__ModuleLoader__.load({
  id: 'dsh-piano-xz',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/dsh-piano-xz'
    const MIDI_MIN = 21 // A0
    const MIDI_MAX = 108 // C8
    /** 中央 C。高亮配色按它分左右手：低于它是左手（蓝），不低于是右手（绿）。 */
    const MIDDLE_C_LOCAL = 60
    const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

    /**
     * 黑键相对「相邻白键缝隙」的偏移，单位是白键宽。
     * 真钢琴上 C#/D#、F#/A# 并不对称压在缝上：C# 偏左、D# 偏右，
     * F# 偏左、A# 偏右，G# 居中。这一条就是"标准钢琴"和"画着玩"的区别。
     */
    const BLACK_OFFSET = { 1: -0.10, 3: 0.10, 6: -0.14, 8: 0, 10: 0.14 }

    const isBlack = (midi) => ((midi % 12) + 12) % 12 in BLACK_OFFSET
    const keyName = (midi) => NAMES[((midi % 12) + 12) % 12] + String(Math.floor(midi / 12) - 1)

    const readLS = (key, fallback) => {
      try {
        const v = window.localStorage.getItem('dsh-piano:' + key)
        return v == null ? fallback : v
      } catch {
        return fallback
      }
    }
    const writeLS = (key, value) => {
      try {
        window.localStorage.setItem('dsh-piano:' + key, String(value))
      } catch {
        /* 隐私模式忽略 */
      }
    }

    /**
     * 88 键排布。白键按 1 份宽，黑键 0.62 份宽，
     * left 用「第几个白键 + 偏移」算，不依赖八度是否完整（A0 起头那格是半截的）。
     */
    const KEYS = (() => {
      const out = []
      let whites = 0
      for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
        const pc = ((midi % 12) + 12) % 12
        if (pc in BLACK_OFFSET) {
          out.push({ midi, black: true, left: whites + BLACK_OFFSET[pc] })
        } else {
          out.push({ midi, black: false, index: whites, octaveC: pc === 0 })
          whites++
        }
      }
      return out
    })()
    const WHITE_TOTAL = KEYS.filter((k) => !k.black).length
    const WHITE_W = 100 / WHITE_TOTAL
    const BLACK_W = WHITE_W * 0.62

    /* ───────────────────────── 钢琴音色 ───────────────────────── */

    // 这些状态挂在 window 上，而不是模块作用域里。
    // 原因：HMR 换掉模块时，模块级变量全部重建 —— 采样缓存（16MB）会被清空，
    // 于是下一次弹奏退回合成兜底，听起来就是"音色又变回去了"。
    // 挂在 window 上，热更新之后 AudioContext 和已解码的采样都还在。
    const AUDIO = window.__dshPianoAudio || (window.__dshPianoAudio = {
      ac: null, master: null, bus: null, volume: 1, failed: false, live: new Set(),
    })

    const A4_HZ = 440
    const freqOf = (midi) => A4_HZ * Math.pow(2, (midi - 69) / 12)
    const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n)

    function ensureAudio() {
      if (AUDIO.ac) {
        if (AUDIO.ac.state === 'suspended') {
          const p = AUDIO.ac.resume()
          if (p && p.catch) p.catch(() => {})
        }
        return AUDIO.ac
      }
      if (AUDIO.failed) return null
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (!Ctor) {
        AUDIO.failed = true
        return null
      }
      let ac
      try {
        ac = new Ctor()
      } catch {
        AUDIO.failed = true
        return null
      }

      const master = ac.createGain()
      master.gain.value = AUDIO.volume
      // 压缩器现在兼着"限制器"的活：音源电平提到 -5 dBFS 之后，
      // 五六个音同时按下去峰值会到 +8 dB，必须收住，否则一片劈啪。
      // 阈值 -6 dB、比例 12 基本是硬限幅，但 attack 3ms 保住了钢琴的击弦瞬态
      // （attack 太短会把起音削掉，听感发闷）。
      const comp = ac.createDynamicsCompressor()
      comp.threshold.value = -6
      comp.knee.value = 4
      comp.ratio.value = 12
      comp.attack.value = 0.003
      comp.release.value = 0.15
      master.connect(comp)
      comp.connect(ac.destination)

      const bus = ac.createGain()
      bus.gain.value = 1
      bus.connect(master)

      AUDIO.ac = ac
      AUDIO.master = master
      AUDIO.bus = bus
      // 采样在后台补齐，不阻塞第一次发声
      if (!preloadStarted) {
        preloadStarted = true
        window.setTimeout(() => {
          preloadSamples(ac).catch(() => {})
        }, 0)
      }
      return ac
    }

    /* ── 采样：Salamander Grand Piano V3（CC BY 3.0） ──────────────
     *
     * 30 个录音采样覆盖 MIDI 21–108，每 3 个半音一个。
     * 中间的音用 playbackRate 变调，最大偏差 1.5 个半音 —— 这是所有
     * 网页钢琴的标准做法，比"合成得像"高一个档次：那是真的弹三角琴录的。
     */

    const SAMPLES = window.__dshPianoSamples || (window.__dshPianoSamples = new Map())
    const SAMPLE_LOADING = window.__dshPianoLoading || (window.__dshPianoLoading = new Set())
    const RELEASES = window.__dshPianoReleases || (window.__dshPianoReleases = new Map())
    const RELEASE_LOADING = window.__dshPianoRelLoading || (window.__dshPianoRelLoading = new Set())
    let preloadStarted = false

    /* ── IndexedDB：把下载过的 mp3 存起来 ────────────────────────
     *
     * 目标只有一个：声音永远不变。
     * 第一次装好之后，采样就在本地，刷新、热更新、重开应用都不用重新下载；
     * 解码虽然还要跑一遍，但那是本地 CPU 的事，两三秒就好。
     */

    const DB_NAME = 'dsh-piano-xz'
    const DB_STORE = 'mp3'
    let dbPromise = null

    function openDb() {
      if (dbPromise) return dbPromise
      dbPromise = new Promise((resolve) => {
        try {
          if (!window.indexedDB) return resolve(null)
          const req = window.indexedDB.open(DB_NAME, 1)
          req.onupgradeneeded = () => {
            try {
              req.result.createObjectStore(DB_STORE)
            } catch {
              /* 已经建过 */
            }
          }
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      })
      return dbPromise
    }

    async function cacheGet(key) {
      const db = await openDb()
      if (!db) return null
      return new Promise((resolve) => {
        try {
          const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key)
          req.onsuccess = () => resolve(req.result || null)
          req.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      })
    }

    async function cachePut(key, buffer) {
      const db = await openDb()
      if (!db) return
      try {
        db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(buffer, key)
      } catch {
        /* 存不进去就算了，下次再下 */
      }
    }

    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    const SAMPLE_POINTS = (() => {
      const out = []
      for (let m = 21; m <= 108; m += 3) out.push(m)
      return out
    })()

    /** 这个音落在哪个采样点上。 */
    function snapToSample(midi) {
      return Math.max(21, Math.min(108, Math.round(midi / 3) * 3))
    }

    /**
     * 30 个采样点的实测**峰值**电平（ffmpeg volumedetect max_volume，velocity 5 层）。
     *
     * 为什么用峰值不用平均：低音弦衰减慢、尾巴长，mean_volume 被尾巴拉低，
     * 会把低音误判成"本来就很响"，补偿时压过头 —— 上一版就是这样把左手压没了。
     * 钢琴音听的是起音那一瞬，所以按 max 对齐。
     */
    const SAMPLE_PEAK_DB = {
      21: -11.0, 24: -9.2, 27: -9.8, 30: -9.0, 33: -10.6,
      36: -9.8, 39: -10.0, 42: -11.2, 45: -11.8, 48: -11.7,
      51: -10.2, 54: -13.3, 57: -15.1, 60: -10.5, 63: -11.6,
      66: -14.8, 69: -12.7, 72: -12.6, 75: -14.5, 78: -13.9,
      81: -17.0, 84: -17.2, 87: -13.4, 90: -16.2, 93: -16.9,
      96: -19.5, 99: -23.0, 102: -17.1, 105: -22.4, 108: -20.3,
    }
    /** 中音区（C4 一带）的峰值电平，作为统一响度的参照。 */
    const LOUDNESS_REF_DB = -12.4

    /** 把某个键的采样拉到统一响度需要的线性增益。 */
    function loudnessTrim(midi) {
      const peak = SAMPLE_PEAK_DB[snapToSample(midi)]
      if (!Number.isFinite(peak)) return 1
      return Math.pow(10, (LOUDNESS_REF_DB - peak) / 20)
    }

    /**
     * 力度分层。Everyone Piano 那种音源是多层的，单层怎么调都平板：
     * 轻音和重音用的是同一段录音，只是音量不同，泛音结构不变。
     * 这里按力度分三档，每档是各自独立录的。
     */
    function layerFor(vel) {
      if (vel < 0.38) return 'v1'
      if (vel < 0.72) return 'v5'
      return 'v16'
    }

    /** 采样文件名：纯数字，例如 midi 63 + v5 → 63v5。URL 里没有任何需要转义的字符。 */
    function sampleName(midi, layer) {
      return String(snapToSample(midi)) + layer
    }

    /**
     * 加载一个采样（按「采样点 + 力度层」去重）。
     * @returns {Promise<AudioBuffer|null>}
     */
    async function loadSample(ac, midi, layer) {
      const m = snapToSample(midi)
      const key = m + ':' + layer
      if (SAMPLES.has(key)) return SAMPLES.get(key)
      if (SAMPLE_LOADING.has(key)) return null
      SAMPLE_LOADING.add(key)
      try {
        const file = sampleName(m, layer) + '.mp3'
        let raw = await cacheGet(file)
        if (!raw) {
          // 文件名里有 #（D#4v5.mp3），不编码的话 URL 会把 # 之后当锚点丢掉，
          // 请求变成 /sample/D 直接 404 —— 带 # 的采样点有一半。
          const res = await fetch(API + '/sample/' + encodeURIComponent(file), { credentials: 'same-origin' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          raw = await res.arrayBuffer()
          // 存一份副本：decodeAudioData 会把传进去的 ArrayBuffer 掏空
          cachePut(file, raw.slice(0))
        }
        const audio = await ac.decodeAudioData(raw)
        SAMPLES.set(key, audio)
        return audio
      } catch (err) {
        window.__dpSampleErr = String((err && err.message) || err)
        return null
      } finally {
        SAMPLE_LOADING.delete(key)
      }
    }

    /**
     * 释放采样：松键时制音器落在弦上那一下（88 个键各一个，很短的噗声）。
     * 少了它，音是"淡出"的；有了它，音是"被止住"的 —— 这一下 EOP 有，我之前没有。
     */
    async function loadRelease(ac, midi) {
      const idx = Math.max(1, Math.min(88, midi - 20))
      if (RELEASES.has(idx)) return RELEASES.get(idx)
      if (RELEASE_LOADING.has(idx)) return null
      RELEASE_LOADING.add(idx)
      try {
        const file = 'rel' + idx + '.mp3'
        let raw = await cacheGet(file)
        if (!raw) {
          const res = await fetch(API + '/sample/' + file, { credentials: 'same-origin' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          raw = await res.arrayBuffer()
          cachePut(file, raw.slice(0))
        }
        const audio = await ac.decodeAudioData(raw)
        RELEASES.set(idx, audio)
        return audio
      } catch {
        return null
      } finally {
        RELEASE_LOADING.delete(idx)
      }
    }

    /**
     * 后台加载：先中间力度层 + 全部释放音（这几个最常用），再补轻重两端。
     */
    async function preloadSamples(ac) {
      // 只加载 v5 层 + 88 个释放音。v1/v16 的三层电平基准和 v5 差太多，不混用。
      for (const m of SAMPLE_POINTS) {
        if (!SAMPLES.has(m + ':v5')) await loadSample(ac, m, 'v5')
      }
      window.__dpSamplesReady = true
    }

    /**
     * 用采样发声：变调 + 力度控增益和亮度 + 松键淡出。
     */
    function playSampleVoice(ac, buf, sampleMidi, midi, when, dur, vel) {
      const t0 = Math.max(when || 0, ac.currentTime + 0.001)
      const hold = Math.max(0.1, Number(dur) || 0.5)

      // 这里是之前最致命的一个错：把谱上的时值当成了"声音该多长"。
      // 八分音符 = 0.288 秒，采样在 288ms 就被掐断，只剩击弦那一下，
      // 没有余振 —— 听着就是木头、发尖、不像钢琴。
      // 钢琴的时值是"键按住多久"，踏板踩着，短音也有完整的余振。
      const sustain = Math.max(hold, 1.25)

      const src = ac.createBufferSource()
      src.buffer = buf

      // ── 参考 mdaPiano（EOP 的音源）的几个细节 ──────────────────
      // 1) 拉伸调音：真实钢琴高音偏高、低音偏低，不是严格十二平均律
      // 2) 随机失谐：同一首曲子里每个音有极微小的音分差，避免"电子琴的整齐"
      // 3) 立体声：低音偏左、高音偏右，两声部在空间上分开才不会糊成一坨
      const fromRoot = midi - 60
      const stretchCents = 0.000434 * (0.667 - 0.5) * fromRoot * fromRoot * 100
      const randomCents = 0.077 * 0.283 * 0.283 * (((fromRoot * fromRoot) % 13) - 6.5) * 100
      const cents = (midi - sampleMidi) * 100 + stretchCents + randomCents
      src.playbackRate.value = Math.pow(2, cents / 1200)

      const pan = Math.max(-1, Math.min(1, (midi - 60) / 42))
      const panner = ac.createStereoPanner ? ac.createStereoPanner() : null
      if (panner) panner.pan.value = pan * 0.45

      // 力度只做温和的明暗变化，不拿它当音色开关。
      // 之前是 2000 + 13000×力度：右手 0.88 → 13.4kHz、左手 0.50 → 8.5kHz，
      // 两只手听起来像两种乐器，这就是"一块对一块不对"的来源。
      const lp = ac.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = Math.min(18000, 12500 + 3500 * vel)

      const g = ac.createGain()
      // 力度曲线要平缓：之前用 vel^1.2，0.35 力度只剩 0.276 倍，
      // 再叠上响度补偿就掉到 1/6，整只手直接听不见了。
      // 现在是 0.15 + 0.85·vel^0.8 —— 轻手仍然清楚，只是退到后面。
      const velGain = 0.15 + 0.85 * Math.pow(vel, 0.8)
      // 再乘这个键的响度补偿（高低音采样电平差 12dB）。
      //
      // 基准为什么是 2.0 而不是 0.32：
      //   loudnessTrim() 已经把采样峰值统一拉到 -12.4 dBFS（线性约 0.24），
      //   旧代码再乘 0.32，出来只剩 0.24×0.844×0.32 ≈ 0.065 ≈ -23.7 dBFS。
      //   正常钢琴应用单音在 -6 ~ -3 dBFS，这一下就低了 18 dB —— 音量滑块拉到顶也不响。
      //   乘 2.0 让 C4 一带的单音落在 -5 dBFS 附近，多音叠加交给下面的压缩器收。
      const peak = 2.0 * velGain * loudnessTrim(midi)
      // 采样自己录好了完整的自然衰减（C4 通常 5～8 秒）。
      // 之前我在 1.25 秒就把它压到 28% —— 等于人为砍掉余振，这才是"干、木、难听"的主因。
      // 现在前 1.8 秒完全不干预，之后才按"松踏板"的速度收掉。
      // 延音踏板开着（EOP 面板上两边都是 ON）：不提前淡出，让采样自然衰减完
      const releaseAt = t0 + Math.max(hold + 2.6, 3.2)
      g.gain.setValueAtTime(0, t0)
      g.gain.linearRampToValueAtTime(peak, t0 + 0.003)
      g.gain.setValueAtTime(peak, releaseAt)
      g.gain.setTargetAtTime(0, releaseAt, 0.28)

      src.connect(g)
      if (panner) {
        g.connect(lp)
        lp.connect(panner)
        panner.connect(AUDIO.bus)
      } else {
        g.connect(lp)
        lp.connect(AUDIO.bus)
      }
      src.start(t0)
      try {
        src.stop(releaseAt + 1.6)
      } catch {
        /* 已经停过 */
      }

      // 释放采样（制音器落在弦上那一下）先不放了。
      // 原意是补真实感，但密度太高：361 个音就是 361 次"噗"，叠起来是一片
      // 翻箱倒柜的杂音，手动点单键时尤其明显。钢琴自己的自然衰减已经够了。
      // 真要加回来，需要按"是否真的松键"和"是否踩踏板"来触发，不是每个音都来一下。

      const voice = {
        midi,
        released: false,
        release(now) {
          if (voice.released) return
          voice.released = true
          const t = Math.max(now || ac.currentTime, ac.currentTime)
          try {
            g.gain.cancelScheduledValues(t)
            g.gain.setValueAtTime(g.gain.value, t)
            g.gain.setTargetAtTime(0, t, 0.035)
          } catch {
            /* 节点可能已回收 */
          }
          try {
            src.stop(t + 0.4)
          } catch {
            /* 已经停过 */
          }
          window.setTimeout(() => AUDIO.live.delete(voice), 600)
        },
      }
      AUDIO.live.add(voice)
      return voice
    }

    /**
     * 敲一个音：有采样就用采样，没加载完就退回合成。
     */
    function strike(midi, when, dur, vel) {
      const ac = ensureAudio()
      if (!ac) return null
      const v = clamp01(Number(vel) || 0.75)
      const m = snapToSample(midi)
      // 只用 v5（中等力度）这一层。
      // v1/v5/v16 三层的实测电平是 -24.2 / -13.9 / -1.5 dB —— 三套完全不同的基准，
      // 按力度在层间跳会让同一首曲子里左右手落在不同音量体系上，
      // 这就是"右手被压低 / 力度反了"反复出现的原因。
      // 单层 + 平方律力度：音色统一、电平可控。
      const buf = SAMPLES.get(m + ':v5')
      if (!buf) {
        loadSample(ac, midi, 'v5').catch(() => {})
        dlog(`strike MISS midi=${midi} snap=${m} vel=${v.toFixed(2)} have=${SAMPLES.size} ac=${ac.state}`)
        return null
      }
      const voice = playSampleVoice(ac, buf, m, midi, when, dur, v)
      dlog(`strike HIT midi=${midi} snap=${m} vel=${v.toFixed(2)} dur=${Number(dur).toFixed(2)} ac=${ac.state} gain=${voice ? 'ok' : 'null'}`)
      return voice
    }

    /**
     * 把诊断写回宿主。
     * 浏览器里的 console 我们看不到 —— 加日志不等于本人能读到，
     * 所以统一走 /log，落到 record/piano.log。
     */
    let dlogBusy = false
    function dlog(line) {
      try {
        const text = new Date().toISOString().slice(11, 23) + ' ' + line
        if (dlogBusy) return
        dlogBusy = true
        fetch(API + '/log', {
          method: 'POST',
          credentials: 'same-origin',
          body: text,
        }).catch(() => {}).finally(() => { dlogBusy = false })
      } catch {
        /* 日志不影响演奏 */
      }
    }

    /**
     * 合成兜底：加法合成。
     *
     * 钢琴音的物理结构：一根弦被击打后，各次泛音同时起振，
     * 但**高次泛音衰减快得多**，所以听起来是"先亮后暖"。
     * 只用一条包络盖住所有泛音，就是电子琴；每个泛音各衰减各的，才像钢琴。
     *
     * @param {number} midi
     * @param {number} when AudioContext 时刻（秒）
     * @param {number} dur 按住多久（秒）
     * @param {number} vel 力度 0–1
     */
    function synthVoice(midi, when, dur, vel) {
      const ac = ensureAudio()
      if (!ac) return null
      const v = clamp01(Number(vel) || 0.75)
      const t0 = Math.max(when || 0, ac.currentTime + 0.001)
      const hold = Math.max(0.12, Number(dur) || 0.5)
      const f0 = freqOf(midi)

      const out = ac.createGain()
      out.gain.value = 1

      // 力度越大高频越多 —— 这是钢琴"怎么弹"的核心，不是音量大小
      const lp = ac.createBiquadFilter()
      lp.type = 'lowpass'
      lp.Q.value = 0.3
      const cut0 = Math.min(16000, Math.max(1400, f0 * (5 + 11 * v) + 800))
      lp.frequency.setValueAtTime(cut0, t0)
      // 高次泛音先衰减，所以截止频率也跟着往下走
      lp.frequency.exponentialRampToValueAtTime(Math.max(600, f0 * 2.2), t0 + 0.9)
      out.connect(lp)
      lp.connect(AUDIO.bus)

      // 弦的非谐性：真实琴弦的高次泛音比整数倍略高一点
      const INHARMONIC = 0.00035
      const PARTIALS = 16
      const oscs = []

      // 频率相关的整体衰减：低音余振长、高音消失快。
      // 这一条是合成钢琴和合成风琴的分水岭 —— 少了它，低音会一直嗡嗡响。
      const baseTau = 4.6 * Math.pow(220 / Math.max(40, f0), 0.55)
      // 16 次泛音按 1/n^1.6 加起来约 1.85，先归一化，再按音区略减
      const headroom = 0.30 / (1 + Math.log2(1 + f0 / 260) * 0.28)

      for (let n = 1; n <= PARTIALS; n++) {
        const f = f0 * n * Math.sqrt(1 + INHARMONIC * n * n)
        if (f > 17000) break
        // 幅度：1/n^1.6（比 1/n 陡得多，听着才不"电子"）；重弹时高次泛音相对更强
        const amp = Math.pow(n, -1.6) * Math.pow(v, 0.35 + 0.55 / n) * headroom
        if (amp < 0.0006) continue
        // 每个泛音自己衰减，高次快得多
        const tau = Math.max(0.05, baseTau / (1 + Math.pow(n, 1.1) * 0.55))

        const o = ac.createOscillator()
        o.type = 'sine'
        o.frequency.setValueAtTime(f, t0)

        const g = ac.createGain()
        // 两段衰减：先是击弦瞬间的快速跌落（40ms 掉到三成），然后才是弦的余振
        g.gain.setValueAtTime(0, t0)
        g.gain.linearRampToValueAtTime(amp, t0 + 0.003)
        g.gain.setTargetAtTime(amp * 0.34, t0 + 0.003, 0.045)
        g.gain.setTargetAtTime(0, t0 + 0.055, tau / 3)

        o.connect(g)
        g.connect(out)
        o.start(t0)
        oscs.push(o)
      }

      // 松键：整体迅速收掉，模拟制音器落下去
      out.gain.setValueAtTime(1, t0)
      out.gain.setValueAtTime(1, t0 + hold)
      out.gain.setTargetAtTime(0, t0 + hold, 0.055)

      const stopAt = t0 + hold + 0.5
      for (const o of oscs) {
        try {
          o.stop(stopAt)
        } catch {
          /* 已经停过 */
        }
      }

      const voice = {
        midi,
        released: false,
        release(now) {
          if (voice.released) return
          voice.released = true
          const t = Math.max(now || ac.currentTime, ac.currentTime)
          try {
            out.gain.cancelScheduledValues(t)
            out.gain.setValueAtTime(out.gain.value, t)
            out.gain.setTargetAtTime(0, t, 0.045)
          } catch {
            /* 节点可能已回收 */
          }
          for (const o of oscs) {
            try {
              o.stop(t + 0.35)
            } catch {
              /* 已经停过 */
            }
          }
          window.setTimeout(() => AUDIO.live.delete(voice), 600)
        },
      }
      AUDIO.live.add(voice)
      return voice
    }

    function cutAll() {
      const ac = AUDIO.ac
      const now = ac ? ac.currentTime : 0
      for (const voice of Array.from(AUDIO.live)) {
        try {
          voice.release(now)
        } catch {
          /* 忽略 */
        }
      }
      AUDIO.live.clear()
      // 保险：总线瞬间静音再恢复。
      // 一首曲子的事件在开演时就全部排进 AudioContext 时间轴了（未来十几秒的音都已经
      // 调度好），光 release 单个 voice 可能漏掉几个；这里直接把总线掐一下，50ms 后恢复。
      //
      // 这里原来有个会永久静音的错：
      //   setValueAtTime(0, now) 之后再来一句 setValueAtTime(1, now + 0.05) ——
      //   两个都是「插入一个事件」，后者并不会覆盖 0 时刻那个；
      //   而 strike() 里的 linearRampToValueAtTime(peak, …) 从 0 爬上去之后同样不回位。
      //   于是总线一路保持在 0：点一次「停」之后，整页直到刷新都不再出声。
      // 正确做法：先 cancelScheduledValues 清掉排定的自动化，再用 ramp 把增益拉回 1.0。
      if (ac && AUDIO.bus) {
        try {
          const g = AUDIO.bus.gain
          const target = Number.isFinite(AUDIO.volume) ? AUDIO.volume : 1
          g.cancelScheduledValues(now)
          g.setValueAtTime(0, now)
          g.linearRampToValueAtTime(target, now + 0.06)
        } catch {
          /* 忽略 */
        }
      }
    }

    /* ───────────────────────── 样式 ───────────────────────── */

    const CSS = `
/* 停靠位置：菜单栏和会话标题栏之下，96px。
   之前定 52px 正好压在标题上，标题和面板控件糊成一片 —— 让开那一条。 */
/* ── 吸附留白 ─────────────────────────────────────────────
   钢琴窗口贴在本页顶部时，用 padding 把页面内容整体下推，
   给钢琴让出位置。改的是本页布局，不动窗口尺寸，
   所以最大化/全屏/分屏都自动成立。 */


[data-dp-root]{position:fixed;top:96px;left:50%;transform:translateX(-50%);z-index:40;
  display:flex;flex-direction:column;align-items:center;gap:0;pointer-events:none;
  width:max-content;max-width:96vw;}

/* ── 独立窗口形态 ─────────────────────────────────────────────
   由 window.open 打开的窗口里只该有钢琴：铺满整个视口，
   上面那层 DSH 界面整块压住，不参与布局。
   窗口本身的位置（贴在主窗口上方）由 window.open 的 left/top 决定。 */
html[data-dp-popup] [data-dp-root]{
  position:fixed;inset:0;transform:none;left:0;top:0;
  width:100%;max-width:100%;height:100%;
  z-index:2147483647;justify-content:center;
  background:#0b1017;margin:0;padding:0;}
html[data-dp-popup] [data-dp-card]{
  width:100%;height:100%;border-radius:0;border:0;
  display:flex;flex-direction:column;background:#0b1017;}
html[data-dp-popup] [data-dp-scroll]{flex:1;display:flex;align-items:center;
  padding:10px 12px;min-height:0;}
html[data-dp-popup] [data-dp-board]{height:100%;min-height:0;width:100%;}
[data-dp-root] > *{pointer-events:auto;}
[data-dp-pill]{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;
  border-radius:14px;cursor:pointer;font:inherit;font-size:12px;color:inherit;
  border:1px solid var(--dsw-alias-border-default,rgba(128,128,128,.28));
  background:var(--dsw-alias-bg-base,transparent);box-shadow:none;}
[data-dp-pill]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));}
/* 跟旁边的 SSH 徽章同一套语法：高亮边框 + 默认文字 + 一个绿点。
   边框用 border-l2（主题里的"更强的边框"）而不是 border-l1，
   线宽也抬到 1.5px —— l1 在深色背景上太淡，看着像没画边框。 */
[data-dp-pill][data-dp-inline],
[data-dp-pill][data-dp-inline] span{
  color:inherit !important;}
/* 边框用 border-l2 再调淡一档：l2 原色有点抢眼，和 SSH 并排时显得更重。
   color-mix 降不透明度，亮色/深色主题都不会跑偏。线宽保留 1.5px —— 变淡不靠变细。 */
[data-dp-pill][data-dp-inline]{
  box-shadow:none;background:transparent;
  border:1.5px solid color-mix(in srgb, var(--dsw-alias-border-l2,rgba(255,255,255,.38)) 62%, transparent) !important;
  font-weight:500;}
[data-dp-pill][data-dp-inline]:hover{
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));
  border-color:color-mix(in srgb, var(--dsw-alias-border-l2,rgba(255,255,255,.55)) 82%, transparent) !important;}

/* 圆点：默认灰（未启动），data-on 才绿（启动中）。
   之前有一行 [data-dp-inline] 的 !important 强制绿色，把状态覆盖掉了。 */
[data-dp-pillbox]{display:inline-flex;align-items:center;gap:4px;}
[data-dp-instwrap]{position:relative;display:inline-flex;}
[data-dp-inst]{display:inline-flex;align-items:center;gap:4px;height:26px;max-width:190px;
  padding:0 8px;font-size:12px;color:inherit;background:transparent;
  border:1px solid rgba(128,128,128,.28);border-radius:7px;cursor:pointer;
  font-family:inherit;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;}
[data-dp-inst]:hover{background-color:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));}
[data-dp-inst]:disabled{opacity:.5;cursor:default;}
[data-dp-inst-cur]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-dp-inst-arrow]{flex:none;opacity:.6;font-size:10px;}

[data-dp-instmenu]{position:absolute;top:30px;left:0;z-index:300;width:260px;
  background:#1c1f24;border:1px solid rgba(128,128,128,.28);border-radius:8px;
  box-shadow:0 10px 28px rgba(0,0,0,.45);padding:6px;display:flex;
  flex-direction:column;gap:4px;}
[data-dp-instsearch]{height:26px;padding:0 8px;font-size:12px;color:inherit;
  background:rgba(255,255,255,.05);border:1px solid rgba(128,128,128,.24);
  border-radius:6px;outline:none;font-family:inherit;}
[data-dp-instsearch]:focus{border-color:rgba(59,130,246,.6);}
[data-dp-instlist]{max-height:320px;overflow-y:auto;overscroll-behavior:contain;}
[data-dp-inst-group]{padding:6px 8px 3px;font-size:11px;opacity:.55;
  position:sticky;top:0;background:#1c1f24;}
[data-dp-inst-item]{display:flex;gap:8px;width:100%;padding:4px 8px;font-size:12px;
  color:inherit;background:transparent;border:0;border-radius:5px;cursor:pointer;
  text-align:left;font-family:inherit;}
[data-dp-inst-item]:hover{background:rgba(128,128,128,.16);}
[data-dp-inst-item][data-sel]{background:rgba(59,130,246,.22);}
[data-dp-inst-num]{width:26px;flex:none;opacity:.5;font-variant-numeric:tabular-nums;}
[data-dp-inst-name]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-dp-instempty]{padding:10px 8px;font-size:12px;opacity:.55;}

[data-dp-midibox]{position:relative;display:inline-flex;align-items:center;}
/* 文件选择框必须藏掉原生"选择文件"按钮 —— 它和旁边的「MIDI」按钮重复。
   display:none 在部分宿主里对 input[type=file] 不生效（原生控件照常渲染），
   所以用"零尺寸 + 绝对定位"的视觉隐藏：不占位、看不见，但 click() 仍然有效。 */
[data-dp-midifile]{position:absolute;width:1px;height:1px;padding:0;margin:-1px;
  overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;opacity:0;}
[data-dp-midi]{width:52px;min-width:52px;height:26px;padding:0;font-size:12px;color:inherit;
  text-align:center;box-sizing:border-box;
  background:transparent;border:1px solid rgba(128,128,128,.28);border-radius:7px;
  cursor:pointer;white-space:nowrap;font-family:inherit;
  transition:background .15s ease;}
[data-dp-midi]:hover{background-color:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));}
[data-dp-midi]:disabled{cursor:default;opacity:.7;}
[data-dp-midi][data-busy]{border-color:rgba(59,130,246,.55);color:#7fb3ff;}

[data-dp-dot]{width:7px;height:7px;border-radius:4px;background:#5b6472;flex:none;transition:background .15s ease;}
[data-dp-dot][data-on]{background:#22c55e;animation:dp-pulse .9s ease-in-out infinite;}
@keyframes dp-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.6);opacity:.45}}
/* 深色停靠条：跟 DSH 的深色界面同一套底色，不再是一块浅色浮窗。
   圆角只在下面两个角 —— 上面那条边贴着标题栏，圆了会露出缝。 */
[data-dp-card]{width:min(96vw,1240px);border-radius:0 0 12px 12px;overflow:hidden;
  border:1px solid rgba(255,255,255,.09);border-top:0;
  background:#11161f;box-shadow:0 14px 36px rgba(0,0,0,.5);}
[data-dp-head]{display:flex;align-items:center;gap:9px;padding:5px 9px 5px 12px;
  background:#0d1219;color:#e3e8ef;
  border-bottom:1px solid rgba(255,255,255,.07);}
[data-dp-title]{font-size:13px;font-weight:600;color:#7dd3a0;}
[data-dp-sub]{font-size:11px;color:#8b95a5;}
[data-dp-grow]{flex:1;min-width:8px;}
[data-dp-btn]{height:23px;padding:0 9px;border-radius:6px;cursor:pointer;font:inherit;font-size:11.5px;
  color:#c9d1dc;border:1px solid rgba(255,255,255,.13);background:transparent;}
[data-dp-btn]:hover{background:rgba(255,255,255,.08);color:#fff;}
[data-dp-vol]{display:flex;align-items:center;gap:5px;font-size:11px;
  color:#8b95a5;white-space:nowrap;}
[data-dp-vol] input[type=range]{width:64px;accent-color:#22c55e;}
[data-dp-vol] input[type=checkbox]{accent-color:#22c55e;}
[data-dp-scroll]{overflow-x:auto;overflow-y:hidden;padding:12px 14px 10px;
  background:linear-gradient(180deg,#0b1017,#161d28 55%,#080c12);
  box-shadow:inset 0 10px 22px rgba(0,0,0,.7);}
[data-dp-board]{position:relative;min-width:900px;height:124px;user-select:none;touch-action:manipulation;}
[data-dp-whites]{display:flex;height:100%;align-items:flex-start;}
[data-dp-white]{flex:1 1 0;min-width:0;height:100%;position:relative;
  display:flex;align-items:flex-end;justify-content:center;
  padding-bottom:6px;font-size:8.5px;line-height:1;color:#8c96a8;cursor:pointer;
  background:linear-gradient(180deg,#ffffff 0%,#f9fbfe 52%,#e9eef6 86%,#dbe2ee 100%);
  border:1px solid #b6c0d0;border-top:0;border-radius:0 0 7px 7px;
  /* 底部那条实心 4px 就是键的厚度；按下时它被压到 0，看起来就"陷进去"了，不需要位移 */
  box-shadow:inset 0 2px 0 rgba(255,255,255,.9), inset -1px 0 0 rgba(0,0,0,.05),
    0 4px 0 #a9b3c4, 0 7px 12px rgba(0,0,0,.35);
  transition:box-shadow .12s ease;}
[data-dp-black]{position:absolute;top:0;height:78px;z-index:2;cursor:pointer;
  background:linear-gradient(180deg,#4b5568 0%,#2b3345 42%,#141924 82%,#05080d 100%);
  border:1px solid #05080d;border-top:0;border-radius:0 0 5px 5px;
  box-shadow:inset 0 2px 0 rgba(255,255,255,.2), inset -1px 0 0 rgba(0,0,0,.4),
    0 5px 0 #04070b, 0 9px 14px rgba(0,0,0,.55);
  transition:box-shadow .12s ease;}
/* 高亮颜色按"哪只手"分：左手蓝、右手绿。
   颜色走 CSS 变量，两只手各覆盖一份，动画本身只写一次 —— 不然要复制两套 keyframes。
   音高分界用中央 C（60）：这曲子左手最低 C2、右手最高 G6，中间界很清楚。 */
@keyframes dp-hit-white{
  0%{background:var(--dp-hi1,#4f92e0);
     box-shadow:inset 0 6px 14px rgba(10,40,90,.45), 0 0 0 #a9b3c4, 0 1px 3px rgba(0,0,0,.3);}
  55%{background:var(--dp-hi2,#8fbdf0);
     box-shadow:inset 0 4px 10px rgba(10,40,90,.3), 0 2px 0 #a9b3c4, 0 3px 7px rgba(0,0,0,.3);}
  100%{background:linear-gradient(180deg,#ffffff,#dbe2ee);
     box-shadow:inset 0 2px 0 rgba(255,255,255,.9), 0 4px 0 #a9b3c4, 0 7px 12px rgba(0,0,0,.35);}
}
@keyframes dp-hit-black{
  0%{background:var(--dp-hi1,#6aa3ee);
     box-shadow:inset 0 6px 14px rgba(0,0,0,.55), 0 0 0 #04070b, 0 2px 4px rgba(0,0,0,.5);}
  55%{background:var(--dp-hi2,#3f74bd);
     box-shadow:inset 0 4px 10px rgba(0,0,0,.45), 0 2px 0 #04070b, 0 4px 8px rgba(0,0,0,.5);}
  100%{background:linear-gradient(180deg,#4b5568,#05080d);
     box-shadow:inset 0 2px 0 rgba(255,255,255,.2), 0 5px 0 #04070b, 0 9px 14px rgba(0,0,0,.55);}
}
[data-dp-white].dp-hit{animation:dp-hit-white .7s cubic-bezier(.2,.8,.3,1) both;}
[data-dp-black].dp-hit{animation:dp-hit-black .7s cubic-bezier(.2,.8,.3,1) both;}
/* 左手（低音区）：蓝 */
[data-dp-white].dp-hit-lh{--dp-hi1:#1d4ed8;--dp-hi2:#60a5fa;}
[data-dp-black].dp-hit-lh{--dp-hi1:#1e40af;--dp-hi2:#3b82f6;}
/* 右手（中高音区）：绿 */
[data-dp-white].dp-hit-rh{--dp-hi1:#15803d;--dp-hi2:#4ade80;}
[data-dp-black].dp-hit-rh{--dp-hi1:#14532d;--dp-hi2:#22c55e;}
[data-dp-foot]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 12px 8px;
  font-size:11px;color:#8b95a5;background:#0d1219;
  border-top:1px solid rgba(255,255,255,.06);}
[data-dp-chip]{height:22px;padding:0 9px;border-radius:11px;cursor:pointer;font:inherit;font-size:11px;
  color:#c9d1dc;border:1px solid rgba(255,255,255,.13);background:transparent;}
[data-dp-chip]:hover{background:rgba(255,255,255,.08);color:#fff;}
[data-dp-sep]{width:1px;height:14px;background:rgba(255,255,255,.12);margin:0 2px;}
[data-dp-hint]{font-size:11px;color:#f59e0b;}
/* 吸附：EXE 钢琴窗口贴在 DSH 顶上时，页面给自己留出那块高度（不碰窗口尺寸）。 */
html[data-dp-snap="1"] body{padding-top:var(--dsh-piano-snap-h,190px);}
html[data-dp-snap="1"] [data-dp-root]{z-index:50;}
`

    /* ───────────────────────── 面板 ───────────────────────── */

    const KEYMAP = {
      a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
      k: 12, o: 13, l: 14, p: 15, ';': 16,
    }

    /** 是否跑在独立钢琴窗口里（由 window.open 打开，URL 带 ?pianoPopup=1）。 */
    const IS_POPUP = (() => {
      try {
        return new URLSearchParams(location.search).has('pianoPopup')
      } catch {
        return false
      }
    })()

    /**
     * 吸附留白：EXE 开了吸附，就插一段 padding，让页面顶部让出钢琴的高度（默认 190）。
     *
     * 为什么必须有这个函数本体：上一版只在 tick() 里调了 `syncSnapLayout(...)`，
     * 函数却没写出来 —— 每次轮询都在 .then() 里抛 ReferenceError，
     * 被后面的 .catch(() => {}) 吃掉，界面上一点错都看不见；
     * 更致命的是同一句链尾的 `timer = setTimeout(tick, 140)` 也不会执行，
     * tick() 从此再也不跑 → 网页端一个 /events 都没发过 → 完全没声。
     *
     * 所以这里：① 引用了就必须存在；② tick() 里的调用点另外用 try/catch 包住，
     * 以后再有类似的"小功能"出错，也只丢那一个功能，不能连累轮询。
     *
     * @param {boolean} on
     * @param {number} height 像素
     */
    function syncSnapLayout(on, height) {
      const root = document.documentElement
      if (!root) return
      if (on) {
        const h = Math.max(0, Math.min(400, Math.round(height || 190)))
        root.style.setProperty('--dsh-piano-snap-h', h + 'px')
        root.setAttribute('data-dp-snap', '1')
      } else {
        root.removeAttribute('data-dp-snap')
        root.style.removeProperty('--dsh-piano-snap-h')
      }
    }

    /**
     * 主窗口 ↔ 独立窗口的协调通道。
     * 两个窗口都会轮询 /events，各自排各自的音 —— 不协调就是双重奏。
     * 独立窗口一开，主窗口就停轮询；关掉再恢复。
     */
    const channel = (() => {
      try {
        return new BroadcastChannel('dsh-piano-xz')
      } catch {
        return null
      }
    })()

    /**
     * 请宿主开一个独立钢琴窗口。
     *
     * 不走 window.open：DSH 是 Electron 壳，主进程通常对 window.open 返回 deny，
     * renderer 里拿到的是 null（这就是之前点了没反应的原因）。
     * 改由宿主用 Chrome 的 --app 模式起窗口，位置按主窗口矩形算，钉在正上方。
     * @returns {Promise<object|null>} 失败返回 null，调用方降级到原地展开
     */
    /** 通知宿主关掉钢琴窗口。 */
    async function closePianoWindow() {
      try {
        await fetch(API + '/popup/close', { method: 'POST', credentials: 'same-origin' })
      } catch {}
      UI.set({ windowOpen: false })
    }

    /** 主窗口定时问宿主：钢琴窗口还开着吗？用来同步圆点颜色。 */
    /**
     * 立刻问一次"窗口开着吗"，并更新 UI 状态。
     * 给"刚做过可能拉起窗口的操作"（如 MIDI 导入）用，免得等轮询。
     */
    async function refreshWindowState() {
      try {
        const r = await fetch(API + '/popup/state', { credentials: 'same-origin', cache: 'no-store' })
        if (!r.ok) return
        const j = await r.json()
        if (!!j.open !== !!UI.windowOpen) UI.set({ windowOpen: !!j.open })
      } catch {}
    }

    function watchPianoWindow() {
      if (IS_POPUP) return () => {}
      let stop = false
      const tick = async () => {
        if (stop) return
        await refreshWindowState()
        if (!stop) setTimeout(tick, 800)
      }
      tick()
      return () => { stop = true }
    }

    async function openPianoWindow() {
      try {
        const r = await fetch(API + '/popup/open', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
        })
        const j = await r.json()
        if (j && j.ok) {
          if (channel) channel.postMessage({ type: 'popup-open' })
          return j
        }
        return null
      } catch {
        return null
      }
    }

    /* ── 开关的共享状态 ──────────────────────────────────────────
     * 胶囊按钮挂在会话标题栏的 utilities（右上角 SSH 那排），
     * 键盘面板挂在 shell.overlay。两个 slot 是两个独立渲染点，
     * 必须有一处共享开关，否则点按钮那边开不动面板。
     * 挂 window 是因为热更新会重建模块 —— 挂在模块作用域会丢状态。 */
    const UI = window.__dshPianoUI || (window.__dshPianoUI = {
      // 独立钢琴窗口是否开着。胶囊按钮靠它决定"点一下是开还是关"，
      // 圆点也靠它上色（开着=绿，关着=灰）。
      windowOpen: false,
      open: false,
      playing: false,
      subs: new Set(),
      emit() { for (const f of this.subs) f() },
      subscribe(f) { this.subs.add(f); return () => this.subs.delete(f) },
      set(patch) { Object.assign(this, patch); this.emit() },
      toggle() { this.set({ open: !this.open }) },
    })

    function usePianoUI() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => UI.subscribe(force), [])
      return UI
    }

    /**
     * GM 的 16 个乐器分类。每类 8 个音色，程序号连续。
     * 下拉框按这个分组，比平铺 128 行好找。
     */
    const GM_GROUPS = [
      [0, '钢琴'], [8, '色彩打击乐'], [16, '风琴'], [24, '吉他'],
      [32, '贝斯'], [40, '弦乐'], [48, '合奏'], [56, '铜管'],
      [64, '簧管'], [72, '长笛'], [80, '合成主音'], [88, '合成铺底'],
      [96, '合成效果'], [104, '民族乐器'], [112, '打击乐'], [120, '音效'],
    ]

    /**
     * 乐器下拉框。
     *
     * 只跟宿主说话，不直接碰 EXE —— EXE 那边在轮询 /preset，
     * 这里 POST /instrument 改了状态，EXE 下一秒就自己切过去了。
     * 这样网页关着、只开着窗口的场景也能用（虽然那时没人点下拉）。
     */
    /**
     * 乐器选择器（自绘下拉）。
     *
     * 为什么不用原生 <select>：
     *   原生下拉的列表是系统画的，滚到哪我们管不了 —— 每次打开都从头开始，
     *   128 个音色要翻半天。换成自绘之后可以：
     *     · 记住上次滚到哪（存 localStorage），再打开直接停在原处
     *     · 输入框搜索（打 "violin" / "弦乐" 立刻筛）
     *     · 分类可折叠
     */
    function InstrumentSelect() {
      const [list, setList] = React.useState([])
      const [cur, setCur] = React.useState(0)
      const [busy, setBusy] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const wrapRef = React.useRef(null)
      const listRef = React.useRef(null)
      const searchRef = React.useRef(null)
      // 当前音色的"真值"，给快捷键用（避免读到过期的 state）
      const curRef = React.useRef(0)
      // 刚由用户主动切到的音色。轮询看到这个值时不再覆盖（防止回弹）
      const lastUserPickRef = React.useRef(-1)

      // 滚到哪了就记下来（按 program 记，不按像素 —— 列表长度变了也能对上）
      const saveScroll = React.useCallback(() => {
        const el = listRef.current
        if (!el) return
        try { writeLS('instTop', String(el.scrollTop)) } catch {}
      }, [])

      // 乐器清单：只取一次
      React.useEffect(() => {
        let alive = true
        ;(async () => {
          try {
            const res = await fetch(API + '/instruments', { credentials: 'same-origin', cache: 'no-store' })
            const r = await res.json()
            if (!alive || !r || !r.ok) return
            setList(Array.isArray(r.list) ? r.list : [])
            const p0 = Number(r.current?.program) || 0
            curRef.current = p0
            setCur(p0)
          } catch {}
        })()
        return () => { alive = false }
      }, [])

      // 当前音色：每秒轮询 /preset（AI 用 piano_instrument 切了要能看到）
      React.useEffect(() => {
        let alive = true
        let timer = null
        let lastApplied = -1
        const tick = async () => {
          try {
            const res = await fetch(API + '/preset', { credentials: 'same-origin', cache: 'no-store' })
            const r = await res.json()
            if (alive && r && r.ok && Number.isFinite(r.program) && r.program !== lastApplied) {
              lastApplied = r.program
              // 用户刚切过的值不要被轮询覆盖（请求还在路上时 /preset 可能还是旧值）
              if (r.program !== lastUserPickRef.current) {
                curRef.current = r.program
                setCur(r.program)
              }
            }
          } catch {}
          if (alive) timer = setTimeout(tick, 1000)
        }
        tick()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [])

      // 点外面 / Esc 关闭
      React.useEffect(() => {
        if (!open) return
        const onDoc = (e) => {
          if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
        }
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDoc)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDoc)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      // 打开时：聚焦搜索框 + 恢复上次滚动位置
      React.useEffect(() => {
        if (!open) return
        const t = setTimeout(() => {
          if (searchRef.current) searchRef.current.focus()
          const el = listRef.current
          if (el) {
            const saved = Number(readLS('instTop', '0'))
            if (Number.isFinite(saved) && saved > 0) el.scrollTop = saved
          }
        }, 0)
        return () => clearTimeout(t)
      }, [open])

      const pick = React.useCallback(async (program) => {
        curRef.current = program
        lastUserPickRef.current = program
        setCur(program)
        setOpen(false)
        setBusy(true)
        try {
          await fetch(API + '/instrument?program=' + program, { method: 'POST', credentials: 'same-origin' })
        } catch {} finally { setBusy(false) }
      }, [])

      /**
       * Ctrl + ↑/↓ 切上一个/下一个乐器。
       *
       * 为什么加这个：128 个音色，翻下拉列表太费劲。
       * 用快捷键可以直接连着试听、快速找到想要的音色。
       *
       * 只在"页面有焦点"时生效，且不抢占：
       *   · 输入框/文本域里按 Ctrl+↑↓ 不拦（那是光标移动/滚动）
       *   · 下拉打开时也拦（那时你就是在选乐器）
       */
      React.useEffect(() => {
        const onKey = (ev) => {
          if (!ev.ctrlKey || ev.altKey || ev.metaKey) return
          if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return

          // 输入框里不拦（聊天框里 Ctrl+↑ 有别的用途）
          const t = ev.target
          const tag = t && t.tagName ? t.tagName.toLowerCase() : ''
          const typing = tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)
          // 例外：我们自己那个搜索框要放行（在下面拦，用来上下选）
          const inSearch = t && t.hasAttribute && t.hasAttribute('data-dp-instsearch')
          if (typing && !inSearch) return

          ev.preventDefault()
          ev.stopPropagation()

          const step = ev.key === 'ArrowUp' ? -1 : 1
          // 用 ref 读当前值，不在 setState 回调里发请求 ——
          // 那样 React 严格模式会重复执行回调，等于连发两次请求。
          const prev = curRef.current
          const next = Math.max(0, Math.min(list.length - 1, prev + step))
          if (next === prev) return

          curRef.current = next
          setCur(next)
          lastUserPickRef.current = next
          // 立刻发切换请求（不 await，键盘要跟手）
          fetch(API + '/instrument?program=' + next, {
            method: 'POST',
            credentials: 'same-origin',
          }).catch(() => {})
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [list.length])

      if (!list.length) return null

      // 搜索过滤
      const q = query.trim().toLowerCase()
      const match = (i) => !q || list[i].name.toLowerCase().includes(q) || String(i) === q

      const rows = []
      for (let gi = 0; gi < GM_GROUPS.length; gi++) {
        const [startI, name] = GM_GROUPS[gi]
        const items = []
        for (let i = startI; i < startI + 8 && i < list.length; i++) {
          if (!match(i)) continue
          items.push(
            h(
              'button',
              {
                key: i,
                type: 'button',
                'data-dp-inst-item': '',
                'data-sel': i === cur ? '' : undefined,
                onClick: () => pick(i),
              },
              h('span', { 'data-dp-inst-num': '' }, String(i)),
              h('span', { 'data-dp-inst-name': '' }, list[i].name),
            ),
          )
        }
        if (!items.length) continue
        rows.push(h('div', { key: 'g' + name, 'data-dp-inst-group': '' }, name))
        rows.push(...items)
      }

      const curName = list[cur] ? list[cur].name : ''

      return h(
        'span',
        { 'data-dp-instwrap': '', ref: wrapRef },
        h(
          'button',
          {
            'data-dp-inst': '',
            type: 'button',
            disabled: busy || undefined,
            title: cur + ' · ' + curName,
            onClick: () => setOpen((v) => !v),
          },
          h('span', { 'data-dp-inst-cur': '' }, cur + ' · ' + curName),
          h('span', { 'data-dp-inst-arrow': '' }, '▾'),
        ),
        open
          ? h(
              'div',
              { 'data-dp-instmenu': '' },
              h('input', {
                ref: searchRef,
                'data-dp-instsearch': '',
                type: 'text',
                placeholder: '搜索乐器…',
                value: query,
                onChange: (e) => setQuery(e.target.value),
              }),
              h(
                'div',
                { 'data-dp-instlist': '', ref: listRef, onScroll: saveScroll },
                rows.length ? rows : h('div', { 'data-dp-instempty': '' }, '没有匹配的乐器'),
              ),
            )
          : null,
      )
    }

    /**
     * 选 MIDI 文件并播放。
     *
     * 用 <input type="file"> + fetch 把二进制 POST 到 /upload-midi。
     * 为什么不在浏览器里解析：解析器（lib/midi.js）在宿主那边，
     * 而且播放队列也在宿主 —— 传文件过去解析+排队，一条路走完，
     * 不在前端维护第二份 MIDI 解析代码。
     */
    function MidiPicker() {
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const inputRef = React.useRef(null)

      const onPick = React.useCallback(async (e) => {
        const file = e.target.files && e.target.files[0]
        e.target.value = ''      // 同一个文件能重复选
        if (!file) return
        setBusy(true)
        setMsg('')
        try {
          const buf = await file.arrayBuffer()
          const res = await fetch(
            API + '/upload-midi?name=' + encodeURIComponent(file.name),
            { method: 'POST', credentials: 'same-origin', body: buf },
          )
          const r = await res.json()
          if (r && r.ok) {
            setMsg(`${r.notes} 个音 · ${r.seconds} 秒`)
            // 上传会顺带把钢琴窗口拉起来 —— 立刻同步一次状态，
            // 不用等下一轮轮询，圆点马上变绿。
            refreshWindowState()
          } else {
            setMsg(r?.error || '播放失败')
            refreshWindowState()
          }
        } catch (err) {
          setMsg(String(err?.message || err))
        } finally {
          setBusy(false)
        }
      }, [])

      return h(
        'span',
        { 'data-dp-midibox': '', title: msg || '选一个 .mid 文件直接播放' },
        h('input', {
          ref: inputRef,
          type: 'file',
          accept: '.mid,.midi,audio/midi,audio/x-midi',
          'data-dp-midifile': '',
          onChange: onPick,
        }),
        h(
          'button',
          {
            'data-dp-midi': '',
            'data-busy': busy ? '' : undefined,
            type: 'button',
            disabled: busy || undefined,
            title: msg || '选一个 .mid 文件直接播放',
            onClick: () => inputRef.current && inputRef.current.click(),
          },
          // 文字不变，只用样式表达"忙" —— 换成"读取中"会让按钮变宽，
          // 整排工具栏往两边抖一下（用户看到的就是"导入时按钮跳了一下"）。
          'MIDI',
        ),
        // 不显示"多少音/多少秒" —— 播放时这个信息用不上，还占位置。
        // msg 只在失败时通过 title 提示，成功就静默。
      )
    }

    /** 右上角那排工具里的「钢琴」按钮。 */
    function PianoPill() {
      const ui = usePianoUI()
      // 挂载时开始轮询宿主，同步"窗口是否开着"，圆点颜色才不会失真
      React.useEffect(() => watchPianoWindow(), [])
      const pill = h(
        'button',
        {
          'data-dp-pill': '',
          'data-dp-inline': '',
          type: 'button',
          title: ui.open ? '收起 DSH 钢琴' : '打开 DSH 钢琴',
          onClick: async () => {
            ensureAudio()
            if (!IS_POPUP) {
              // 开着就关，关着就开 —— 同一个按钮，点一下切一次。
              if (UI.windowOpen) {
                await closePianoWindow()
                return
              }
              const r = await openPianoWindow()
              if (r) {
                UI.set({ open: false, windowOpen: true })
                return
              }
            }
            UI.toggle()
          },
        },
        h('span', { 'data-dp-dot': '', 'data-on': (ui.windowOpen || ui.open || ui.playing) ? '' : undefined }),
        h('span', null, '钢琴'),
      )

      // 乐器选择框挨着胶囊。只开着独立窗口时这里不显示（那是 EXE 自己的顶栏管）。
      // 导出不做按钮 —— 它是个"命令"而不是"操作"：
      // 用户要导出时在对话里说一声（piano_export 工具）就够了，
      // 工具栏上多一个按钮只会挤位置、还容易误点。
      return h(
        'span',
        { 'data-dp-pillbox': '' },
        pill,
        h(InstrumentSelect, null),
        h(MidiPicker, null),
      )
    }

    function Panel() {
      const ui = usePianoUI()
      const open = ui.open
      const setOpen = React.useCallback((v) => UI.set({ open: !!v }), [])
      const [volume, setVolume] = React.useState(() => {
        // key 从 vol 换成 vol2：旧版默认 72%，且那时候音源电平低 18 dB，
        // 留在 localStorage 里的 72 会把提上来的电平又拽回去。换 key 等于一次性迁移。
        // 默认给满 —— 电平和正常应用对齐以后，100% 才是"正常大小"，
        // 觉得吵往下拉就行，别让默认值先扣一截。
        const v = Number(readLS('vol2', '100'))
        return Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : 1
      })
      const [autoOpen, setAutoOpen] = React.useState(() => readLS('auto', '1') === '1')
      const [info, setInfo] = React.useState(null)
      const [octave, setOctave] = React.useState(4)
      const [playing, setPlaying] = React.useState(false)
      const [ready, setReady] = React.useState(0)
      const [hint, setHint] = React.useState(false)
      const [nowPlaying, setNowPlaying] = React.useState('')

      // 把"正在演奏"同步给工具栏那颗胶囊（它在另一个 slot 里，看不到这里的 state）
      React.useEffect(() => {
        UI.set({ playing })
      }, [playing])

      // 独立窗口开关的协调：它开我就停，它关我就恢复
      React.useEffect(() => {
        if (!channel || IS_POPUP) return
        const onMsg = (e) => {
          const type = e && e.data && e.data.type
          if (type === 'popup-open') {
            pausedRef.current = true
            cutAll()
            clearLights()
            pendingEvents.current = []
            setPlaying(false)
            setNowPlaying('')
          } else if (type === 'popup-close') {
            pausedRef.current = false
          }
        }
        channel.addEventListener('message', onMsg)
        return () => channel.removeEventListener('message', onMsg)
      }, [])

      // 独立窗口自己关掉时通知主窗口恢复
      React.useEffect(() => {
        if (!IS_POPUP) return undefined
        const bye = () => {
          if (channel) channel.postMessage({ type: 'popup-close' })
        }
        window.addEventListener('beforeunload', bye)
        return () => {
          window.removeEventListener('beforeunload', bye)
          bye()
        }
      }, [])

      const scrollRef = React.useRef(null)
      const hitAt = React.useRef(new Map())
      const held = React.useRef(new Map())
      const playingTimer = React.useRef(null)
      /** 所有排队中的「点灯」定时器，停止时要逐個取消。 */
      const lightTimers = React.useRef(new Set())
      /** 代数：停止后自增，让已经在途的回调自觉作废。 */
      const lightGen = React.useRef(0)
      /** 还没到调度窗口的事件（避免一次往 AudioContext 塞几千个振荡器）。 */
      const pendingEvents = React.useRef([])
      /** 最近一次宿主时间基准，滑窗推进时用来换算「现在几点了」。 */
      const clock = React.useRef({ serverNow: 0, at: 0 })
      /** 独立钢琴窗口开着的时候，本窗口停轮询（否则两个窗口轮流取事件，声音会重）。 */
      const pausedRef = React.useRef(false)
      /**
       * 轮询游标必须跨 effect 存活。
       * 挂在 useCallback 依赖上时，effect 每重建一次游标就归零，
       * 服务器就会把同一批事件反复发回来（日志里 since=0 不变就是这个）。
       */
      const tickRefs = React.useRef({ seq: 0, stopTick: 0, primed: false })
      const autoOpened = React.useRef(false)
      const live = React.useRef({})
      live.current = { open, autoOpen }

      React.useEffect(() => {
        AUDIO.volume = volume
        if (AUDIO.master) AUDIO.master.gain.value = volume
        writeLS('vol2', Math.round(volume * 100))
      }, [volume])

      React.useEffect(() => {
        writeLS('open', open ? '1' : '0')
      }, [open])

      React.useEffect(() => {
        writeLS('auto', autoOpen ? '1' : '0')
      }, [autoOpen])

      React.useEffect(() => {
        let cancelled = false
        fetch(API + '/info', { credentials: 'same-origin', cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (!cancelled && data && data.ok) {
              setInfo(data)
              // 独立窗口的地址由宿主给（绝对 HTTP URL），存到共享状态里，
              // openPianoWindow 是模块级函数，拿不到组件 state。
              UI.set({ popupUrl: data.popup || '' })
            }
          })
          .catch(() => {})
        return () => {
          cancelled = true
        }
      }, [])

      // 面板一挂上就开始加载采样（AudioContext 挂在 suspended 状态也能解码），
      // 不等用户先点一下；顺便每 500ms 把已就绪数量同步到界面。
      React.useEffect(() => {
        const ac = ensureAudio()
        if (ac && SAMPLES.size < 90 && !window.__dshPianoPreloading) {
          window.__dshPianoPreloading = true
          preloadSamples(ac)
            .catch(() => {})
            .finally(() => {
              window.__dshPianoPreloading = false
            })
        }
        const id = window.setInterval(() => setReady(SAMPLES.size), 500)
        return () => window.clearInterval(id)
      }, [])

      /**
       * 敲一下某个键的高光。
       *
       * 前面试过三种都不行：
       *   1. React state —— 几十个音同一毫秒到点
       *   2. ref 缓存 DOM 节点 —— 收起/展开换分支时缓存为空
       *   3. 属性 + 内联样式，靠 on/off 两个定时器切换 —— 诊断显示 paint 122/0
       *      全部成功，但查的时候"亮 0"，说明设置完立刻被清掉了
       *
       * 现在改成一次性动画：加个 class 触发 keyframes，0.85 秒自己亮到淡出复位。
       * 没有"熄灭"这个动作，也就不存在被定时器清掉的问题。
       */
      const paint = React.useCallback((midi) => {
        const box = scrollRef.current
        if (!box) {
          window.__dpMiss = (window.__dpMiss || 0) + 1
          return
        }
        const el = box.querySelector('[data-m="' + midi + '"]')
        if (!el) {
          window.__dpMiss = (window.__dpMiss || 0) + 1
          return
        }
        window.__dpOk = (window.__dpOk || 0) + 1
        hitAt.current.set(midi, Date.now())
        // 左手蓝、右手绿：按中央 C 分界。
        const side = midi < MIDDLE_C_LOCAL ? 'dp-hit-lh' : 'dp-hit-rh'
        // 动画结束后摘掉 class，让键回到静态的渐变样式（不然会停在动画末帧的纯色上）
        el.onanimationend = () => {
          el.classList.remove('dp-hit', 'dp-hit-lh', 'dp-hit-rh')
        }
        // 去掉类 → 强制 reflow → 再加回来，动画才会重新播放
        el.classList.remove('dp-hit', 'dp-hit-lh', 'dp-hit-rh')
        void el.offsetWidth
        el.classList.add('dp-hit', side)
      }, [])

      // 临时诊断：paint 命中率 + 最近击键数，定位完删掉
      React.useEffect(() => {
        const id = window.setInterval(() => {
          const box = scrollRef.current
          const holder = box && box.parentElement && box.parentElement.parentElement
          const diag = holder && holder.querySelector('[data-dp-diag]')
          if (!diag) return
          const keys = box ? box.querySelectorAll('[data-m]').length : 0
          const now = Date.now()
          let recent = 0
          for (const t of hitAt.current.values()) if (now - t < 900) recent++
          diag.textContent =
            'paint ' + (window.__dpOk || 0) + '/' + (window.__dpMiss || 0)
            + ' · 近 0.9s 击键 ' + recent
            + ' · 键 ' + keys
            + ' · 采样 ' + SAMPLES.size + '/90'
            + ' · 释放 ' + RELEASES.size + '/88'
            + (window.__dpStrikeErr ? ' · 音频错:' + window.__dpStrikeErr : '')
            + (window.__dpSampleErr ? ' · 采样错:' + window.__dpSampleErr : '')
        }, 300)
        return () => window.clearInterval(id)
      }, [])

      const hold = React.useCallback(
        (midi, delayMs) => {
          // 定时器必须登记：一首四五分钟的谱会排出几千个「什么时候点哪个键」，
          // 点「停」的时候如果只清 DOM，这些排队中的回调还会一个个把键点亮
          // （声音已经掐了，键却还在动）—— 所以既要能取消，也要带代数校验。
          const gen = lightGen.current
          const id = window.setTimeout(() => {
            lightTimers.current.delete(id)
            if (gen !== lightGen.current) return
            paint(midi)
          }, Math.max(0, delayMs))
          lightTimers.current.add(id)
        },
        [paint],
      )

      /** 停止/重置时让所有在途的「点灯」失效。 */
      const killLightTimers = React.useCallback(() => {
        lightGen.current += 1
        for (const id of lightTimers.current) window.clearTimeout(id)
        lightTimers.current.clear()
      }, [])

      const clearLights = React.useCallback(() => {
        killLightTimers()
        hitAt.current.clear()
        const box = scrollRef.current
        if (!box) return
        for (const el of box.querySelectorAll('.dp-hit')) {
          el.classList.remove('dp-hit', 'dp-hit-lh', 'dp-hit-rh')
          // 关键帧动画带 fill-mode:both，被打断时会停在末帧，键就一直亮着。
          // 强制清一次 animation，让键立刻回到静态样式。
          el.style.animation = 'none'
          void el.offsetWidth
          el.style.animation = ''
        }
      }, [killLightTimers])

      /**
       * 调度窗口：只把「未来 6 秒内」的音真正排进 AudioContext。
       * 整曲一次塞进去会有几千个振荡器同时挂着，浏览器会卡；
       * 而且那些音本来也取消不干净。其余事件放在 pendingEvents 里，
       * 由 pump 每 1.2 秒推进一次。
       */
      const SCHED_WINDOW_SEC = 6

      /** 把一条事件变成声音 + 灯。 */
      const fireEvent = React.useCallback(
        (e, dueSec) => {
          const ac = AUDIO.ac
          const when = (ac ? ac.currentTime : 0) + Math.max(0.004, dueSec)
          const durSec = Math.max(0.1, (e.d || 400) / 1000)
          dlog(`fire midi=${e.m} due=${dueSec.toFixed(3)} dur=${durSec.toFixed(2)} ac=${ac ? ac.state : 'null'}`)
          if (ac) {
            try {
              strike(e.m, when, durSec, e.v == null ? 0.78 : e.v)
            } catch (err) {
              // 音频出错绝不能连累点灯：记一笔，继续往下走
              window.__dpStrikeErr = String((err && err.message) || err)
            }
          }
          hold(e.m, Math.max(0, dueSec * 1000))
        },
        [hold],
      )

      /** 按当前基准时间把窗口内的事件放出去。 */
      const pump = React.useCallback(() => {
        const list = pendingEvents.current
        if (!list.length) return
        const c = clock.current
        if (!c.serverNow) return
        const nowServer = c.serverNow + (Date.now() - c.at)
        const rest = []
        for (const e of list) {
          const dueSec = (e.t - nowServer) / 1000
          if (dueSec <= SCHED_WINDOW_SEC) fireEvent(e, dueSec)
          else rest.push(e)
        }
        pendingEvents.current = rest
      }, [fireEvent])

      /** 真正的排音逻辑（AudioContext 已经 running 时才会走到这里）。 */
      const scheduleBatch = React.useCallback(
        (events, serverNow, label) => {
          // 新的一批：基准时间刷新，窗口外的事件先攒着
          clock.current = { serverNow, at: Date.now() }
          let tail = 0
          for (const e of events) {
            const dueSec = (e.t - serverNow) / 1000
            if (dueSec <= SCHED_WINDOW_SEC) {
              fireEvent(e, dueSec)
              tail = Math.max(tail, dueSec * 1000 + Math.max(0.1, (e.d || 400)))
            } else {
              pendingEvents.current.push(e)
            }
          }
          // 攒着的那部分也算进总时长，进度灯才准
          for (const e of pendingEvents.current) {
            tail = Math.max(tail, e.t - serverNow + Math.max(0.1, (e.d || 400)))
          }

          setPlaying(true)
          if (label) setNowPlaying(label)
          window.clearTimeout(playingTimer.current)
          playingTimer.current = window.setTimeout(() => {
            setPlaying(false)
            setNowPlaying('')
          }, Math.min(30000, tail + 700))
          // AI 一弹就把面板展开：收起状态下键盘不在 DOM 里，没有键可亮。
          // 之前只在本次会话第一次弹时展开，用户手动收起之后就再也不自动开了。
          if (live.current.autoOpen && !live.current.open) setOpen(true)
        },
        [fireEvent],
      )

      /**
       * AudioContext 被浏览器挂起时，先把整批事件存这儿。
       *
       * 为什么不能直接排：suspended 状态下 ac.currentTime 是不走的。
       * 按「当前时刻 + 延时」算出来的 when 会全部挤在同一个瞬间，
       * 一旦 resume，几百个音同时炸开，比没声音还糟。
       */
      const waiting = React.useRef([])
      const lastLabel = React.useRef('')

      /** 唤醒成功后，把挂起期间攒下的音补上。 */
      const flushWaiting = React.useCallback(() => {
        const ac = AUDIO.ac
        if (!ac || ac.state !== 'running' || !waiting.current.length) return
        const c = clock.current
        const nowServer = c.serverNow ? c.serverNow + (Date.now() - c.at) : 0
        if (!nowServer) return
        // 已经过去太久的音就别补了，补了也是错拍
        const batch = waiting.current.filter((e) => e.t + (e.d || 400) > nowServer)
        waiting.current = []
        setHint(false)
        if (batch.length) scheduleBatch(batch, nowServer, lastLabel.current)
      }, [scheduleBatch])

      const onEvents = React.useCallback(
        (events, serverNow, label) => {
          if (!events.length) return
          const ac = ensureAudio()
          if (label) lastLabel.current = label

          if (!ac || ac.state !== 'running') {
            // 没 running：存起来，并且顺手试一次 resume。
            // 真正成功要靠一次用户手势 —— 那个监听装在下面的 effect 里。
            waiting.current = waiting.current.concat(events)
            clock.current = { serverNow, at: Date.now() }
            setHint(true)
            if (ac) {
              const p = ac.resume()
              if (p && p.then) p.then(() => flushWaiting()).catch(() => {})
            }
            return
          }
          scheduleBatch(events, serverNow, label)
        },
        [scheduleBatch, flushWaiting],
      )

      /**
       * 全局手势唤醒。
       *
       * 浏览器只认「用户手势」这一个开关。旧代码只在点钢琴面板时 resume，
       * 所以插件一重载、AudioContext 一被挂起，就得重新去点那一小块 ——
       * 用起来像每次都坏了。这里挂到 window 上：页面上点任何地方、按任何键，
       * 都能把它叫醒，并且把挂起期间攒的音补回去。
       */
      React.useEffect(() => {
        const kick = () => {
          const ac = AUDIO.ac
          if (!ac) return
          if (ac.state === 'running') {
            if (waiting.current.length) flushWaiting()
            return
          }
          const p = ac.resume()
          if (p && p.then) {
            p.then(() => {
              if (AUDIO.ac && AUDIO.ac.state === 'running') flushWaiting()
            }).catch(() => {})
          }
        }
        window.addEventListener('pointerdown', kick, true)
        window.addEventListener('keydown', kick, true)
        window.addEventListener('touchstart', kick, true)
        return () => {
          window.removeEventListener('pointerdown', kick, true)
          window.removeEventListener('keydown', kick, true)
          window.removeEventListener('touchstart', kick, true)
        }
      }, [flushWaiting])

      // 滑窗推进器
      React.useEffect(() => {
        const id = window.setInterval(() => {
          if (pendingEvents.current.length) pump()
        }, 1200)
        return () => window.clearInterval(id)
      }, [pump])

      React.useEffect(() => {
        let cancelled = false
        // seq / stopTick / primed 必须在 ref 里。
        // 之前它们是这个 effect 的局部变量：onEvents 的依赖一变，effect 就重跑，
        // seq 归零 → 每次都带着 since=0 去取 → 同一个事件被反复取回反复播放，
        // 几秒内叠出几十层同音，听起来就是一片"嗡嗡"。日志里 since=0 一直不变，
        // 就是这个原因。
        let timer = null
        const seqRef = tickRefs.seq
        const stopRef = tickRefs.stopTick
        const primedRef = tickRefs.primed

        const tick = () => {
          if (cancelled) return
          // 独立钢琴窗口开着：本窗口不取事件（不然两边各排一遍，声音重复）。
          // 用慢轮询保持存活，等它关掉再恢复。
          if (pausedRef.current) {
            timer = window.setTimeout(tick, 400)
            return
          }
          fetch(API + '/events?since=' + seqRef.current, { credentials: 'same-origin', cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
            .then((data) => {
              if (cancelled || !data || !data.ok) return
              if (!primedRef.current) {
                primedRef.current = true
                stopRef.current = data.stop || 0
              } else if ((data.stop || 0) !== stopRef.current) {
                stopRef.current = data.stop || 0
                // 三件一起清：正在响的、排队等着点灯的、还没进调度窗口的。
                // 少清任何一样，琴都会在「停」之后接着动。
                cutAll()
                clearLights()
                pendingEvents.current = []
                clock.current = { serverNow: 0, at: 0 }
                setPlaying(false)
                setNowPlaying('')
                // 停止这一轮别再处理事件，否则刚清掉的高亮又被点亮
                return
              }
              // 吸附状态：EXE 开了吸附，插件就在页面顶部让出钢琴的高度。
              // 这是"插件里留空间"，不碰 DSH 窗口尺寸，最大化/全屏都自然生效。
              // 单独 try/catch：留白是装饰，不能让它把下面的排音和轮询带走。
              try {
                syncSnapLayout(!!data.snap, Number(data.snapH) || 190)
              } catch (err) {
                dlog('snap layout failed: ' + ((err && err.message) || err))
              }

              const events = Array.isArray(data.events) ? data.events : []
              if (events.length) {
                for (const e of events) if (e.i > seqRef.current) seqRef.current = e.i
                onEvents(events, data.now, data.label || '')
              }
            })
            .catch((err) => {
              // 以前这里是 .catch(() => {})：轮询里任何一处抛错都被吃得干干净净，
              // 界面上完全看不出「其实是坏了」。现在至少留一条。
              if (err && err.name !== 'AbortError') {
                dlog('poll failed: ' + ((err && err.message) || err))
              }
            })
            .then(() => {
              if (!cancelled) timer = window.setTimeout(tick, 140)
            })
        }

        const onVisible = () => {
          if (document.visibilityState !== 'visible') return
          window.clearTimeout(timer)
          tick()
        }

        tick()
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          cancelled = true
          window.clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [onEvents, clearLights])

      React.useEffect(
        () => () => {
          window.clearTimeout(playingTimer.current)
          for (const id of lightTimers.current) window.clearTimeout(id)
          lightTimers.current.clear()
          lightGen.current += 1
          pendingEvents.current = []
          hitAt.current.clear()
          held.current.clear()
        },
        [],
      )

      React.useEffect(() => {
        if (!open) return
        const box = scrollRef.current
        if (!box) return
        const first = box.querySelector('[data-m="' + MIDI_MIN + '"]')
        const middle = box.querySelector('[data-m="60"]')
        if (!first || !middle) return
        box.scrollLeft = Math.max(0, middle.offsetLeft - first.offsetLeft - box.clientWidth * 0.26)
      }, [open])

      const press = React.useCallback(
        (midi) => {
          const ac = ensureAudio()
          if (!ac) {
            setHint(true)
            return
          }
          if (ac.state !== 'running') setHint(true)
          const old = held.current.get(midi)
          if (old) old.release()
          const voice = strike(midi, ac.currentTime + 0.004, 2.2, 0.78)
          if (voice) held.current.set(midi, voice)
          hold(midi, 0)
        },
        [hold],
      )

      const release = React.useCallback((midi) => {
        const voice = held.current.get(midi)
        if (!voice) return
        voice.release()
        held.current.delete(midi)
      }, [])

      React.useEffect(() => {
        if (!open) return
        const base = (octave + 1) * 12
        const onDown = (ev) => {
          if (ev.metaKey || ev.ctrlKey || ev.altKey) return
          const el = ev.target
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
          const k = String(ev.key || '').toLowerCase()
          if (k === 'z') {
            setOctave((o) => Math.max(1, o - 1))
            return
          }
          if (k === 'x') {
            setOctave((o) => Math.min(7, o + 1))
            return
          }
          const offset = KEYMAP[k]
          if (offset === undefined || ev.repeat) return
          const midi = base + offset
          if (midi < MIDI_MIN || midi > MIDI_MAX) return
          ev.preventDefault()
          press(midi)
        }
        const onUp = (ev) => {
          const offset = KEYMAP[String(ev.key || '').toLowerCase()]
          if (offset === undefined) return
          release(base + offset)
        }
        window.addEventListener('keydown', onDown)
        window.addEventListener('keyup', onUp)
        return () => {
          window.removeEventListener('keydown', onDown)
          window.removeEventListener('keyup', onUp)
        }
      }, [open, octave, press, release])

      const playMelody = (id, title) => {
        const ac = ensureAudio()
        if (ac && ac.state === 'suspended') ac.resume().catch(() => {})
        setNowPlaying(title)
        fetch(API + '/play', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        }).catch(() => {})
      }

      const stopAll = () => {
        cutAll()
        clearLights()
        pendingEvents.current = []
        clock.current = { serverNow: 0, at: 0 }
        setPlaying(false)
        setNowPlaying('')
        fetch(API + '/stop', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
      }

      const cardClick = () => {
        if (!hint) return
        const ac = ensureAudio()
        if (ac) {
          const p = ac.resume()
          if (p && p.catch) p.catch(() => {})
          if (ac.state === 'running') setHint(false)
          else window.setTimeout(() => setHint(ac.state !== 'running'), 240)
        }
      }

      const style = h('style', { key: 'dp-css' }, CSS)

      // 收起时不渲染任何东西 —— 入口胶囊已经在右上角工具栏里了，
      // 这里再画一个就是两个按钮。样式还要留着（胶囊靠它）。
      if (!open) return h(React.Fragment, null, style)

      const melodies = (info && info.melodies) || []

      return h(
        React.Fragment,
        null,
        style,
        h(
          'div',
          { 'data-dp-root': '' },
          h(
            'div',
            { 'data-dp-card': '', onClick: cardClick },
            h(
              'div',
              { 'data-dp-head': '' },
              h('span', { 'data-dp-title': '' }, '♪'),
              h('span', { 'data-dp-sub': '' }, playing
                ? (nowPlaying || '正在演奏')
                : (ready < 90 ? '加载 ' + ready + '/90' : '钢琴')),
              h('span', { 'data-dp-grow': '' }),
              hint ? h('span', { 'data-dp-hint': '' }, '点一下开声音') : null,
              h(
                'label',
                { 'data-dp-vol': '' },
                h('input', {
                  type: 'range',
                  min: 0,
                  max: 100,
                  value: Math.round(volume * 100),
                  onChange: (e) => setVolume(Math.max(0, Math.min(1, Number(e.target.value) / 100))),
                }),
              ),
              h(
                'label',
                { 'data-dp-vol': '', title: 'AI 弹的时候自动把这个面板展开' },
                h('input', {
                  type: 'checkbox',
                  checked: autoOpen,
                  onChange: (e) => setAutoOpen(e.target.checked),
                }),
                '自动展开',
              ),
              h('button', { 'data-dp-btn': '', type: 'button', onClick: stopAll }, '停'),
              h('button', {
                'data-dp-btn': '',
                type: 'button',
                title: IS_POPUP ? '关掉这个窗口' : '收起到工具栏',
                onClick: () => {
                  if (IS_POPUP) {
                    try {
                      window.close()
                    } catch {
                      setOpen(false)
                    }
                  } else {
                    setOpen(false)
                  }
                },
              }, '×'),
            ),
            h(
              'div',
              { 'data-dp-scroll': '', ref: scrollRef },
              h(
                'div',
                { 'data-dp-board': '' },
                h(
                  'div',
                  { 'data-dp-whites': '' },
                  KEYS.filter((k) => !k.black).map((k) =>
                    h(
                      'div',
                      {
                        key: k.midi,
                        'data-m': k.midi,
                        'data-dp-white': '',
                        title: keyName(k.midi),
                        onPointerDown: (e) => {
                          e.preventDefault()
                          press(k.midi)
                        },
                        onPointerUp: () => release(k.midi),
                        onPointerLeave: () => release(k.midi),
                        onPointerCancel: () => release(k.midi),
                      },
                      k.octaveC ? keyName(k.midi) : null,
                    ),
                  ),
                ),
                KEYS.filter((k) => k.black).map((k) =>
                  h('div', {
                    key: k.midi,
                    'data-m': k.midi,
                    'data-dp-black': '',
                    title: keyName(k.midi),
                    style: { left: (k.left - 0.31) * WHITE_W + '%', width: BLACK_W + '%' },
                    onPointerDown: (e) => {
                      e.preventDefault()
                      press(k.midi)
                    },
                    onPointerUp: () => release(k.midi),
                    onPointerLeave: () => release(k.midi),
                    onPointerCancel: () => release(k.midi),
                  }),
                ),
              ),
            ),
            h(
              'div',
              { 'data-dp-foot': '' },
              melodies.map((m) =>
                h(
                  'button',
                  { key: m.id, 'data-dp-chip': '', type: 'button', onClick: () => playMelody(m.id, m.title) },
                  m.title,
                ),
              ),
              h('span', { 'data-dp-sep': '' }),
              h('span', null, '电脑键盘 A–J 一个八度，Z / X 换八度 · 当前 C' + octave),
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式注入到 head 一次。胶囊挂在工具栏、面板挂在 overlay，
        // 是两个渲染点 —— 谁先挂载都不该决定 CSS 在不在。
        if (typeof document !== 'undefined' && !document.getElementById('dsh-piano-xz-css')) {
          const el = document.createElement('style')
          el.id = 'dsh-piano-xz-css'
          el.textContent = CSS
          document.head.appendChild(el)
        }
        // 热更新会重建模块：AudioContext 还在、采样可能只加载了一半。
        // 这里补一刀，缺多少补多少，不用用户去刷新页面。
        if (!window.__dshPianoPreloading && AUDIO.ac && SAMPLES.size < 90) {
          window.__dshPianoPreloading = true
          preloadSamples(AUDIO.ac)
            .catch(() => {})
            .finally(() => {
              window.__dshPianoPreloading = false
            })
        }

        ctx.effect(() => {
          const wake = () => {
            const ac = ensureAudio()
            if (ac && ac.state === 'suspended') {
              const p = ac.resume()
              if (p && p.catch) p.catch(() => {})
            }
          }
          document.addEventListener('pointerdown', wake, { capture: true, passive: true })
          document.addEventListener('keydown', wake, { capture: true })
          return () => {
            document.removeEventListener('pointerdown', wake, { capture: true })
            document.removeEventListener('keydown', wake, { capture: true })
            cutAll()
          }
        }, 'dsh-piano-xz: 音频唤醒')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        // 独立窗口：整页只留钢琴，并且默认展开。
        if (IS_POPUP) {
          document.documentElement.setAttribute('data-dp-popup', '1')
          UI.set({ open: true })
          slots.inject('shell.overlay', () =>
            slots.register({ name: 'shell.overlay', id: 'dsh-piano-xz', order: 40 }, Panel),
          )
          return
        }

        // 入口：会话标题栏右上角那排工具（SSH 徽章旁边），跟原生控件同一行。
        slots.inject('conversation.session.header.utilities', () =>
          slots.register(
            { name: 'conversation.session.header.utilities', id: 'dsh-piano-xz-pill', order: 8, label: '钢琴' },
            PianoPill,
          ),
        )
        // 键盘本体：仍然走 shell.overlay（要一大块横向空间），但只是"展开时才出现"。
        slots.inject('shell.overlay', () =>
          slots.register({ name: 'shell.overlay', id: 'dsh-piano-xz', order: 40 }, Panel),
        )
      },
    }
  },
})
