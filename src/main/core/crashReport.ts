import fs from 'fs'
import path from 'path'
import type { CrashReportInfo } from '../../shared/types'

/**
 * 解析游戏实例目录下 crash-reports 里最新一份崩溃报告（Minecraft Crash Report），
 * 提取崩溃描述（Description）与嫌疑模组（Suspected Mod），供启动失败弹窗直显原因。
 * 解析失败返回 null（不阻断弹窗原有文案）。
 */
export function findLatestCrashReport(gameDir: string): CrashReportInfo | null {
  try {
    const dir = path.join(gameDir, 'crash-reports')
    if (!fs.existsSync(dir)) return null
    const entries = fs
      .readdirSync(dir)
      .filter((f) => /^crash-.+\.txt$/.test(f) && fs.statSync(path.join(dir, f)).isFile())
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    if (!entries.length) return null
    const file = entries[0].f
    const content = fs.readFileSync(path.join(dir, file), 'utf8')
    const info: CrashReportInfo = { file, description: '', suspectedMod: '' }
    const timeMatch = content.match(/^Time:\s*(.+)$/m)
    if (timeMatch) info.time = timeMatch[1].trim()
    const descMatch = content.match(/^Description:\s*(.+)$/m)
    if (descMatch) info.description = descMatch[1].trim()
    // Suspected Mod 块：以 "Suspected Mod:" 行为起点，后续缩进行直到下一段非缩进文本
    const modIdx = content.search(/^Suspected Mod:\s*$/m)
    if (modIdx >= 0) {
      const rest = content.slice(modIdx + 'Suspected Mod:'.length)
      const end = rest.search(/\n\S/)
      const block = rest.slice(0, end >= 0 ? end : rest.length)
      const lines = block
        .split(/\r?\n/)
        .map((l) => l.replace(/^\t+/, '').trim())
        .filter(Boolean)
      if (lines.length) info.suspectedMod = lines[0]
    }
    return info
  } catch {
    return null
  }
}
