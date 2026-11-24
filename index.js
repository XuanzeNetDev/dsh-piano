/**
 * dsh-piano-xz —— 璇泽科技 · DSH 电脑钢琴（宿主半侧）
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
 * 声音由独立窗口（PianoWindow.exe）发出：钢琴用 Yamaha 每键采样，其余 127 种用 GM 音源。
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

const ROUTE = '/api/dsh-piano-xz'

/** 一次最多排多少音，防超长谱把队列撑爆。 */
const MAX_NOTES_PER_CALL = 20000
/** 谱文件上限。 */
const MAX_SCORE_BYTES = 1_000_000
/** MIDI 文件上限（一般三四分钟的曲子几百 KB）。 */
const MAX_MIDI_BYTES = 16_000_000

/** 钢琴采样目录（Salamander Grand Piano V3，CC BY 3.0，每 3 个半音一个）。 */
const PKG_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * 版本号从 package.json 读，不硬编码。
 *
 * 之前写死 '2.1.0'，package.json 升到 2.2.0 之后忘了同步，
 * /info 就一直在报旧版本 —— 用户查"装的是哪版"会看到错的。
 * 现在只有 package.json 一个源头，不会再漂。
 */
const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
/** 采样文件读一次就留在内存里，本地 300KB 一个，30 个也就 5MB。 */
const sampleCache = new Map()

/** 诊断计数（/events 被轮询了多少次）。 */
const probe = { ticks: 0 }
/**
 * 注意：这里原来有一个「按 UA 分桶记住游标」的 Map，用来兜老版本 client 传 since=0 的病。
 * 它反而把现役 client 变成"永远回空"，已经连同 /events 里的用法一起删掉。
 * 若将来真需要防重发，应该在 client 里守住游标，而不是在宿主侧吞事件。
 */
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

演奏是排给独立窗口的：窗口没开会自动拉起。也可以在界面上用乐器选择器换音色（128 种）。`

const PLAY_DESCRIPTION = `当场弹一段，不落盘。参数和 piano_score 的 text 完全一样（简谱 / 音名都行）。
谱要留档、要反复弹，用 piano_score 写成文件。

${SCORE_FORMAT}

