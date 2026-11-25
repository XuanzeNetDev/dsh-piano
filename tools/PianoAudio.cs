// DSH 钢琴窗口的发声引擎。
//
// 为什么不用 SoundPlayer：它一次只能播一个音，按和弦会把前一个掐掉。
// 这里用 winmm 的 waveOut（Windows 最老也最稳的音频输出）+ 自己混音：
// 每个音是一个 voice（采样、播放位置、速率、增益），每帧把它们加在一起。
//
// 音色逻辑照抄 DSH 网页版：
//   · 30 个采样点（每 3 个半音一个），中间的音用重采样变调
//   · 力度按 0.15 + 0.85·v^0.8 走增益，不是开关
//   · 每个采样点的原始电平不同，按峰值归一化（响度补偿）
namespace DshPiano
{
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Runtime.InteropServices;
    using System.Threading;

    sealed class Voice
    {
        public short[] Data;
        public int Start;       // 波表里本 keygroup 的起点
        public int End;         // 终点（到这儿跳回 Loop）
        public int Loop;        // 循环点
        public double Pos;      // 读指针（浮点，便于插值）
        public double Rate;     // 播放速率 = 2^(半音差/12)
        public double Gain;
        public double Elapsed;  // 已经播了多久（秒）
        public double LpState;  // 一阶低通的记忆
        public double LpCoef;   // 低通系数（按力度算一次）
        public double HpPrevIn;   // 高通第 1 级：上一帧输入
        public double HpPrevOut;  // 高通第 1 级：上一帧输出
        public double Hp2PrevIn;  // 高通第 2 级
        public double Hp2PrevOut;
        public double ShelfState; // 高频搁架的参考低通状态
        public double ShelfCoef;  // 参考低通系数（2kHz）
        public bool Dead;

        // ── 以下用于 GM 多乐器。钢琴路径上全部保持默认值，
        //    行为与改造前逐字节一致（0.008 / 1.4 / 不循环）。──
        public int LoopStart;        // 循环起点（采样点），0 = 不循环
        public int LoopEnd;          // 循环终点，> LoopStart 才生效
        public double AttackSec = 0.008;    // 起音淡入时长
        public double DecaySec = 1.4;       // 指数衰减时间常数
        public double SustainLevel;         // 衰减到的下限（1.0 = 不掉）
        public double ReleaseSec;           // 松键后的释放时长（0 = 不用）
        public double HoldSec;              // 这个音该持续多久，到点开始释放
    }

    static class Audio
    {
        const int SR = 44100;
        /// <summary>
        /// 每块混多少帧。1024 帧 ≈ 23ms。
        /// 之前 2048（46ms）配 4 块缓冲，最老那块还在播，按下键最多要等 186ms 才出声 —— 就是"点了等一会儿"。
        /// 现在 1024 配 3 块，延迟约 70ms。
        /// </summary>
        const int FRAMES = 1024;

        /// <summary>把混音原样录到 WAV（诊断用，--record 打开）。</summary>
        static FileStream recStream;
        static long recFrames;
        static readonly object recGate = new object();

        /// <summary>
        /// 是否由本进程发声。默认 **true**。
        /// 曾尝试交给浏览器出声，但实测：DSH 面板一收起，client.js 就不再轮询 /events，
        /// 于是两边都不响。EXE 必须是唯一的发声者。
        /// </summary>
        public static bool SoundEnabled = true;

        public static string RecordPath = "";

