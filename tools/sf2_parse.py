#!/usr/bin/env python3
"""
SoundFont 2（.sf2 / .sf3）完整解析器 —— 只为 DSH 钢琴的多乐器支持而写。

为什么要"完整"：
    extract-sf2.py 只读了 shdr（采样头），够钢琴用，因为钢琴只需要
    "88 个键 → 88 个采样"这一层映射。

    多乐器则必须走完整链路，因为一个 preset（乐器）到实际采样是四层间接：

        phdr  Preset Header     "Acoustic Grand Piano" + program 0 + bank 0
          ↓
        pbag  Preset Zone       一个 preset 下可以有多个区域（按 key/vel 分层）
          ↓
        pgen  Preset Generator  区域参数：keyRange、velRange、以及指向 instrument 的索引
          ↓
        inst  Instrument Header 乐器定义（一个 preset 可以引用多个 instrument）
          ↓
        ibag / igen             乐器的区域和参数：采样索引、调音、包络、滤波、循环
          ↓
        shdr  Sample Header     最终采样的 PCM 起止位置

    跳过任何一层，都拿不到"这个音该用哪个采样、用什么包络"。

SF2 与 SF3 的区别：
    .sf2 = 未压缩 PCM（16 bit）
    .sf3 = Ogg Vorbis 压缩的采样（体积小 10 倍，MuseScore 用的就是这种）
    两者容器结构完全一样，区别只在 smpl 块里是 PCM 还是 Ogg 流。

用法：
    python tools/sf2_parse.py <音源文件>            # 列出所有 preset
    python tools/sf2_parse.py <音源文件> --preset 0 # 展开某个 preset 的区域
    python tools/sf2_parse.py <音源文件> --json out.json
"""

import json
import os
import struct
import sys


# ── SF2 生成器操作码（只列我们实际会用到的）──────────────────────────
GEN = {
    0: "startAddrsOffset",      1: "endAddrsOffset",
    2: "startloopAddrsOffset",  3: "endloopAddrsOffset",
    4: "startAddrsCoarseOffset", 12: "endAddrsCoarseOffset",
    8: "initialFilterFc",       9: "initialFilterQ",
    15: "chorusEffectsSend",    16: "reverbEffectsSend",
    17: "pan",
    21: "delayModLFO",          22: "freqModLFO",
    23: "delayVibLFO",          24: "freqVibLFO",
    25: "delayModEnv",          26: "attackModEnv",
    27: "holdModEnv",           28: "decayModEnv",
    29: "sustainModEnv",        30: "releaseModEnv",
    31: "keynumToModEnvHold",   32: "keynumToModEnvDecay",
    33: "delayVolEnv",          34: "attackVolEnv",
    35: "holdVolEnv",           36: "decayVolEnv",
    37: "sustainVolEnv",        38: "releaseVolEnv",
    39: "keynumToVolEnvHold",   40: "keynumToVolEnvDecay",
    41: "instrument",           43: "keyRange",
    44: "velRange",
    45: "startloopAddrsCoarseOffset",
    46: "keynum",               47: "velocity",
    48: "initialAttenuation",
    50: "endloopAddrsCoarseOffset",
    51: "coarseTune",           52: "fineTune",
    53: "sampleID",             54: "sampleModes",
    56: "scaleTuning",          57: "exclusiveClass",
    58: "overridingRootKey",
}

# generator 的值有两种类型：word（2 字节整数）和 range（两个字节）
RANGE_GENS = {43, 44}   # keyRange, velRange —— 值是两个字节


def read_chunks(buf, off, end):
    """遍历 RIFF 块。SF2 用的是 RIFF 变体（sfbk + LIST 嵌套）。"""
    out = []
    while off + 8 <= end:
        cid = buf[off:off + 4]
        size = struct.unpack("<I", buf[off + 4:off + 8])[0]
        out.append((cid, off + 8, size))
        off += 8 + size + (size & 1)      # 块按偶数字节对齐
    return out


