#!/usr/bin/env python3
"""
从 Yamaha Upright.sf2 提取 88 个键的采样，重采样到 44100 Hz 单声道。

为什么 88 个键要各自独立：
    用少量采样 + 变调覆盖全音域时，低音区的变调率会低到 0.25
    （每 4 个输出样本才读 1 个采样样本）。线性插值在 rate<1 时等于"抽取"，
    超过 Nyquist×rate 的成分会折叠回低频 —— 听感就是"格子卡住"的阶梯声。
    每键独立采样后 rate 恒为 1.0，不存在抽取，混叠从物理上消失。

用法：
    1. 下载 Yamaha Upright.sf2（约 170 MB）放到 assets/yup/
    2. python tools/extract-sf2.py
    输出：assets/yup/wav/21.wav … 108.wav（88 个，44100 单声道，每个最长 3 秒）

SoundFont 结构（本脚本只用到三块）：
    LIST/sdta/smpl   PCM 数据（int16）
    LIST/pdta/shdr   采样头：名称、起止、采样率、原始音高
"""

import os
import struct
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
SF2_PATH = os.path.join(PKG, "assets", "yup", "Yamaha Upright.sf2")
OUT_DIR = os.path.join(PKG, "assets", "yup", "wav")

TARGET_SR = 44100
MAX_SECONDS = 3.0
# 只用 medium 层（yh_m_*）。同目录还有 soft(_s_)、hard(_h_) 两层，
# 想要力度分层可以把判断条件换成 '_s_' / '_h_' 再跑一遍。
LAYER = "_m_"
CHANNEL = "L"  # 取左声道；引擎是单声道


def read_chunks(buf, off, end):
    """遍历 RIFF 块，返回 (id, data_offset, size)。"""
    out = []
    while off + 8 <= end:
        cid = buf[off:off + 4]
        size = struct.unpack("<I", buf[off + 4:off + 8])[0]
        out.append((cid, off + 8, size))
        off += 8 + size + (size & 1)  # 块按偶数字节对齐
    return out


def find_blocks(data):
    """定位 smpl（PCM）和 shdr（采样头）两块。"""
    riff_size = struct.unpack("<I", data[4:8])[0]
    smpl = None
    shdr = None
    for cid, off, size in read_chunks(data, 12, 12 + riff_size):
        if cid != b"LIST":
            continue
        for scid, soff, ssize in read_chunks(data, off + 4, off + size):
            if scid == b"smpl":
                smpl = (soff, ssize)
            elif scid == b"shdr":
                shdr = (soff, ssize)
    return smpl, shdr


def parse_shdr(data, off, size):
    """每条 46 字节：20 字节名 + 5 个 uint32 + 1 int8 + 3 uint16。"""
    rows = []
    for i in range(size // 46):
        p = off + i * 46
        name = data[p:p + 20].rstrip(b"\0").decode("ascii", "replace")
        start, end, _lstart, _lend, rate = struct.unpack("<IIIII", data[p + 20:p + 40])
        orig = struct.unpack("<b", data[p + 40:p + 41])[0]
        if end > start:
            rows.append((name, start, end, rate, orig))
    return rows


def lanczos_resample(x, from_sr, to_sr, taps=4):
    """4-tap Lanczos 重采样。够快，质量远好于线性插值。"""
    if from_sr == to_sr:
        return x
    ratio = to_sr / from_sr
    n_out = int(len(x) * ratio)
    idx = np.arange(n_out) / ratio
    i0 = np.floor(idx).astype(int)
    frac = idx - i0
    out = np.zeros(n_out)
    for k in range(-taps + 1, taps + 1):
        src = np.clip(i0 + k, 0, len(x) - 1)
        d = frac - k
        with np.errstate(invalid="ignore", divide="ignore"):
            w = np.sinc(d) * np.sinc(d / taps)
        w[np.abs(d) >= taps] = 0
        out += x[src] * w
    return out


def main():
    if not os.path.exists(SF2_PATH):
        raise SystemExit(
            f"找不到 {SF2_PATH}\n"
            "请先下载 Yamaha Upright.sf2（约 170 MB）放到 assets/yup/ 下。\n"
            "来源：https://isamorphic.net → 或搜索 \"Yamaha Upright soundfont\""
        )

    data = open(SF2_PATH, "rb").read()
    print(f"读取 {SF2_PATH}  ({len(data) / 1024 / 1024:.1f} MB)")

    (smpl_off, smpl_size), (shdr_off, shdr_size) = find_blocks(data)
    pcm = np.frombuffer(data[smpl_off:smpl_off + smpl_size], dtype=np.int16).astype(np.float64)
    rows = parse_shdr(data, shdr_off, shdr_size)
    print(f"采样头 {len(rows)} 条")

    os.makedirs(OUT_DIR, exist_ok=True)
    made = 0
    for name, start, end, rate, orig in rows:
        # 只要目标层、目标声道、音高落在 88 键范围内
        if LAYER not in name or not name.endswith(CHANNEL):
            continue
        if orig < 21 or orig > 108:
            continue
        seg = pcm[start:end]
        if len(seg) < 1000:
            continue

        y = lanczos_resample(seg, rate, TARGET_SR)
        peak = np.abs(y).max()
        if peak > 0:
            y = y / peak * 0.9          # 归一化到 -1 dBFS 左右
        y = np.clip(y[:int(TARGET_SR * MAX_SECONDS)], -1, 1)

        out = os.path.join(OUT_DIR, f"{orig}.wav")
        with wave.open(out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(TARGET_SR)
            w.writeframes((y * 32767).astype(np.int16).tobytes())
        made += 1

    total = sum(
        os.path.getsize(os.path.join(OUT_DIR, f)) for f in os.listdir(OUT_DIR)
    )
    print(f"导出 {made} 个 wav → {OUT_DIR}")
    print(f"总体积 {total / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
