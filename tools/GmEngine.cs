using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Web.Script.Serialization;

namespace DshPiano
{
/// <summary>
/// GM 多乐器引擎。
///
/// 与 PianoAudio 的分工：
///   PianoAudio  = waveOut 输出、混音、包络、滤波（底层，只管"把一段 PCM 播出来"）
///   GmEngine    = 乐器库、preset 切换、按 key/vel 选采样、算变调比（这一层）
///
/// 一个音从 MIDI 事件到实际采样，要经过三次筛选：
///
///   1. preset  → 当前 bank/program 决定用哪个乐器（GM 128 音色之一）
///   2. zone    → 按 midi 落在哪个 keyRange、vel 落在哪个 velRange
///   3. sample  → zone 里每个采样各覆盖一段音域，找包含 midi 的那个
///
/// 找到采样后算变调比：
///   rate = 2^((midi - originalPitch + pitchCorrection/100) / 12)
///
/// originalPitch 是这个采样录制的原始音高（比如 C4 = 60），
/// 差几个半音就升几个半音。pitchCorrection 是录制时的微调（单位音分）。
/// </summary>
static class GmEngine
{
    // ── 数据结构：对应 index.json ──
    public sealed class GmSample
    {
        public string File;
        public int MidiLow, MidiHigh;
        public int OriginalPitch;
        public int PitchCorrection;
        public int SampleRate;
        public int LoopStart, LoopEnd;
        public int SampleModes;      // 1 = 循环，0 = 不循环
        public int AttackMs, HoldMs, DecayMs, ReleaseMs;
        public int SustainDb;
        public int Attenuation;
        public int Pan;
        public int Tune;
        public short[] Pcm;          // 惰性加载
    }

    public sealed class GmZone
    {
        public int KeyLow, KeyHigh;
        public int VelLow, VelHigh;
        public List<GmSample> Samples = new List<GmSample>();
    }

    public sealed class GmPreset
    {
        public int Bank, Program;
        public string Name;
        public List<GmZone> Zones = new List<GmZone>();
        public int NoteCount { get { int n = 0; foreach (var z in Zones) n += z.Samples.Count; return n; } }
    }

    // ── 状态 ──
    static string dataDir = "";
    static readonly Dictionary<int, GmPreset> presets = new Dictionary<int, GmPreset>();  // key = bank*256 + program
    static readonly List<GmPreset> ordered = new List<GmPreset>();                         // 按 program 排序
    static GmPreset current = null;
    static int currentBank, currentProgram;

    public static bool Ready { get { return presets.Count > 0; } }
    public static int Count { get { return presets.Count; } }
    public static GmPreset Current { get { return current; } }
    public static int CurrentProgram { get { return currentProgram; } }
    public static int CurrentBank { get { return currentBank; } }
    public static List<GmPreset> All { get { return ordered; } }

    /// <summary>加载 index.json。返回可读的摘要。</summary>
    public static string Load(string indexPath)
    {
        if (!File.Exists(indexPath))
            return "找不到 " + indexPath;

        dataDir = Path.GetDirectoryName(indexPath);
        string json = File.ReadAllText(indexPath);
        var ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        var root = ser.Deserialize<Dictionary<string, object>>(json);

        presets.Clear();
        ordered.Clear();

        if (!root.ContainsKey("presets"))
            return "index.json 里没有 presets";

        var list = root["presets"] as System.Collections.ArrayList;
        if (list == null) return "presets 格式不对";

        foreach (var item in list)
        {
            var pd = item as Dictionary<string, object>;
            if (pd == null) continue;

            var p = new GmPreset
            {
                Bank = ToInt(pd, "bank"),
                Program = ToInt(pd, "program"),
                Name = ToStr(pd, "name"),
            };

            var zl = pd.ContainsKey("zones") ? pd["zones"] as System.Collections.ArrayList : null;
            if (zl == null) continue;

            foreach (var zi in zl)
            {
                var zd = zi as Dictionary<string, object>;
                if (zd == null) continue;

                var z = new GmZone();
                var kr = zd.ContainsKey("keyRange") ? zd["keyRange"] as System.Collections.ArrayList : null;
                var vr = zd.ContainsKey("velRange") ? zd["velRange"] as System.Collections.ArrayList : null;
                z.KeyLow = kr != null && kr.Count > 0 ? Convert.ToInt32(kr[0]) : 0;
                z.KeyHigh = kr != null && kr.Count > 1 ? Convert.ToInt32(kr[1]) : 127;
                z.VelLow = vr != null && vr.Count > 0 ? Convert.ToInt32(vr[0]) : 0;
                z.VelHigh = vr != null && vr.Count > 1 ? Convert.ToInt32(vr[1]) : 127;

                var sl = zd.ContainsKey("samples") ? zd["samples"] as System.Collections.ArrayList : null;
                if (sl == null) { if (z.Samples.Count > 0) p.Zones.Add(z); continue; }

                foreach (var si in sl)
                {
                    var sd = si as Dictionary<string, object>;
                    if (sd == null) continue;
                    z.Samples.Add(new GmSample
                    {
                        File = ToStr(sd, "file"),
                        MidiLow = ToInt(sd, "midiLow"),
                        MidiHigh = ToInt(sd, "midiHigh"),
                        OriginalPitch = ToInt(sd, "originalPitch"),
                        PitchCorrection = ToInt(sd, "pitchCorrection"),
                        SampleRate = ToInt(sd, "sampleRate"),
                        LoopStart = ToInt(sd, "loopStart"),
                        LoopEnd = ToInt(sd, "loopEnd"),
                        SampleModes = ToInt(sd, "sampleModes"),
                        AttackMs = ToInt(sd, "attackMs"),
                        HoldMs = ToInt(sd, "holdMs"),
                        DecayMs = ToInt(sd, "decayMs"),
                        SustainDb = ToInt(sd, "sustainDb"),
                        ReleaseMs = ToInt(sd, "releaseMs"),
                        Attenuation = ToInt(sd, "attenuation"),
                        Pan = ToInt(sd, "pan"),
                        Tune = ToInt(sd, "tune"),
                    });
                }
                if (z.Samples.Count > 0) p.Zones.Add(z);
            }

            if (p.Zones.Count == 0) continue;
            int key = p.Bank * 256 + p.Program;
            if (!presets.ContainsKey(key)) presets[key] = p;
            ordered.Add(p);
        }

        // 按 program 排序，UI 下拉框才是 GM 标准顺序
        ordered.Sort((a, b) => a.Bank != b.Bank ? a.Bank.CompareTo(b.Bank) : a.Program.CompareTo(b.Program));

        if (ordered.Count > 0) SetProgram(ordered[0].Bank, ordered[0].Program);

        return ordered.Count + " 个乐器";
    }

