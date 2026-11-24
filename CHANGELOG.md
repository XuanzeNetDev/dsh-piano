# 变更记录

按日期倒序。每条写清「改了什么 / 为什么 / 怎么验证的」。

---

## 2026-11-24（下午）— 废弃网页发声、全站瘦身

版本保持 `2.2.0`。这一轮只有一个目标：**确认 EXE 是唯一发声者，把网页那套全删掉。**

### 背景

`client.js` 里有一套完整的 Web Audio 引擎（约 550 行）：IndexedDB 采样缓存、
物理建模合成、响度补偿表、调度窗口。它和 EXE 各发一遍声，听感是**重奏**。

EXE 有 Yamaha 88 键每键采样和 GM 128 音色，音质和延迟都更好；
那套引擎只为废弃路径服务，还带着 178 个 mp3（16 MB）。

### 删掉的

| 内容 | 规模 |
|---|---|
| `client.js` Web Audio 引擎 | 约 550 行（`ensureAudio` / `loadSample` / `strike` / `synthVoice` / `cutAll` / IndexedDB 缓存） |
| `client.js` 调度链的音频部分 | `scheduleBatch` 保留，`fireEvent` 去掉 `strike` |
| `client.js` AudioContext 唤醒逻辑 | 手势唤醒 effect、`cardClick`、`flushWaiting` |
| `index.js` 的 `/popup` 页面 | `renderPopupPage` 214 行（内嵌一整块网页钢琴 + Web Audio） |
| `index.js` 的 `/sample` 路由 | 服务 178 个 mp3 |
| `index.js` 的 Chrome 备用方案 | `popup-open.ps1` 整块（内嵌网页钢琴） |
| `assets/piano/` | 178 个 Salamander mp3，**16 MB** |
| `tools/popup-open.ps1` | 8.6 KB |
| `tools/piano-window.ps1` | 8.6 KB（最早的 PowerShell 版窗口，移到 `tools/archive/`） |
| `docs/screenshot.png` | 212.8 KB（和 `interface.png` md5 完全相同，无人引用） |

**代码规模**：`client.js` 2110 → 1439 行（-671），`index.js` 1774 → 1545 行（-229）。

### 保留的

网页端只剩工具栏：`PianoPill`（开关）、`InstrumentSelect`（选乐器）、
`MidiPicker`（导入 MIDI），以及琴键点亮（`hold()`，纯视觉，不发声）。

**EXE 相关文件一个字节都没动**（`PianoWindow.exe` / `.cs` / `PianoAudio.cs` / `GmEngine.cs`
哈希与改动前完全一致）。

### 顺手修的两个 bug

**① 导出的文件名 `.wav.wav`**

`resolveExportPath` 里的正则写成了 `/\\.(wav|mp3)$/i` —— 多一个反斜杠，
匹配永远失败，于是每次都追加 `.wav`。

**② 导出等 60 秒超时，但文件其实已经生成**

`/render/done` 里写的是 `JSON.parse(await readBody(req))`，
但 `readBody` **已经 parse 过了**，返回的是对象。再 `JSON.parse` 一个对象必然抛异常，
被 `handler` 的 catch 吞掉 → 回调返回 200，但 `renderJob.done` 永远置不上 →
前端轮询到 60 秒放弃。

日志证据：

```
23:05:26.899 RENDER start id=rmwuttq8t notes=108
23:05:27.060 RENDER done 42.5s
23:05:27.068 RENDER callback ok {"ok":true,"seconds":42.51}
       ↑ 渲染和回调都成功了，但前端不知道
```

### 验证

```
Export Test      导出 潮汐之外.wav → C:\Users\海冥乐\Downloads
                 3.6 MB  44100Hz 1ch 16bit  42.5s  峰值 0.832
                 RIFF 长度字段 3749064 = 文件大小 - 8  ✓
                 文件名没有 .wav.wav  ✓
EXE 播放          重启后 88 采样 / GM 128 乐器 / waveOut 正常
selfcheck        自检全部通过
notation-test    全部通过
host-test        全部通过（8 个工具 + HTTP 路由）
verify_gm        128 乐器 / 6361 采样 / 零缺文件
```

