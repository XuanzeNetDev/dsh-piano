#!/usr/bin/env python3
"""
从 GM SoundFont（.sf2 / .sf3）导出采样，组织成引擎能直接读的结构。

为什么要单独写一个导出脚本，而不是让引擎直接读 SF3：
    SF3 里的采样是 Ogg Vorbis 压缩的，而且 1187 个 Ogg 流首尾相接存在
    同一个 smpl 块里，每次播放都要现场 seek + 解码 —— 那会把实时性毁掉。

    离线导成 WAV 之后，引擎只需要 fopen + 读 PCM，和现在的钢琴引擎一样。

输出结构：
    assets/gm/out/
    ├── index.json              所有 preset / zone / 采样的元数据
    ├── p0/                     program 0（Grand Piano）
    │   ├── 0_0-127_0-63.wav
    │   └── ...
    ├── p1/                     program 1（Bright Grand Piano）
    └── ...

    WAV 文件名 = {采样序号}_{keyRange}_{velRange}.wav
    这样一个目录下的文件名本身就说明了它覆盖哪个音域、哪个力度层。

用法：
    python tools/extract_gm.py                       # 默认导出 bank 0（GM 128 音色）
    python tools/extract_gm.py --all-banks           # 连 GS 变体和鼓组一起导
    python tools/extract_gm.py --only 0,48,40        # 只导某几个 program
    python tools/extract_gm.py --max-seconds 3       # 每个采样截到 3 秒（默认）
"""

import json
import os
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from sf2_parse import SoundFont   # noqa: E402

PKG = os.path.dirname(HERE)
DEFAULT_SF = os.path.join(PKG, "assets", "gm", "FluidR3Mono_GM.sf3")
OUT_DIR = os.path.join(PKG, "assets", "gm", "out")

# ffmpeg：只用于把 Ogg 解成 WAV。没装就报错退出（不静默降级）
FFMPEG_CANDIDATES = [
    r"E:\ffmpeg-2026-06-15-git-44d082edc8-full_build\bin\ffmpeg.exe",
    "ffmpeg",
]

TARGET_SR = 44100          # 引擎按 44100 工作，统一重采样到这
MAX_SECONDS = 4.0          # 每个采样最多保留 4 秒（钢琴余振需要这么长）
MAX_SAMPLES_PER_ZONE = 128  # 单个 zone 超过这个数就按 keyRange 下采样


def find_ffmpeg():
    for p in FFMPEG_CANDIDATES:
        try:
            r = subprocess.run([p, "-version"], capture_output=True, timeout=10)
            if r.returncode == 0:
                return p
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
    return None


def decode_ogg_to_wav(ffmpeg, ogg_bytes, out_path, tmpdir, idx):
    """一个 Ogg 流 → 44100 单声道 16bit WAV，截到 MAX_SECONDS。"""
    ogg_path = os.path.join(tmpdir, f"t{idx}.ogg")
    with open(ogg_path, "wb") as f:
        f.write(ogg_bytes)
    cmd = [
        ffmpeg, "-y", "-loglevel", "error",
        "-i", ogg_path,
        "-t", str(MAX_SECONDS),
        "-ar", str(TARGET_SR),
        "-ac", "1",
        "-c:a", "pcm_s16le",
        out_path,
    ]
    r = subprocess.run(cmd, capture_output=True, timeout=120)
    if not os.path.exists(out_path) or os.path.getsize(out_path) <= 44:
        return False, (r.stderr or b"").decode("utf-8", "replace")[-200:]
    return True, ""


def trim_names(name):
    """SF2 里的名字可能带控制字符，清一下。"""
    return "".join(c if 32 <= ord(c) < 127 or ord(c) > 127 else " " for c in name).strip()