    /// <summary>切换乐器。</summary>
    public static bool SetProgram(int bank, int program)
    {
        int key = bank * 256 + program;
        GmPreset p;
        if (!presets.TryGetValue(key, out p))
        {
            // bank 没有就退回 bank 0（GM 的常规做法）
            if (bank != 0 && presets.TryGetValue(program, out p)) { bank = 0; }
            else return false;
        }
        current = p; currentBank = bank; currentProgram = program;
        return true;
    }

    public static bool SetProgram(int program)
    {
        // 优先 bank 0
        if (presets.ContainsKey(program)) return SetProgram(0, program);
        foreach (var p in ordered)
            if (p.Program == program) return SetProgram(p.Bank, p.Program);
        return false;
    }

    /// <summary>
    /// 选采样。返回 null 表示这个音域该乐器没有采样（极少数情况）。
    /// 三级筛选：zone（按 key+vel）→ sample（按 key）。
    /// </summary>
    public static GmSample Pick(int midi, int velocity, out GmZone zone)
    {
        zone = null;
        if (current == null) return null;

        int vel = Math.Max(1, Math.Min(127, velocity));

        // 第一轮：选 zone。
        //
        // 这里有个坑：zone 自己的 keyRange 常常是 0-127（等于不限），
        // 真正决定"这个 zone 能不能发出 midi 这个音"的是它下面的采样音域。
        // 钢琴就是典型：vel 1-100 有两个 zone，一个装低音区 60 个采样、
        // 一个装高音区 22 个采样，两者的 keyRange 都是 0-127。
        // 只看 keyRange 会选中第一个，然后用"最近采样"兜底去变调 28 个半音，
        // 听感就是完全跑调。
        //
        // 所以判据必须是「这个 zone 里确实有采样覆盖 midi」。
        GmZone best = null;
        bool bestLoop = false;
        foreach (var z in current.Zones)
        {
            if (vel < z.VelLow || vel > z.VelHigh) continue;
            if (midi < z.KeyLow || midi > z.KeyHigh) continue;

            bool hasCover = false;
            bool hasLoop = false;
            foreach (var s0 in z.Samples)
            {
                if (midi >= s0.MidiLow && midi <= s0.MidiHigh)
                {
                    hasCover = true;
                    if (s0.SampleModes == 1) hasLoop = true;
                }
            }
            if (!hasCover) continue;

            if (best == null) { best = z; bestLoop = hasLoop; continue; }

            // ── 选哪一个 zone ──
            //
            // SF2 的 zone 会重叠。大提琴是典型：主音 zone（velRange 0-79 等，
            // 采样 1.35 秒、有 loop 点）和 release sample zone（velRange 69-127
            // 等，采样 0.24 秒、无 loop）压在同一片 vel 区间上。
            //
            // 原来按"vel 范围更窄"挑，结果选中了宽度 10 的 release zone，
            // 拿到 0.24 秒的松键采样 —— 大提琴听起来像被掐断。
            //
            // 现在的判据：**有循环采样的优先**。release sample 永远不循环
            // （它是松键那一瞬的噪声），所以这一条能把两者分开。
            // 同为循环或同为不循环时，再比 vel 宽度。
            if (hasLoop != bestLoop)
            {
                if (hasLoop) { best = z; bestLoop = true; }
                continue;
            }
            int w1 = best.VelHigh - best.VelLow;
            int w2 = z.VelHigh - z.VelLow;
            if (w2 < w1) { best = z; bestLoop = hasLoop; }
        }
        // 退路：没有 zone 能精确覆盖，就挑采样音域最接近的那个 zone
        if (best == null)
        {
            int bestDist = int.MaxValue;
            foreach (var z in current.Zones)
            {
                if (vel < z.VelLow || vel > z.VelHigh) continue;
                foreach (var s0 in z.Samples)
                {
                    int d = midi < s0.MidiLow ? s0.MidiLow - midi
                          : midi > s0.MidiHigh ? midi - s0.MidiHigh : 0;
                    if (d < bestDist) { bestDist = d; best = z; }
                }
            }
        }
        if (best == null) return null;
        zone = best;

        // 第二轮：zone 里哪个采样覆盖 midi
        GmSample exact = null, near = null;
        int nearDist = int.MaxValue;
        foreach (var s in best.Samples)
        {
            if (midi >= s.MidiLow && midi <= s.MidiHigh) { exact = s; break; }
            // 记录最近的，作为超出音域时的兜底
            int d = midi < s.MidiLow ? s.MidiLow - midi : midi - s.MidiHigh;
            if (d < nearDist) { nearDist = d; near = s; }
        }
        return exact ?? near;
    }