        /// <summary>
        /// 离线渲染：不经过 waveOut，直接把整首曲子的混音写成 WAV。
        ///
        /// 为什么要单独一条路，而不是"边播边录"：
        ///   边播边录受实时性影响 —— 系统卡一下就会掉帧，渲染出来有断续；
        ///   而且必须真的等那么长时间（三分钟的歌要等三分钟）。
        ///   离线渲染是"有多少帧算多少帧"，几百倍速，而且结果确定、可复现。
        ///
        /// 实现上复用同一套 Voice / 混音 / 滤波代码，只是把输出去向从
        /// waveOut 的缓冲改成文件。音色和实时播放完全一致 —— 这里没有第二套合成器。
        /// </summary>
        /// <param name="path">输出 WAV 路径</param>
        /// <param name="timeline">[{ midi, at(ms), dur(ms), velocity, program, channel }]</param>
        /// <param name="tailMs">最后一个音之后再录多久（留余振）</param>
        /// <returns>渲染的秒数</returns>
        public static double RenderToWav(string path, System.Collections.IList timeline, int tailMs = 2500)
        {
            if (timeline == null || timeline.Count == 0) return 0;

            // 1) 先算出总时长
            double totalMs = 0;
            foreach (var raw in timeline)
            {
                var e = raw as System.Collections.IDictionary;
                if (e == null) continue;
                double at = Convert.ToDouble(e["at"], System.Globalization.CultureInfo.InvariantCulture);
                double dur = Convert.ToDouble(e["dur"], System.Globalization.CultureInfo.InvariantCulture);
                if (at + dur > totalMs) totalMs = at + dur;
            }
            totalMs += tailMs;
            long totalFrames = (long)(totalMs / 1000.0 * SR);
            if (totalFrames <= 0) return 0;
            if (totalFrames > (long)SR * 3600) totalFrames = (long)SR * 3600;   // 上限 1 小时

            Log("RENDER " + path + "  " + (totalMs / 1000.0).ToString("0.0") + "s  " + timeline.Count + " 音");

            // 2) 时间轴按时刻排序，逐帧推进
            // 用一个简单结构体而不是匿名类型 + dynamic：
            // 这里的 csc 是 .NET 4.0（C# 5），没有 dynamic 的运行时绑定，
            // 而且 ArrayList.Sort 只认 IComparer，不认 lambda。
            var notes = new List<RenderNote>();
            foreach (var raw in timeline)
            {
                var e = raw as System.Collections.IDictionary;
                if (e == null) continue;
                notes.Add(new RenderNote
                {
                    At = (long)Convert.ToDouble(e["at"], System.Globalization.CultureInfo.InvariantCulture),
                    Dur = (int)Convert.ToDouble(e["dur"], System.Globalization.CultureInfo.InvariantCulture),
                    Midi = Convert.ToInt32(e["midi"], System.Globalization.CultureInfo.InvariantCulture),
                    Vel = Convert.ToDouble(e["velocity"], System.Globalization.CultureInfo.InvariantCulture),
                });
            }
            notes.Sort(delegate (RenderNote a, RenderNote b) { return a.At.CompareTo(b.At); });

            var output = new short[totalFrames];
            var mix = new float[FRAMES];
            double dcIn = 0, dcOut = 0, dcInPrev = 0, dcOutPrev = 0;
            double limGain = 1.0;   // 限幅器当前增益（1.0 = 不压缩）
            int nextNote = 0;
            long frame = 0;

            lock (gate)
            {
                voices.Clear();

                while (frame < totalFrames)
                {
                    // 到点的音全部排进来（提前量按帧算，不用毫秒）
                    long nowMs = (long)(frame * 1000.0 / SR);
                    while (nextNote < notes.Count && notes[nextNote].At <= nowMs)
                    {
                        var n = notes[nextNote];
                        QueueGM(n.Midi, n.Vel, n.Dur);
                        nextNote++;
                    }

                    Array.Clear(mix, 0, FRAMES);
                    for (int i = voices.Count - 1; i >= 0; i--)
                    {
                        var v = voices[i];
                        MixVoice(v, mix, FRAMES);
                        if (v.Dead) voices.RemoveAt(i);
                    }

                    int n2 = (int)Math.Min(FRAMES, totalFrames - frame);
                    for (int k = 0; k < n2; k++)
                    {
                        dcIn = mix[k];
                        dcOut = DcCoef * (dcOutPrev + dcIn - dcInPrev);
                        dcInPrev = dcIn;
                        dcOutPrev = dcOut;
                        double limitedR = LimitGain(dcOut, ref limGain);
                        double x = Math.Tanh(limitedR);
                        output[frame + k] = (short)(x * 32000);
                    }
                    frame += n2;
                }
            }

            // 3) 写 WAV
            using (var fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read))
            {
                var h = new byte[44];
                int dataBytes = output.Length * 2;
                System.Text.Encoding.ASCII.GetBytes("RIFF").CopyTo(h, 0);
                // 偏移 4 的 RIFF 块长度：**文件总长 - 8**。
                // 漏填这个字段（一直是 0）的话，播放器/音频库会认为文件损坏 ——
                // Python 的 wave 模块直接报 "not a WAVE file"，
                // Windows 播放器也打不开。之前一直是 0，导出的文件其实不能用。
                BitConverter.GetBytes(dataBytes + 36).CopyTo(h, 4);
                System.Text.Encoding.ASCII.GetBytes("WAVEfmt ").CopyTo(h, 8);
                BitConverter.GetBytes(16).CopyTo(h, 16);
                BitConverter.GetBytes((short)1).CopyTo(h, 20);
                BitConverter.GetBytes((short)1).CopyTo(h, 22);
                BitConverter.GetBytes(SR).CopyTo(h, 24);
                BitConverter.GetBytes(SR * 2).CopyTo(h, 28);
                BitConverter.GetBytes((short)2).CopyTo(h, 32);
                BitConverter.GetBytes((short)16).CopyTo(h, 34);
                System.Text.Encoding.ASCII.GetBytes("data").CopyTo(h, 36);
                BitConverter.GetBytes(dataBytes).CopyTo(h, 40);
                fs.Write(h, 0, 44);
                var bytes = new byte[output.Length * 2];
                Buffer.BlockCopy(output, 0, bytes, 0, bytes.Length);
                fs.Write(bytes, 0, bytes.Length);
            }

            Log("RENDER done " + (output.Length / (double)SR).ToString("0.0") + "s");
            return output.Length / (double)SR;
        }

        /// <summary>离线渲染用的音符结构（避免 anonymous + dynamic）。</summary>
        struct RenderNote
        {
            public long At;
            public int Dur;
            public int Midi;
            public double Vel;
        }