def export(sf_path, out_dir, all_banks=False, only_programs=None, max_seconds=MAX_SECONDS):
    global MAX_SECONDS
    MAX_SECONDS = max_seconds

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise SystemExit("找不到 ffmpeg。请装 ffmpeg 或改 FFMPEG_CANDIDATES 里的路径。")
    print(f"ffmpeg: {ffmpeg}")

    sf = SoundFont(sf_path)
    smpl_off, _ = sf.smpl
    print(f"音源: {os.path.basename(sf_path)}  {len(sf.presets)} 预设  {len(sf.samples)} 采样")

    os.makedirs(out_dir, exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix="sf3x-")

    # ── 选 preset：按 bank+program 去重，同号取采样数最多的 ──
    by_key = {}
    for p in sf.presets:
        if not all_banks and p["bank"] != 0:
            continue
        if only_programs and p["program"] not in only_programs:
            continue
        zones = sf.zones_of_preset(p["index"])
        nsamples = sum(len(z.get("instruments", [])) for z in zones)
        if nsamples == 0:
            continue         # 空壳（bank 0 program 0 有个重复的空项）
        key = (p["bank"], p["program"])
        if key not in by_key or nsamples > by_key[key][1]:
            by_key[key] = (p, nsamples, zones)

    print(f"选中 {len(by_key)} 个预设待导出\n")

    index = {
        "source": os.path.basename(sf_path),
        "targetSampleRate": TARGET_SR,
        "maxSeconds": MAX_SECONDS,
        "presets": [],
    }

    counter = 0
    ok_count = 0
    fail_count = 0

    for (bank, program), (preset, nsamples, zones) in sorted(by_key.items()):
        pdir = os.path.join(out_dir, f"p{program}")
        os.makedirs(pdir, exist_ok=True)

        pentry = {
            "bank": bank,
            "program": program,
            "name": trim_names(preset["name"]),
            "zones": [],
        }

        for zi, zone in enumerate(zones):
            zentry = {
                "keyRange": zone.get("keyRange", [0, 127]),
                "velRange": zone.get("velRange", [0, 127]),
                "samples": [],
            }
            instruments = zone.get("instruments", [])
            if len(instruments) > MAX_SAMPLES_PER_ZONE:
                step = len(instruments) / MAX_SAMPLES_PER_ZONE
                instruments = [instruments[int(i * step)] for i in range(MAX_SAMPLES_PER_ZONE)]

            for si, ins in enumerate(instruments):
                counter += 1
                sample_idx = None
                for s in sf.samples:
                    if s["name"] == ins["sample"]:
                        sample_idx = s["index"]
                        break
                if sample_idx is None:
                    continue

                s = sf.samples[sample_idx]
                ogg = sf.data[smpl_off + s["start"]: smpl_off + s["end"]]
                if not ogg or ogg[:4] != b"OggS":
                    fail_count += 1
                    continue

                ik = ins.get("keyRange", [0, 127])
                fname = f"{sample_idx}_{ik[0]}-{ik[1]}_{zentry['velRange'][0]}-{zentry['velRange'][1]}.wav"
                wav_path = os.path.join(pdir, fname)

                if not os.path.exists(wav_path):
                    success, err = decode_ogg_to_wav(ffmpeg, ogg, wav_path, tmpdir, counter)
                    if not success:
                        fail_count += 1
                        if fail_count <= 5:
                            print(f"  解码失败 [{sample_idx}] {s['name']}: {err}")
                        continue
                ok_count += 1

                # ── 循环点 ──
                #
                # shdr 里的 loopStart/loopEnd 已经是「相对采样起点」的偏移
                # （不是相对整个 smpl 块）—— 直接拿来和 WAV 对齐就行。
                #
                # 曾经误以为它是绝对偏移、去减了 s["start"]，
                # 结果算出一堆负数，全部退化成"不循环"。
                #
                # 但仍要加 igen 里的那两个微调量（规范和 shdr 值叠加）：
                #   startloopAddrsOffset / endloopAddrsOffset      单位样本
                #   startloopAddrsCoarseOffset / ...CoarseOffset   单位 32768 样本
                try:
                    wav_frames = (os.path.getsize(wav_path) - 44) // 2
                except OSError:
                    wav_frames = 0

                ls = s["loopStart"] + ins.get("startloopAddrsOffset", 0) \
                     + ins.get("startloopAddrsCoarseOffset", 0) * 32768
                le = s["loopEnd"] + ins.get("endloopAddrsOffset", 0) \
                     + ins.get("endloopAddrsCoarseOffset", 0) * 32768

                # 校验：落在 WAV 内，且循环段不能太短。
                # < 64 样本（约 1.5ms）的循环是一个固定周期的高频重复，
                # 听感是刺耳的嗡嗡声 —— 宁可让它不循环，靠包络收尾。
                if (wav_frames <= 0 or ls < 0 or le > wav_frames or le - ls < 64):
                    ls, le = 0, 0
                    modes = 0
                else:
                    modes = ins.get("sampleModes", 0)

                # ── 变调基准 ──
                # SF2 里有两处都声明"这个采样录在哪个音高"：
                #   shdr.originalPitch      —— 采样头里写的（FluidR3Mono 里常常是错的/无意义）
                #   igen 的 overridingRootKey（op 58）—— instrument 层显式覆盖，**优先级更高**
                #
                # 规范原文：如果 generator 给了 overridingRootKey，就用它的值当 root key，
                # 忽略 shdr.originalPitch。
                #
                # 漏了这条，长笛的 shdr 写 72、实际应该是 61（C#4），
                # 弹 C4 就被判成"要降八度"（rate=0.5），结果音低了一个八度、
                # 采样被拉长一倍、共振峰全乱 —— 听起来就是"刺耳 + 调不对"。
                root_key = s["originalPitch"]
                if "overridingRootKey" in ins and ins["overridingRootKey"] >= 0:
                    root_key = ins["overridingRootKey"]

                zentry["samples"].append({
                    "file": f"p{program}/{fname}",
                    "midiLow": ik[0],
                    "midiHigh": ik[1],
                    "originalPitch": root_key,
                    "rawOriginalPitch": s["originalPitch"],   # 留一份原始值便于排查
                    "pitchCorrection": s["pitchCorrection"],
                    "sampleRate": s["sampleRate"],
                    "loopStart": ls,
                    "loopEnd": le,
                    "sampleModes": modes,
                    "attackMs": ins.get("attackVolEnv", -12000),
                    "holdMs": ins.get("holdVolEnv", -12000),
                    "decayMs": ins.get("decayVolEnv", -12000),
                    "sustainDb": ins.get("sustainVolEnv", 0),
                    "releaseMs": ins.get("releaseVolEnv", -12000),
                    "attenuation": ins.get("initialAttenuation", 0),
                    "pan": ins.get("pan", 0),
                    "tune": ins.get("coarseTune", 0) * 100 + ins.get("fineTune", 0),
                })

            if zentry["samples"]:
                pentry["zones"].append(zentry)

        if pentry["zones"]:
            index["presets"].append(pentry)
            print(f"  p{program:3d}  {pentry['name']:30s}  "
                  f"{len(pentry['zones'])} 层  "
                  f"{sum(len(z['samples']) for z in pentry['zones'])} 采样")

    idx_path = os.path.join(out_dir, "index.json")
    with open(idx_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)

    # 统计
    total = 0
    for root, _, files in os.walk(out_dir):
        for fn in files:
            total += os.path.getsize(os.path.join(root, fn))

    print(f"\n完成：{len(index['presets'])} 个预设  {ok_count} 个采样  {fail_count} 失败")
    print(f"输出 {out_dir}  共 {total / 1024 / 1024:.1f} MB")
    print(f"索引 {idx_path}")


def main():
    sf_path = DEFAULT_SF
    out_dir = OUT_DIR
    all_banks = "--all-banks" in sys.argv
    only = None
    max_sec = MAX_SECONDS

    if "--sf" in sys.argv:
        sf_path = sys.argv[sys.argv.index("--sf") + 1]
    if "--out" in sys.argv:
        out_dir = sys.argv[sys.argv.index("--out") + 1]
    if "--only" in sys.argv:
        only = {int(x) for x in sys.argv[sys.argv.index("--only") + 1].split(",")}
    if "--max-seconds" in sys.argv:
        max_sec = float(sys.argv[sys.argv.index("--max-seconds") + 1])

    if not os.path.exists(sf_path):
        raise SystemExit(f"音源不存在：{sf_path}")

    export(sf_path, out_dir, all_banks=all_banks, only_programs=only, max_seconds=max_sec)


if __name__ == "__main__":
    main()