---


## 2026-11-24 — 多乐器、导出、界面

版本 `2.1.0 → 2.2.0`。这一天基本是把插件从「一台钢琴」变成「一台能换乐器的演奏器」，
顺带把导出的整条链路打通。

### 一、多乐器（GM 128 音色）

**新增文件**

| 文件 | 作用 |
|---|---|
| `tools/sf2_parse.py`（352 行） | SF2/SF3 完整解析：`phdr → pbag → pgen → inst → ibag → igen → shdr` |
| `tools/extract_gm.py`（301 行） | 从 SF3 导出采样：Ogg → WAV，写 `index.json` |
| `tools/GmEngine.cs`（375 行） | 运行时乐器库：preset 切换、按 key/vel 选采样、算变调比 |
| `tools/verify_gm.mjs`（144 行） | 128 音色覆盖检查（缺文件 / 空文件 / loop 越界） |

**音源**：`assets/gm/FluidR3Mono_GM.sf3`（22.6 MB，MIT 许可，已入库）。
导出的采样在 `assets/gm/out/`（838 MB，gitignore 排除，用户跑一次 `extract_gm.py` 就有）。

**改动的文件**

- `PianoAudio.cs`：`Voice` 加 6 个字段（循环点 / 可变包络 / sustain 下限 / 保持时长）；
  新增 `PlaySample()`、`MixVoice()`（实时与离线共用）、`RenderToWav()`；`MAX_VOICES = 32`
- `PianoWindow.cs`：新增 `PlayNote()` 分发 —— **program 0 走原钢琴引擎，其余 127 个走 GM**
- `lib/midi.js`：解析 `0xC0` Program Change，逐音携带 `program` / `channel`
- `lib/engine.js`：事件加 `pg` / `ch`；新增 `snapshotForRender()`
- `index.js`：`GM_INSTRUMENTS` 128 音色表、`piano_instrument` 工具、`/preset` `/instrument` `/instruments` 路由

**为什么钢琴不走 GM**：Yamaha Upright 88 键每键独立采样，`rate` 恒为 1.0，零变调零混叠。
GM 的 "Grand Piano" 只有 164 个采样覆盖 88 键，音质不是一个档次。

**踩过的坑（都已修）**

1. **`sustainVolEnv` 读反了** —— SF2 里 `0` 表示「衰减 0 dB（完全不掉）」，
   不是「衰减到死」。写反导致小提琴 1ms 内没声。换算应为 `10^(-centibel/200)`。
2. **复音无上限** —— 循环采样 + `sustain=1.0` 永不结束，41 个 voice 叠一起削波。
   加了 `MAX_VOICES=32` 和 `HoldSec` 到点释放。
3. **zone 选择只看 keyRange** —— 钢琴 4 个 zone 里两个 `velRange` 相同、`keyRange` 都是 0-127，
   但一个装低音区一个装高音区。只看 keyRange 会选错，靠"最近采样"变调 28 个半音 → 完全跑调。
   改成**先确认这个 zone 里真有采样覆盖目标音**。
4. **release sample 被误选** —— 大提琴 9 个 zone 的 `velRange` 重叠，
   主音 zone（1.35s、有循环）和 release zone（0.24s、无循环）压在同一片区间。
   改成**优先选有循环采样的 zone**。
5. **`overridingRootKey` 没用上** —— FluidR3Mono 的 `shdr.originalPitch` 大面积写错
   （长笛全写 72、口琴全写 60，跟实际录制音高差 10~12 个半音）。SF2 规范里
   `igen` 的 `overridingRootKey`（op 58）优先级更高，漏了它导致长笛 `rate=0.5`（降八度）、
   采样被拉长一倍、共振峰全乱 —— 听感就是"刺耳 + 调不对"。
