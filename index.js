/**
 * dsh-piano-xz —— 璇泽 · DSH 电脑钢琴（宿主半侧）
 *
 * 设计前提：一首歌 = 一份乐谱文本。
 *   AI 写好谱（简谱 / 音名都行），插件把谱解析成绝对时间轴，浏览器照着弹。
 *
 * 三块东西：
 *   1. 乐谱引擎（lib/notation.js）：简谱文本 → 每个音在何时、多长、多响
 *   2. 工具：piano_score（写谱/读谱播放）、piano_play（当场弹一段）、
 *            piano_piece（内置曲）、piano_stop、piano_status
 *   3. /api/dsh-piano-xz/*：浏览器半侧来取时间轴、点曲子、看状态
 *
 * 宿主不发声（服务端没扬声器），它只排「第几毫秒该响哪个键多大声」，
 * 声音由浏览器用 WebAudio 现场合成为钢琴音色。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, appendFileSync } from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KEY_COUNT, MIDDLE_C, MIDI_MAX, MIDI_MIN, NoteError, noteName, rangeText } from './lib/notes.js'
import {
  MELODIES,
  clampTempo,
  findMelody,
  melodyCatalog,
  parseScore,
  summarizeNotes,
  toTimeline,
} from './lib/score.js'
import { createEngine } from './lib/engine.js'
import { describeMidi, midiToTimeline, parseMidi } from './lib/midi.js'

export const name = 'dsh-piano-xz'

const VERSION = '2.1.0'
const ROUTE = '/api/dsh-piano-xz'

/** 一次最多排多少音，防超长谱把队列撑爆。 */
const MAX_NOTES_PER_CALL = 20000
/** 谱文件上限。 */
const MAX_SCORE_BYTES = 1_000_000
/** MIDI 文件上限（一般三四分钟的曲子几百 KB）。 */
const MAX_MIDI_BYTES = 16_000_000

/** 钢琴采样目录（Salamander Grand Piano V3，CC BY 3.0，每 3 个半音一个）。 */
const PKG_ROOT = dirname(fileURLToPath(import.meta.url))
const SAMPLE_DIR = join(PKG_ROOT, 'assets', 'piano')
/** 采样文件读一次就留在内存里，本地 300KB 一个，30 个也就 5MB。 */
const sampleCache = new Map()

/** 诊断计数（/events 被轮询了多少次）。 */
const probe = { ticks: 0 }
/**
 * 每个客户端的已发游标（key = User-Agent 前缀）。
 * 用来兜住"浏览器传 since=0 反复要同一批事件"那个 bug。
 */
const cursors = new Map()
const LOG_FILE = join(PKG_ROOT, 'record', 'piano.log')

/**
 * 写诊断日志。宿主侧自己的日志，用来反推浏览器那半边有没有活着。
 * 任何异常都吞掉 —— 日志坏了不能影响演奏。
 */
function probeLog(line) {
  try {
    const dir = join(PKG_ROOT, 'record')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(LOG_FILE, new Date().toISOString().slice(11, 23) + ' ' + line + '\n', 'utf8')
  } catch {
    /* 忽略 */
  }
}

const SCORE_FORMAT = `乐谱写法（照纸上简谱抄就行）：

  tempo 100           每分钟拍数
  key 1=B3            数字 1 对应哪个键（省略八度就取 C4 附近那个）
  unit 0.5            每个记号默认占几拍（八分音符写 0.5）
  dyn 0.75            默认力度 0–1

  [RH]                右手
  3 2 6' 2' | 3 2 6' 2'

  [LH]                左手
  4, 1, 4, 5, 6, r | 5, 2, 5, 6, 7, r

记号：1–7 级数（可带 # / b）；' 升八度、, 降八度（可叠）；
     :n 占 n 拍；@v 单独给力度；+ 同时按；- 延长一拍；r 或 0 休止。
也认音名（C4 / Db4 / A#3），两种可以混着写。`

const SCORE_DESCRIPTION = `把一份乐谱文本变成一首歌。

两种用法：
1. 只给 path：读这个谱文件并演奏。
2. 给 path + text：把 text 写成谱文件，然后演奏（谱就存下来了，下次只给 path 就行）。

${SCORE_FORMAT}

演奏是排给浏览器的那台钢琴的：面板没开也会出声，打开右下角键盘能看到琴键按下去。`

const PLAY_DESCRIPTION = `当场弹一段，不落盘。参数和 piano_score 的 text 完全一样（简谱 / 音名都行）。
谱要留档、要反复弹，用 piano_score 写成文件。

${SCORE_FORMAT}

例：「3 2 6' 2'」四个八分音符（配合 unit 0.5）；「1+3+5」一个和弦；
「3:2 5 - -」三拍长音接延长。`

const PIECE_DESCRIPTION = `用内置曲子弹一首（小星星、两只老虎、欢乐颂、生日快乐、致爱丽丝、铃儿响叮当、卡农和弦、茉莉花）。
name 可以是标题、id 或别名，也可以只给关键词。自己编谱用 piano_score / piano_play。`

