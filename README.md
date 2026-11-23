# 璇泽 · DSH 钢琴（dsh-piano）

一台标准 **88 键**电脑钢琴，挂载在 DeepSeek Harness 上。

**核心不是"能响"，是"能把一份乐谱变成一首歌"**：AI 写一份乐谱文本（或直接读一份
MIDI 文件）→ 插件解析成时间轴 → 按标准钢琴音色弹出来。谱就是歌，文件就是作品。

---

## 快速开始（Windows）

**三步**，不需要装 Node、不需要编译：

```powershell
git clone https://github.com/XuanzeNetDev/dsh-piano.git
cd dsh-piano
.\install.ps1          # 链接到 DSH profile + 检查音源 + 编译缺失的 EXE
```

然后重启 DSH，在插件列表里启用「DSH 钢琴」。网页右下角出现「● 钢琴」胶囊。

### 依赖情况

**零外部依赖**：

| 需要 | 说明 |
|---|---|
| **Node.js** | DSH 自带，无需另装 |
| **.NET Framework 4.x** | Windows 10/11 自带，用于跑 `tools/PianoWindow.exe` |
| **Python 3** | **只有重新提取音源时**才需要；88 个 wav 已入库，正常使用不需要 |
| **npm 包** | **无**（`dependencies` 和 `devDependencies` 都是空，只用 `node:` 内置模块） |

### `install.ps1` 做了什么

1. 找到 `%USERPROFILE%\.dsh\profiles\desktop`
2. 把本仓库链接成 `node_modules\dsh-piano-xz`（用符号链接，改代码即时生效）
3. 检查 `assets/yup/wav/` 里是否 88 个 wav
4. 检查 `tools/PianoWindow.exe`，缺了就现场用 `csc.exe` 编译
5. 全部就绪后提示重启 DSH

### 如果 install.ps1 跑不了

手动两步：

```powershell
# 1. 链接
cmd /c mklink /D "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-piano-xz" "<本仓库路径>"

# 2. 编译播放器（如果 tools\PianoWindow.exe 不存在）
cd tools
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /optimize+ `
  /out:PianoWindow.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll `
  PianoWindow.cs PianoAudio.cs
```

---
## 三个"标准"

### 1. 键盘是标准钢琴

- 88 键，A0–C8，52 白键 + 36 黑键
- 白键等宽，黑键按真钢琴的比例压在键缝上：**C# 偏左、D# 偏右、F# 偏左、A# 偏右、G# 居中**
  （把黑键一律画在键缝正中间是"画着玩"，不是钢琴）
- 每个 C 标音名（C1…C8）；窗口宽度变化时**整排琴键等比伸缩**

### 2. 音是标准钢琴音

播放器用 **Yamaha Upright**（Polyphone / isamorphic.net，公有领域）的真实录音，
**88 键每键一个独立采样**，48 kHz 原始、提取时重采样到 44.1 kHz 单声道。

**每键独立采样的意义**：变调率恒为 `1.0`，也就是"读一个输出样本 = 读一个采样样本"。
不存在抽取、不存在插值、不存在混叠，所以低音区不会有那种"格子卡住"的阶梯感。

信号链（`tools/PianoAudio.cs`）：

| 环节 | 处理 |
|---|---|
| 重采样 | `rate = 1.0`，直接取整（不需要插值） |
| 防混叠 | 二级级联高通 90 Hz（12 dB/oct） |
| 琴槌噪声 | 低通 7–9 kHz（mdaPiano 压到 210 Hz 那种"闷"是另一个极端） |
| 直流 | 输出端 10 Hz DC blocker |
| 包络 | 8 ms 淡入 + 指数衰减 + 末尾 40 ms 线性淡出 |
| 复音 | 24 上限，超限偷最老的声部 |
| 输出 | winmm `waveOut`，1024 帧 × 3 块环形缓冲（约 70 ms 延迟） |

网页端另外带一套 **Salamander Grand Piano V3**（30 个采样点，CC BY 3.0），
用作浏览器内直接试听；采样没就绪时有物理建模合成兜底（16 次泛音各自衰减）。

### 3. 谱是标准简谱

照纸上那种简谱抄，双手分开写：

```
tempo 100
key 1=B3
unit 0.5
dyn 100

[RH]
3 2 6' 2' | 3 2 6' 2'

[LH]
4, 1, 4, 5, 6, r | 5, 2, 5, 6, 7, r
```

| 记号 | 含义 |
|---|---|
| `1`–`7` | 级数（可带 `#` / `b`） |
| `'` / `,` | 升 / 降八度（可叠） |
| `:n` | 占 n 拍 |
| `@v` | 单独给力度 |
| `+` | 同时按（和弦） |
| `-` | 延长一拍 |
| `r` / `0` | 休止 |
| `[RH]` / `[LH]` | 右手 / 左手声部 |
| `tempo` `key` `unit` `dyn` | 速度 / 调号 / 单记号拍数 / 默认力度（`ppp`…`fff` 或数字） |

MIDI 文件也直接支持（`piano_midi`），会读 tempo map、拍号、调号、分轨。

---

## 两个形态

```
┌─ DSH 网页 ─────────────────────┐
│  右下角「● 钢琴」胶囊            │
│  ├─ 点一下 → 弹出独立窗口       │
│  └─ 再点一下 → 关掉             │
└────────────────────────────────┘
              │ HTTP /events
              ▼
   PianoWindow.exe（独立置顶窗口）
   ├─ 88 键渲染 + 高亮
   ├─ waverOut 实时合成
   └─ 可吸附在 DSH 上方
```