        /// <summary>离线渲染时按 Midi 事件排一个音（和 GmEngine.Play 同样的选采样逻辑）。</summary>
        static void QueueGM(int midi, double vel, int durMs)
        {
            if (GmEngine.Ready && GmEngine.CurrentProgram != 0)
            {
                GmEngine.Play(midi, vel, durMs, true);
                return;
            }
            Play(midi, vel);
        }

        public static void StartRecord()
        {
            if (string.IsNullOrEmpty(RecordPath)) return;
            try
            {
                recStream = new FileStream(RecordPath, FileMode.Create, FileAccess.Write, FileShare.Read);
                var h = new byte[44];
                // RIFF/WAVE 头（长度先占位，Close 时回填）
                System.Text.Encoding.ASCII.GetBytes("RIFF").CopyTo(h, 0);
                System.Text.Encoding.ASCII.GetBytes("WAVEfmt ").CopyTo(h, 8);
                BitConverter.GetBytes(16).CopyTo(h, 16);
                BitConverter.GetBytes((short)1).CopyTo(h, 20);
                BitConverter.GetBytes((short)1).CopyTo(h, 22);
                BitConverter.GetBytes(SR).CopyTo(h, 24);
                BitConverter.GetBytes(SR * 2).CopyTo(h, 28);
                BitConverter.GetBytes((short)2).CopyTo(h, 32);
                BitConverter.GetBytes((short)16).CopyTo(h, 34);
                System.Text.Encoding.ASCII.GetBytes("data").CopyTo(h, 36);
                recStream.Write(h, 0, 44);
                recFrames = 0;
            }
            catch { recStream = null; }
        }

        public static void StopRecord()
        {
            lock (recGate)
            {
                if (recStream == null) return;
                try
                {
                    long dataLen = recFrames * 2;
                    recStream.Seek(4, SeekOrigin.Begin);
                    recStream.Write(BitConverter.GetBytes((int)(36 + dataLen)), 0, 4);
                    recStream.Seek(40, SeekOrigin.Begin);
                    recStream.Write(BitConverter.GetBytes((int)dataLen), 0, 4);
                    recStream.Close();
                }
                catch { }
                recStream = null;
            }
        }

        static string logPath = "";
        static readonly object logGate = new object();

        public static void SetLog(string path) { logPath = path; }