    /// <summary>
    /// 弹一个音。选到采样就交给 Audio 播，没选到就静默跳过。
    /// </summary>
    public static bool Play(int midi, double velocity, int holdMs)
    {
        return Play(midi, velocity, holdMs, false);
    }

    /// <param name="offline">离线渲染：不写日志，避免几万个音把日志刷爆。</param>
    public static bool Play(int midi, double velocity, int holdMs, bool offline)
    {
        if (!Ready) return false;

        int velInt = (int)Math.Round(Math.Max(1, Math.Min(127, velocity * 127)));
        GmZone zone;
        var s = Pick(midi, velInt, out zone);
        if (s == null)
        {
            if (!offline) Audio.Log("NOMAP m=" + midi + " vel=" + velInt + " prog=" + currentProgram);
            return false;
        }

        // 采样惰性加载：第一次用到这个采样才读盘
        if (s.Pcm == null)
        {
            string path = Path.Combine(dataDir, s.File);
            if (!File.Exists(path)) { Audio.Log("NOFILE " + path); return false; }
            try { s.Pcm = Audio.ReadWavPublic(path); }
            catch (Exception ex) { Audio.Log("READFAIL " + s.File + " " + ex.Message); return false; }
        }
        if (s.Pcm.Length < 64) return false;

        // 变调比：以采样原始音高为基准
        double semis = (midi - s.OriginalPitch) + s.PitchCorrection / 100.0 + s.Tune / 100.0;
        double rate = Math.Pow(2.0, semis / 12.0);

        // 力度 → 增益。GM 的 attenuation 是"衰减多少分贝"，单位 0.1dB（正值变小）
        double v = Math.Max(0.02, Math.Min(1.0, velocity));
        double velGain = 0.10 + 0.90 * Math.Pow(v, 0.85);
        double attGain = Math.Pow(10.0, -s.Attenuation / 200.0);   // centibel → 线性
        // 0.30 而不是 0.90：GM 采样本身电平就高（FluidR3 是归一化的），
        // 再加上弦乐/风琴不衰减会一直叠，0.90 直接削波。实测 0.30 峰值约 0.35。
        double gain = 0.30 * velGain * attGain;

        // 循环：sampleModes == 1 才循环（弦乐/风琴/铺底需要长音）
        int loopStart = (s.SampleModes == 1 && s.LoopEnd > s.LoopStart) ? s.LoopStart : 0;
        int loopEnd = (s.SampleModes == 1 && s.LoopEnd > s.LoopStart) ? s.LoopEnd : 0;

        // 记下选了哪个采样 —— 只靠 start/end 对不出文件，排查时全是猜。
        if (!offline)
            Audio.Log("PICK prog=" + currentProgram + " m=" + midi + " vel=" + velInt
                      + " → " + s.File + " (orig=" + s.OriginalPitch
                      + " modes=" + s.SampleModes + ")");

        Audio.PlaySample(
            s.Pcm,
            start: 0,
            end: s.Pcm.Length,
            loopStart: loopStart,
            loopEnd: loopEnd,
            rate: rate,
            gain: gain,
            attackMs: s.AttackMs,
            decayMs: s.DecayMs,
            sustainDb: s.SustainDb,
            releaseMs: s.ReleaseMs,
            rawSampleRate: s.SampleRate,
            holdSec: Math.Max(0.02, holdMs / 1000.0));

        return true;
    }

    // ── JSON 取值辅助 ──
    static int ToInt(Dictionary<string, object> d, string k)
    {
        object o;
        if (!d.TryGetValue(k, out o) || o == null) return 0;
        try { return Convert.ToInt32(o, CultureInfo.InvariantCulture); } catch { return 0; }
    }

    static string ToStr(Dictionary<string, object> d, string k)
    {
        object o;
        if (!d.TryGetValue(k, out o) || o == null) return "";
        return o.ToString();
    }
}
}
