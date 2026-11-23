// DSH 钢琴独立窗口
//
// 为什么单独写成 exe：
//   PowerShell + WinForms 那版每次启动都要现编译脚本，双缓冲还得反射绕 protected，
//   画起来一明一暗地闪。编译成 exe 之后：双缓冲是原生的、启动是一瞬间、
//   单例/吸附/定位全在自己的代码里，不受任何宿主限制。
//
// 职责：看得见 + 听得到。发声由本进程的 PianoAudio 负责（winmm waveOut + 自己混音），
// 不依赖 DSH 页面里的 WebAudio —— 网页没开、没点击激活也照样出声。
// 宿主只提供事件队列（/events），窗口按事件里的 t（该响的绝对毫秒）自己排时间轴。
//
// 编译：csc /target:winexe /out:PianoWindow.exe /r:System.Web.Extensions.dll PianoWindow.cs

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace DshPiano
{
    /// <summary>
    /// 物理键盘 → 半音偏移 的映射（虚拟键码 → 相对基准音的半音数）。
    /// 布局原则：白键一排、黑键一排（Virtual Piano / Online Pianist 的通用做法），
    /// 而不是 EOP 的简谱 1-2-b3-4-5-6-b7 —— 后者一个八度只有 7 个音，缺 5 个半音，
    /// Flower Dance 里那些 D#/C#/G# 根本按不出来。
    ///
    ///   左手  Z X C V B N M   = C3..B3 白键
    ///         S D   G H J     = C#3 D#3 F#3 G#3 A#3
    ///   右手  Q W E R T Y U   = C4..B4 白键
    ///         2 3   5 6 7     = C#4 D#4 F#4 G#4 A#4
    ///   小键盘 7 8 9 / 4 5 6  = C5..B5 高音延伸
    /// </summary>
    /// <summary>
    /// 物理键盘 → MIDI 音高。
    ///
    /// 布局：左手铺满键盘左侧四排，右手铺满小键盘，全部键都用上，
    /// 每一排**按半音顺序连续**接上一排（不是每排重新起一个八度），
    /// 这样 55 个键连起来能覆盖 4 个多八度，不会出现"某个键没用"。
    ///
    ///   左手  Z X C V B N M , . /   = C3 起，连续 10 个半音
    ///         A S D F G H J K L ;   = 接上，连续 10 个
    ///         Q W E R T Y U I O P   = 再接 10 个
    ///         1 2 3 4 5 6 7 8 9 0   = 再接 10 个
    ///   右手  小键盘 7 8 9 / 4 5 6 * 1 2 3 - 0 . +  = 高八度继续
    ///
    /// 用 ← → 整体移八度。
    /// </summary>
    /// <summary>
    /// 物理键盘 → MIDI 音高。**完全照搬 Everyone Piano 的思路**：
    /// 每排 = 一个八度的白键（7 个），三排 = 三个八度，八度靠切换。
    /// EOP 的「键位映射3.ini」原文：
    ///     [C2] 1=Z 2=X 3=C 4=V 5=B 6=N 7=M
    ///     [C3] 1=A 2=S 3=D 4=F 5=G 6=H 7=J
    ///     [C4] 1=Q 2=W 3=E 4=R 5=T 6=Y 7=U
    ///
    /// 在此基础上补两件事（EOP 那套弹不了带黑键的曲子）：
    ///   1. Shift + 该白键左侧的键 = 黑键（Shift+Z = C#2，Shift+X = D#2 …）
    ///   2. 小键盘 + 数字排做更高八度
    /// </summary>
    static class KeyMap
    {
        /// <summary>基准：Z 排对应 C2。</summary>
        public const int BaseMidi = 36;

        /// <summary>白键行：每行 7 个，行内音程 0 2 4 5 7 9 11（大调音阶）。</summary>
        static readonly int[][] WhiteRows =
        {
            new int[] { 'Z','X','C','V','B','N','M' },            // C2 八度
            new int[] { 'A','S','D','F','G','H','J' },            // C3 八度
            new int[] { 'Q','W','E','R','T','Y','U' },            // C4 八度
            new int[] { '1','2','3','4','5','6','7' },            // C5 八度
            // 小键盘：按数字顺序 1..7 正好一个八度（do re mi fa sol la si）
            new int[] { 0x61,0x62,0x63,0x64,0x65,0x66,0x67 },     // Num1..Num7 = C6 八度
            // 8、9 接着往上两个音，再和旁边那排符号键拼成下一个八度
            new int[] { 0x68,0x69,0x6F,0x6A,0x6D,0x6B,0x6E },     // Num8 Num9 / * - + . = C7 起
        };

        static readonly int[] MajorSteps = { 0, 2, 4, 5, 7, 9, 11 };

        public static readonly Dictionary<int, int> Semitone = BuildWhite();
        static readonly Dictionary<int, int> ShiftSemitone = BuildShift();
        static readonly Dictionary<int, string> Names = BuildNames();

        static Dictionary<int, int> BuildWhite()
        {
            var d = new Dictionary<int, int>();
            for (int r = 0; r < WhiteRows.Length; r++)
            {
                var row = WhiteRows[r];
                for (int i = 0; i < row.Length; i++)
                {
                    int semi = r * 12 + MajorSteps[i];
                    if (!d.ContainsKey(row[i])) d[row[i]] = semi;
                }
            }
            return d;
        }

        /// <summary>
        /// Shift + 键 = 该键右侧的黑键。
        /// 白键映射到音阶 0 2 4 5 7 9 11，缺的黑键是 1 3 6 8 10，
        /// 分别对应"前一个白键的 Shift"：Shift+Z=1(C#), Shift+X=3(D#),
        /// Shift+V=6(F#), Shift+B=8(G#), Shift+N=10(A#)。
        /// </summary>
        static Dictionary<int, int> BuildShift()
        {
            var d = new Dictionary<int, int>();
            // 每行内，第 i 个键的 Shift = 该白键 +1 半音（若正好是黑键）
            int[] blackAfterIdx = { 0, 1, 3, 4, 5 };    // 0→1, 1→3, 3→6, 4→8, 5→10
            for (int r = 0; r < WhiteRows.Length; r++)
            {
                var row = WhiteRows[r];
                foreach (int i in blackAfterIdx)
                {
                    if (i >= row.Length) continue;
                    int semi = r * 12 + MajorSteps[i] + 1;
                    if (!d.ContainsKey(row[i])) d[row[i]] = semi;
                    if (!Semitone.ContainsKey(row[i]) || true) { }
                }
            }
            return d;
        }

        static Dictionary<int, string> BuildNames()
        {
            var d = new Dictionary<int, string>();
            foreach (var row in WhiteRows)
                foreach (var vk in row)
                    if (!d.ContainsKey(vk)) d[vk] = VkName(vk);
            foreach (var kv in new Dictionary<int,int>(ShiftSemitone))
                if (!d.ContainsKey(kv.Key)) d[kv.Key] = VkName(kv.Key);
            return d;
        }

        static string VkName(int vk)
        {
            if (vk >= 'A' && vk <= 'Z') return ((char)vk).ToString();
            if (vk >= '0' && vk <= '9') return ((char)vk).ToString();
            if (vk >= 0x60 && vk <= 0x69) return ((char)('0' + (vk - 0x60))).ToString();
            return "?";
        }

        public static bool IsNumpad(int vk) { return vk >= 0x60 && vk <= 0x6F; }

        /// <summary>查这个键（含 Shift 与否）对应的半音。没有映射返回 false。</summary>
        public static bool TryGet(int vk, bool shift, out int semi)
        {
            if (shift && ShiftSemitone.TryGetValue(vk, out semi)) return true;
            return Semitone.TryGetValue(vk, out semi);
        }

        public static int MaxSemitone { get { return (WhiteRows.Length - 1) * 12 + 11; } }

        public static string NameOfSemitone(int semi, out bool isBlack)
        {
            isBlack = false;
            // 白键
            for (int r = 0; r < WhiteRows.Length; r++)
                for (int i = 0; i < WhiteRows[r].Length; i++)
                    if (r * 12 + MajorSteps[i] == semi)
                        return VkName(WhiteRows[r][i]);
            // 黑键（Shift 组合）
            foreach (var kv in ShiftSemitone)
                if (kv.Value == semi) { isBlack = true; return VkName(kv.Key); }
            return "";
        }
    }

    static class Native
    {
        public delegate bool EnumProc(IntPtr h, IntPtr l);

        // ── 低级键盘钩子 ──
        // EOP 用的就是这个：WH_KEYBOARD_LL 是唯一能拿到 Win 键、Alt+Tab、
        // 以及窗口失焦时按键的方式。普通 KeyDown 只能收到焦点窗口里的键。
        public delegate IntPtr KbdProc(int nCode, IntPtr wParam, IntPtr lParam);
        public const int WH_KEYBOARD_LL = 13;
        public const int WM_KEYDOWN = 0x0100;
        public const int WM_KEYUP = 0x0101;
        public const int WM_SYSKEYDOWN = 0x0104;
        public const int WM_SYSKEYUP = 0x0105;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, KbdProc lpfn, IntPtr hMod, uint dwThreadId);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);
        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")]
        public static extern IntPtr GetModuleHandle(string lpModuleName);

        public delegate bool EnumProc2(IntPtr h, IntPtr l);
        // ── 窗口位置事件钩子 ──
        // 轮询（哪怕 30ms）快速拖动时一定会滞后；事件驱动是 DS H 一动就回调，零延迟。
        public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
        public const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
        public const int OBJID_WINDOW = 0;
        public const int CHILDID_SELF = 0;
        public const uint WINEVENT_OUTOFCONTEXT = 0x0000;
        public const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
        [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(
            uint eventMin, uint eventMax, IntPtr hmod, WinEventProc proc,
            uint idProcess, uint idThread, uint flags);
        [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr h);

        // 擦掉窗口旧位置那块区域（NOREDRAW 移动后会残留，所以要手动擦）
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);

        // DWM 扩展边框：返回"肉眼可见"的真实边界（不含被系统隐藏的不可见边框）。
        // Win10/11 的窗口有 7px 左右的不可见边框，GetClientRect / GetWindowRect 给的
        // 都比实际可见区域偏一点，对齐就会留缝。这个才是准的。
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(
            IntPtr hwnd, int attr, out RECT value, int size);
        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        
        [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
        public struct POINT { public int X, Y; }
        [DllImport("user32.dll")] public static extern bool RedrawWindow(
            IntPtr hWnd, IntPtr lprcUpdate, IntPtr hrgnUpdate, uint flags);
        public const uint RDW_INVALIDATE = 0x0001;
        public const uint RDW_ERASE = 0x0004;
        public const uint RDW_ALLCHILDREN = 0x0080;
        public const uint RDW_UPDATENOW = 0x0100;

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
        public static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
        public static extern IntPtr SetWindowLongPtr(IntPtr h, int idx, IntPtr val);
        public const int GWL_STYLE = -16;
        public const long WS_CAPTION = 0x00C00000L;
        public const long WS_SYSMENU = 0x00080000L;

        [DllImport("user32.dll")] public static extern bool SetWindowPos(
            IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
        // SWP_NOREDRAW：移动/改变尺寸时不重绘客户区。
        // 画面内容没变、只是位置变了，重画整个键盘纯属浪费 —— 这就是拖动卡的根源。
        public const uint SWP_NOREDRAW = 0x0008;
        public const uint SWP_NOZORDER = 0x0004;
        public const uint SWP_NOACTIVATE = 0x0010;
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_FRAMECHANGED = 0x0020;
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
        [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        
        
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        public const uint WM_CLOSE = 0x0010;

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int L, T, R, B; }

        /// <summary>按标题子串找可见窗口，返回句柄（找不到为 Zero）。</summary>
        public static IntPtr Find(string contains, int minWidth = 0)
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows((h, l) =>
            {
                if (!IsWindowVisible(h)) return true;
                var sb = new StringBuilder(512);
                GetWindowText(h, sb, 512);
                if (sb.ToString().IndexOf(contains, StringComparison.OrdinalIgnoreCase) < 0) return true;
                if (minWidth > 0)
                {
                    RECT r;
                    if (!GetWindowRect(h, out r) || (r.R - r.L) < minWidth) return true;
                }
                found = h;
                return false;
            }, IntPtr.Zero);
            return found;
        }

        public static Rectangle Bounds(IntPtr h)
        {
            RECT r;
            if (!GetWindowRect(h, out r)) return Rectangle.Empty;
            return new Rectangle(r.L, r.T, r.R - r.L, r.B - r.T);
        }
    }

    sealed class Key
    {
        public int Midi;
        public bool Black;
        public float X;
        public float W;
    }

    sealed class PianoForm : Form
    {
        const int MIN = 21, MAX = 108;
        static readonly int[] WhitePc = { 0, 2, 4, 5, 7, 9, 11 };
        static readonly string[] Names = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };

        readonly string api;
        readonly List<Key> keys = new List<Key>();
        readonly Dictionary<int, Lit> lit = new Dictionary<int, Lit>();
        readonly object gate = new object();

        /// <summary>待播音符：宿主一次可能给几百条，必须按 t 到点才响，不能一收到就播。</summary>
        sealed class Pending { public long T; public int Midi; public double Vel; public long Dur; public int Hand; }
        /// <summary>点亮记录：结束时刻 + 哪只手（0 右 1 左）。</summary>
        sealed class Lit { public long Until; public int Hand; }
        readonly List<Pending> pending = new List<Pending>();
        System.Windows.Forms.Timer tickTimer;

        long skewMs;
        long seq;
        bool primed;
        long playFromMs, playToMs;      // 顶栏进度用
        string lastFile = "";           // 上一首的文件名（用于判断换曲）
        long lastSeq = 0;
        string nowPlaying = "";
        string scoreKey = "";        // 显示用：如 "1=B"（B 大调）
        string scoreTime = "";       // 显示用：如 "4/4"
        int scoreBpm = 0;
        int keyRoot = -1;            // 当前调的主音（0=C … 11=B），-1 表示未知
        int keyMode;                 // 0 大调 1 小调
        int transpose;               // 相对原调的移调量（半音），只用于发声
        int dragX, dragY;
        bool dragging;

        /// <summary>吸附距离：拖动结束时离主窗口边缘多近就自动对齐。</summary>
        const int SnapPx = 24;
        const int BarH = 36;   // 顶栏高度：26 太扁，文字挤在一起\n        const int BarPad = 6;

        Rectangle btnPlay, btnClose;    // btnPlay = 暂停/继续切换
        bool paused;
        long pumpTick;
        long pauseOffset;               // 累计暂停时长（毫秒）
        long pausedAt;                  // 本次暂停起点
        // 缓存的 GDI 对象。原来每帧给 88 个键各 new 一次 Font/Brush/GraphicsPath，
        // 一秒钟几十帧就是上千个临时对象，GC 一停画面就卡。
        readonly Font fName = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold);
        readonly Font fTitle = new Font("Microsoft YaHei UI", 8.5f);
        readonly Font fInfo = new Font("Microsoft YaHei UI", 8f);
        readonly Font fC = new Font("Segoe UI", 7f, FontStyle.Bold);
        readonly Font fMnem = new Font("Consolas", 7.5f, FontStyle.Bold);
        readonly Font fBtn = new Font("Segoe UI", 7.5f);
        readonly SolidBrush bName = new SolidBrush(Color.FromArgb(226, 234, 246));
        readonly SolidBrush bTitle = new SolidBrush(Color.FromArgb(104, 118, 138));
        readonly SolidBrush bBpm = new SolidBrush(Color.FromArgb(96, 108, 126));
        readonly SolidBrush bTime = new SolidBrush(Color.FromArgb(118, 132, 152));
        readonly SolidBrush bCoff = new SolidBrush(Color.FromArgb(132, 146, 168));
        readonly SolidBrush bCon = new SolidBrush(Color.FromArgb(250, 252, 255));

        Rectangle keyBadge;      // 调号整块
        Rectangle keyPrev, keyNext;   // 左右切换箭头（都用左键点）
        Rectangle timeBadge, bpmBadge;  // 拍号 / 速度（都可点）
        static readonly string[] TimeSigs = { "2/4", "3/4", "4/4", "5/4", "6/4", "3/8", "5/8", "6/8", "7/8", "9/8", "12/8" };
        int timeSigIdx = 2;             // 默认 4/4
        int bpmAdj;                     // 速度调整量（相对曲谱原速）

        static readonly Color BgTop = Color.FromArgb(13, 18, 25);
        static readonly Color CWhiteHi = Color.FromArgb(252, 254, 255);
        static readonly Color CWhiteLo = Color.FromArgb(214, 222, 234);
        static readonly Color CBlackHi = Color.FromArgb(72, 84, 104);
        static readonly Color CBlackLo = Color.FromArgb(8, 12, 18);
        static readonly Color CLeft = Color.FromArgb(37, 99, 235);
        static readonly Color CRight = Color.FromArgb(34, 197, 94);

        public PianoForm(string api, int height)
        {
            this.api = api;
            Text = "DSH 钢琴";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = true;
            BackColor = Color.FromArgb(11, 16, 23);
            KeyPreview = true;

            // 双缓冲：不开的话，88 个键是逐个画到屏幕上的，拖动窗口时会闪、会卡。
            // 这条是"拖起来丝滑"的关键。
            SetStyle(ControlStyles.OptimizedDoubleBuffer
                   | ControlStyles.AllPaintingInWmPaint
                   | ControlStyles.UserPaint, true);
            DoubleBuffered = true;
            ResizeRedraw = false;      // 改尺寸由 OnPaint 自己处理，别触发额外重绘
            // 关键：WinForms 默认按字体自动缩放，第二次创建时度量不同，
            // 230 会被拉成 260 多。关掉缩放，高度才是写死的那个数。
            AutoScaleMode = AutoScaleMode.None;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                     | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);

            PlaceAboveDsh(height);
            BuildKeys();
        }

        void PlaceAboveDsh(int height)
        {
            var dsh = Native.Find("DeepSeek Harness", 600);
            if (dsh != IntPtr.Zero)
            {
                var r = Native.Bounds(dsh);
                int w = Math.Max(700, r.Width - 16);
                int left = r.Left + (r.Width - w) / 2;
                int top = Math.Max(0, r.Top - height - 4);
                Bounds = new Rectangle(left, top, w, height);
            }
            else
            {
                Bounds = new Rectangle(100, 40, 1200, height);
            }
        }

        void BuildKeys()
        {
            int whites = 0;
            for (int m = MIN; m <= MAX; m++) if (Array.IndexOf(WhitePc, ((m % 12) + 12) % 12) >= 0) whites++;
            float kw = ClientSize.Width / (float)whites;
            float bw = kw * 0.62f;
            float[] offset = { 0f, -0.10f, 0f, 0.10f, 0f, 0f, -0.12f, 0f, 0f, 0f, 0.12f, 0f };

            keys.Clear();
            int wi = 0;
            for (int m = MIN; m <= MAX; m++)
            {
                int pc = ((m % 12) + 12) % 12;
                if (Array.IndexOf(WhitePc, pc) >= 0)
                {
                    keys.Add(new Key { Midi = m, Black = false, X = wi * kw, W = kw });
                    wi++;
                }
                else
                {
                    float x = wi * kw + offset[pc] * kw - bw / 2f;
                    keys.Add(new Key { Midi = m, Black = true, X = Math.Max(0, x), W = bw });
                }
            }
        }

        int barH = BarH;

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            var t = new System.Windows.Forms.Timer { Interval = 40 };   // 100ms 太钝，音符最多晚 100ms 才排进来
            t.Tick += (s, a) => Poll();
            t.Start();
            // 15ms 的播放泵：Poll 只入队，真正发声由它按 t 到点触发。
            // 之前直接在 Poll 里播，第一轮把几百条事件一口气全播了 —— 就是"一瞬间播完"。
            // 恢复上次的吸附状态
            snapped = LoadSnapSetting();
            if (snapped)
            {
                ApplyDragLock(true);
                ApplyTopMost(true);
            }

            StartFollow();
            tickTimer = new System.Windows.Forms.Timer { Interval = 8 };
            tickTimer.Tick += (s, a) => Pump();
            tickTimer.Start();
            Poll();
        }

        void Poll()
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    var json = Fetch(api + "/events?since=" + seq);
                    var ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                    var root = ser.Deserialize<Dictionary<string, object>>(json);
                    if (root == null || !root.ContainsKey("ok") || !(root["ok"] is bool) || !(bool)root["ok"]) return;

                    long hostNow = Convert.ToInt64(root["now"], CultureInfo.InvariantCulture);
                    long localNow = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    skewMs = hostNow - localNow;

                    // JavaScriptSerializer 还原出来的 JSON 数组是 ArrayList，不是 object[]，
                    // 直接用 as object[] 会得到 null —— 之前 EXE 因此从来没播过任何事件。
                    long snapshotSeq = root.ContainsKey("seq") ? Convert.ToInt64(root["seq"], CultureInfo.InvariantCulture) : 0;
                    var evs = root.ContainsKey("events") ? root["events"] as System.Collections.IList : null;
                    if (evs == null)
                    {
                        Audio.Log("POLL since=" + seq + " events 字段缺失或类型不对");
                        return;
                    }
                    Audio.Log("POLL since=" + seq + " evs=" + evs.Count + " primed=" + primed);

                    lock (gate)
                    {
                        if (!primed)
                        {
                            // 第一次轮询要照常处理。
                            // 早先这里是"只对齐序号、不播、直接 return"，但宿主的 /events
                            // 每次请求都会把游标推到最新 seq —— 这么一 return，整批事件就被
                            // 消耗掉了，之后再也取不到，表现就是"完全没声音"。
                            // 已经过期的音会被下面的 endLocal > cur 自然滤掉，不用担心炸响。
                            seq = 0;
                            primed = true;
                        }
                        foreach (var raw in evs)
                        {
                            var e = raw as Dictionary<string, object>;
                            if (e == null) continue;
                            long i = Convert.ToInt64(e["i"], CultureInfo.InvariantCulture);
                            if (i > seq) seq = i;
                            long d = Convert.ToInt64(e["d"], CultureInfo.InvariantCulture);
                            int m = Convert.ToInt32(e["m"], CultureInfo.InvariantCulture);
                            long cur = localNow + skewMs;
                            // 结束时刻必须用事件自己的开始时刻 t 来算。
                            // 原来写成 hostNow + d（服务器当前时间 + 时长），整首曲子是提前排好的，
                            // t 都在未来，算出来的"结束"比现在还早，于是绝大多数音被当成过期丢掉。
                            long t0 = e.ContainsKey("t") ? Convert.ToInt64(e["t"], CultureInfo.InvariantCulture) : cur;
                            long endLocal = t0 + d;
                            // 只播"现在还没开始"或"刚刚开始"的音。
                            // 宿主首次会吐上万条历史事件（t 全在过去），
                            // 不过滤就等于把整首曲子几秒内播完 —— 听感是"快进"。
                            // 200ms 的容差足够吸收轮询抖动，又不会把真正该响的音丢掉。
                            if (t0 < cur - 200) continue;
                            if (endLocal > cur)
                            {
                                double v = 0.8;
                                if (e.ContainsKey("v")) v = Convert.ToDouble(e["v"], CultureInfo.InvariantCulture);
                                // 宿主新版会带 h（左右手）；旧版没有就按音高兜底：
                                // 低于 C4 视为左手，否则右手。
                                int hand = e.ContainsKey("h") ? Convert.ToInt32(e["h"]) : (m < 60 ? 1 : 0);
                                pending.Add(new Pending { T = t0, Midi = m, Vel = v, Dur = d, Hand = hand });
                            }
                        }
                        if (root.ContainsKey("label") && root["label"] is string) nowPlaying = (string)root["label"];
                        // 曲子的调号 / 拍号 / 速度
                        if (root.ContainsKey("score") && root["score"] is Dictionary<string, object>)
                        {
                            var sc = (Dictionary<string, object>)root["score"];
                            if (sc.ContainsKey("key") && sc["key"] is Dictionary<string, object>)
                            {
                                var k = (Dictionary<string, object>)sc["key"];
                                string nm = k.ContainsKey("name") ? Convert.ToString(k["name"]) : "";
                                if (!string.IsNullOrEmpty(nm)) scoreKey = nm;
                                // sf(-7..7) + mi(0/1) → 主音 pitch class
                                if (k.ContainsKey("sf"))
                                {
                                    int sf = Convert.ToInt32(k["sf"]);
                                    int mi = k.ContainsKey("mi") ? Convert.ToInt32(k["mi"]) : 0;
                                    int[] majorRoot = { 11, 6, 1, 8, 3, 10, 5, 0, 7, 2, 9, 4, 11, 6, 1 };
                                    int[] minorRoot = { 8, 3, 10, 5, 0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10 };
                                    int idx = Math.Max(0, Math.Min(14, sf + 7));
                                    keyRoot = mi == 1 ? minorRoot[idx] : majorRoot[idx];
                                    keyMode = mi;
                                }
                            }
                            if (sc.ContainsKey("timeSig") && sc["timeSig"] is Dictionary<string, object>)
                            {
                                var ts = (Dictionary<string, object>)sc["timeSig"];
                                int num = ts.ContainsKey("numerator") ? Convert.ToInt32(ts["numerator"]) : 0;
                                int den = ts.ContainsKey("denominator") ? Convert.ToInt32(ts["denominator"]) : 0;
                                if (num > 0 && den > 0) scoreTime = num + "/" + den;
                            }
                            if (sc.ContainsKey("bpm")) scoreBpm = Convert.ToInt32(sc["bpm"]);
                            // 换曲子（或同一首重弹）就清空旧队列。
                            // 不清的话，几次弹奏会叠在一起，音全挤在同一时间段响 —— 听感是"非常快"。
                            string fileTag = sc.ContainsKey("file") ? Convert.ToString(sc["file"]) : "";
                            long seqTag = snapshotSeq;
                            if (fileTag != lastFile || (seqTag != lastSeq && fileTag.Length > 0 && pending.Count == 0))
                            {
                                if (fileTag != lastFile)
                                {
                                    pending.Clear();
                                    lock (gate) lit.Clear();
                                    Audio.AllOff();
                                    paused = false; pauseOffset = 0; pausedAt = 0;
                                    playFromMs = 0; playToMs = 0;
                                    Audio.Log("NEWPIECE " + fileTag);
                                }
                                lastFile = fileTag;
                            }
                            lastSeq = seqTag;
                        }
                        if (pending.Count > 0)
                        {
                            playToMs = pending[0].T;
                            foreach (var pn in pending) if (pn.T > playToMs) playToMs = pn.T;
                            if (playFromMs == 0) playFromMs = pending[0].T;
                        }
                        primed = true;
                    }
                    BeginInvoke(new Action(Invalidate));
                }
                catch (Exception ex) { Audio.Log("POLLERR " + ex.GetType().Name + ": " + ex.Message); }
            });
        }

        /// <summary>
        /// 播放泵：每 15ms 看一次待播队列，到点的才交给音频引擎。
        /// 提前 25ms 发声 —— 定时器有抖动，卡在正点上反而会晚。
        /// </summary>
        /// <summary>
        /// 全局低级键盘钩子：让整个键盘（含 Win 键）都能当钢琴弹，窗口失焦也有效。
        /// 只吞我们映射过的键，其余一律放行 —— 否则系统快捷键会失效。
        /// </summary>
        void InstallKeyboardHook()
        {
            kbdProc = KbdCallback;
            kbdHook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, kbdProc,
                                              Native.GetModuleHandle(null), 0);
            Audio.Log("HOOK " + (kbdHook != IntPtr.Zero ? "已装" : "失败 err=" + Marshal.GetLastWin32Error()));
        }

        IntPtr KbdCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int vk = Marshal.ReadInt32(lParam);
                int msg = wParam.ToInt32();
                bool down = msg == Native.WM_KEYDOWN || msg == Native.WM_SYSKEYDOWN;

                // 八度切换：← 降、→ 升（范围 -2..+2）
                if (down && (vk == 0x25 || vk == 0x27))
                {
                    kbdOctave = Math.Max(-2, Math.Min(2, kbdOctave + (vk == 0x27 ? 1 : -1)));
                    Audio.Log("KBD octave=" + kbdOctave);
                    BeginInvoke(new Action(Invalidate));
                    return (IntPtr)1;      // 吞掉，别再触发系统行为
                }

                int semi;
                if (KeyMap.Semitone.TryGetValue(vk, out semi))
                {
                    if (down)
                    {
                        // 键盘会自动重复发送 KEYDOWN，靠 kbdDown 去重，不然一个键会连发几十个音
                        if (kbdDown.Add(vk))
                        {
                            int midi = KeyMap.BaseMidi + semi + kbdOctave * 12;
                            if (midi >= 21 && midi <= 108)
                            {
                                Audio.Play(midi, 0.72);
                                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + skewMs - pauseOffset;
                                lock (gate)
                                    lit[midi] = new Lit { Until = now + 380, Hand = semi < 12 ? 1 : 0 };
                                BeginInvoke(new Action(Invalidate));
                            }
                        }
                    }
                    else kbdDown.Remove(vk);
                    return (IntPtr)1;      // 吞掉这个键（不打字、不触发系统功能）
                }
            }
            return Native.CallNextHookEx(kbdHook, nCode, wParam, lParam);
        }

        /// <summary>
        /// 吸附跟随：钢琴贴在 DSH 主窗口正上方，并跟着它的状态走。
        /// DSH 最小化 → 钢琴隐藏；DSH 关掉 → 钢琴也关；
        /// DSH 恢复 → 钢琴重新贴回去。
        /// </summary>
        void StartFollow()
        {
            FindHost();
            if (hostHwnd != IntPtr.Zero) InstallLocationHook();

            // 主跟随靠 SetWinEventHook 事件回调（零延迟）；
            // 这个定时器只做兜底（100ms），防止某些情况下事件没到。
            followTimer = new System.Windows.Forms.Timer { Interval = 100 };
            followTimer.Tick += (a, b) =>
            {
                if (hostHwnd == IntPtr.Zero) FindHost();
                if (hostHwnd == IntPtr.Zero) return;

                if (!Native.IsWindow(hostHwnd))
                {
                    // DSH 已经关掉了，钢琴跟着退出
                    Audio.Log("HOST gone -> close");
                    followTimer.Stop();
                    Close();
                    return;
                }

                bool min = Native.IsIconic(hostHwnd);
                bool vis = Native.IsWindowVisible(hostHwnd);

                if (min || !vis)
                {
                    if (Visible) { Audio.Log("HOST minimized -> hide"); Hide(); }
                    return;
                }

                if (!Visible) { Show(); Audio.Log("HOST restored -> show"); }

                // 兜底：统一走 SnapToHost。
                // 这里原来还留着一份最早期的手写钳制（wa.Left / wa.Top），
                // 每 100ms 把钢琴强行拉回屏幕内 —— 这就是"拖到屏幕外又被弹回来"的真凶。
                // 而且它还带 SWP_NOREDRAW + SetBoundsCore，顺带制造了闪烁。
                SnapToHost();
            };
            followTimer.Start();
        }

        /// <summary>DSH 一移动就回调，钢琴立刻贴上去（比轮询快一个数量级）。</summary>
        void InstallLocationHook()
        {
            locProc = (hook, ev, hwnd, obj, child, thread, time) =>
            {
                if (hwnd == IntPtr.Zero) return;
                if (hostHwnd == IntPtr.Zero || hwnd != hostHwnd) return;

                // 关键过滤：LOCATIONCHANGE 不只为主窗口发，也为**窗口内的子对象**发
                // （按钮、文本、滚动条、Electron 的渲染层）。
                // DSH 是 Electron，内部元素每秒变几十次，全当"窗口移动"处理，
                // 钢琴就会跟着抖 —— 而 DSH 本体其实纹丝没动。
                // 只接受顶层窗口自身（OBJID_WINDOW）的位置变化。
                if (obj != Native.OBJID_WINDOW || child != Native.CHILDID_SELF) return;

                // 回调每秒可能被调用上百次，这里只做最轻的对齐，不打日志。
                SnapToHost();
            };
            locHook = Native.SetWinEventHook(Native.EVENT_OBJECT_LOCATIONCHANGE,
                Native.EVENT_OBJECT_LOCATIONCHANGE, IntPtr.Zero, locProc, 0, 0,
                Native.WINEVENT_OUTOFCONTEXT | Native.WINEVENT_SKIPOWNPROCESS);
            Audio.Log("LOCHHOOK " + (locHook != IntPtr.Zero ? "已装" : "失败"));
        }

        /// <summary>把钢琴贴到 DSH 正上方（不重绘）。</summary>
        void SnapToHost()
        {
            if (hostHwnd == IntPtr.Zero) return;
            if (snapping) return;
            snapping = true;
            try
            {
                if (!snapped) return;        // 没开吸附就不跟

                // 用 DWM 扩展边框（真实可见区域），不是 GetClientRect。
                // 后者在 Win11 上会少算/多算边框，对齐后右边、底边会留缝。
                Native.RECT cr = default(Native.RECT);
                bool ok = Native.DwmGetWindowAttribute(hostHwnd,
                    Native.DWMWA_EXTENDED_FRAME_BOUNDS, out cr, Marshal.SizeOf(typeof(Native.RECT))) == 0;
                if (!ok || cr.R <= cr.L)
                {
                    if (!Native.GetClientRect(hostHwnd, out cr)) return;
                    var o2 = new Native.POINT { X = 0, Y = 0 };
                    if (!Native.ClientToScreen(hostHwnd, ref o2)) return;
                    int dw0 = cr.R - cr.L, dh0 = cr.B - cr.T;
                    cr.L = o2.X; cr.T = o2.Y; cr.R = o2.X + dw0; cr.B = o2.Y + dh0;
                }
                int hostW = cr.R - cr.L;
                if (hostW <= 0) return;
                int hostX = cr.L, hostY = cr.T;

                // ── 增量式跟随 ──
                // 不每帧重算绝对位置（那样 DPI 换算误差会让它反复微调、看起来在闪）。
                // 只问一件事：DSH 这次比上次挪了多少？钢琴跟着挪同样的距离。
                // 这样两者的相对位置永远不变，误差也不累积。
                if (lastHostX == int.MinValue)
                {
                    // 第一次：绝对对齐一次，作为基准
                    lastHostX = hostX; lastHostY = hostY; lastHostW = hostW;
                    int t0 = hostY - Height;
                    Native.SetWindowPos(Handle, IntPtr.Zero, hostX, t0, hostW, Height,
                        Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
                    setLeft = hostX; setTop = t0; setW = hostW;
                    return;
                }

                int dx = hostX - lastHostX;
                int dy = hostY - lastHostY;
                int dw = hostW - lastHostW;

                // 宽度变化要够大才认（避免 ±1px 抖动）。宽度变了要重新算位置，
                // 因为右锚点会跟着动；位置本身仍走增量。
                bool bigW = Math.Abs(dw) > 8;

                if (dx == 0 && dy == 0 && !bigW) return;   // 什么都没变，一帧都不动

                lastHostX = hostX; lastHostY = hostY;
                if (bigW) lastHostW = hostW;

                int newLeft = setLeft + dx;
                int newTop = setTop + dy;
                int newW = bigW ? hostW : setW;

                setLeft = newLeft; setTop = newTop; setW = newW;
                // 吸附时用 HWND_TOPMOST 并重申：光有 WS_EX_TOPMOST 位不够，
                // 同层内还有顺序，DSH 最大化/切前台都可能把钢琴压到后面。
                Native.SetWindowPos(Handle, snapped ? Native.HWND_TOPMOST : IntPtr.Zero,
                    newLeft, newTop, newW, Height,
                    Native.SWP_NOACTIVATE);
            }
            finally { snapping = false; }
        }

        void FindHost()
        {
            hostHwnd = Native.Find("DeepSeek Harness", 600);
        }

        long lastPaintTick;

        /// <summary>节流重绘：屏幕上 40fps 就够，没必要每 8ms 刷一次。</summary>
        void RequestPaint()
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (now - lastPaintTick < 25) return;
            lastPaintTick = now;
            Invalidate();
        }

        void Pump()
        {
            if (pending.Count == 0) return;
            if (paused) return;      // 暂停期间一帧都不推进

            // 安全阀：队列异常膨胀（多次弹奏叠加）时丢掉最早的，防止越积越多
            if (pending.Count > 2600)
            {
                int drop = pending.Count - 2352;
                pending.RemoveRange(0, drop);
                Audio.Log("DROP " + drop + " 条积压");
            }
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + skewMs - pauseOffset;
            // 自救：宿主把新曲接在"上一次排队的结束时刻"之后，弹几次就排到十几分钟后了，
            // 听感是"完全没播放"。队首离现在超过 3 秒就把整条队列前移。
            if (pending.Count > 0 && pending[0].T - now > 3000)
            {
                long shift = pending[0].T - now - 60;
                for (int i = 0; i < pending.Count; i++) pending[i].T -= shift;
                Audio.Log("RESYNC shift=" + shift + "ms queue=" + pending.Count);
            }
            pumpTick++;
            if (pumpTick % 60 == 0 && pending.Count > 0)
            {
                Audio.Log("PUMP now=" + now + " skew=" + skewMs + " head.T=" + pending[0].T
                          + " delta=" + (pending[0].T - now) + "ms queue=" + pending.Count
                          + " headM=" + pending[0].Midi);
            }
            bool changed = false;
            lock (gate)
            {
                for (int i = 0; i < pending.Count; i++)
                {
                    var pn = pending[i];
                    if (pn.T > now + 25) break;         // 队列按 t 递增，后面只会更晚
                    int playMidi = pn.Midi + transpose;
                    if (playMidi < 21) playMidi = 21;
                    if (playMidi > 108) playMidi = 108;
                    Audio.Play(playMidi, pn.Vel);
                    lit[pn.Midi] = new Lit { Until = now + Math.Max(160, Math.Min(900, pn.Dur)), Hand = pn.Hand };
                    pending.RemoveAt(i);
                    i--;
                    changed = true;
                    if (pending.Count == 0) break;
                }
            }
            if (changed) BeginInvoke(new Action(RequestPaint));   // 节流：最多 40fps
        }

        /// <summary>
        /// 本进程唯一的 UA。
        /// 宿主的 /events 按 UA 前 40 字符分桶记游标，并且会把游标无条件推到最新 seq。
        /// 如果和浏览器共用同一个 UA，窗口一启动（since=0）就被抬到最新，之后新排的
        /// 事件全落在"已消费"范围里，永远取不到 —— 表现就是一点声音都没有。
        /// </summary>
        static readonly string ClientUa = "DSHPianoWin/" + Guid.NewGuid().ToString("N").Substring(0, 12);

        static string Fetch(string url)
        {
            using (var wc = new WebClient())
            {
                wc.Encoding = Encoding.UTF8;
                wc.Headers["cache-control"] = "no-store";
                wc.Headers["User-Agent"] = ClientUa;
                return wc.DownloadString(url);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            int w = ClientSize.Width, h = ClientSize.Height;

            // ── 背景：上深下浅的夜空感 ──
            using (var b = new LinearGradientBrush(new Rectangle(0, 0, w, h + 1),
                       Color.FromArgb(22, 29, 41), Color.FromArgb(12, 16, 24), 90f))
                g.FillRectangle(b, 0, 0, w, h);

            // ── 顶栏 ──
            using (var b = new LinearGradientBrush(new Rectangle(0, 0, w, barH),
                       Color.FromArgb(31, 40, 54), Color.FromArgb(19, 25, 36), 90f))
                g.FillRectangle(b, 0, 0, w, barH);
            using (var p2 = new Pen(Color.FromArgb(58, 71, 92)))
                g.DrawLine(p2, 0, barH - 1, w, barH - 1);
            using (var p2 = new Pen(Color.FromArgb(22, 255, 255, 255)))
                g.DrawLine(p2, 0, 0, w, 0);

            // 左：状态点 + 名字
            using (var b = new SolidBrush(Color.FromArgb(74, 222, 158)))
                g.FillEllipse(b, 11, barH / 2f - 3f, 6, 6);
            {
                var szName = g.MeasureString("钢琴", fName);
                g.DrawString("钢琴", fName, bName, 23, (barH - szName.Height) / 2f);
            }

            // 中左：曲名（裁到可用宽度，绝不和右边叠）
            int rightZone = 170;                       // 右侧信息+按钮占位
            // "钢琴"两字（9pt 粗体）从 x=23 起，实际占到 x≈64，起点必须让过去，
            // 否则首字母会被压掉（之前显示成 "lower-Dance-…" 就是这个）。
            int stillX = 74;
            int stillMax = Math.Max(0, w - rightZone - stillX);
            if (!string.IsNullOrEmpty(nowPlaying) && stillMax > 60)
            {
                using (var sf = new StringFormat
                {
                    Trimming = StringTrimming.EllipsisCharacter,
                    FormatFlags = StringFormatFlags.NoWrap,
                    LineAlignment = StringAlignment.Center,
                })
                    g.DrawString(nowPlaying, fTitle, bTitle, new RectangleF(stillX, 0f, stillMax, barH), sf);
            }

            // 右侧：曲信息（从右往左排，不重叠）+ 两个按钮
            int bw = 30, bh = 19, by = (barH - bh) / 2;
            btnClose = new Rectangle(w - bw - 9, by, bw, bh);
            btnPlay = new Rectangle(w - bw * 2 - 15, by, bw, bh);
            DrawButton(g, btnPlay, "", Color.FromArgb(208, 218, 234), false);
            // 播放/暂停图标自绘：
            // 字符 "❚❚" 的两竖间距由字体决定，改不了；自己画两条线才能控制。
            {
                float cx = btnPlay.Left + btnPlay.Width / 2f;
                float cy = btnPlay.Top + btnPlay.Height / 2f;
                using (var b = new SolidBrush(Color.FromArgb(214, 226, 242)))
                {
                    if (paused)
                    {
                        // ▶ 播放三角
                        var tri = new PointF[]
                        {
                            new PointF(cx - 4f, cy - 5.5f),
                            new PointF(cx - 4f, cy + 5.5f),
                            new PointF(cx + 5.5f, cy),
                        };
                        g.FillPolygon(b, tri);
                    }
                    else
                    {
                        // ❚❚ 暂停：两条 3px 宽竖线，间距 3px
                        g.FillRectangle(b, cx - 4.5f, cy - 5.5f, 3f, 11f);
                        g.FillRectangle(b, cx + 1.5f, cy - 5.5f, 3f, 11f);
                    }
                }
            }
            DrawButton(g, btnClose, "✕", Color.FromArgb(208, 218, 234), true);

            int infoRight = btnPlay.Left - 12;
            {
                // 速度
                if (scoreBpm > 0)
                {
                    int shown = Math.Max(20, Math.Min(400, scoreBpm + bpmAdj));
                    string bt = "♩=" + shown;
                    var sz = g.MeasureString(bt, fInfo);
                    int bwid = (int)sz.Width + 12;
                    infoRight -= bwid;
                    bpmBadge = new Rectangle(infoRight, by - 1, bwid, bh + 2);
                    using (var b = new SolidBrush(Color.FromArgb(26, 200, 220, 255)))
                        g.FillPath(b, RoundRect(new RectangleF(bpmBadge.X, bpmBadge.Y, bwid, bh + 2), 5f));
                    TextRenderer.DrawText(g, bt, fInfo, new Rectangle(infoRight, 0, bwid, barH),
                        Color.FromArgb(150, 172, 200),
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
                    infoRight -= 8;
                }
                // 拍号（可点：左键下一个、右键上一个）
                {
                    string ts = TimeSigs[timeSigIdx];
                    var sz = g.MeasureString(ts, fInfo);
                    int tw = (int)sz.Width + 12;
                    infoRight -= tw;
                    timeBadge = new Rectangle(infoRight, by - 1, tw, bh + 2);
                    using (var b = new SolidBrush(Color.FromArgb(26, 200, 220, 255)))
                        g.FillPath(b, RoundRect(new RectangleF(timeBadge.X, timeBadge.Y, tw, bh + 2), 5f));
                    TextRenderer.DrawText(g, ts, fInfo, new Rectangle(infoRight, 0, tw, barH),
                        Color.FromArgb(150, 172, 200),
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
                    infoRight -= 8;
                }
                // 吸附按钮
                {
                    string lbl = snapped ? "吸附中" : "吸附";
                    var szb = g.MeasureString(lbl, fInfo);
                    int bwid = (int)szb.Width + 14;
                    infoRight -= bwid;
                    snapBtn = new Rectangle(infoRight, by - 1, bwid, bh + 2);
                    using (var b = snapped
                        ? new SolidBrush(Color.FromArgb(90, 74, 222, 158))
                        : new SolidBrush(Color.FromArgb(26, 200, 220, 255)))
                        g.FillPath(b, RoundRect(new RectangleF(snapBtn.X, snapBtn.Y, bwid, bh + 2), 5f));
                    using (var p2 = new Pen(snapped
                        ? Color.FromArgb(150, 74, 222, 158)
                        : Color.FromArgb(70, 160, 200, 240)))
                        g.DrawPath(p2, RoundRect(new RectangleF(snapBtn.X, snapBtn.Y, bwid, bh + 2), 5f));
                    TextRenderer.DrawText(g, lbl, fInfo, new Rectangle(snapBtn.X, 0, bwid, barH),
                        snapped ? Color.FromArgb(220, 245, 235) : Color.FromArgb(150, 172, 200),
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
                    infoRight -= 8;
                }

                // 调号徽标（可点）
                if (keyRoot >= 0)
                {
                    // 写法照 Everyone Piano：1 = C(0)，括号里是八度。
                    int cur = ((keyRoot + transpose) % 12 + 12) % 12;
                    string sig = "1=" + Names[cur] + "(0)";
                    int arrowW = 18;
                    var sz = g.MeasureString(sig, fInfo);
                    int textW = (int)sz.Width + 4;
                    // 左右各留 4px 内边距，箭头和文字才不会贴在一起
                    int pad = 4;
                    int bwd = textW + arrowW * 2 + pad * 2;
                    int bx = infoRight - bwd;
                    keyBadge = new Rectangle(bx, by - 1, bwd, bh + 2);
                    keyPrev = new Rectangle(bx + pad, by - 1, arrowW, bh + 2);
                    keyNext = new Rectangle(bx + bwd - pad - arrowW, by - 1, arrowW, bh + 2);

                    using (var b = new LinearGradientBrush(new Rectangle(keyBadge.X, keyBadge.Y, keyBadge.Width, keyBadge.Height),
                               Color.FromArgb(74, 98, 136), Color.FromArgb(46, 64, 94), 90f))
                        g.FillPath(b, RoundRect(new RectangleF(keyBadge.X, keyBadge.Y, keyBadge.Width, keyBadge.Height), 7f));
                    using (var p2 = new Pen(Color.FromArgb(112, 142, 188)))
                        g.DrawPath(p2, RoundRect(new RectangleF(keyBadge.X, keyBadge.Y, keyBadge.Width, keyBadge.Height), 7f));

                    // 用 TextRenderer（GDI）而不是 Graphics.DrawString：
                    // 后者量出来的尺寸自带约 1/6 em 的内边距，拿它居中必然偏。
                    var flags = TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter
                              | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine;
                    TextRenderer.DrawText(g, "◀", fInfo,
                        new Rectangle(bx + pad, keyBadge.Y, arrowW, keyBadge.Height),
                        Color.FromArgb(198, 216, 240), flags);
                    TextRenderer.DrawText(g, "▶", fInfo,
                        new Rectangle(bx + bwd - pad - arrowW, keyBadge.Y, arrowW, keyBadge.Height),
                        Color.FromArgb(198, 216, 240), flags);
                    TextRenderer.DrawText(g, sig, fInfo,
                        new Rectangle(bx + pad + arrowW, keyBadge.Y, textW, keyBadge.Height),
                        Color.FromArgb(226, 238, 252), flags);
                }
                else { keyBadge = Rectangle.Empty; keyPrev = Rectangle.Empty; keyNext = Rectangle.Empty; }
            }

            // ── 键盘区：先画"键床"内凹底座，键才有嵌进去的感觉 ──
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + skewMs - pauseOffset;

            // 取一次快照，之后整个绘制过程不再碰锁。
            // 原来每个键都 lock(gate)，88 键 × 2 就是 176 次加锁；而混音线程
            // 每块要持锁算 1024 个样本 × 几十个 voice，UI 线程排队等锁 → 画面卡住。
            Dictionary<int, Lit> litSnap;
            lock (gate) litSnap = new Dictionary<int, Lit>(lit);
            int bedTop = barH + 4;
            int bedH = h - bedTop - 6;
            using (var b = new LinearGradientBrush(new Rectangle(0, bedTop, w, bedH),
                       Color.FromArgb(9, 12, 18), Color.FromArgb(20, 26, 36), 90f))
                g.FillPath(b, RoundRect(new RectangleF(2, bedTop, w - 4, bedH), 10f));
            using (var p2 = new Pen(Color.FromArgb(46, 58, 76), 1f))
                g.DrawPath(p2, RoundRect(new RectangleF(2, bedTop, w - 4, bedH), 10f));

            int keyTop = bedTop + 7;
            int keyH = bedH - 14;
            float radius = 5f;

            // ── 白键：圆角 + 上亮下暗 + 底部立体边 ──
            foreach (var k in keys)
            {
                if (k.Black) continue;
                bool on; int hand = 0;
                Lit lv;
                on = litSnap.TryGetValue(k.Midi, out lv) && lv.Until > nowMs;
                if (on) hand = lv.Hand;
                float kx = k.X + 1.5f, kw = k.W - 3f;
                var body = new RectangleF(kx, keyTop, kw, keyH - 4f);

                if (on)
                {
                    // 按下：整体下压 2px、底部边收掉 → 视觉上"陷进去"
                    // 颜色按手：左手蓝、右手绿（与黑白键无关）
                    var press = new RectangleF(kx, keyTop + 2f, kw, keyH - 6f);
                    Color cHi = hand == 1 ? Color.FromArgb(186, 224, 255) : Color.FromArgb(190, 250, 210);
                    Color cLo = hand == 1 ? Color.FromArgb(86, 150, 232) : Color.FromArgb(60, 186, 118);
                    using (var b = new LinearGradientBrush(press, cHi, cLo, 90f))
                        g.FillPath(b, RoundRect(press, radius));
                    using (var p2 = new Pen(hand == 1 ? Color.FromArgb(52, 110, 180) : Color.FromArgb(38, 140, 84)))
                        g.DrawPath(p2, RoundRect(press, radius));
                }
                else
                {
                    // 底部立体边
                    using (var b = new SolidBrush(Color.FromArgb(150, 162, 182)))
                        g.FillPath(b, RoundRect(new RectangleF(kx, keyTop + 4f, kw, keyH - 4f), radius));
                    using (var b = new LinearGradientBrush(body, Color.FromArgb(253, 254, 255), Color.FromArgb(219, 228, 241), 90f))
                        g.FillPath(b, RoundRect(body, radius));
                    using (var p2 = new Pen(Color.FromArgb(176, 188, 206)))
                        g.DrawPath(p2, RoundRect(body, radius));
                }

                // 只在 C 键标八度
                if (k.Midi % 12 == 0)
                {
                    string label = "C" + (k.Midi / 12 - 1);
                    var sz = g.MeasureString(label, fC);
                    g.DrawString(label, fC, on ? bCon : bCoff, kx + (kw - sz.Width) / 2, keyTop + keyH - 18);
                }
            }

            // ── 黑键：圆角 + 投影，压在白键上 ──
            foreach (var k in keys)
            {
                if (!k.Black) continue;
                bool on; int hand = 0;
                Lit lv2;
                on = litSnap.TryGetValue(k.Midi, out lv2) && lv2.Until > nowMs;
                if (on) hand = lv2.Hand;
                var body = new RectangleF(k.X, keyTop, k.W, keyH * 0.58f);
                var shadow = new RectangleF(k.X + 1.5f, keyTop + 3f, k.W, keyH * 0.58f);

                using (var b = new SolidBrush(Color.FromArgb(70, 0, 0, 0)))
                    g.FillPath(b, RoundRect(shadow, 4f));

                if (on)
                {
                    var press = new RectangleF(k.X, keyTop + 1f, k.W, keyH * 0.58f);
                    Color cHi = hand == 1 ? Color.FromArgb(120, 170, 250) : Color.FromArgb(110, 220, 150);
                    Color cLo = hand == 1 ? Color.FromArgb(44, 74, 150) : Color.FromArgb(20, 110, 66);
                    using (var b = new LinearGradientBrush(press, cHi, cLo, 90f))
                        g.FillPath(b, RoundRect(press, 4f));
                }
                else
                {
                    using (var b = new LinearGradientBrush(body, Color.FromArgb(78, 90, 110), Color.FromArgb(16, 21, 30), 90f))
                        g.FillPath(b, RoundRect(body, 4f));
                    using (var p2 = new Pen(Color.FromArgb(6, 9, 14)))
                        g.DrawPath(p2, RoundRect(body, 4f));
                    // 顶部一道高光，键才有圆润的厚度
                    using (var p2 = new Pen(Color.FromArgb(46, 200, 220, 255), 1f))
                        g.DrawLine(p2, k.X + 3, keyTop + 2, k.X + k.W - 3, keyTop + 2);
                }

            }

            // ── 播放进度：细长胶囊，贴在键床顶部 ──
            if (playFromMs > 0 && playToMs > playFromMs && nowMs <= playToMs + 2000)
            {
                float frac = Math.Max(0f, Math.Min(1f, (nowMs - playFromMs) / (float)(playToMs - playFromMs)));
                int px0 = 14, px1 = w - 14, py = bedTop + 2;
                using (var b = new SolidBrush(Color.FromArgb(52, 66, 88)))
                    g.FillPath(b, RoundRect(new RectangleF(px0, py, px1 - px0, 3f), 1.5f));
                using (var b = new SolidBrush(Color.FromArgb(120, 180, 250)))
                    g.FillPath(b, RoundRect(new RectangleF(px0, py, (px1 - px0) * frac, 3f), 1.5f));
            }

            // 过期清理
            lock (gate)
            {
                if (lit.Count > 0)
                {
                    var dead = new List<int>();
                    foreach (var kv in lit) if (kv.Value.Until <= nowMs) dead.Add(kv.Key);
                    foreach (var d in dead) lit.Remove(d);
                }
            }
        }

        static GraphicsPath RoundRect(RectangleF r, float rad)
        {
            var p = new GraphicsPath();
            float d = rad * 2;
            p.AddArc(r.Left, r.Top, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Top, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        static void DrawButton(Graphics g, Rectangle r, string glyph, Color fg, bool hot)
        {
            Color top = hot ? Color.FromArgb(120, 38, 46, 60) : Color.FromArgb(48, 58, 74);
            Color bot = hot ? Color.FromArgb(60, 22, 28, 38) : Color.FromArgb(30, 38, 50);
            using (var b = new LinearGradientBrush(r, top, bot, 90f))
                g.FillPath(b, RoundRect(r, 5f));
            using (var p = new Pen(Color.FromArgb(64, 76, 96)))
                g.DrawPath(p, RoundRect(r, 5f));
            // 顶部高光
            using (var p = new Pen(Color.FromArgb(30, 255, 255, 255)))
                g.DrawLine(p, r.Left + 4, r.Top + 1, r.Right - 4, r.Top + 1);
            using (var f = new Font("Segoe UI", 7.5f))
            using (var b = new SolidBrush(fg))
            {
                var size = g.MeasureString(glyph, f);
                g.DrawString(glyph, f, b, r.Left + (r.Width - size.Width) / 2, r.Top + (r.Height - size.Height) / 2);
            }
        }

        // ── 拖动 + 吸附 ──────────────────────────────────────────
        Key HitTest(Point p)
        {
            int keyTop = barH + 6;
            int keyH = ClientSize.Height - keyTop - 4;
            // 黑键压在白键上，先判
            foreach (var k in keys)
            {
                if (!k.Black) continue;
                if (new RectangleF(k.X, keyTop, k.W, keyH * 0.60f).Contains(p)) return k;
            }
            foreach (var k in keys)
            {
                if (k.Black) continue;
                if (new RectangleF(k.X, keyTop, k.W, keyH).Contains(p)) return k;
            }
            return null;
        }

        /// <summary>本地立刻点亮 + 发声。声音完全由本进程负责。</summary>
        void Strike(int midi, bool repaint = true)
        {
            // 只在这里发声，不要再 PostNote 给宿主 ——
            // 两边各播一遍，起点差几十毫秒，叠起来就是"音不准""发怪"。
            // 窗口自身已经会点亮键，宿主的灯不要也无所谓。
            Audio.Play(midi, 0.82);
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + skewMs - pauseOffset;
            lock (gate) lit[midi] = new Lit { Until = now + 620, Hand = midi < 60 ? 1 : 0 };
            if (repaint) Invalidate();
        }

        /// <summary>彻底停下：请求宿主清队列、掐掉本地声音、清高亮。</summary>
        void StopAll()
        {
            try
            {
                var req = WebRequest.Create(api + "/stop");
                req.Method = "POST";
                req.GetResponse().Close();
            }
            catch { }
            lock (gate) { lit.Clear(); pending.Clear(); }
            Audio.AllOff();
            paused = false; pauseOffset = 0; pausedAt = 0;
            playFromMs = 0; playToMs = 0;
            Invalidate();
        }

        // 全局键盘钩子。委托必须用字段持有 —— 只传局部变量的话，
        // 委托会被 GC 回收，原生层回调到已释放的地址，进程直接崩。
        IntPtr kbdHook = IntPtr.Zero;
        Native.KbdProc kbdProc;
        int kbdOctave;                  // 键盘整体移调（八度）
        readonly HashSet<int> kbdDown = new HashSet<int>();   // 已按下的键（防自动重复）

        bool sliding;
        int lastSlideMidi = -1;
        Point lastSlidePt;          // 上一次的鼠标位置（滑奏插值用）
        IntPtr hostHwnd = IntPtr.Zero;   // 被吸附的 DSH 主窗口
        System.Windows.Forms.Timer followTimer;
        IntPtr locHook = IntPtr.Zero;
        Native.WinEventProc locProc;     // 必须字段持有，否则被 GC 回收后原生回调会崩
        bool snapping;                   // 防重入：自己改窗口又会触发 LOCATIONCHANGE

        // 上次"设给"窗口的目标值。必须用目标值比较，不能读回实际值：
        // SetWindowPos 设 -952，DPI 换算后 Left 读回来是 -953，
        // 拿实际值比较就永远判定"有差异"，于是每帧都移 → 位置来回变、画面闪。
        int setLeft = int.MinValue, setTop = int.MinValue, setW;
        int lastHostX = int.MinValue, lastHostY = int.MinValue, lastHostW;
        bool snapped;                    // 吸附开关（默认关，点了按钮才开）
        Rectangle snapBtn;               // 右上角"吸附"按钮

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;

            // 调号区：左键 +1 半音，右键 -1 半音（范围 -12..+12）
            // 吸附开关
            if (snapBtn != Rectangle.Empty && snapBtn.Contains(e.Location))
            {
                snapped = !snapped;
                ApplyDragLock(snapped);
                ApplyTopMost(snapped);
                SaveSnapSetting();
                NotifySnap();
                Audio.Log("SNAP " + (snapped ? "on" : "off"));
                if (snapped)
                {
                    // 打开吸附：立刻对齐一次，并重置基准
                    lastHostX = int.MinValue;
                    setLeft = int.MinValue;
                    FindHost();
                    SnapToHost();
                }
                Invalidate();
                return;
            }

            // 拍号：左键下一个、右键上一个
            if (timeBadge != Rectangle.Empty && timeBadge.Contains(e.Location))
            {
                int d = e.Button == MouseButtons.Right ? -1 : 1;
                timeSigIdx = (timeSigIdx + d + TimeSigs.Length) % TimeSigs.Length;
                Audio.Log("TIMESIG " + TimeSigs[timeSigIdx]);
                Invalidate();
                return;
            }
            // 速度：左键 +5、右键 −5（鼠标中键归零）
            if (bpmBadge != Rectangle.Empty && bpmBadge.Contains(e.Location))
            {
                if (e.Button == MouseButtons.Middle) bpmAdj = 0;
                else bpmAdj += (e.Button == MouseButtons.Right ? -5 : 5);
                bpmAdj = Math.Max(-60, Math.Min(120, bpmAdj));
                Audio.Log("BPMADJ " + bpmAdj);
                Invalidate();
                return;
            }

            if (keyRoot >= 0 && (keyPrev.Contains(e.Location) || keyNext.Contains(e.Location)))
            {
                // 纯鼠标点击：点左箭头降一个调，点右箭头升一个调；12 个调循环
                int delta = keyPrev.Contains(e.Location) ? -1 : 1;
                transpose += delta;
                while (transpose > 11) transpose -= 12;
                while (transpose < -11) transpose += 12;
                Audio.Log("KEY " + transpose);
                Invalidate();
                return;
            }
            if (btnClose.Contains(e.Location))
            {
                // ✕ = 停止播放并关窗（不是只关窗留声音）
                StopAll();
                Close();
                return;
            }
            if (btnPlay.Contains(e.Location))
            {
                if (!paused)
                {
                    // 暂停：冻住时间轴 + 掐掉正在响的音
                    paused = true;
                    pausedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    Audio.AllOff();
                    lock (gate) lit.Clear();
                }
                else
                {
                    // 继续：把暂停期间的时长补进偏移，时间轴接着走
                    paused = false;
                    pauseOffset += DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - pausedAt;
                }
                Audio.Log("PAUSE " + (paused ? "on" : "off") + " offset=" + pauseOffset);
                Invalidate();
                return;
            }

            // 顶栏 → 拖动窗口；键盘 → 弹奏
            if (e.Y <= barH)
            {
                // 吸附状态下不可拖：拖动是我自己实现的（不是系统标题栏），
                // 所以必须在入口就拦住，否则摘掉 WS_CAPTION 也没用。
                if (snapped) return;
                dragging = true;
                dragX = Cursor.Position.X - Left;
                dragY = Cursor.Position.Y - Top;
                return;
            }

            var k = HitTest(e.Location);
            if (k != null)
            {
                sliding = true;
                lastSlideMidi = k.Midi;
                lastSlidePt = e.Location;
                Strike(k.Midi);
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (dragging)
            {
                Left = Cursor.Position.X - dragX;
                Top = Cursor.Position.Y - dragY;
                return;
            }
            // 滑奏：按住划过去，每换一个键响一次。
            // 不人为限速 —— 真钢琴滑过去本来就是每个键都响。
            if (sliding)
            {
                // 沿上一次位置到当前位置之间插值取点。
                // OnMouseMove 只给离散位置，鼠标快速划过时一次可能跨过好几个键，
                // 只看终点就会"跳音"。这里按 1/3 个键宽为步长把途中扫一遍，
                // 每个新键只触发一次（靠 lastSlideMidi 去重）。
                int dx = e.X - lastSlidePt.X, dy = e.Y - lastSlidePt.Y;
                double dist = Math.Sqrt(dx * dx + dy * dy);
                float kw = 24f;
                lock (gate) { if (keys.Count > 0) kw = keys[0].W; }
                int steps = Math.Max(1, Math.Min(24, (int)(dist / Math.Max(6f, kw / 3f))));
                for (int i = 1; i <= steps; i++)
                {
                    var pt = new Point(
                        lastSlidePt.X + (int)(dx * i / (double)steps),
                        lastSlidePt.Y + (int)(dy * i / (double)steps));
                    var kk = HitTest(pt);
                    if (kk != null && kk.Midi != lastSlideMidi)
                    {
                        lastSlideMidi = kk.Midi;
                        Strike(kk.Midi, false);   // 滑奏中途不逐帧重绘
                    }
                }
                lastSlidePt = e.Location;
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (dragging)
            {
                dragging = false;
                SnapToDsh();
            }
            sliding = false;
            lastSlideMidi = -1;
        }

        /// <summary>
        /// 松手后跟 DSH 主窗口对一下：靠得够近就贴上去。
        /// 四种贴合：贴底（窗口在 DSH 上方）、贴顶、左右对齐、同宽吸附。
        /// </summary>
        void SnapToDsh()
        {
            var dsh = Native.Find("DeepSeek Harness", 600);
            if (dsh == IntPtr.Zero) return;
            var r = Native.Bounds(dsh);

            int left = Left, top = Top, w = Width, h = Height;

            // 下边缘贴 DSH 上边缘
            if (Math.Abs((top + h) - r.Top) <= SnapPx) top = r.Top - h - 2;
            // 上边缘贴 DSH 下边缘
            else if (Math.Abs(top - r.Bottom) <= SnapPx) top = r.Bottom + 2;

            // 水平居中吸附（主窗口范围够宽时）
            int centerDiff = Math.Abs((left + w / 2) - (r.Left + r.Width / 2));
            if (centerDiff <= SnapPx * 2) left = r.Left + (r.Width - w) / 2;

            // 左右边缘
            if (Math.Abs(left - r.Left) <= SnapPx) left = r.Left;
            else if (Math.Abs((left + w) - r.Right) <= SnapPx) left = r.Right - w;

            if (left != Left || top != Top) Bounds = new Rectangle(left, top, w, h);
        }

        /// <summary>
        /// 吸附状态下彻底禁用拖动：直接摘掉窗口的 WS_CAPTION 样式。
        /// 之前拦 WM_NCHITTEST 没用（Form 的命中测试走的是另一条路），
        /// 从窗口样式层面去掉标题栏才是系统级的"不可拖"。
        /// 顶部那条是我的自绘顶栏，不依赖系统标题栏，所以视觉上没有变化。
        /// </summary>
        /// <summary>
        /// 告诉宿主当前吸附状态。宿主据此让插件页面顶部留出钢琴的高度
        /// —— 这样最大化/全屏时页面内容不会被钢琴盖住，而且不用去改 DSH 窗口尺寸。
        /// </summary>
        /// <summary>设置文件路径（和 EXE 同目录的 settings.json）。</summary>
        static string SettingsPath
        {
            get
            {
                string dir = Path.GetDirectoryName(Application.ExecutablePath);
                return Path.Combine(dir, "settings.json");
            }
        }

        /// <summary>读上次的吸附状态。文件不存在或格式坏了都按 false 处理。</summary>
        static bool LoadSnapSetting()
        {
            try
            {
                string p = SettingsPath;
                if (!File.Exists(p)) return false;
                string txt = File.ReadAllText(p);
                return txt.IndexOf("\"snapped\":true", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch { return false; }
        }

        /// <summary>记住吸附状态，下次启动沿用。</summary>
        void SaveSnapSetting()
        {
            try
            {
                File.WriteAllText(SettingsPath,
                    "{\"snapped\":" + (snapped ? "true" : "false") + "}");
            }
            catch { }
        }

        void NotifySnap()
        {
            try
            {
                string u = api + "/snap?on=" + (snapped ? "1" : "0") + "&h=" + Height;
                var req = WebRequest.Create(u);
                req.Method = "POST";
                req.Timeout = 1500;
                using (var r = req.GetResponse()) { }
            }
            catch { }
        }

        /// <summary>
        /// 置顶/取消置顶。
        /// DSH 最大化后会占满屏幕，只有 WS_EX_TOPMOST 的窗口才能画在它上面。
        /// 注意：TOPMOST 只是一个"层"，同层内还有先后顺序，
        /// 所以每次跟随都要重新 SetWindowPos(HWND_TOPMOST) 重申一次。
        /// </summary>
        void ApplyTopMost(bool on)
        {
            if (Handle == IntPtr.Zero) return;
            Native.SetWindowPos(Handle, on ? Native.HWND_TOPMOST : Native.HWND_NOTOPMOST,
                0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
        }

        void ApplyDragLock(bool locked)
        {
            if (Handle == IntPtr.Zero) return;
            long style = Native.GetWindowLongPtr(Handle, Native.GWL_STYLE).ToInt64();
            long newStyle = locked
                ? (style & ~Native.WS_CAPTION)
                : (style | Native.WS_CAPTION | Native.WS_SYSMENU);
            if (newStyle != style)
            {
                Native.SetWindowLongPtr(Handle, Native.GWL_STYLE, (IntPtr)newStyle);
                // 改样式后要让它生效
                Native.SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0,
                    Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOZORDER
                    | Native.SWP_NOACTIVATE | Native.SWP_FRAMECHANGED);
            }
        }

        protected override void WndProc(ref Message m)
        {
            base.WndProc(ref m);
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            // 窗口宽度变了（吸附跟随 DSH、手动拉伸）→ 重建琴键布局，
            // 让每个键按新的宽度均分。原来只在构造时建一次，所以缩放后琴键不变形。
            if (ClientSize.Width > 0 && ClientSize.Height > 0)
            {
                BuildKeys();
                Invalidate();
            }
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Escape) { Close(); return; }

            // 八度切换：← 降、→ 升（±2 个八度）
            if (e.KeyCode == Keys.Left || e.KeyCode == Keys.Right)
            {
                kbdOctave = Math.Max(-2, Math.Min(2, kbdOctave + (e.KeyCode == Keys.Right ? 1 : -1)));
                Invalidate();
                e.Handled = true;
                return;
            }

            // 只在窗口有焦点时响应（KeyPreview），不做全局钩子：
            // 全局钩子会吞掉 Q/W/E/2/3 这些打字键，开着钢琴就没法打字了。
            int semi;
            int vk = (int)e.KeyCode;
            bool shift = (Control.ModifierKeys & Keys.Shift) == Keys.Shift;
            if (KeyMap.TryGet(vk, shift, out semi))
            {
                if (kbdDown.Add(vk))
                {
                    int midi = KeyMap.BaseMidi + semi + kbdOctave * 12;
                    if (midi >= 21 && midi <= 108) Strike(midi, false);
                }
                e.Handled = true;
            }
        }

        protected override void OnKeyUp(KeyEventArgs e)
        {
            base.OnKeyUp(e);
            kbdDown.Remove((int)e.KeyCode);
        }
    }

    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            // DPI 感知必须在建窗口之前设。
            // 不设的话：GetWindowRect 给的是物理像素，WinForms 的 Bounds 是逻辑像素，
            // 125% 缩放下两者差 1.25 倍 —— 窗口每次打开高度都不一样，
            // 算出来的定位也跟着漂。
            Native.SetProcessDPIAware();

            string api = "http://127.0.0.1:60420/api/dsh-piano-xz";
            int height = 190;
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == "--api") api = args[i + 1];
                if (args[i] == "--height") int.TryParse(args[i + 1], out height);
                if (args[i] == "--record") Audio.RecordPath = args[i + 1];
                if (args[i] == "--sound") Audio.SoundEnabled = true;   // 不加则只显示、不出声（由浏览器发声）
            }

            // 高度上限：宿主侧如果还是旧代码，会传 --height 300，
            // 跟手动启动的 190 一高一矮，看着像两个程序。统一压到 190。
            if (height > 200) height = 190;

            // --height 按"逻辑像素"理解，换算成物理像素。
            // DPI 感知之后窗口尺寸用的是物理像素，不换算的话 220 在 150% 缩放下只有 147 高。
            using (var gg = Graphics.FromHwnd(IntPtr.Zero))
            {
                float scale = gg.DpiY / 96f;
                if (scale > 0.5f && scale < 4f) height = (int)Math.Round(height * scale);
            }

            // 第二下点击 = 收起来。
            // 单例不能只是"叫到前面"，那样按钮就永远关不掉窗口。
            // 已经有窗口就给它发 WM_CLOSE，让这个开关是真的开关。
            bool created;
            using (var mutex = new Mutex(true, "Local\\DshPianoWindow", out created))
            {
                if (!created)
                {
                    // 已经有窗口：**激活它**，不要关掉。
                    // 原来这里是 PostMessage(WM_CLOSE)，等于"点一下按钮把窗口关掉、自己不启动"，
                    // 看起来就像"调用的不是同一个 EXE"。
                    var existing = Native.Find("DSH 钢琴");
                    if (existing != IntPtr.Zero)
                    {
                        Native.ShowWindow(existing, 9);          // SW_RESTORE
                        Native.SetForegroundWindow(existing);
                    }
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                // 采样与音频先起来：窗口一出现就能直接弹响，不用等网络。
                try
                {
                    var exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                    // 新音源：Yamaha Upright 88 键独立采样（44100 单声道）
                    var wavDir = Path.GetFullPath(Path.Combine(exeDir, "..", "assets", "yup", "wav"));
                    var logDir = Path.GetFullPath(Path.Combine(exeDir, "..", "record"));
                    Directory.CreateDirectory(logDir);
                    Audio.SetLog(Path.Combine(logDir, "audio.log"));
                    // 优先用 mdaPiano 的波表（EOP 的原音源）；没有才退回 wav 采样
                    var wtPath = Path.GetFullPath(Path.Combine(exeDir, "..", "assets", "mdapiano-wavetable-raw.bin"));
                    var wtCount = Audio.LoadWaveTable(wtPath);
                    Audio.Log("波表 " + wtCount + " samples  (" + wtPath + ")");
                    var loaded = Audio.Load(wavDir);
                    Audio.Start();
                    Audio.StartRecord();   // --record 时把混音原样录下来（诊断用）
                }
                catch { /* 没有采样就只显示不发声 */ }

                try
                {
                    Application.Run(new PianoForm(api, height));
                }
                finally
                {
                    Audio.Stop();
                    Audio.StopRecord();
                }
            }
        }
    }
}