        public static void Log(string line)
        {
            if (string.IsNullOrEmpty(logPath)) return;
            try
            {
                lock (logGate)
                {
                    File.AppendAllText(logPath,
                        DateTime.Now.ToString("HH:mm:ss.fff") + " " + line + Environment.NewLine);
                }
            }
            catch { }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct WAVEFORMATEX
        {
            public short wFormatTag;
            public short nChannels;
            public int nSamplesPerSec;
            public int nAvgBytesPerSec;
            public short nBlockAlign;
            public short wBitsPerSample;
            public short cbSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct WAVEHDR
        {
            public IntPtr lpData;
            public int dwBufferLength;
            public int dwBytesRecorded;
            public IntPtr dwUser;
            public int dwFlags;
            public int dwLoops;
            public IntPtr lpNext;
            public IntPtr reserved;
        }

        [DllImport("winmm.dll")] static extern int waveOutOpen(out IntPtr h, int dev, ref WAVEFORMATEX fmt, IntPtr cb, IntPtr inst, int flags);
        [DllImport("winmm.dll")] static extern int waveOutPrepareHeader(IntPtr h, IntPtr hdr, int size);
        [DllImport("winmm.dll")] static extern int waveOutWrite(IntPtr h, IntPtr hdr, int size);
        [DllImport("winmm.dll")] static extern int waveOutUnprepareHeader(IntPtr h, IntPtr hdr, int size);
        [DllImport("winmm.dll")] static extern int waveOutReset(IntPtr h);
        [DllImport("winmm.dll")] static extern int waveOutClose(IntPtr h);

        /// <summary>
        /// 一阶高通系数（y = α·(y₋₁ + x - x₋₁)，α = RC/(RC+dt) ≈ 1）。
        /// 两级级联：每级 6dB/oct，两级 12dB/oct。
        /// 实测症状：静音状态下按任意键都有一声"咔"，频谱显示是 30-40Hz 以下的能量。
        /// 单级 45Hz 对 20Hz 只衰减 7dB，挡不住；两级 90Hz 才能把极低频压下去。
        /// </summary>
        static readonly double HpCoef = (1.0 / (2.0 * Math.PI * 90.0)) / (1.0 / (2.0 * Math.PI * 90.0) + 1.0 / SR);
        static readonly double HpCoef2 = HpCoef;
        /// <summary>输出前的直流隔断（10Hz），防止任何偏置直接进扬声器。</summary>
        static readonly double DcCoef = (1.0 / (2.0 * Math.PI * 10.0)) / (1.0 / (2.0 * Math.PI * 10.0) + 1.0 / SR);
        /// <summary>
        /// 峰值限幅：把超过阈值的部分压下来，但不让波形"撞墙"。
        ///
        /// 为什么必须有：混音是**不加限制地累加**的 —— 几百上千个声部同时响时，
        /// 混音值能到几十。原来的处理是 Math.Tanh(x)，它在 |x|>3 之后基本是常数，
        /// 波形被压成方波 —— 那就是"爆音"（刺耳的咔哒声）。
        ///
        /// 做法（瞬时压 + 平滑释放）：
        ///   · 超过阈值 → 立刻压到阈值（宁可短暂失真也不要破音）
        ///   · 低于阈值 → 200ms 时间常数慢慢恢复（避免"抽气"感）
        ///
        /// 阈值 0.92：留 8% 余量给 Tanh 的软膝，实际碰不到硬削。
        /// </summary>
        static double LimitGain(double sample, ref double gain)
        {
            const double THRESH = 0.92;
            double a = sample < 0 ? -sample : sample;
            if (a > THRESH)
            {
                double need = THRESH / a;
                if (need < gain) gain = need;
            }
            else
            {
                gain += (1.0 - gain) * 1.13e-4;   // SR=44100, 200ms
                if (gain > 1.0) gain = 1.0;
            }
            return sample * gain;
        }


        const int WHDR_DONE = 0x00000001;
        const int WAVE_MAPPER = -1;

        /// <summary>
        /// mdaPiano 的波表：1,172,698 字节 int16 PCM（586349 samples），以 22050Hz 录制。
        /// 从 mdaPiano.dll 的资源段原样提出，7 个 keygroup 覆盖 C2–C4 以上，其余靠变调。
        /// 这是 EOP 真正在用的音源，不是外部 wav/mp3。
        /// </summary>
        static short[] waveTable;
        /// {root, high, pos, end, loop} —— 与 mdaPiano 源码逐行一致（15 组）
        static readonly int[][] Kg =
        {
            new[] { 36,  37, 0,       36275,  14774 },
            new[] { 40,  41, 36278,   83135,  16268 },
            new[] { 43,  45, 83137,   146756, 33541 },
            new[] { 48,  49, 146758,  204997, 21156 },
            new[] { 52,  53, 204999,  244908, 17191 },
            new[] { 55,  57, 244910,  290978, 23286 },
            new[] { 60,  61, 290980,  342948, 18002 },
            new[] { 64,  65, 342950,  391750, 19746 },
            new[] { 67,  69, 391752,  436915, 22253 },
            new[] { 72,  73, 436917,  468807, 8852  },
            new[] { 76,  77, 468809,  492772, 9693  },
            new[] { 79,  81, 492774,  532293, 10596 },
            new[] { 84,  85, 532295,  560192, 6011  },
            new[] { 88,  89, 560194,  574121, 3414  },
            new[] { 93,  999, 574123, 586343, 2399  },
        };
        const double WtSampleRate = 22050.0;

        /// <summary>装载 mdaPiano 波表。返回样本数。</summary>
        public static int LoadWaveTable(string path)
        {
            if (!File.Exists(path)) return 0;
            var bytes = File.ReadAllBytes(path);
            waveTable = new short[bytes.Length / 2];
            Buffer.BlockCopy(bytes, 0, waveTable, 0, waveTable.Length * 2);
            return waveTable.Length;
        }

        static int FindKg(int midi)
        {
            for (int i = 0; i < Kg.Length; i++) if (midi <= Kg[i][1]) return i;
            return Kg.Length - 1;
        }

        static readonly Dictionary<int, short[]> samples = new Dictionary<int, short[]>();
        static readonly Dictionary<int, double> trims = new Dictionary<int, double>();
        static readonly List<Voice> voices = new List<Voice>();
        static readonly object gate = new object();
        static IntPtr handle = IntPtr.Zero;
        static volatile bool running;
        static Thread pump;

        static readonly double[] PeakDb = {
            -11.0, -9.2, -9.8, -9.0, -10.6,
            -9.8, -10.0, -11.2, -11.8, -11.7,
            -10.2, -13.3, -15.1, -10.5, -11.6,
            -14.8, -12.7, -12.6, -14.5, -13.9,
            -17.0, -17.2, -13.4, -16.2, -16.9,
            -19.5, -23.0, -17.1, -22.4, -20.3,
        };
        const double RefDb = -12.4;

        public static string Load(string wavDir)
        {
            int ok = 0;
            // 新音源：Yamaha Upright，88 键每键一个文件（文件名就是 MIDI 号）
            for (int m = 21; m <= 108; m++)
            {
                var path = Path.Combine(wavDir, m + ".wav");
                if (!File.Exists(path)) continue;
                try
                {
                    samples[m] = ReadWav(path);
                    ok++;
                }
                catch { }
            }
            // 响度补偿：每个采样点按实测峰值拉到统一电平，高低音才一样响
            for (int i = 0; i < 30; i++)
            {
                int m = 21 + i * 3;
                double db = PeakDb[i];
                trims[m] = Math.Pow(10, (RefDb - db) / 20.0);
            }
            return ok + " 个采样";
        }

        /// <summary>给 GmEngine 用的公开入口（ReadWav 本身保持 private）。</summary>
        public static short[] ReadWavPublic(string path) { return ReadWav(path); }

        static short[] ReadWav(string path)
        {
            var bytes = File.ReadAllBytes(path);
            int pos = 12;
            int dataOff = -1, dataLen = 0;
            while (pos + 8 <= bytes.Length)
            {
                var id = System.Text.Encoding.ASCII.GetString(bytes, pos, 4);
                int size = BitConverter.ToInt32(bytes, pos + 4);
                if (id == "data") { dataOff = pos + 8; dataLen = size; break; }
                pos += 8 + size + (size & 1);
            }
            if (dataOff < 0) throw new InvalidDataException("no data chunk");
            dataLen = Math.Min(dataLen, bytes.Length - dataOff);
            var pcm = new short[dataLen / 2];
            Buffer.BlockCopy(bytes, dataOff, pcm, 0, pcm.Length * 2);
            return pcm;
        }

        public static void Start()
        {
            if (running) return;
            var fmt = new WAVEFORMATEX();
            fmt.wFormatTag = 1;
            fmt.nChannels = 1;
            fmt.nSamplesPerSec = SR;
            fmt.wBitsPerSample = 16;
            fmt.nBlockAlign = 2;
            fmt.nAvgBytesPerSec = SR * 2;
            int rc = waveOutOpen(out handle, WAVE_MAPPER, ref fmt, IntPtr.Zero, IntPtr.Zero, 0);
            if (rc != 0)
            {
                Log("waveOutOpen 失败 rc=" + rc);
                handle = IntPtr.Zero;
                return;
            }
            Log("waveOut 打开成功，采样 " + samples.Count + " 个，每块 " + FRAMES + " 帧");
            running = true;
            pump = new Thread(PumpLoop) { IsBackground = true, Priority = ThreadPriority.AboveNormal };
            pump.Start();
        }

        public static void Stop()
        {
            running = false;
            if (handle != IntPtr.Zero) { try { waveOutReset(handle); } catch { } }
        }


        /// <summary>归一化 sinc。</summary>
        static double Sinc(double x)
        {
            if (x > -1e-9 && x < 1e-9) return 1.0;
            double px = Math.PI * x;
            return Math.Sin(px) / px;
        }

        /// <summary>
        /// Lanczos 窗 sinc：L(x) = sinc(x)·sinc(x/a)。
        /// a=4 即 8 抽样点（-3..+4）。
        /// 为什么必须用这个：线性插值本质是"无抗混叠滤波的重采样"，
        /// 波表 22050Hz 降到低音区 rate=0.25 时，超过 Nyquist×rate 的成分会折叠回低频，
        /// 听感就是"格子卡住"的阶梯声。sinc 插值自带带限，能从根上消掉混叠。
        /// </summary>
        static double Lanczos(double x, int a)
        {
            if (x <= -a || x >= a) return 0.0;
            return Sinc(x) * Sinc(x / a);
        }

        /// <summary>8-tap Lanczos 插值。</summary>
        static double SampleSinc(short[] d, double pos, int lo, int hi)
        {
            int i0 = (int)Math.Floor(pos);
            double frac = pos - i0;
            double sum = 0.0, wsum = 0.0;
            for (int k = -3; k <= 4; k++)
            {
                int idx = i0 + k;
                if (idx < lo) idx = lo;
                else if (idx >= hi) idx = hi - 1;
                double w = Lanczos(frac - k, 4);
                sum += d[idx] * w;
                wsum += w;
            }
            return wsum > 1e-9 ? sum / wsum : d[i0 < lo ? lo : (i0 >= hi ? hi - 1 : i0)];
        }

        static int Snap(int midi)
        {
            int m = (int)Math.Round((midi - 21) / 3.0) * 3 + 21;
            return Math.Max(21, Math.Min(108, m));
        }

        /// <summary>弹一个音。逻辑与网页版一致：采样变调 + 力度的幂曲线 + 响度补偿。</summary>
        public static void Play(int midi, double vel)
        {
            if (!SoundEnabled) return;

            // 每键独立采样（Yamaha Upright，88 键 × 3 层）。
            // 不再变调 —— 之前用 15 个 keygroup 覆盖 88 键，低音区 rate 低到 0.25，
            // 线性插值等于抽取，超过 Nyquist×rate 的成分折叠回低频，
            // 听感就是"格子卡住"的阶梯声。每键一个采样后 rate 恒为 1，混叠归零。
            int m = midi;
            if (m < 21) m = 21;
            if (m > 108) m = 108;
            short[] data;
            if (!samples.TryGetValue(m, out data))
            {
                Log("MISS m=" + midi);
                return;
            }
            if (data.Length < 256) return;

            double v = Math.Max(0.02, Math.Min(1, vel));
            double velGain = 0.15 + 0.85 * Math.Pow(v, 0.8);
            double gain = 0.95 * velGain;

            const double rate = 1.0;      // 无变调

            // 低通只负责压琴槌噪声，不再承担抗混叠（rate=1 时没有混叠）
            double cutoff = Math.Min(9000, 7000 + 2000 * v);
            double coef = 1.0 - Math.Exp(-2.0 * Math.PI * cutoff / SR);
            double shelfCoef = 1.0 - Math.Exp(-2.0 * Math.PI * 2000.0 / SR);

            Log("PLAY m=" + m + " len=" + data.Length + " gain=" + gain.ToString("0.000"));

            lock (gate)
            {
                // 复音上限：这条路径原来**完全没有**这道闸门 ——
                // MAX_VOICES 只写在 PlaySample()（GM 音色）里，
                // 钢琴走的是这里，于是同时能叠任意多个声部。
                // 实测日志里出现过 voices=2228：2228 个声部一起混，
                // 混音值远超 1.0，Tanh 压成方波 —— 那就是"爆音"。
                while (voices.Count >= MAX_VOICES) voices.RemoveAt(0);

                voices.Add(new Voice
                {
                    Data = data,
                    Start = 0,
                    End = data.Length,
                    Loop = 0,
                    Pos = 0,
                    Rate = rate,
                    Gain = gain,
                    LpCoef = coef,
                    ShelfCoef = shelfCoef,
                });
            }
        }

        /// <summary>
        /// 播一段任意采样（GM 乐器走这个入口）。
        /// 与 Play() 的区别：这里由调用方给定起止、循环点和包络，不做钢琴专用假设。
        ///
        /// sf2EnvMs 用的是 SF2 的时间单位：毫秒的绝对值，-32768 表示"瞬时"。
        /// 这里只翻译成秒，不做别的解释。
        /// </summary>
/// <summary>
        /// 把一个 voice 混进 mix（累加，不清零）。
        ///
        /// 实时播放和离线渲染共用这一个函数 —— 这样导出的 WAV 和听到的声音
        /// 走的是同一套包络、滤波、循环逻辑，不存在"录出来和听起来不一样"。
        /// </summary>
        static void MixVoice(Voice v, float[] mix, int count)
        {
                var d = v.Data;
                for (int n = 0; n < count; n++)
                {
                    // ── 循环回绕 ──
                    // 钢琴路径 LoopEnd=0，这一段永不进入，行为与改造前一致。
                    // GM 的弦乐/风琴/铺底是长音，采样只有 1-3 秒，
                    // 必须靠 sf2 自带的 loop 点续着，否则拉一个长音两秒就断。
                    if (v.LoopEnd > v.LoopStart && v.Pos >= v.LoopEnd)
                    {
                        double span = v.LoopEnd - v.LoopStart;
                        if (span > 8)
                            v.Pos = v.LoopStart + (v.Pos - v.LoopEnd) % span;
                        else
                            v.LoopEnd = 0;   // 循环段太短，回绕会变成嗡嗡声，直接放弃
                    }

                    int idx = (int)v.Pos;
                    if (idx >= v.End - 1 || idx >= d.Length - 1)
                    {
                        // 不循环的采样播完就结束；
                        // 循环的如果还能走到这儿，说明 loop 点越界了，也结束。
                        v.Dead = true;
                        break;
                    }

                    double env;
                    double atk = v.AttackSec > 1e-6 ? v.AttackSec : 1e-6;
                    if (v.Elapsed < atk)
                    {
                        env = v.Elapsed / atk;          // 起音淡入，防"啪"
                    }
                    else
                    {
                        // ── 到点释放 ──
                        // 循环采样自己不会结束，必须由"这个音该响多久"来收。
                        // HoldSec 是音符时长；超过之后按 ReleaseSec 线性淡出。
                        // 钢琴路径 HoldSec=0（不设），跳过这一段，行为不变。
                        if (v.HoldSec > 0 && v.Elapsed >= v.HoldSec)
                        {
                            double rel = v.ReleaseSec > 0.01 ? v.ReleaseSec : 0.12;
                            double over = v.Elapsed - v.HoldSec;
                            if (over >= rel) { v.Dead = true; break; }
                            env = 1.0 - over / rel;
                            // 释放阶段不再走后面那套衰减计算
                            goto envelopeDone;
                        }

                        env = Math.Exp(-(v.Elapsed - atk) / Math.Max(0.001, v.DecaySec));

                        // sustain 下限：GM 乐器衰减到某个电平后应该保持住
                        // （风琴/弦乐是持续的，不是敲一下就没了）。
                        // 钢琴 SustainLevel=0，这一行不改变任何东西。
                        if (v.SustainLevel > 0 && env < v.SustainLevel)
                            env = v.SustainLevel;

                        // 收尾淡出只对不循环的采样做。
                        // 循环的长音不需要，它会一直响到松键。
                        if (v.LoopEnd <= v.LoopStart)
                        {
                            double totalSec = (v.End - v.Start) / v.Rate / SR;
                            double remain = totalSec - v.Elapsed;
                            if (remain < 0.040)
                            {
                                if (remain <= 0) { v.Dead = true; break; }
                                env *= remain / 0.040;
                            }
                        }
                        if (env < 0.0006 && v.SustainLevel <= 0.001) { v.Dead = true; break; }
                    }
                    envelopeDone:;

                    // rate==1（每键独立采样）时 frac 恒为 0，8-tap 插值纯属浪费，
                    // 权重只有 k=0 是 1，其余全 0 —— 直接取整即可，省 8 倍。
                    double smp;
                    if (v.Rate == 1.0) smp = d[idx];
                    else smp = SampleSinc(d, v.Pos, v.Start, v.End);
                    v.LpState += v.LpCoef * (smp - v.LpState);
                    // 两级级联高通（12dB/oct），把 40Hz 以下的能量压死
                    double hp1 = HpCoef * (v.HpPrevOut + v.LpState - v.HpPrevIn);
                    v.HpPrevIn = v.LpState;
                    v.HpPrevOut = hp1;
                    double hp = HpCoef2 * (v.Hp2PrevOut + hp1 - v.Hp2PrevIn);
                    v.Hp2PrevIn = hp1;
                    v.Hp2PrevOut = hp;
                    // 高频搁架：bright = x + k(x - lowpass2k(x))。
                    // 起音第一帧 ShelfState 还是 0，公式会变成 x + k·x（放大 2.1 倍），
                    // 每个音的起音都"哒"一下 —— 听感就是跟着音符走的节拍器。
                    // 前 10ms 让 ShelfState 直接跟随 hp，跳过放大。
                    if (v.Elapsed < 0.010) v.ShelfState = hp;
                    else v.ShelfState += v.ShelfCoef * (hp - v.ShelfState);
                    double bright = hp + 1.1 * (hp - v.ShelfState);
                    mix[n] += (float)(bright / 32768.0 * v.Gain * env);
                    v.Pos += v.Rate;
                    v.Elapsed += v.Rate / SR;
                }
        }

        public static void PlaySample(
            short[] data, int start, int end,
            int loopStart, int loopEnd,
            double rate, double gain,
            int attackMs, int decayMs, int sustainDb, int releaseMs,
            int rawSampleRate, double holdSec)
        {
            if (!SoundEnabled) return;
            if (data == null || data.Length < 64) return;

            // 采样率归一：GM 里 44100 和 48000 混着，统一到引擎的 SR
            if (rawSampleRate > 0 && rawSampleRate != SR)
                rate *= (double)rawSampleRate / SR;

            double v = Math.Max(0.02, Math.Min(1.0, gain / 0.95));
            double cutoff = Math.Min(9000, 7000 + 2000 * v);
            double coef = 1.0 - Math.Exp(-2.0 * Math.PI * cutoff / SR);
            double shelfCoef = 1.0 - Math.Exp(-2.0 * Math.PI * 2000.0 / SR);

            // SF2 的包络时间单位是"时间cents"：ms = 2^(val/1200)，val=-32768 视为 0
            double attackSec = EnvSeconds(attackMs, 0.008);
            double decaySec = EnvSeconds(decayMs, 1.4);
            double releaseSec = EnvSeconds(releaseMs, 0.0);
            // sustainVolEnv 是"衰减掉多少 centibel"：
            //   0    = 一点都不掉（小提琴/弦乐/风琴这类持续音，也包含钢琴）
            //   1000 = 掉 100 dB（等于静音）
            // 之前写反了 —— 把 0 当成"衰减到 0"，于是小提琴 1ms 内就没声了。
            // 正确的换算是 10^(-centibel/200)：0 → 1.0，1000 → 1e-5。
            double sustain = Math.Pow(10.0, -Math.Max(0, sustainDb) / 200.0);
            if (sustain > 1.0) sustain = 1.0;

            lock (gate)
            {
                // 复音上限：超过就偷最老的那个。
                // GM 的长音（弦乐、风琴）不会自己结束，没有这道闸门，
                // 一首曲子播到一半就有几十个 voice 叠在一起，直接削波。
                while (voices.Count >= MAX_VOICES) voices.RemoveAt(0);

                voices.Add(new Voice
                {
                    Data = data,
                    Start = start,
                    End = end,
                    Loop = loopStart,
                    Pos = start,
                    Rate = rate,
                    Gain = gain,
                    LpCoef = coef,
                    ShelfCoef = shelfCoef,
                    LoopStart = loopStart,
                    LoopEnd = loopEnd,
                    AttackSec = attackSec,
                    DecaySec = decaySec,
                    SustainLevel = sustain,
                    ReleaseSec = releaseSec,
                    HoldSec = holdSec,
                });
            }
            Log("GMPLAY start=" + start + " end=" + end + " loop=" + loopStart + ".." + loopEnd +
                " rate=" + rate.ToString("0.0000") + " gain=" + gain.ToString("0.000"));
        }

        /// <summary>SF2 时间cents → 秒。负值按 0 处理。</summary>
        static double EnvSeconds(int timecents, double fallback)
        {
            if (timecents <= -32768) return 0.0;
            if (timecents == 0) return fallback;
            double sec = Math.Pow(2.0, timecents / 1200.0);
            if (sec > 60) sec = 60;
            return sec;
        }

        public static void AllOff()
        {
            lock (gate) voices.Clear();
        }

        /// <summary>缓冲数量。3 块折中：延迟约 70ms，同时仍有 2 块在前台排队，不容易断粮。</summary>
        const int NBUF = 3;

        /// <summary>
        /// 复音上限。超过就偷最老的 voice。
        /// 24 对钢琴够（十个手指最多按十几个音 + 踏板余音），
        /// GM 弦乐那种不停的长音需要多留一点，给 32。
        /// </summary>
        const int MAX_VOICES = 32;

        static void PumpLoop()
        {
            var fmtSize = Marshal.SizeOf(typeof(WAVEHDR));
            var bufs = new byte[NBUF][];
            var mix = new float[FRAMES];
            double dcIn = 0, dcOut = 0, dcInPrev = 0, dcOutPrev = 0;
            double limGain = 1.0;   // 限幅器当前增益（1.0 = 不压缩）   // 输出前直流隔断的状态

            // WAVEHDR 必须放在**非托管内存**里。
            // 托管数组里的结构体，驱动写回的是它自己固定的那份副本，
            // 我们在托管侧读 dwFlags 永远看不到 WHDR_DONE —— 队列判断就全错。
            var hdrPtrs = new IntPtr[NBUF];
            for (int b = 0; b < NBUF; b++)
            {
                hdrPtrs[b] = Marshal.AllocHGlobal(fmtSize);
                bufs[b] = new byte[FRAMES * 2];
                var h0 = new WAVEHDR();
                h0.lpData = Marshal.AllocHGlobal(bufs[b].Length);
                h0.dwBufferLength = bufs[b].Length;
                h0.dwFlags = 0;
                Marshal.StructureToPtr(h0, hdrPtrs[b], false);
                waveOutPrepareHeader(handle, hdrPtrs[b], fmtSize);
                // prepare 之后把 DONE 打上，表示这块初始可用
                var h1 = (WAVEHDR)Marshal.PtrToStructure(hdrPtrs[b], typeof(WAVEHDR));
                h1.dwFlags |= WHDR_DONE;
                Marshal.StructureToPtr(h1, hdrPtrs[b], false);
            }

            int next = 0;
            long blocks = 0;

            while (running)
            {
                var hp2 = hdrPtrs[next];

                // 等这一块播完。超时上限要小：一块只有 46ms，
                // 之前给 4000ms，一旦驱动没及时置 WHDR_DONE 就每块干等 4 秒，
                // 结果 4 分钟只放出 147 个音（听着就是"没在播"）。
                // 多缓冲下就算这一块还没播完，直接填下一块也不会断粮。
                int spin = 0;
                while (running && spin < 60)
                {
                    var cur = (WAVEHDR)Marshal.PtrToStructure(hp2, typeof(WAVEHDR));
                    if ((cur.dwFlags & WHDR_DONE) != 0) break;
                    Thread.Sleep(1);
                    spin++;
                }
                if (!running) break;

                // ── 混音到 bufs[next] ──
                Array.Clear(mix, 0, FRAMES);
                lock (gate)
                {
                    for (int i = voices.Count - 1; i >= 0; i--)
                    {
                        var v = voices[i];
                        MixVoice(v, mix, FRAMES);
                        if (v.Dead) voices.RemoveAt(i);
                    }
                }

                var buf = bufs[next];
                float peak = 0f;
                for (int n = 0; n < FRAMES; n++)
                {
                    // 直流隔断：整条混音再过一次 10Hz 高通。
                    // 任何起音/松键造成的偏置都在这里被拿掉，
                    // 否则它会以"咔"的形式从扬声器放出来。
                    dcIn = mix[n];
                    dcOut = DcCoef * (dcOutPrev + dcIn - dcInPrev);
                    dcInPrev = dcIn;
                    dcOutPrev = dcOut;
                    double limited = LimitGain(dcOut, ref limGain);
                    double x = Math.Tanh(limited);
                    short sv = (short)(x * 32000);
                    buf[n * 2] = (byte)(sv & 0xFF);
                    buf[n * 2 + 1] = (byte)((sv >> 8) & 0xFF);
                    float a = x < 0 ? (float)-x : (float)x;
                    if (a > peak) peak = a;
                }

                if (recStream != null)
                {
                    lock (recGate)
                    {
                        try { recStream.Write(buf, 0, buf.Length); recFrames += FRAMES; } catch { }
                    }
                }

                if (blocks % 40 == 0)
                    Audio.Log("BLOCK " + blocks + " peak=" + peak.ToString("0.0000") + " voices=" + voices.Count + " bufs=" + NBUF);
                blocks++;

                var hw = (WAVEHDR)Marshal.PtrToStructure(hp2, typeof(WAVEHDR));
                Marshal.Copy(buf, 0, hw.lpData, buf.Length);
                hw.dwFlags &= ~WHDR_DONE;
                Marshal.StructureToPtr(hw, hp2, false);
                int wrc = waveOutWrite(handle, hp2, fmtSize);
                if (wrc != 0) { Audio.Log("waveOutWrite 失败 rc=" + wrc); break; }

                next = (next + 1) % NBUF;
            }

            for (int b = 0; b < NBUF; b++)
            {
                waveOutUnprepareHeader(handle, hdrPtrs[b], fmtSize);
                var hf = (WAVEHDR)Marshal.PtrToStructure(hdrPtrs[b], typeof(WAVEHDR));
                Marshal.FreeHGlobal(hf.lpData);
                Marshal.FreeHGlobal(hdrPtrs[b]);
            }
            if (handle != IntPtr.Zero) waveOutClose(handle);
            handle = IntPtr.Zero;
        }
    }
}