**为什么需要独立窗口**：浏览器标签页切到后台或面板收起时，`requestAnimationFrame`
会被节流，音乐就断了。独立进程不受影响。

### 独立窗口

- **吸附按钮**（右上角）：默认关，钢琴可自由拖动；开启后**贴住 DSH 上方、
  置顶、锁定不可拖**，宽度跟随 DSH，状态存进 `settings.json` 持久化
- **暂停 / 继续**：冻结时间轴（`pauseOffset`），恢复后从原地继续，不跳
- **调号 `◀ 1=B(0) ▶`**：点箭头在 12 个调之间循环
- **拍号 / 速度**：可点，左键加、右键减

---

## 安装

```bash
# 从工作区链接到 profile
cd ~/.dsh/profiles/desktop
npm link F:/work/.../dsh-piano
```

或把整个 `dsh-piano` 目录复制到
`~/.dsh/profiles/desktop/node_modules/dsh-piano-xz`。

启用后在 DSH 插件列表里打开，网页右下角会出现「● 钢琴」胶囊。

### 编译独立窗口

`tools/PianoWindow.exe` **不入库**（二进制），从源码现场编译：

```powershell
cd tools
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe `
  /target:winexe /optimize+ /out:PianoWindow.exe `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll `
  PianoWindow.cs PianoAudio.cs
```

依赖 .NET Framework 4.x（Windows 自带，无需另装）。

### 还原音源

`assets/yup/*.sf2`（169 MB）超过 GitHub 单文件上限，**不进版本库**。

```
assets/yup/wav/          ← 88 个 .wav，已入库（22 MB），直接用
assets/yup/*.sf2         ← 需要时才下，用脚本提取
```

重新提取：

```bash
# 1. 下载 Yamaha Upright.sf2（约 170 MB）
#    https://isamorphic.net  →  或搜索 "Yamaha Upright soundfont Polyphone"

# 2. 提取 medium 层的 88 个键，重采样到 44100 单声道
python tools/extract-sf2.py
```

---

## 工具（Host 侧）

| 工具 | 作用 |
|---|---|
| `piano_score` | 把简谱文本写成 `.score` 文件并演奏 |
| `piano_play` | 直接弹一段简谱（不落盘） |
| `piano_midi` | 播放 `.mid` 文件（支持 `tempoScale` / `transpose` / 选轨） |
| `piano_piece` | 内置曲目（小星星、欢乐颂、致爱丽丝、卡农…） |
| `piano_stop` | 立刻静音 |
| `piano_status` | 队列状态、下一个音、键盘范围 |

HTTP 前缀：`/api/dsh-piano-xz`

---

## 目录结构

```
dsh-piano/
├── index.js              Host 侧：6 个工具 + HTTP 路由（985 行）
├── client.js             浏览器侧：88 键渲染 + Web Audio（1676 行）
├── cordis.patch.yml      插件挂载点
├── package.json
├── icon.svg
├── lib/
│   ├── notation.js       简谱解析（379 行）
│   ├── midi.js           MIDI 解析 + tempo map（329 行）
│   ├── engine.js         事件队列 / 调度（180 行）
│   ├── notes.js          音名 ↔ MIDI（199 行）
│   └── score.js          谱面读写（131 行）
├── tools/
│   ├── PianoWindow.cs    独立窗口 WinForms（1701 行）
│   ├── PianoAudio.cs     waveOut 实时合成（574 行）
│   └── extract-sf2.py    SoundFont → 88 个 wav
├── assets/
│   ├── piano/            Salamander mp3（网页试听用）
│   └── yup/wav/          Yamaha 88 键采样（EXE 发声用）
├── scores/               示例乐谱与 MIDI
├── locale/               zh / en
└── LICENSE
```

---

## 键盘映射（独立窗口）

主键盘四排 + 小键盘，覆盖 **C2–B7（6 个八度）**：

```
Z排   Z=C2  X=D2  C=E2  V=F2  B=G2  N=A2  M=B2
A排   A=C3  S=D3  D=E3  F=F3  G=G3  H=A3  J=B3
Q排   Q=C4  W=D4  E=E4  R=F4  T=G4  Y=A4  U=B4
1排   1=C5  2=D5  3=E5  4=F5  5=G5  6=A5  7=B5

Num1=C6  Num2=D6  Num3=E6  Num4=F6  Num5=G6  Num6=A6  Num7=B6
Num8=C7  Num9=D7  Num/ =E7  Num* =F7  Num- =G7  Num+ =A7  Num. =B7
```

黑键：**Shift + 该白键**（`Shift+Z` = C♯2）。

> 只在窗口有焦点时响应。不做全局钩子 —— 那会吞掉 `Q W E 2 3` 这些打字键。

---

## 致谢与音源许可

| 资源 | 作者 / 来源 | 许可 |
|---|---|---|
| **Yamaha Upright** SoundFont | Polyphone / isamorphic.net | 公有领域 |
| **Salamander Grand Piano V3** | Alexander Holm | CC BY 3.0 |
| 简谱 / MIDI 解析、窗口、合成 | 璇泽 | 见 LICENSE |

---

## 许可

**PolyForm Noncommercial License 1.0.0** —— 源码开放，**不可商用**。

- ✅ 个人学习、研究、爱好项目、教学、非营利组织使用
- ✅ 修改、分发（需保留本许可与版权声明）
- ❌ 任何有商业预期的使用

完整条款见 [LICENSE](LICENSE)。