const STOP_DESCRIPTION = '让钢琴立刻静音：清空还没弹的音符，掐掉正在响的音。'

const MIDI_DESCRIPTION = `直接弹一份标准 MIDI 文件（.mid / .midi）—— 首选方式。

为什么优先用 MIDI：MIDI 里每个音有自己的开始时刻、时长、力度，
是精确数据；乐谱文本（简谱 / .score）本质是单声部时间轴，一个音的长度会被
下一个音截断，写不出「长音拖着、另一只手同时在跑」的真复调，抄谱也容易错。
只要手上有 .mid，就优先 piano_midi，不要手抄简谱。

支持 format 0/1、running status、tempo map（整首变速会按真实时间还原）。

参数：
  path         .mid 文件路径（必填）
  list         true = 只报告结构（轨、音数、音域、时长），不弹
  tempoScale   1 = 原速；0.5 = 半速；1.5 = 快一半
  transpose    整体移调（半音）
  minVelocity  力度下限 0–1，默认 0.2
  tracks       只弹指定轨（序号数组，从 0 开始）`

const STATUS_DESCRIPTION = '看钢琴当前状态：队列、下一个音、上一次弹的是什么、键盘范围。'

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ leadMs?: number, maxVoices?: number }} [config]
 */
let popupOpen = false
let snapOn = false
let snapH = 190

