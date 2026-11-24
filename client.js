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
    /** 调试日志：只在 window.__dpDebug 为真时输出（原来用于音频排查，留着给轮询用）。 */
    const dlog = (line) => {
      if (!window.__dpDebug) return
      try { console.log('[dsh-piano] ' + line) } catch { /* 忽略 */ }
    }

    /* ───────── 浏览器侧不再发声（已废弃）─────────
     *
     * 这里原来是约 550 行的 Web Audio 引擎：
     *   ensureAudio / IndexedDB 采样缓存 / loadSample / preloadSamples
     *   playSampleVoice / strike / synthVoice（物理建模）/ cutAll
     *   SAMPLE_POINTS / SAMPLE_PEAK_DB / loudnessTrim（响度补偿表）
     *
     * 为什么删：
     *   1. EXE（PianoWindow.exe）是唯一的发声者 —— 它有 Yamaha 88 键每键采样
     *      和 GM 128 音色，音质和延迟都比这里好。
     *   2. 两边同时发声就是重奏：同一个音从系统和浏览器各出一次。
     *   3. 这套引擎依赖 assets/piano/ 下 178 个 mp3（16 MB），
     *      只为这条废弃路径服务。
     *
     * 现在网页侧只做两件事：点灯（看琴键按下）+ 工具栏（开关/选乐器/导入 MIDI）。
     * 声音一律由 EXE 出。
     */


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

      // 音量滑块只记用户偏好，不再驱动任何音频 —— 声音是 EXE 发的，
      // 它的输出音量由系统混音器控制。这个值留着，将来若给 EXE 传音量可以用上。
      React.useEffect(() => {
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

      /**
       * 把一条事件变成「灯」。
       *
       * 原来这里还会调 strike() 让浏览器发声 —— 已经去掉了：
       * EXE 是唯一发声者，网页这边只负责把琴键点亮，
       * 否则同一个音会从系统和浏览器各响一次。
       */
      const fireEvent = React.useCallback(
        (e, dueSec) => {
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
       * 事件入口：直接进调度窗口。
       *
       * 原来要先过一遍 AudioContext 状态检查（挂起就把事件攒着等用户手势唤醒）——
       * 那是给「浏览器发声」准备的。现在只点灯，没有 AudioContext 也就没有挂起，
       * 直接排就是。
       */
      const onEvents = React.useCallback(
        (events, serverNow, label) => {
          if (!events.length) return
          if (label) setNowPlaying(label)
          scheduleBatch(events, serverNow, label)
        },
        [scheduleBatch],
      )

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

      /**
       * 鼠标点键：只点灯，不发声。
       *
       * 想听声音就用独立窗口上的键盘（Z X C V B N M），
       * 那边是 EXE 在发声，音色和采样都是真的。
       */
      const press = React.useCallback(
        (midi) => {
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
        setNowPlaying(title)
        fetch(API + '/play', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        }).catch(() => {})
      }

      const stopAll = () => {
        clearLights()
        pendingEvents.current = []
        clock.current = { serverNow: 0, at: 0 }
        setPlaying(false)
        setNowPlaying('')
        fetch(API + '/stop', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
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
            { 'data-dp-card': '', onClick: () => setHint(false) },
            h(
              'div',
              { 'data-dp-head': '' },
              h('span', { 'data-dp-title': '' }, '♪'),
              h('span', { 'data-dp-sub': '' }, playing
                ? (nowPlaying || '正在演奏')
                : '钢琴'),
              h('span', { 'data-dp-grow': '' }),
              hint ? h('span', { 'data-dp-hint': '' }, '声音由独立窗口发出') : null,
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
