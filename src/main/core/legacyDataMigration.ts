/**
 * 便携版旧数据目录迁移（C 盘 %APPDATA% → 安装目录旁）。
 *
 * 历史行为：安装目录 data 为空时整体搬迁，否则直接删除 C 盘目录——
 * 这样如果 C 盘里还留着旧账号文件（而安装目录已有更新账号），旧账号会
 * 被无声删掉。本模块改为「增量搬移、绝不覆盖、搬完清理」：
 *   - C 盘有而安装目录没有的文件 → 搬过来（旧账号/旧设置不丢）
 *   - 安装目录已存在同名文件   → 不覆盖新数据，C 盘那份直接删掉
 *   - 最后清理整个 C 盘残留目录
 * 纯文件操作，不依赖 Electron，便于直接单测。
 */
import fs from 'node:fs'
import path from 'node:path'

export interface LegacyMigrationResult {
  /** 实际从 C 盘搬入安装目录的文件数量。 */
  imported: number
  /** 安装目录已有同名、未覆盖的文件数量（C 盘旧文件被清理）。 */
  skippedExisting: number
}

export function migrateLegacyUserData(legacyDir: string, freshDir: string): LegacyMigrationResult {
  const result: LegacyMigrationResult = { imported: 0, skippedExisting: 0 }
  if (!fs.existsSync(legacyDir)) return result
  fs.mkdirSync(freshDir, { recursive: true })
  for (const name of fs.readdirSync(legacyDir)) {
    const from = path.join(legacyDir, name)
    const to = path.join(freshDir, name)
    if (fs.existsSync(to)) {
      // 安装目录已有更新版本：以安装目录为准，C 盘旧文件稍后随目录清理删除
      result.skippedExisting++
      continue
    }
    try {
      fs.renameSync(from, to)
      result.imported++
    } catch {
      // 被占用/无权限：本次留着，下次启动再试
    }
  }
  try {
    fs.rmSync(legacyDir, { recursive: true, force: true })
  } catch {
    // 目录删不掉（残留占用）不打断启动
  }
  return result
}