export function apply(ctx, config = {}) {
  const engine = createEngine({ leadMs: config?.leadMs, maxVoices: config?.maxVoices })

  /**
   * 解析一段谱文本并排队，回执文字由调用方补。
   * @param {string} text
   * @param {{ tempo?: number, label?: string, gap?: number }} [options]
   */
  function playText(text, options = {}) {
    const parsed = parseScore(text, { tempo: options.tempo })
    if (parsed.notes.length > MAX_NOTES_PER_CALL) {
      throw new NoteError(`一次最多 ${MAX_NOTES_PER_CALL} 个音（这份有 ${parsed.notes.length} 个），拆成几段。`)
    }
    const timeline = toTimeline(parsed, { tempo: parsed.tempo, gapRatio: clampGap(options.gap) })
    const result = engine.schedule(timeline, { label: options.label ?? '乐谱', tempo: parsed.tempo })
    return { parsed, timeline, result }
  }

  ctx.inject(['tools'], (c) => {
    c.tools.register({
      name: 'piano_score',
      description: SCORE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '谱文件路径（.score / .txt / .jianpu 都行）。给 text 时是写入目标，只给 path 时是读取来源。',
          },
          text: { type: 'string', description: '完整乐谱文本；给了就写进 path 再演奏。' },
          tempo: { type: 'number', description: '覆盖谱里的 tempo（30–280）。不填就按谱上写的。' },
          save: { type: 'boolean', description: '写了 text 但只想存不想弹时，传 true。' },
        },
        required: ['path'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'text'],
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      execute: async (args) => {
        try {
          const target = resolveTarget(args?.path)
          let source = ''

          if (typeof args?.text === 'string' && args.text.trim()) {
            if (byteLength(args.text) > MAX_SCORE_BYTES) {
              return { ok: false, text: `谱太大了（上限 ${MAX_SCORE_BYTES} 字节）。` }
            }
            mkdirSync(dirname(target), { recursive: true })
            writeFileSync(target, args.text, 'utf8')
            source = args.text
          } else {
            if (!existsSync(target)) return { ok: false, text: `找不到谱文件：${target}` }
            const size = statSync(target).size
            if (size > MAX_SCORE_BYTES) return { ok: false, text: `谱文件太大（${size} 字节，上限 ${MAX_SCORE_BYTES}）。` }
            source = readFileSync(target, 'utf8')
          }

          const head = typeof args?.text === 'string' && args.text.trim() ? `已写入 ${target}` : `读入 ${target}`
          if (args?.save) {
            const parsed = parseScore(source, { tempo: args?.tempo })
            return { ok: true, text: `${head}\n${describeScore(parsed)}` }
          }

          const { parsed, timeline, result } = playText(source, { tempo: args?.tempo, label: basename(target) })
          const warn = parsed.warnings.length ? `\n提示：${parsed.warnings.slice(0, 5).join('；')}` : ''
          return {
            ok: true,
            text:
              `${head}\n${describeScore(parsed)}`
              + `\n演奏：${(result.spanMs / 1000).toFixed(1)} 秒，${parsed.tempo} BPM\n`
              + `开头：${summarizeNotes(timeline, 14)}${warn}`,
          }
        } catch (error) {
          return { ok: false, text: describeError(error) }
        }
      },
    })

    c.tools.register({
      name: 'piano_midi',
      description: MIDI_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'MIDI 文件路径（.mid / .midi）。' },
          list: { type: 'boolean', description: 'true = 只报告这份 MIDI 的结构（轨、音数、音域、时长），不弹。' },
          tempoScale: { type: 'number', description: '速度倍率：1 = 原速，0.5 = 半速，1.5 = 快一半。默认 1。' },
          transpose: { type: 'number', description: '整体移调（半音），默认 0。' },
          minVelocity: { type: 'number', description: '力度下限 0–1，默认 0.2（太轻的音抬到这儿，免得听不见）。' },
          tracks: { type: 'array', items: { type: 'number' }, description: '只弹这几条轨（按序号，从 0 开始）。不填就全弹。' },
        },
        required: ['path'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'text'],
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      execute: async (args) => {
        try {
          const target = resolveTarget(args?.path)
          if (!existsSync(target)) return { ok: false, text: `找不到 MIDI 文件：${target}` }
          const size = statSync(target).size
          if (size > MAX_MIDI_BYTES) {
            return { ok: false, text: `MIDI 太大了（${size} 字节，上限 ${MAX_MIDI_BYTES}）。` }
          }

          const midi = parseMidi(readFileSync(target))
          const head = `读入 ${target}\n${describeMidi(midi)}`

          const trackLines = midi.tracks.map((t, i) => {
            if (!t.notes.length) return null
            const ps = t.notes.map((n) => n.pitch)
            return `  [${i}] ${t.name || '(无名)'} — ${t.notes.length} 音 · ${noteName(Math.min(...ps))}–${noteName(Math.max(...ps))}`
          }).filter(Boolean)
          const tracksText = trackLines.length ? `\n轨道：\n${trackLines.join('\n')}` : ''

          if (args?.list) return { ok: true, text: head + tracksText }

          const { timeline, seconds, dropped, clipped } = midiToTimeline(midi, {
            tempoScale: args?.tempoScale,
            transpose: args?.transpose,
            minVelocity: args?.minVelocity,
            trackFilter: Array.isArray(args?.tracks) ? args.tracks.map(Number) : null,
          })

          if (!timeline.length) return { ok: false, text: `${head}\n没有可以弹的音（可能全被音域裁掉了）。` }
          if (timeline.length > MAX_NOTES_PER_CALL) {
            return {
              ok: false,
              text: `${head}\n这次要弹 ${timeline.length} 个音，超过单次上限 ${MAX_NOTES_PER_CALL}。用 tracks 只挑几轨。`,
            }
          }

          const bpm = midi.tempoMap && midi.tempoMap.length
            ? Math.round(60_000_000 / midi.tempoMap[0].usPerQuarter)
            : null
          const score = {
            topic: 'midi',
            file: basename(target),
            bpm,
            bpmList: (midi.tempoMap || []).map((t) => Math.round(60_000_000 / t.usPerQuarter)),
            key: midi.keySignature || null,
            timeSig: midi.timeSignature || null,
            transpose: Number(args?.transpose) || 0,
          }
          // 排新曲之前必须清空队列：上一次弹奏的未来音还挂在里面，
          // 叠在一起就"挤在同一时间段全响"，听感正是"播放特别快"。
          engine.stop()
          const result = engine.schedule(timeline, { label: basename(target), tempo: null, score })
          const notes = timeline.slice(0, 14).map((n) => noteName(n.midi)).join(' ')
          const extra = [
            dropped ? `跳过 ${dropped} 个越界音` : '',
            clipped ? `${clipped} 个音移了八度回到键盘上` : '',
          ].filter(Boolean).join('；')

          return {
            ok: true,
            text:
              `${head}${tracksText}\n`
              + `演奏：${(result.spanMs / 1000).toFixed(1)} 秒，${timeline.length} 个音（MIDI 原始时长 ${seconds.toFixed(1)} 秒）\n`
              + `开头：${notes}${extra ? '\n提示：' + extra : ''}`,
          }
        } catch (error) {
          return { ok: false, text: describeError(error) }
        }
      },
    })

    c.tools.register({
      name: 'piano_play',
      description: PLAY_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          score: { type: 'string', description: '乐谱文本（简谱或音名）。' },
          tempo: { type: 'number', description: '覆盖谱里的 tempo（30–280），默认 100。' },
          velocity: { type: 'number', description: '整体力度 0–1，默认 0.78。' },
          gap: { type: 'number', description: '每个音实际按住的比例 0.3–1，默认 0.96。' },
        },
        required: ['score'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'text'],
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      execute: async (args) => {
        try {
          const { parsed, timeline, result } = playText(String(args?.score ?? ''), {
            tempo: args?.tempo,
            velocity: args?.velocity,
            gap: args?.gap,
            label: '即兴',
          })
          const warn = parsed.warnings.length ? `\n提示：${parsed.warnings.slice(0, 5).join('；')}` : ''
          return {
            ok: true,
            text:
              `弹 ${timeline.length} 个音，${parsed.tempo} BPM，约 ${(result.spanMs / 1000).toFixed(1)} 秒。`
              + `\n音符：${summarizeNotes(timeline, 14)}${warn}`,
          }
        } catch (error) {
          return { ok: false, text: describeError(error) }
        }
      },
    })

    c.tools.register({
      name: 'piano_piece',
      description: PIECE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '曲名、id、别名或关键词。list 为 true 时可不填。' },
          tempo: { type: 'number', description: '覆盖拍速（30–280）。' },
          list: { type: 'boolean', description: 'true = 只列出曲目。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'text'],
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      execute: async (args) => {
        if (args?.list) {
          const lines = MELODIES.map((m) => `· ${m.title}（${m.id}，${m.tempo} BPM）`).join('\n')
          return { ok: true, text: `内置 ${MELODIES.length} 首：\n${lines}` }
        }
        try {
          const query = String(args?.name ?? '').trim()
          if (!query) return { ok: false, text: '要给一个曲名（list: true 可以看清单）。' }
          const melody = findMelody(query)
          if (!melody) {
            return { ok: false, text: `没找到「${query}」。内置的有：${MELODIES.map((m) => m.title).join('、')}。` }
          }
          const { parsed, timeline, result } = playText(melody.score, {
            tempo: args?.tempo ?? melody.tempo,
            label: melody.title,
          })
          return {
            ok: true,
            text:
              `《${melody.title}》${timeline.length} 个音，${parsed.tempo} BPM，约 ${(result.spanMs / 1000).toFixed(1)} 秒。`
              + `\n开头：${summarizeNotes(timeline, 12)}`,
          }
        } catch (error) {
          return { ok: false, text: describeError(error) }
        }
      },
    })

    c.tools.register({
      name: 'piano_stop',
      description: STOP_DESCRIPTION,
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'text'],
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      execute: async () => {
        const before = engine.status().queued
        engine.stop()
        return { ok: true, text: before > 0 ? `停了，清掉 ${before} 个还没响的音。` : '已经停了。' }
      },
    })

    c.tools.register({
      name: 'piano_status',
      description: STATUS_DESCRIPTION,
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'text'],
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      execute: async () => {
        const st = engine.status()
        return {
          ok: true,
          text: [
            `键盘：${rangeText()}`,
            `队列：${st.queued} 个音待响${st.queued ? `，下一个 ${st.nextInMs} ms 后` : ''}`,
            st.last
              ? `上一条：${st.last.label || '乐谱'}${st.last.tempo ? `，${st.last.tempo} BPM` : ''}，${st.last.count} 个音，${(st.last.agoMs / 1000).toFixed(1)} 秒前`
              : '上一条：还没弹过',
            `提前量：${st.leadMs} ms`,
          ].join('\n'),
        }
      },
    })
  })

  ctx.inject(['webServer'], (c) => {
    const server = c.webServer || (typeof c.get === 'function' ? c.get('webServer') : undefined)
    if (!server || typeof server.register !== 'function') return

    ctx.effect(
      () =>
        server.register({
          kind: 'prefix',
          path: ROUTE,
          handler: (req, res) => {
            let origin = ''
            try {
              origin = typeof server.getOrigin === 'function' ? server.getOrigin() : ''
            } catch {
              /* 拿不到就退回相对路径 */
            }
            handle(req, res, engine, playText, origin).catch((error) => {
              try {
                sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
              } catch {
                /* 响应已经走了 */
              }
            })
          },
        }),
      'dsh-piano-xz: /api/dsh-piano-xz',
    )
  })
}