6. **循环段太短会嗡鸣** —— 加硬门槛：循环短于 64 样本（约 1.5ms）退化为不循环。
   128 个乐器里 9 个触发（都在 Vibraphone）。

**验证**

```
verify_gm.mjs：128 乐器 / 6361 采样 / 零缺文件 / 零 loop 越界
钢琴     PLAY 79 次    GMPLAY 0 次    peak=0.65
大提琴   GMPLAY 91 次  全部带循环     peak=0.40
变调     C4=1.000  E4=1.260  G4=1.498  ✓
```

### 二、音色归属：用户选的优先于 MIDI 文件

**问题**：几乎所有 MIDI 开头都发 `Program Change → 0`（钢琴）。想用大提琴拉一首钢琴曲，
第一个音会先响一声钢琴，0.1 秒后 `/preset` 轮询又把音色拉回来。

**规则**（`PianoWindow.cs`）：

| 用户选的乐器 | 遇到文件里的 Program Change |
|---|---|
| 非钢琴 | **忽略**，保持用户选的 |
| 钢琴 | 跟随文件（多轨换音色才有意义） |
| 文件改成另一个非钢琴音色 | 照做（那是真实换乐器） |

日志写明判断过程：`EVPROG 忽略文件里的 pg=0，保持 10（用户选的）`。

**权威顺序**也理顺了：宿主 `/preset` > `settings.json`。
之前两者打架 —— 启动读 `settings.json` 设成 10，轮询发现宿主是 20 又切回去，
用户看到的是"音色记不住"。现在宿主一表态就覆盖，并记录：

```
PRESET -> 10 Music Box（覆盖启动时的 20，以宿主为准）
```

`forceProgram` 改成**一次性开关**：读完立刻从 `settings.json` 删掉。
否则它留在文件里，`piano_instrument` 切任何音色都会失效，而界面上看不出来。

### 三、导出（离线渲染 WAV）

**新增工具** `piano_export`，把当前队列渲染成 WAV。

| | 实时播放 | 离线渲染 |
|---|---|---|
| 4 分钟的歌 | 等 4 分钟 | **约 1~3 秒** |
| 系统卡顿 | 会掉帧 | 不影响 |
| 结果 | 每次略有不同 | 完全可复现 |

**关键设计**：`MixVoice()` 实时和离线共用同一套包络/滤波/循环代码，
所以导出的声音和听到的一模一样，不存在"两套合成器"。

**`--render-only` 模式**（`PianoWindow.cs`）：不建窗口、不打开 waveOut、不发声，
取任务 → 渲染 → 回调 → 自己退出。**导出跟窗口开没开、有没有在播全都无关了。**

**默认输出目录**：Windows 下载文件夹（问系统 `GetFolderPath('UserProfile')`，
考虑 OneDrive 重定向）。支持 `dir` 参数或完整路径。

**踩过的坑**

1. **`RIFF` 长度字段从没填**（一直是 0）—— 导出的文件**根本不是合法 WAV**，
   Python `wave` 报 `not a WAVE file`，播放器也打不开。这是个长期潜伏的 bug。
2. **`resolveExportPath` 定义在 `handle()` 里** —— `piano_export` 在 `apply()` 内，够不到，
   报 `is not defined`。移到模块级。
3. **参数解析 `i < args.Length - 1`** —— 最后的 `--render-only` 永远读不到，
   EXE 建了窗口但没进渲染分支，静默失败。
4. **`req.Headers["Expect"] = ""`** —— `Expect` 是受限标头，赋值直接抛异常，
   回调静默失败。去掉这行（`Expect100Continue = false` 已经够了）。
5. **导出强制要窗口** —— 顺序反了：先查 origin 再查进程，EXE 在跑也报"起不了窗口"。
   改成**先查进程**（在跑就直接复用）。
6. **卡死的任务清不掉** —— 超时判断写在"已派发"之前，一旦派发过就永远 `return id:null`。
   改成超时先清、新任务能顶掉超过 90 秒的死任务。

**验证**