class SoundFont:
    """一个 SoundFont 文件。分层解析，每层都是惰性的。"""

    def __init__(self, path):
        self.path = path
        self.data = open(path, "rb").read()
        self._parse_container()
        self._parse_pdta()

    # ── 容器层 ──
    def _parse_container(self):
        data = self.data
        if data[:4] != b"RIFF":
            raise ValueError(f"不是 RIFF 文件：{data[:4]!r}")
        if data[8:12] != b"sfbk":
            raise ValueError(f"不是 SoundFont：{data[8:12]!r}")

        self.smpl = None      # (偏移, 大小) —— 采样 PCM/Ogg 数据
        self.pdta = {}        # 各子块 (偏移, 大小)

        riff_size = struct.unpack("<I", data[4:8])[0]
        for cid, off, size in read_chunks(data, 12, 12 + riff_size):
            if cid != b"LIST":
                continue
            kind = data[off:off + 4]
            for scid, soff, ssize in read_chunks(data, off + 4, off + size):
                if kind == b"sdta" and scid == b"smpl":
                    self.smpl = (soff, ssize)
                elif kind == b"pdta":
                    self.pdta[scid.decode("ascii", "replace")] = (soff, ssize)

    # ── pdta 层：预设 / 乐器 / 采样 ──
    def _parse_pdta(self):
        need = ["phdr", "pbag", "pgen", "inst", "ibag", "igen", "shdr"]
        missing = [k for k in need if k not in self.pdta]
        if missing:
            raise ValueError(f"缺少必需块：{missing}")

        self.presets = self._read_phdr()
        self.pbags = self._read_bag("pbag")
        self.pgens = self._read_gen("pgen")
        self.insts = self._read_inst()
        self.ibags = self._read_bag("ibag")
        self.igens = self._read_gen("igen")
        self.samples = self._read_shdr()

    def _read_phdr(self):
        """Preset Header，每条 38 字节。最后一条是终止记录（名称 EOP）。"""
        off, size = self.pdta["phdr"]
        out = []
        for i in range(size // 38):
            p = off + i * 38
            name = self.data[p:p + 20].rstrip(b"\0").decode("latin-1", "replace")
            if name == "EOP":
                break
            preset, bank, bag_ndx = struct.unpack("<HHH", self.data[p + 20:p + 26])
            out.append({
                "index": len(out),
                "name": name,
                "program": preset,      # ← 这就是 MIDI Program Change 的编号
                "bank": bank,
                "bagIndex": bag_ndx,
            })
        return out

    def _read_bag(self, key):
        """Bag，每条 4 字节（指向 gen 列表的起始索引）。"""
        off, size = self.pdta[key]
        return [struct.unpack("<H", self.data[off + i * 4:off + i * 4 + 2])[0]
                for i in range(size // 4)]

    def _read_gen(self, key):
        """Generator，每条 4 字节：操作码(H) + 值(H) 或 range(两个 B)。"""
        off, size = self.pdta[key]
        out = []
        for i in range(size // 4):
            p = off + i * 4
            op = struct.unpack("<H", self.data[p:p + 2])[0]
            if op in RANGE_GENS:
                lo, hi = self.data[p + 2], self.data[p + 3]
                out.append({"op": op, "name": GEN.get(op, f"op{op}"), "lo": lo, "hi": hi})
            else:
                val = struct.unpack("<h", self.data[p + 2:p + 4])[0]   # 有符号
                out.append({"op": op, "name": GEN.get(op, f"op{op}"), "value": val})
        return out

    def _read_inst(self):
        """Instrument Header，每条 22 字节。"""
        off, size = self.pdta["inst"]
        out = []
        for i in range(size // 22):
            p = off + i * 22
            name = self.data[p:p + 20].rstrip(b"\0").decode("latin-1", "replace")
            if name == "EOI":
                break
            bag_ndx = struct.unpack("<H", self.data[p + 20:p + 22])[0]
            out.append({"index": len(out), "name": name, "bagIndex": bag_ndx})
        return out

    def _read_shdr(self):
        """Sample Header，每条 46 字节。"""
        off, size = self.pdta["shdr"]
        out = []
        for i in range(size // 46):
            p = off + i * 46
            name = self.data[p:p + 20].rstrip(b"\0").decode("latin-1", "replace")
            if name == "EOS":
                break
            start, end, lstart, lend, rate = struct.unpack("<IIIII", self.data[p + 20:p + 40])
            orig, corr, link, typ = struct.unpack("<BbHH", self.data[p + 40:p + 46])
            out.append({
                "index": len(out),
                "name": name,
                "start": start,
                "end": end,
                "loopStart": lstart,
                "loopEnd": lend,
                "sampleRate": rate,
                "originalPitch": orig,
                "pitchCorrection": corr,
                "sampleType": typ,
            })
        return out

    # ── 展开：preset → 区域 → 采样 ──
    def zones_of_preset(self, preset_index):
        """一个 preset 的所有区域，已解析到"用哪个采样 + 什么参数"。"""
        p = self.presets[preset_index]
        start = p["bagIndex"]
        # 下一个 preset 的 bagIndex 就是本 preset 区域的结束
        nxt = self.presets[preset_index + 1]["bagIndex"] if preset_index + 1 < len(self.presets) else len(self.pbags) - 1
        zones = []
        for bi in range(start, nxt):
            if bi >= len(self.pbags) - 1:
                break
            gstart = self.pbags[bi]
            gend = self.pbags[bi + 1] if bi + 1 < len(self.pbags) else len(self.pgens) - 1
            zone = self._apply_gens(self.pgens[gstart:gend])
            # 只有带 instrument 的区域才有效
            if "instrument" in zone:
                inst_idx = zone["instrument"]
                if 0 <= inst_idx < len(self.insts):
                    zone["instruments"] = self.zones_of_instrument(inst_idx)
                    zone["instrumentName"] = self.insts[inst_idx]["name"]
            if zone.get("instruments"):
                zones.append(zone)
        return zones

    def zones_of_instrument(self, inst_index):
        """一个 instrument 的所有区域，已解析到具体采样。"""
        ins = self.insts[inst_index]
        start = ins["bagIndex"]
        nxt = self.insts[inst_index + 1]["bagIndex"] if inst_index + 1 < len(self.insts) else len(self.ibags) - 1
        zones = []
        for bi in range(start, nxt):
            if bi >= len(self.ibags) - 1:
                break
            gstart = self.ibags[bi]
            gend = self.ibags[bi + 1] if bi + 1 < len(self.ibags) else len(self.igens) - 1
            zone = self._apply_gens(self.igens[gstart:gend])
            if "sampleID" in zone and 0 <= zone["sampleID"] < len(self.samples):
                s = self.samples[zone["sampleID"]]
                zone["sample"] = s["name"]
                zone["sampleStart"] = s["start"]
                zone["sampleEnd"] = s["end"]
                zone["sampleRate"] = s["sampleRate"]
                zone["originalPitch"] = s["originalPitch"]
                zone["pitchCorrection"] = s["pitchCorrection"]
                zones.append(zone)
        return zones

    @staticmethod
    def _apply_gens(gens):
        """把一串 generator 折叠成一个 dict。"""
        zone = {}
        for g in gens:
            n = g["name"]
            if n in ("keyRange", "velRange"):
                zone[n] = [g["lo"], g["hi"]]
            else:
                zone[n] = g["value"]
        return zone


def summarize(path):
    sf = SoundFont(path)
    kind = "SF3（Ogg 压缩采样）" if path.lower().endswith(".sf3") else "SF2（PCM）"
    pcm_mb = (sf.smpl[1] / 1024 / 1024) if sf.smpl else 0

    print(f"文件       {os.path.basename(path)}")
    print(f"格式       {kind}")
    print(f"体积       {os.path.getsize(path) / 1024 / 1024:.2f} MB")
    print(f"采样数据   {pcm_mb:.1f} MB")
    print(f"预设       {len(sf.presets)} 个")
    print(f"乐器       {len(sf.insts)} 个")
    print(f"采样       {len(sf.samples)} 个")
    print()
    print("前 20 个预设：")
    print(f"  {'#':>4}  {'bank':>4}  {'prog':>4}  {'区域':>4}  名称")
    for p in sf.presets[:20]:
        zones = sf.zones_of_preset(p["index"])
        print(f"  {p['index']:>4}  {p['bank']:>4}  {p['program']:>4}  {len(zones):>4}  {p['name']}")
    print()
    print(f"…… 共 {len(sf.presets)} 个")
    return sf


def detail(path, idx):
    sf = SoundFont(path)
    if idx >= len(sf.presets):
        print(f"没有第 {idx} 个预设")
        return
    p = sf.presets[idx]
    zones = sf.zones_of_preset(idx)
    print(f"预设 #{idx}  {p['name']}")
    print(f"  bank={p['bank']}  program={p['program']}  区域={len(zones)}")
    for zi, z in enumerate(zones):
        keys = z.get("keyRange", [0, 127])
        vels = z.get("velRange", [0, 127])
        print(f"\n  区域 {zi}: key {keys[0]}–{keys[1]}  vel {vels[0]}–{vels[1]}")
        for ins in z["instruments"]:
            ik = ins.get("keyRange", [0, 127])
            print(f"    ├─ {ins['sample']:22s} key {ik[0]}–{ik[1]}  "
                  f"rate {ins['sampleRate']}  原始音高 {ins['originalPitch']}")
            if "sampleModes" in ins:
                print(f"    │   loop={ins['sampleModes']}  "
                      f"attack={ins.get('attackVolEnv', '?')}ms  "
                      f"release={ins.get('releaseVolEnv', '?')}ms")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"文件不存在：{path}")
        sys.exit(1)

    if "--preset" in sys.argv:
        idx = int(sys.argv[sys.argv.index("--preset") + 1])
        detail(path, idx)
        return

    sf = summarize(path)

    if "--json" in sys.argv:
        out_path = sys.argv[sys.argv.index("--json") + 1]
        data = {
            "file": os.path.basename(path),
            "presets": [
                {
                    "index": p["index"], "name": p["name"],
                    "bank": p["bank"], "program": p["program"],
                    "zones": len(sf.zones_of_preset(p["index"])),
                }
                for p in sf.presets
            ],
        }
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"\n已导出 {out_path}")


if __name__ == "__main__":
    main()