/**
 * 一句话交代这份谱：多少音、多长、几个声部。
 * @param {ReturnType<typeof parseScore>} parsed
 */
function describeScore(parsed) {
  const bars = Math.ceil(parsed.beats / 4)
  return `调 ${parsed.key}，${parsed.tempo} BPM，${parsed.voices.join('+')} ${parsed.voices.length > 1 ? '双' : '单'}声部，`
    + `${parsed.notes.length} 个音，${parsed.beats.toFixed(1)} 拍（约 ${bars} 小节）`
}

/**
 * 文件路径收口：相对路径按当前工作目录解析。
 * @param {unknown} raw
 * @returns {string}
 */
function resolveTarget(raw) {
  const p = String(raw ?? '').trim()
  if (!p) throw new NoteError('要给一个谱文件路径。')
  if (p.includes('\0')) throw new NoteError('路径不合法。')
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

/**
 * 取文件名当标签。
 * @param {string} p
 */
function basename(p) {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/**
 * 字节数（中文按 UTF-8 算）。
 * @param {string} s
 */
function byteLength(s) {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * HTTP 处理。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {ReturnType<typeof createEngine>} engine
 * @param {(text: string, options?: object) => any} playText
 */
async function handle(req, res, engine, playText, origin) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname.replace(/^\/api\/dsh-piano-xz/, '') || '/'
  const method = req.method ?? 'GET'

  if (method === 'GET' && (path === '/' || path === '/info')) {
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      // 独立窗口要用绝对 HTTP 地址：主页面跑在 dsh-app:// 里，
      // 相对路径拼出来的 URL 在那个协议下打不开。
      origin: origin || '',
      popup: origin ? origin + ROUTE + '/popup' : '',
      range: { low: noteName(MIDI_MIN), high: noteName(MIDI_MAX), keys: KEY_COUNT, middleC: noteName(MIDDLE_C) },
      samples: {
        dir: SAMPLE_DIR,
        count: existsSync(SAMPLE_DIR)
          ? readdirSync(SAMPLE_DIR).filter((f) => f.endsWith('.mp3')).length
          : 0,
        layers: ['v1', 'v5', 'v16'],
        release: true,
      },
      melodies: melodyCatalog(),
      status: engine.status(),
    })
  }

  if (method === 'GET' && path === '/popup') {
    // 独立钢琴窗口用的最小页面。不加载 DSH 本体：
    // ① dsh-app:// 协议在 window.open 出来的窗口里不可靠；
    // ② 再启动一个 DSH 实例会跟主窗口抢 Session。
    // 这里只要键盘 + 采样 + 轮询，够用且互不干扰。
    return sendHtml(res, renderPopupPage())
  }

  if (method === 'POST' && path === '/popup/open') {
    // 由宿主开独立窗口，不走 window.open（Electron 壳会 deny）。
    // 首选原生 exe：双缓冲是原生的、启动是一瞬间、单例用 Mutex 管、吸附在它自己代码里。
    // 没有 exe 才退回 Chrome --app 那条路。
    if (process.platform !== 'win32') {
      return sendJson(res, 200, { ok: false, error: '独立窗口目前只支持 Windows' })
    }
    if (!origin) return sendJson(res, 200, { ok: false, error: '拿不到本机 origin' })
    const api = origin + ROUTE
    const exe = join(PKG_ROOT, 'tools', 'PianoWindow.exe')
    if (existsSync(exe)) {
      try {
        // 高度要和手动启动时一致。原来写死 300，手动启动用 190，
        // 同一个 exe 出来两个尺寸，看着像"调用了别的程序"。
        popupOpen = true
        spawn(exe, ['--api', api, '--height', '190'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        }).unref()
        return sendJson(res, 200, { ok: true, engine: 'native' })
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
      }
    }
    const script = join(PKG_ROOT, 'tools', 'popup-open.ps1')
    if (!existsSync(script)) {
      return sendJson(res, 200, { ok: false, error: '既没有 PianoWindow.exe 也没有 popup-open.ps1' })
    }
    const profile = join(PKG_ROOT, 'record', '_chrome-popup-profile')
    try {
      const out = spawnSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
          '-Url', api + '/popup', '-Height', '300', '-ProfileDir', profile],
        { encoding: 'utf8', timeout: 15000, windowsHide: true },
      )
      const text = String(out.stdout || '').trim()
      const line = text.split(/\r?\n/).filter(Boolean).pop() || ''
      try {
        return sendJson(res, 200, Object.assign({ engine: 'chrome' }, JSON.parse(line)))
      } catch {
        return sendJson(res, 200, { ok: false, error: '启动脚本没有返回结果', raw: text.slice(0, 300) })
      }
    } catch (error) {
      return sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
    }
  }

  // 吸附状态：EXE 开启吸附时置 true，插件据此给页面留出钢琴的高度。
  // 钢琴窗口是否开着（client 用它决定胶囊按钮是"打开"还是"关闭"）
  if (method === 'GET' && path === '/popup/state') {
    writeJson(res, 200, { ok: true, open: popupOpen })
    return
  }

  // 关掉钢琴窗口：胶囊按钮第二次点就走这里
  if (method === 'POST' && path === '/popup/close') {
    let killed = 0
    try {
      if (process.platform === 'win32') {
        const r = spawnSync('taskkill', ['/IM', 'PianoWindow.exe', '/F'], { windowsHide: true })
        killed = r.status === 0 ? 1 : 0
      }
    } catch {}
    popupOpen = false
    writeJson(res, 200, { ok: true, killed })
    return
  }

  if (method === 'POST' && path === '/snap') {
    const q = url.searchParams
    snapOn = q.get('on') === '1' || q.get('on') === 'true'
    const h = Number(q.get('h')) || 190
    snapH = Math.max(60, Math.min(400, h))
    writeJson(res, 200, { ok: true, snap: snapOn, height: snapH })
    return
  }

  if (method === 'GET' && path === '/events') {
    const since = Number(url.searchParams.get('since') ?? '0')

    /**
     * 游标兜底。
     *
     * 浏览器那半边有个版本把 seq 放在 useEffect 的局部变量里，effect 一重跑就归零，
     * 于是每秒八次带着 since=0 来要"所有事件"，同一个音被反复播放几十层 ——
     * 听感就是一片嗡嗡。那个 bug 在 client 里，但 client bundle 没跟着更新，
     * 所以在这里按客户端分桶记游标：它传 0 也没用，我们只给没发过的。
     *
     * 分桶用 User-Agent 前 40 字符：网页端是 Chrome，独立窗口是 .NET WebClient，
     * 两者互不抢事件。
     */
    const ua = String(req.headers['user-agent'] || 'unknown').slice(0, 40)
    const remembered = cursors.get(ua) || 0
    const useSince = Math.max(since, remembered)
    const snapshot = engine.drain(useSince)
    cursors.set(ua, snapshot.seq)

    probe.ticks++
    if (probe.ticks === 1 || snapshot.events.length) {
      probeLog(`events since=${since} used=${useSince} seq=${snapshot.seq} got=${snapshot.events.length} ua=${ua.slice(0, 18)}`)
    }
    return sendJson(res, 200, { ok: true, ...snapshot })
  }

  // 采样音频：浏览器那边 fetch 一次 decodeAudioData 就常驻
  if (method === 'GET' && path.startsWith('/sample/')) {
    const name = decodeURIComponent(path.slice('/sample/'.length))
    // 采样文件名是纯数字：MIDI 号 + 力度层，例如 63v5.mp3。
    // 之前用音名（D#4v5.mp3），# 在 URL 里会被当锚点截断，带升号的采样全部 404 —— 
    // 右手一半的音因此静音。改名之后 URL 里不再有需要转义的字符。
    if (!/^(?:\d+v\d+|rel\d+)\.mp3$/.test(name)) {
      return sendJson(res, 400, { ok: false, error: '采样名不合法' })
    }
    let body = sampleCache.get(name)
    if (!body) {
      const file = join(SAMPLE_DIR, name)
      if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: '没有这个采样' })
      body = readFileSync(file)
      sampleCache.set(name, body)
    }
    res.statusCode = 200
    res.setHeader('content-type', 'audio/mpeg')
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    res.setHeader('content-length', String(body.length))
    res.end(body)
    return
  }

  if (method === 'POST' && path === '/play') {
    const body = await readBody(req)
    const melody = findMelody(String(body?.id ?? body?.name ?? ''))
    if (!melody) return sendJson(res, 404, { ok: false, error: '没有这首曲子' })
    const { result } = playText(melody.score, { tempo: body?.tempo ?? melody.tempo, label: melody.title })
    return sendJson(res, 200, { ok: true, title: melody.title, count: result.count, spanMs: result.spanMs })
  }

  if (method === 'POST' && path === '/log') {
    // 浏览器那半边的诊断出口。面板上的 console 我们看不见，
    // 只能让它把关键判断写回来，落到 record/piano.log 里。
    const body = await readBody(req)
    probeLog('[client] ' + String(body || '').slice(0, 400))
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'POST' && path === '/stop') {
    engine.stop()
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'POST' && path === '/note') {
    // 手动点键：独立窗口点一下就把这个音塞进队列，
    // 浏览器下一次轮询就会用真实采样发声 —— 声音只有一处，
    // 窗口自己不用碰音频，也就不会两边重奏。
    const body = await readBody(req)
    let m = NaN
    let v = 0.8
    try {
      const j = JSON.parse(body || '{}')
      m = Number(j.m)
      if (Number.isFinite(Number(j.v))) v = Number(j.v)
    } catch {
      const q = url.searchParams
      m = Number(q.get('m'))
      if (q.get('v')) v = Number(q.get('v'))
    }
    const r = engine.playNow(m, v, 460)
    return sendJson(res, 200, { ok: r.count > 0 })
  }

  return sendJson(res, 404, { ok: false, error: `unknown ${method} ${path}` })
}

