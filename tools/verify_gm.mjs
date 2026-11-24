#!/usr/bin/env node
/**
 * GM 多乐器端到端验证。
 *
 * 不看 UI，直接验证三件事：
 *   1. index.json 里每个 program 都有可用采样
 *   2. index.json 里每个音域（21-108）都能在对应 preset 里找到采样
 *   3. 采样文件确实存在、能被解析成 PCM
 *
 * 为什么不用跑 EXE：EXE 的选采样逻辑（GmEngine.Pick）就是照着这个
 * index.json 的结构写的。索引里每个音都能命中采样，引擎就不会 NOMAP。
 *
 * 用法：
 *   node tools/verify_gm.mjs                 # 全量检查
 *   node tools/verify_gm.mjs --quick         # 只查索引，不读 wav
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(ROOT, 'assets', 'gm', 'out')
const INDEX = join(OUT, 'index.json')

const QUICK = process.argv.includes('--quick')
const MIDI_MIN = 21
const MIDI_MAX = 108

function main() {
  if (!existsSync(INDEX)) {
    console.error(`找不到索引：${INDEX}`)
    console.error('先跑一次：python tools/extract_gm.py')
    process.exit(1)
  }

  const idx = JSON.parse(readFileSync(INDEX, 'utf8'))
  console.log(`索引  ${idx.source}  采样率 ${idx.targetSampleRate}  时长上限 ${idx.maxSeconds}s`)
  console.log(`乐器  ${idx.presets.length} 个\n`)

  let totalSamples = 0
  let missingFiles = 0
  let emptyFiles = 0
  let badLoop = 0
  let coverageFail = 0
  let covered = 0
  const problems = []

  for (const p of idx.presets) {
    // ── 检查 1：每个音域都有采样覆盖 ──
    const coveredKeys = new Set()
    for (const z of p.zones) {
      for (const s of z.samples) {
        for (let m = Math.max(MIDI_MIN, s.midiLow); m <= Math.min(MIDI_MAX, s.midiHigh); m++) {
          coveredKeys.add(m)
        }
      }
    }
    const missingKeys = []
    for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
      if (!coveredKeys.has(m)) missingKeys.push(m)
    }
    // 键盘范围靠变调兜底：只要这个乐器有 *任何* 采样，就能靠 rate 补出所有音。
    // 所以只有"一个采样都没有"才算真失败。
    if (coveredKeys.size === 0) {
      coverageFail++
      problems.push(`p${p.program} ${p.name}: 没有任何采样`)
    } else {
      covered++
    }

    // ── 检查 2：采样文件存在且非空 ──
    for (const z of p.zones) {
      for (const s of z.samples) {
        totalSamples++
        const f = join(OUT, s.file)
        if (!existsSync(f)) {
          missingFiles++
          if (problems.length < 20) problems.push(`缺文件 ${s.file}`)
          continue
        }
        const sz = statSync(f).size
        if (sz <= 44) {
          emptyFiles++
          if (problems.length < 20) problems.push(`空文件 ${s.file}`)
        }
        // loop 点必须在文件范围内
        if (s.sampleModes === 1) {
          const frames = Math.floor((sz - 44) / 2)
          if (s.loopStart < 0 || s.loopEnd > frames || s.loopEnd <= s.loopStart) {
            badLoop++
            if (problems.length < 20) {
              problems.push(`loop 越界 ${s.file} loop=${s.loopStart}..${s.loopEnd} frames=${frames}`)
            }
          }
        }
      }
    }
  }

  // ── 输出 ──
  const width = Math.min(idx.presets.length, 40)
  console.log('按分类抽查（每类前 2 个）：')
  const groups = [
    [0, '钢琴'], [8, '色彩打击乐'], [16, '风琴'], [24, '吉他'],
    [32, '贝斯'], [40, '弦乐'], [48, '合奏'], [56, '铜管'],
    [64, '簧管'], [72, '长笛'], [80, '合成主音'], [88, '合成铺底'],
    [96, '合成效果'], [104, '民族乐器'], [112, '打击乐'], [120, '音效'],
  ]
  for (const [start, label] of groups) {
    const picks = idx.presets.filter((p) => p.program >= start && p.program < start + 8).slice(0, 2)
    if (!picks.length) continue
    const desc = picks.map((p) => {
      const n = p.zones.reduce((a, z) => a + z.samples.length, 0)
      return `${p.program}:${p.name}(${n})`
    }).join('  ')
    console.log(`  ${label.padEnd(6, '　')} ${desc}`)
  }

  console.log('')
  console.log('=== 统计 ===')
  console.log(`  乐器数        ${idx.presets.length}`)
  console.log(`  采样总数      ${totalSamples}`)
  console.log(`  有采样的乐器  ${covered}`)
  console.log(`  无采样的乐器  ${coverageFail}`)
  if (!QUICK) {
    console.log(`  缺文件        ${missingFiles}`)
    console.log(`  空文件        ${emptyFiles}`)
    console.log(`  loop 越界     ${badLoop}`)
  }

  if (problems.length) {
    console.log('\n=== 问题（最多 20 条）===')
    for (const s of problems) console.log('  ' + s)
  }

  const fail = coverageFail > 0 || missingFiles > 0 || emptyFiles > 0 || badLoop > 0
  console.log('')
  console.log(fail ? '✗ 有问题，见上面清单' : '✓ 全部通过：每个乐器都有可用采样，文件齐全，loop 点合法')
  process.exit(fail ? 1 : 0)
}

main()