```
render-only 模式：3.1 秒渲染 42.7 秒音频
回调      {id: ro5, ok: true, seconds: 42.69}
文件      3.59 MB  44100Hz 单声道 16bit  42.7 秒
峰值      0.755 满度（不削波）
```

### 四、播放立即生效

**问题**：连着弹两次，第二次会等第一次放完才响。

**根因两处**：

1. `lib/engine.js` 的 `base = Math.max(now + leadMs, last.t)` —— 新播放接在上一批之后
2. `PianoWindow.cs` 只在**文件名变了**时才清队列；简谱没有 `file` 字段，
   `fileTag` 恒为空 → **永远不清**

**修法**：`playText` 里加 `engine.stop()`（覆盖 5 个调用点）；
EXE 改成**序号前进了就清**（每次 `schedule` 都会推 seq）。

### 五、窗口行为

**① 默认吸附**

`LoadSnapSetting()` 缺字段返回 `true`。钢琴是挂在 DSH 上的附属窗口，浮着会盖内容。

**② 上方空间不足时穿出屏幕**

`ChooseTop()` 三级判断：

```
1. 上方放得下 → 贴上方
2. 上方放不下，下方放得下 → 贴下方
3. 两边都挤 → 贴上方，允许超出屏幕顶（DSH 不动）
```

**关键**：`WndProc` 拦截 `WM_WINDOWPOSCHANGING`，给 `WINDOWPOS.flags` 打上 `SWP_NOMOVE`。
否则系统会把负坐标窗口拉回可见区：

```
SETCHECK   want T=-70  got T=-70  ✓     设置成功
LATECHECK  t0=-70  now=40  ← 后来被改了   250ms 内被系统拉回
```

**曾经搞错过**：一度改成"把 DSH 往下推"，那是把从属关系搞反了 ——
DSH 是主应用，用户摆在哪就是哪。

**③ 播放时自动拉起窗口**

`ensureWindow()`：没起窗口就先起，否则音排了但没人放。接到 `playText` / `piano_midi` /
`/upload-midi` 三处。顺序是**先查进程再查 origin**（origin 只是启动参数）。

### 六、界面

**工具栏**：`[● 钢琴] [▼ 0 · Grand Piano] [MIDI]`

**乐器选择器**改成自绘下拉（原生 `<select>` 的列表是系统画的，管不了滚动位置）：

- 搜索（打 `violin` / `弦乐` / 编号）
- 记住滚动位置（`localStorage`）
- 分类吸顶
- `Ctrl+↑` / `Ctrl+↓` 切上一个/下一个

快捷键在聊天输入框里不生效；用 `curRef` 读当前值，不在 `setState` 回调里发请求
（严格模式会重复执行）；`lastUserPickRef` 防止轮询把刚切的音色覆盖回去。

**MIDI 导入按钮**：宽度固定 52px，文字恒为 `MIDI`（原来忙态换成"读取中…"会让整排工具栏抖）；
结果不显示"多少音/多少秒"（播放时用不上，还占位置）。

**按钮圆点变绿**：轮询 `1500ms → 800ms`；MIDI 导入后立即 `refreshWindowState()`。

### 七、其他

- `install.ps1`：编译命令补上 `GmEngine.cs`（漏了它新用户装不上）；加 GM 音源检查与导出提示
- `package.json`：`2.1.0 → 2.2.0`；`files` 从 `assets` 改成精确路径（避免把 838 MB 导出目录打进包）
- `COMMERCIAL.md`：补第三方音源许可表（FluidR3 MIT / Salamander CC BY 3.0）
- `README.md`：8.9 KB → 14 KB，新增「界面」「导出」「音色优先级」「循环长度校验」章节，重写目录结构

### 新增乐谱

- `scores/晨雾微光.score` —— C 大调 66 BPM，雾的意象
- `scores/逆流之城.score` —— A 小调 126 BPM，400 音，十六分音符跑动 + 三音和弦
- `scores/潮汐之外.score` —— D 大调 74 BPM，五声音阶波浪线，导出测试用的那首