例：「3 2 6' 2'」四个八分音符（配合 unit 0.5）；「1+3+5」一个和弦；
「3:2 5 - -」三拍长音接延长。`

const PIECE_DESCRIPTION = `用内置曲子弹一首（小星星、两只老虎、欢乐颂、生日快乐、致爱丽丝、铃儿响叮当、卡农和弦、茉莉花）。
name 可以是标题、id 或别名，也可以只给关键词。自己编谱用 piano_score / piano_play。`

const INSTRUMENT_DESCRIPTION = [
  '切换发声乐器（General MIDI 128 音色）。',
  '',
  '弹出来的音不再固定是钢琴：0=三角钢琴，40=小提琴，48=弦乐合奏，56=小号，',
  '73=长笛，24=尼龙弦吉他，32=贝斯，128 个音色按 GM 标准编号。',
  '',
  '用法：',
  '  { program: 40 }        —— 按编号选',
  '  { name: "violin" }     —— 按名字模糊匹配（大小写不敏感）',
  '  { list: true }         —— 列出全部 128 个',
  '',
  '切换只影响之后的音，已经在响的音不受影响。',
  '注意：需要先跑过 tools/extract_gm.py 导出采样，否则乐器库是空的。',
].join('\n')

const EXPORT_DESCRIPTION = [
  '把当前队列里的曲子渲染成 WAV 文件。',
  '',
  '离线渲染，不走扬声器 —— 比你听到的快得多（一两分钟的歌几秒钟就好），',
  '而且结果确定、可复现。音色、包络、循环用的都是演奏时那套代码。',
  '',
  '用法：',
  '  {}                          —— 渲染当前队列，文件名用时间戳',
  '  { file: "我的曲子.wav" }     —— 指定文件名',
  '  { wait: false }             —— 只排队不等结果',
  '',
  '输出在 record/ 目录。队列里有什么就渲染什么，所以要先弹一首。',
  '要 MP3 的话把扩展名写成 .mp3，之后可以用 ffmpeg 转（内置不直接生成 MP3）。',
].join('\n')

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
let snapOn = true    // 默认吸附（和 DSH 一体，不覆盖内容）
let snapH = 190

/**
 * 本机 origin。webServer 注入的时候记一次，工具执行时用它拼 EXE 的 --api。
 * 拿不到就空字符串，ensureWindow 会因此跳过（非 Windows 或环境异常）。
 */
let hostOrigin = ''

/**
 * 当前 GM 乐器。null 表示"没切过"，EXE 用它自己的默认（program 0）。
 * 浏览器端和 EXE 端通过 /preset 对齐：谁改了都推到这里，另一边轮询跟上。
 */
let gmPreset = { bank: 0, program: 0, name: 'Grand Piano' }

/**
 * 离线渲染任务。EXE 每秒轮询 /render/pending 来取。
 *
 * 为什么让 EXE 渲染而不是在 Node 里合成：
 *   音色、包络、滤波、循环全在 PianoAudio.cs 里，Node 那边没有。
 *   在 Node 里重写一遍合成器，等于维护两套，导出的声音必然和听到的不一样。
 *   EXE 已经有 RenderToWav()，直接复用同一套 Voice/混音代码。
 */
let renderJob = null   // { id, out, timeline, startedAt }

/**
 * GM 标准 128 个音色的名称表（程序号即数组下标）。
 * 来自 FluidR3Mono_GM.sf3 的 bank 0，按 program 排序。
 * 第 10 通道（ch 10）的鼓组不在这张表里 —— 那是另一套映射。
 */
const GM_INSTRUMENTS = [
  "Grand Piano",
  "Bright Grand Piano",
  "Electric Grand",
  "Honky-Tonk Piano",
  "Tine Electric Piano",
  "FM Electric Piano",
  "Harpsichord",
  "Clavinet",
  "Celesta",
  "Glockenspiel",
  "Music Box",
  "Vibraphone",
  "Marimba",
  "Xylophone",
  "Tubular Bells",
  "Dulcimer",
  "Drawbar Organ",
  "Percussive Organ",
  "Rock Organ",
  "Church Organ",
  "Reed Organ",
  "Accordion",
  "Harmonica",
  "Bandoneon",
  "Nylon String Guitar",
  "Steel String Guitar",
  "Jazz Guitar",
  "Clean Guitar",
  "Palm Muted Guitar",
  "Overdrive Guitar",
  "Distortion Guitar",
  "Guitar Harmonics",
  "Acoustic Bass",
  "Fingered Bass",
  "Picked Bass",
  "Fretless Bass",
  "Slap Bass",
  "Pop Bass",
  "Synth Bass 1",
  "Synth Bass 2",
  "Violin",
  "Viola",
  "Cello",
  "Contrabass",
  "Tremolo Strings",
  "Pizzicato Strings",
  "Harp",
  "Timpani",
  "Strings",
  "Slow Strings",
  "Synth Strings 1",
  "Synth Strings 2",
  "Choir Aahs",
  "Voice Oohs",
  "Synth Voice",
  "Orchestra Hit",
  "Trumpet",
  "Trombone",
  "Tuba",
  "Harmon Mute Trumpet",
  "French Horns",
  "Brass Section",
  "Synth Brass 1",
  "Synth Brass 2",
  "Soprano Sax",
  "Alto Sax",
  "Tenor Sax",
  "Baritone Sax",
  "Oboe",
  "English Horn",
  "Bassoon",
  "Clarinet",
  "Piccolo",
  "Flute",
  "Recorder",
  "Pan Flute",
  "Bottle Chiff",
  "Shakuhachi",
  "Whistle",
  "Ocarina",
  "Square Lead",
  "Saw Lead",
  "Calliope Lead",
  "Chiffer Lead",
  "Charang",
  "Solo Vox",
  "5th Saw Wave",
  "Bass & Lead",
  "Fantasia",
  "Warm Pad",
  "Polysynth",
  "Space Voice",
  "Bowed Glass",
  "Metal Pad",
  "Halo Pad",
  "Sweep Pad",
  "Ice Rain",
  "Soundtrack",
  "Crystal",
  "Atmosphere",
  "Brightness",
  "Goblin",
  "Echo Drops",
  "Star Theme",
  "Sitar",
  "Banjo",
  "Shamisen",
  "Koto",
  "Kalimba",
  "Bagpipe",
  "Fiddle",
  "Shenai",
  "Tinker Bell",
  "Agogo",
  "Steel Drums",
  "Woodblock",
  "Taiko Drum",
  "Melodic Tom",
  "Synth Drum",
  "Reverse Cymbal",
  "Fret Noise",
  "Breath Noise",
  "Sea Shore",
  "Bird Tweet",
  "Telephone",
  "Helicopter",
  "Applause",
  "Gun Shot",
]


/**
 * ── 模块级：独立窗口的启动 ──
 *
 * 为什么放在模块级而不是 apply() 里：
 * handle() 是模块级函数，拿不到 apply() 内部的局部变量。
 * 之前 ensureWindow 定义在 apply 里，handle 里引用就报
 * "ensureWindow is not defined" —— 而且因为 ESM 模块缓存，
 * 改完代码重启也未必立刻生效，排查起来极其费劲。
 *
 * 这一层只用模块级状态，谁都能调。
 */

/** 是否认为窗口开着（仅作快路径，实际以进程为准）。 */
let winSpawned = false

/** 最近一次 getOrigin 拿到的地址。 */
let winOrigin = ''

/** 吸附状态（模块级，供启动时用）。 */
let winSnapOn = true
let winSnapH = 190

/** 写一行诊断日志到 record/window.log。 */
export function winLog(line) {
  try {
    mkdirSync(join(PKG_ROOT, 'record'), { recursive: true })
    appendFileSync(
      join(PKG_ROOT, 'record', 'window.log'),
      new Date().toISOString().slice(11, 23) + ' ' + line + '\n',
    )
  } catch {}
}

/** 真有 PianoWindow.exe 在跑吗（按进程名查）。 */
export function isPianoRunning() {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq PianoWindow.exe', '/NH'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 3000,
    })
    const out = String(r?.stdout || '')
    return /PianoWindow\.exe/i.test(out)
  } catch {
    return false
  }
}

/** origin 拿不到时兜底：从进程监听端口推一个。 */
export function guessOrigin() {
  try {
    const envPort = process.env.DSH_WEB_PORT || process.env.PORT
    if (envPort && /^\d+$/.test(String(envPort))) {
      return 'http://127.0.0.1:' + envPort
    }
    const r = spawnSync('netstat', ['-ano'], { windowsHide: true, encoding: 'utf8', timeout: 4000 })
    const out = String(r?.stdout || '')
    const re = new RegExp('127\\.0\\.0\\.1:(\\d+)\\s+0\\.0\\.0\\.0:0\\s+LISTENING\\s+' + process.pid + '\\b')
    const m = out.match(re)
    return m ? 'http://127.0.0.1:' + m[1] : ''
  } catch {
    return ''
  }
}

/**
 * 确保独立窗口存在（模块级版本，handle 也能调）。
 * @param {string} [origin]
 * @param {{ snapOn?: boolean, snapH?: number }} [opts]
 * @returns {boolean}
 */
/**
 * 确保「有东西能渲染」。
 *
 * 和 ensureWindowModule 的区别：
 *   · ensureWindowModule 要**可见窗口**（用户要看要弹）
 *   · 这个只要**有进程能算**（导出）
 *
 * 顺序：
 *   1. 已经有 PianoWindow.exe 在跑 → 直接用（省一次启动）
 *   2. 没有 → spawn 一个 --render-only 实例，它不建窗口、不碰 waveOut，
 *      取到任务、渲染完、自己退出
 *
 * 这样导出就跟"窗口开没开""有没有在播""吸不吸附"全都无关了。
 *
 * @param {string} origin
 * @returns {boolean}
 */
export function ensureRenderer(origin) {
  if (process.platform !== 'win32') {
    winLog('ensureRenderer: 非 win32')
    return false
  }
  const exe = join(PKG_ROOT, 'tools', 'PianoWindow.exe')
  if (!existsSync(exe)) {
    winLog('ensureRenderer: 找不到 ' + exe)
    return false
  }

  // 已有实例在跑（不管它是窗口还是上一次的渲染进程）——复用它
  if (isPianoRunning()) {
    winLog('ensureRenderer: 已有实例在跑，复用它')
    return true
  }

  let base = origin || winOrigin || ''
  if (!base) {
    base = guessOrigin()
    winLog('ensureRenderer: origin 为空，推断得到 ' + (base || '(失败)'))
    if (!base) return false
  }
  winOrigin = base

  try {
    winLog('ensureRenderer: 启动 render-only 实例, api=' + base + ROUTE)
    spawn(exe, ['--api', base + ROUTE, '--render-only'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    return true
  } catch (e) {
    winLog('ensureRenderer: spawn 失败 ' + String(e?.message || e))
    return false
  }
}

export function ensureWindowModule(origin, opts = {}) {
  if (process.platform !== 'win32') {
    winLog('ensureWindow: 非 win32')
    return false
  }

  // ── 先看进程，再看 origin ──
  //
  // 顺序很重要：窗口已经在跑的时候，根本不需要 origin（那是"启动参数"用的）。
  // 原来先检查 origin，拿不到就直接 return false ——
  // 表现是"EXE 明明开着，导出却报'起不了钢琴窗口'"。
  if (isPianoRunning()) {
    winSpawned = true
    return true
  }
  if (winSpawned) {
    winLog('ensureWindow: 标志说开着，但进程不在 —— 纠正')
    winSpawned = false
  }

  const exe = join(PKG_ROOT, 'tools', 'PianoWindow.exe')
  if (!existsSync(exe)) {
    winLog('ensureWindow: 找不到 ' + exe)
    return false
  }

  let base = origin || winOrigin || ''
  if (!base) {
    base = guessOrigin()
    winLog('ensureWindow: origin 为空，推断得到 ' + (base || '(失败)'))
    if (!base) return false
  }
  winOrigin = base

  const snapOn = opts.snapOn ?? winSnapOn
  const snapH = opts.snapH ?? winSnapH
  try {
    winSpawned = true
    const fullApi = base + ROUTE
    winLog('ensureWindow: 启动 exe, api=' + fullApi + ' snap=' + (snapOn ? '1' : '0'))
    spawn(exe, ['--api', fullApi, '--height', String(snapH), '--snap', snapOn ? '1' : '0'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }).unref()
    return true
  } catch (e) {
    winLog('ensureWindow: spawn 失败 ' + String(e?.message || e))
    winSpawned = false
    return false
  }
}

/**
 * 默认导出目录：**Windows 的下载文件夹**。
 *
 * 之前用插件的 record/，用户根本找不到（藏在插件目录里）。
 * 导出的东西是"作品"，应该落在用户自然会去的地方。
 *
 * 顺序：
 *   1. 系统已知的 Downloads 文件夹（被 OneDrive 重定向也能拿到）
 *   2. 环境变量 USERPROFILE\\Downloads
 *   3. 退回插件 record/（极少数环境两者都没有）
 */
function defaultExportDir() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    if (process.platform === 'win32') {
      const r = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command',
         "[Environment]::GetFolderPath('UserProfile') + '\\Downloads'"],
        { windowsHide: true, encoding: 'utf8', timeout: 4000 },
      )
      const p1 = String(r?.stdout || '').trim()
      if (p1 && existsSync(p1)) return p1
    }
    if (home) {
      const p2 = join(home, 'Downloads')
      if (existsSync(p2)) return p2
      return home
    }
  } catch {}
  return join(PKG_ROOT, 'record')
}

/**
 * 解析导出路径。
 *
 * 默认落在**系统下载文件夹**。不能用 process.cwd()：
 * DSH 的工作目录是 profile 目录（…\\.dsh\\profiles\\desktop），
 * 写那儿用户根本找不到，而且换个 profile 就换个地方。
 *
 * 也支持绝对路径（用户想导到 D 盘某处）。
 *
 * @param {unknown} rawFile 文件名或完整路径
 * @param {unknown} rawDir  目录（可选）
 * @returns {{ out: string, name: string, dir: string }}
 */
function resolveExportPath(rawFile, rawDir) {
  let name = String(rawFile || '').trim()
  if (!name) name = 'render-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')

  const looksAbsolute = /^[a-zA-Z]:[\\/]/.test(name) || name.startsWith('\\\\') || name.startsWith('/')
  if (!looksAbsolute) name = name.replace(/[\\/:*?"<>|]/g, '_')
  if (!/\.(wav|mp3)$/i.test(name)) name += '.wav'

  let dir = String(rawDir || '').trim()
  if (!dir) dir = defaultExportDir()
  else if (!isAbsolute(dir)) dir = resolve(PKG_ROOT, dir)

  const out = looksAbsolute ? name : join(dir, name)
  try { mkdirSync(dirname(out), { recursive: true }) } catch {}
  return { out, name: basename(out), dir: dirname(out) }
}

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
    // ── 先停，再排 ──
    // engine.schedule 的 base 是 Math.max(now+lead, last.t)，也就是"接在上一段
    // 结束之后排"。不先停的话，连着弹两次，第二次会等到第一次放完才响 ——
    // 用户看到的现象就是"点了没反应，过一会儿才响"。
    //
    // 这里是所有"发命令就立刻响"的统一切口：谱文本、文件、MIDI 都经过 playText
    // 或它旁边的调度，所以在这一层停一次就够，不用每个工具各写一遍。
    engine.stop()
    // 没起窗口就先起 —— 否则音排了但没人放，用户看到的是"点了没反应"
    ensureWindowModule(hostOrigin)
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
          ensureWindowModule(hostOrigin)
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

    c.tools.register({
      name: 'piano_instrument',
      description: INSTRUMENT_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          program: { type: 'number', description: 'GM 音色号 0-127（0=三角钢琴，40=小提琴，48=弦乐合奏，56=小号…）' },
          bank: { type: 'number', description: '音色库号，默认 0（GM 标准库）' },
          name: { type: 'string', description: '直接按名字选（模糊匹配，如 "violin"、"弦乐"）' },
          list: { type: 'boolean', description: '只列出可用乐器，不切换' },
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
      execute: async (args = {}) => {
        const GM = GM_INSTRUMENTS
        if (args.list) {
          const lines = GM.map((n, i) => `${String(i).padStart(3, ' ')}  ${n}`)
          return { ok: true, text: `可用乐器（${GM.length} 个）：\n${lines.join('\n')}` }
        }

        let program = null
        let bank = Number.isFinite(args.bank) ? Math.max(0, Math.min(127, args.bank)) : 0

        if (Number.isFinite(args.program)) {
          program = Math.max(0, Math.min(127, Math.floor(args.program)))
        } else if (typeof args.name === 'string' && args.name.trim()) {
          const q = args.name.trim().toLowerCase()
          const hit = GM.findIndex((n) => n.toLowerCase().includes(q))
          if (hit < 0) {
            return { ok: false, text: `没找到叫「${args.name}」的乐器。用 list: true 看全部。` }
          }
          program = hit
        } else {
          return { ok: false, text: `给个 program（0-127）或 name，或者 list: true 看清单。` }
        }

        gmPreset = { bank, program, name: GM[program] }
        engine.stop()
        return {
          ok: true,
          text: `已切到 ${program} · ${GM[program]}${bank ? `（bank ${bank}）` : ''}。下一个音就用这个音色。`,
        }
      },
    })

    c.tools.register({
      name: 'piano_export',
      description: EXPORT_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: '输出文件名或完整路径。省略则用时间戳。' },
          dir: { type: 'string', description: '输出目录（可选）。默认系统下载文件夹。' },
          wait: { type: 'boolean', description: '是否等渲染完成（默认 true，最长 60 秒）' },
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
      execute: async (args = {}) => {
        const snap = engine.snapshotForRender()
        if (!snap.count) {
          return { ok: false, text: '队列是空的。先 piano_play / piano_score / piano_midi 弹一首，再导出。' }
        }
        const id = 'r' + Date.now().toString(36)
        const { out, name, dir } = resolveExportPath(args?.file, args?.dir)

        // 渲染要靠 EXE 的音频代码，但**不需要窗口**。
        // ensureRenderer 会在没进程时起一个 --render-only 实例（不建窗口、不发声）。
        if (!ensureRenderer(hostOrigin)) {
          return {
            ok: false,
            text: '起不了渲染进程（非 Windows，或 tools/PianoWindow.exe 不存在）。',
          }
        }

        renderJob = { id, out, timeline: snap.timeline, startedAt: Date.now(), spanMs: snap.spanMs }

        if (args?.wait === false) {
          return { ok: true, text: `已排入渲染队列：${name}\n${snap.count} 个音，约 ${(snap.spanMs / 1000).toFixed(0)} 秒音频。\n用 piano_export({ wait: true }) 或 pip 等它完成。` }
        }

        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          if (renderJob && renderJob.done) break
          await new Promise((r) => setTimeout(r, 300))
        }
        if (!renderJob || !renderJob.done) {
          return { ok: false, text: `渲染超时（等 60 秒没完成）。看 record/audio.log 里的 RENDER 行。目标文件：${out}` }
        }
        if (!renderJob.ok) {
          return { ok: false, text: `渲染失败。日志在 record/audio.log 里搜 RENDER。` }
        }
        return {
          ok: true,
          text: `导出完成：${name}\n目录 ${dir}\n文件 ${out}\n音频 ${renderJob.seconds.toFixed(1)} 秒，${snap.count} 个音。`,
        }
      },
    })
  })




  ctx.inject(['webServer'], (c) => {
    const server = c.webServer || (typeof c.get === 'function' ? c.get('webServer') : undefined)
    if (!server || typeof server.register !== 'function') return

    /**
     * 立刻取一次 origin —— 不能等第一个 HTTP 请求。
     *
     * 之前 hostOrigin 只在 handle() 里赋值，而 handle 要等用户发请求才跑。
     * 结果是：用户第一次调 piano_play / 选 MIDI 的时候，hostOrigin 还是空串，
     * ensureWindow('') 直接返回 false，EXE 根本没起来 ——
     * 表现就是"点了播放没声音，钢琴按钮还是灰的"。
     *
     * 现在注册成功就先取一次；取不到（老版本 webServer 没这个方法）
     * 就在下面的轮询里补。
     */
    const grabOrigin = () => {
      try {
        const o = typeof server.getOrigin === 'function' ? server.getOrigin() : ''
        if (o) hostOrigin = o
        return !!o
      } catch {
        return false
      }
    }
    grabOrigin()
    // 有些宿主 webServer 起来得晚，兜底再试几次（总共约 5 秒）
    if (!hostOrigin) {
      let tries = 0
      const timer = setInterval(() => {
        if (grabOrigin() || ++tries > 20) clearInterval(timer)
      }, 250)
      // 不阻塞退出
      if (typeof timer.unref === 'function') timer.unref()
    }

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
            if (origin) hostOrigin = origin
            // handle 每次都会取到最新的 origin（端口可能变），顺手更新给工具用
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
      melodies: melodyCatalog(),
      status: engine.status(),
    })
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
    // 原来的 Chrome --app 备用方案已经删了。
    //
    // 它会在浏览器里生成一整块 88 键键盘 + Web Audio 发声 —— 那等于把
    // 「网页版钢琴」又做一遍，和现在「EXE 是唯一发声者」的架构冲突。
    // 而且它的前提是「没有 PianoWindow.exe」，现在 EXE 已入库，这个前提不成立了。
    return sendJson(res, 200, {
      ok: false,
      error: '找不到 tools/PianoWindow.exe。请在仓库根目录跑一次 install.ps1。',
    })
  }

  // 钢琴窗口是否开着（client 用它决定胶囊按钮是"打开"还是"关闭"）
  if (method === 'GET' && path === '/popup/state') {
    // 这里原来写的是 writeJson —— index.js 里没有这个函数（兄弟路由都用 sendJson），
    // 于是这个接口稳定 500，client 每次问都拿到错误。
    // 用进程实检 —— 内存标志在"用户手动关窗口""EXE 崩了"之后会失准，
    // 前端据此画按钮颜色，就不准了。
    const running = isPianoRunning()
    popupOpen = running
    return sendJson(res, 200, { ok: true, open: running })
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
    sendJson(res, 200, { ok: true, killed })
    return
  }

  // 上传一个 MIDI 文件并直接播放。body 是裸二进制 .mid。
  // 参数：name=<文件名>（只用于显示）、tempo=<倍率>
  if (method === 'POST' && path === '/upload-midi') {
    const buf = await readRawBody(req)
    if (!buf || buf.length < 14) {
      return sendJson(res, 400, { ok: false, error: '没收到文件，或者文件太小不像 MIDI。' })
    }
    if (buf.slice(0, 4).toString('ascii') !== 'MThd') {
      return sendJson(res, 400, { ok: false, error: '这不是标准 MIDI 文件（缺少 MThd 头）。' })
    }
    const label = String(url.searchParams.get('name') || 'uploaded.mid')
    const scale = Number(url.searchParams.get('tempo')) || 1
    try {
      const midi = parseMidi(buf)
      const { timeline, seconds, dropped, clipped } = midiToTimeline(midi, { tempoScale: scale })
      if (!timeline.length) {
        return sendJson(res, 400, { ok: false, error: '这份 MIDI 里没有能播的音符。' })
      }
      if (timeline.length > MAX_NOTES_PER_CALL) {
        return sendJson(res, 400, {
          ok: false,
          error: `这份 MIDI 有 ${timeline.length} 个音，超过单次上限 ${MAX_NOTES_PER_CALL}。`,
        })
      }
      const bpm = midi.tempoMap?.length ? Math.round(60_000_000 / midi.tempoMap[0].usPerQuarter) : null
      const score = {
        topic: 'midi',
        file: label,
        bpm,
        key: midi.keySignature || null,
        timeSig: midi.timeSignature || null,
        transpose: 0,
      }
      engine.stop()
      ensureWindowModule(origin)
      const result = engine.schedule(timeline, { label, tempo: null, score })
      return sendJson(res, 200, {
        ok: true,
        label,
        notes: timeline.length,
        seconds: Math.round(seconds),
        dropped,
        clipped,
        bytes: buf.length,
        ...result,
      })
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: '解析失败：' + String(error?.message ?? error) })
    }
  }



  // 开始渲染：把时间轴交给 EXE，它渲染完回报。参数：file=<输出文件名>
  if (method === 'POST' && path === '/render') {
    // 上一个还挂着但超过 90 秒没动静 → 认为它死了，直接顶掉
    if (renderJob && !renderJob.done && Date.now() - renderJob.startedAt > 90_000) {
      renderJob = null
    }
    if (renderJob && !renderJob.done) {
      return sendJson(res, 409, { ok: false, error: '上一个渲染还没完成：' + renderJob.id })
    }
    renderJob = null   // 上一个已完成，可以开新的
    const snap = engine.snapshotForRender()
    if (!snap.count) {
      return sendJson(res, 400, { ok: false, error: '队列是空的，先弹一首再导出。' })
    }
    const id = 'r' + Date.now().toString(36)
    const { out, name, dir } = resolveExportPath(url.searchParams.get('file'), url.searchParams.get('dir'))
    renderJob = { id, out, timeline: snap.timeline, startedAt: Date.now(), spanMs: snap.spanMs }
    return sendJson(res, 200, { ok: true, id, out, name, dir, notes: snap.count, seconds: Math.round(snap.spanMs / 100) / 10 })
  }

  // EXE 来取任务
  if (method === 'GET' && path === '/render/pending') {
    if (!renderJob) return sendJson(res, 200, { ok: true, id: null })

    // 超时清掉就任务作废（原来这个判断写在"已派发"之前，
    // 一旦派发过就永远 return id:null，卡住的旧任务再也不清）
    if (Date.now() - renderJob.startedAt > 120_000) {
      renderJob = null
      return sendJson(res, 200, { ok: true, id: null, error: '超时，已丢弃' })
    }
    if (renderJob.dispatched) return sendJson(res, 200, { ok: true, id: null })
    renderJob.dispatched = true
    return sendJson(res, 200, {
      ok: true,
      id: renderJob.id,
      out: renderJob.out,
      timeline: renderJob.timeline,
    })
  }

  // EXE 渲染完回报
  if (method === 'POST' && path === '/render/done') {
    // readBody 已经 JSON.parse 过了，返回的是对象。
    // 原来这里又 parse 一次，字符串化后必然抛异常 ——
    // 表现就是"回调收到 200，但 done 永远置不上，前端等 60 秒超时"。
    const body = await readBody(req)
    const data = (body && typeof body === 'object') ? body : {}
    winLog('render/done 收到 id=' + data.id
           + ' 当前 renderJob=' + (renderJob ? renderJob.id : 'null')
           + ' 匹配=' + !!(renderJob && data.id === renderJob.id))
    if (renderJob && data.id === renderJob.id) {
      renderJob.done = true
      renderJob.ok = !!data.ok
      renderJob.seconds = Number(data.seconds) || 0
      winLog('render/done 已标记 done=' + renderJob.id)
    }
    return sendJson(res, 200, { ok: true })
  }

  // 查询渲染状态
  if (method === 'GET' && path === '/render/state') {
    if (!renderJob) return sendJson(res, 200, { ok: true, state: 'idle' })
    return sendJson(res, 200, {
      ok: true,
      state: renderJob.done ? (renderJob.ok ? 'done' : 'failed') : 'running',
      id: renderJob.id,
      out: renderJob.out,
      seconds: renderJob.seconds || 0,
      elapsedMs: Date.now() - renderJob.startedAt,
    })
  }

  // 切乐器（网页端下拉框走这里）。参数：program=0-127&bank=0-127
  if (method === 'POST' && path === '/instrument') {
    const q = url.searchParams
    const raw = Number(q.get('program'))
    if (!Number.isFinite(raw)) {
      return sendJson(res, 400, { ok: false, error: '要给 program（0-127）' })
    }
    const program = Math.max(0, Math.min(127, Math.floor(raw)))
    const bank = Math.max(0, Math.min(127, Math.floor(Number(q.get('bank')) || 0)))
    gmPreset = { bank, program, name: GM_INSTRUMENTS[program] ?? `Program ${program}` }
    engine.stop()
    return sendJson(res, 200, { ok: true, ...gmPreset })
  }

  // 乐器清单（网页端下拉框初始化时取一次）
  if (method === 'GET' && path === '/instruments') {
    return sendJson(res, 200, {
      ok: true,
      current: gmPreset,
      list: GM_INSTRUMENTS.map((name, program) => ({ program, name })),
    })
  }

  // 当前乐器。EXE 轮询这个接口，发现变了就切 preset。
  if (method === 'GET' && path === '/preset') {
    return sendJson(res, 200, {
      ok: true,
      bank: gmPreset.bank,
      program: gmPreset.program,
      name: gmPreset.name,
      available: GM_INSTRUMENTS.length,
    })
  }

  if (method === 'POST' && path === '/snap') {
    const q = url.searchParams
    snapOn = q.get('on') === '1' || q.get('on') === 'true'
    const h = Number(q.get('h')) || 190
    snapH = Math.max(60, Math.min(400, h))
    sendJson(res, 200, { ok: true, snap: snapOn, height: snapH })
    return
  }

  if (method === 'GET' && path === '/events') {
    const since = Number(url.searchParams.get('since') ?? '0')

    /**
     * 游标：只看浏览器自己传的 since。
     *
     * 这里原来有一层「按 UA 分桶记住游标，然后 max(since, remembered)」的兜底，
     * 本意是治老版本 client「每次传 since=0 把同一批事件反复要」的毛病。
     * 但现役 client（client.js 和独立窗口那段内联脚本）发的**就是 since=0**：
     * 第一次拿全量，之后 remembered 已经被推到最新 seq，于是永远回空 ——
     * 网页端一个音都听不到，EXE 那边则是偶尔漏音。
     * 兜底本身比 bug 更坏，去掉，尊重调用方给的游标。
     */
    const snapshot = engine.drain(Number.isFinite(since) && since > 0 ? since : 0)

    probe.ticks++
    if (probe.ticks === 1 || snapshot.events.length) {
      probeLog(`events since=${since} seq=${snapshot.seq} got=${snapshot.events.length} ua=${String(req.headers['user-agent'] || 'unknown').slice(0, 18)}`)
    }
    return sendJson(res, 200, { ok: true, ...snapshot })
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
 * 读请求体。
 * @param {import('node:http').IncomingMessage} req
 */
/**
 * 读二进制 body（上传 MIDI 用）。
 *
 * 不能复用 readBody：那个把数据当字符串拼，二进制过一遍 UTF-8 就被破坏了。
 * 这里收到的是 Buffer 块，直接拼成一块。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit] 上限字节数，默认 8 MB（标准 MIDI 很少有超过 1 MB 的）
 * @returns {Promise<Buffer>}
 */
function readRawBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolvePromise) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolvePromise(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', () => resolvePromise(null))
  })
}

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