/**
 * 回 JSON。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * 独立钢琴窗口的页面。
 *
 * 特意写成自包含的一页：不 import、不依赖 DSH 的模块加载器。
 * 它只做四件事 —— 画 88 键、加载采样、轮询 /events、按时间点响。
 * window.open 出来的窗口里跑不了 dsh-app:// 那一套，所以这些得自带。
 */
function renderPopupPage() {
  const api = ROUTE
  const p = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>DSH 钢琴</title><style>',
    'html,body{margin:0;height:100%;background:#0b1017;overflow:hidden;',
    'font:12px/1.4 system-ui,"Segoe UI",sans-serif;color:#c9d1dc;user-select:none;}',
    '#bar{display:flex;align-items:center;gap:10px;height:34px;padding:0 12px;',
    'background:#0d1219;border-bottom:1px solid rgba(255,255,255,.07);}',
    '#name{color:#7dd3a0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38vw;}',
    '#gap{flex:1;}',
    '#bar input[type=range]{width:76px;accent-color:#22c55e;}',
    'button{height:22px;padding:0 9px;border-radius:6px;cursor:pointer;font:inherit;font-size:11.5px;',
    'color:#c9d1dc;border:1px solid rgba(255,255,255,.13);background:transparent;}',
    'button:hover{background:rgba(255,255,255,.08);color:#fff;}',
    '#hint{color:#f59e0b;font-size:11px;}',
    '#stage{position:relative;height:calc(100% - 34px);padding:10px 12px 8px;box-sizing:border-box;}',
    '#board{position:relative;height:100%;}',
    '.wk{position:absolute;top:0;bottom:0;box-sizing:border-box;',
    'background:linear-gradient(180deg,#fff 0%,#f9fbfe 52%,#e9eef6 86%,#dbe2ee 100%);',
    'border:1px solid #b6c0d0;border-top:0;border-radius:0 0 6px 6px;',
    'box-shadow:inset 0 2px 0 rgba(255,255,255,.9),0 3px 0 #a9b3c4,0 5px 9px rgba(0,0,0,.35);',
    'display:flex;align-items:flex-end;justify-content:center;padding-bottom:4px;',
    'font-size:8px;color:#8c96a8;}',
    '.bk{position:absolute;top:0;height:62%;box-sizing:border-box;z-index:2;',
    'background:linear-gradient(180deg,#4b5568 0%,#2b3345 42%,#141924 82%,#05080d 100%);',
    'border:1px solid #05080d;border-top:0;border-radius:0 0 4px 4px;',
    'box-shadow:inset 0 2px 0 rgba(255,255,255,.2),0 4px 0 #04070b,0 7px 11px rgba(0,0,0,.55);}',
    '.wk.hit-lh{animation:hl .55s ease-out both;}',
    '.wk.hit-rh{animation:hr .55s ease-out both;}',
    '.bk.hit-lh{animation:hlb .55s ease-out both;}',
    '.bk.hit-rh{animation:hrb .55s ease-out both;}',
    '@keyframes hl{0%{background:#1d4ed8}60%{background:#60a5fa}100%{background:#dbe2ee}}',
    '@keyframes hr{0%{background:#15803d}60%{background:#4ade80}100%{background:#dbe2ee}}',
    '@keyframes hlb{0%{background:#1e40af}60%{background:#3b82f6}100%{background:#05080d}}',
    '@keyframes hrb{0%{background:#14532d}60%{background:#22c55e}100%{background:#05080d}}',
    '</style></head><body>',
    '<div id="bar"><span id="name">钢琴</span><span id="hint" hidden>点一下开始</span>',
    '<span id="gap"></span><span>音量</span>',
    '<input id="vol" type="range" min="0" max="100" value="100">',
    '<button id="stop">停</button><button id="close">×</button></div>',
    '<div id="stage"><div id="board"></div></div>',
    '<script>(function(){',
    'var API=', JSON.stringify(api), ';',
    'var MIN=21,MAX=108,WHITE=[0,2,4,5,7,9,11];',
    'var NAMES=["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];',
    // 黑键相对"左侧白键右缘"的偏移，按真钢琴比例微调
    'var OFF={1:-0.10,3:0.10,6:-0.12,8:0,10:0.12};',
    'var ac=null,bus=null,vol=1,seq=0,stopTick=0,primed=false;',
    'var S={},LOADING={},board=document.getElementById("board");',
    'var keys={};',

    // ── 建键盘 ──
    'var whites=[],midi;',
    'for(midi=MIN;midi<=MAX;midi++){if(WHITE.indexOf(midi%12)>=0)whites.push(midi);}',
    'var w=100/whites.length,wi=0,bw=w*0.62;',
    'var frag=document.createDocumentFragment();',
    'for(midi=MIN;midi<=MAX;midi++){',
    ' var pc=((midi%12)+12)%12,el=document.createElement("div");',
    ' if(WHITE.indexOf(pc)>=0){',
    '  el.className="wk";el.style.left=(wi*w)+"%";el.style.width=w+"%";',
    '  if(pc===0)el.textContent="C"+(Math.floor(midi/12)-1);',
    '  keys[midi]=el;frag.appendChild(el);wi++;',
    ' }else{',
    '  var left=(wi*w)+(OFF[pc]||0)*w-bw/2;',
    '  el.className="bk";el.style.left=Math.max(0,left)+"%";el.style.width=bw+"%";',
    '  keys[midi]=el;frag.appendChild(el);',
    ' }',
    '}',
    'board.appendChild(frag);',

    // ── 音频 ──
    'function ensure(){',
    ' if(ac)return ac;',
    ' var C=window.AudioContext||window.webkitAudioContext;if(!C)return null;',
    ' ac=new C();bus=ac.createGain();bus.gain.value=vol;bus.connect(ac.destination);',
    ' preload();return ac;',
    '}',
    'function snap(m){return Math.max(21,Math.min(108,Math.round((m-21)/3)*3+21));}',
    'function layer(v){return v<0.38?1:(v<0.72?5:16);}',
    'function preload(){',
    ' var list=[];for(var m=21;m<=108;m+=3){list.push(m+"v1.mp3",m+"v5.mp3",m+"v16.mp3");}',
    ' list.forEach(function(f){',
    '  if(S[f]||LOADING[f])return;LOADING[f]=1;',
    '  fetch(API+"/sample/"+f).then(function(r){return r.ok?r.arrayBuffer():null;})',
    '   .then(function(b){if(!b)return null;return ac.decodeAudioData(b);})',
    '   .then(function(buf){if(buf)S[f]=buf;}).catch(function(){});',
    ' });',
    '}',
    'function pick(m,v){',
    ' var s=snap(m),lv=layer(v),f=s+"v"+lv+".mp3";',
    ' return S[f]||S[s+"v5.mp3"]||S[s+"v1.mp3"]||S[s+"v16.mp3"]||null;',
    '}',
    'function strike(m,when,dur,v){',
    ' var buf=pick(m,v);if(!buf)return;',
    ' var s=ac.createBufferSource();s.buffer=buf;',
    ' s.playbackRate.value=Math.pow(2,(m-snap(m))/12);',
    ' var g=ac.createGain(),peak=(0.15+0.85*Math.pow(v,0.8))*0.55;',
    ' g.gain.setValueAtTime(0,when);',
    ' g.gain.linearRampToValueAtTime(peak,when+0.004);',
    ' g.gain.setTargetAtTime(0,when+Math.max(dur,0.6),0.35);',
    ' s.connect(g);g.connect(bus);s.start(when);',
    ' try{s.stop(when+Math.max(dur,0.6)+2.2);}catch(e){}',
    '}',

    // ── 点灯 ──
    'function paint(m){',
    ' var el=keys[m];if(!el)return;',
    ' var cls=m<60?"hit-lh":"hit-rh";',
    ' el.classList.remove("hit-lh","hit-rh");void el.offsetWidth;',
    ' el.classList.add(cls);',
    ' setTimeout(function(){el.classList.remove(cls);},560);',
    '}',

    // ── 轮询 ──
    'function schedule(events,now){',
    ' for(var i=0;i<events.length;i++){',
    '  var e=events[i],due=(e.t-now)/1000;',
    '  if(due>6)continue;',
    '  if(due<-3)continue;',
    '  var d=Math.max(0.1,(e.d||400)/1000);',
    '  strike(e.m,ac.currentTime+Math.max(0.01,due),d,e.v==null?0.78:e.v);',
    '  (function(m,ms){setTimeout(function(){paint(m);},Math.max(0,due*1000));})(e.m,due);',
    ' }',
    '}',
    'function tick(){',
    ' fetch(API+"/events?since="+seq).then(function(r){return r.json();}).then(function(d){',
    '  if(!d||!d.ok)return;',
    '  if(!primed){primed=true;stopTick=d.stop||0;}',
    '  else if((d.stop||0)!==stopTick){',
    '   stopTick=d.stop||0;',
    '   if(bus){bus.gain.cancelScheduledValues(ac.currentTime);bus.gain.setValueAtTime(0,ac.currentTime);',
    '    bus.gain.setValueAtTime(vol,ac.currentTime+0.05);}',
    '   for(var k in keys){keys[k].classList.remove("hit-lh","hit-rh");}',
    '   document.getElementById("name").textContent="钢琴";',
    '   return;',
    '  }',
    '  var ev=d.events||[];',
    '  if(ev.length){',
    '   for(var i=0;i<ev.length;i++){if(ev[i].i>seq)seq=ev[i].i;}',
    '   if(!ac)ensure();',
    '   if(ac&&ac.state!=="running"){ac.resume().catch(function(){});}',
    '   if(ac&&ac.state==="running")schedule(ev,d.now);',
    '  }',
    ' }).catch(function(){}).then(function(){setTimeout(tick,140);});',
    '}',

    // ── 控件 ──
    'var volEl=document.getElementById("vol");',
    'volEl.oninput=function(){vol=Number(volEl.value)/100;if(bus)bus.gain.value=vol;};',
    'document.getElementById("stop").onclick=function(){',
    ' fetch(API+"/stop",{method:"POST"}).catch(function(){});',
    '};',
    'document.getElementById("close").onclick=function(){window.close();};',
    'var kick=function(){var a=ensure();if(a&&a.state!=="running")a.resume().catch(function(){});',
    ' document.getElementById("hint").hidden=true;};',
    'window.addEventListener("pointerdown",kick,true);',
    'window.addEventListener("keydown",kick,true);',
    // 通知主窗口让位：两边同时轮询 /events 会各排一遍音，听起来是重奏。
    'try{var bc=new BroadcastChannel("dsh-piano-xz");',
    'bc.postMessage({type:"popup-open"});',
    'window.addEventListener("beforeunload",function(){',
    'try{bc.postMessage({type:"popup-close"});}catch(e){}});}catch(e){}',
    'ensure();tick();',
    '})();</script></body></html>',
  ]
  return p.join('')
}

function sendHtml(res, html) {
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(html)
}

/**
 * 读请求体。
 * @param {import('node:http').IncomingMessage} req
 */
function readBody(req) {
  return new Promise((resolvePromise) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      try {
        resolvePromise(raw ? JSON.parse(raw) : {})
      } catch {
        resolvePromise({})
      }
    })
    req.on('error', () => resolvePromise({}))
  })
}

/**
 * 发音比例收口。
 * @param {unknown} value
 */
function clampGap(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0.96
  return Math.max(0.3, Math.min(1, n))
}

/**
 * 把错误翻成能照着改的一句话。
 * @param {unknown} error
 */
function describeError(error) {
  if (error instanceof NoteError) return `谱没写对：${error.message}`
  return `弹不了：${String(error?.message ?? error)}`
}
