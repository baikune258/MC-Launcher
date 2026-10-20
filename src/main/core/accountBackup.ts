/**
 * 账号数据自动备份与恢复。
 *
 * 启动器是便携版：accounts.json 存放在安装目录旁的 MC-Launcher\data 内，
 * 自更新只替换外层 exe、不碰 data 目录。但为了防御误删、磁盘异常、以及
 * 历史上 C 盘旧数据迁移时可能出现的覆盖/丢失，这里再加一道保险：
 *   - 每次写入 accounts.json 后，同步留一份快照到 .account-backup\accounts.json
 *   - 启动加载时若主文件缺失或损坏，自动从快照恢复并写回主文件
 * 本模块只做文件级纯操作，不依赖 Electron，便于直接单测。
 */
import fs from 'node:fs'
import path from 'node:path'

export function accountBackupPath(storePath: string): string {
  return path.join(path.dirname(storePath), '.account-backup', 'accounts.json')
}

/** 主文件写入成功后调用：留一份内容完全一致的快照。失败只记日志，不影响主文件。 */
export function writeAccountBackup(storePath: string, content: string): void {
  const backup = accountBackupPath(storePath)
  fs.mkdirSync(path.dirname(backup), { recursive: true })
  fs.writeFileSync(backup, content, { encoding: 'utf-8', mode: 0o600 })
}

function looksValid(file: string): boolean {
  try {
    JSON.parse(fs.readFileSync(file, 'utf-8'))
    return true
  } catch {
    return false
  }
}

/**
 * 主文件缺失或损坏时，从最近一次自动快照恢复。
 * @returns true 表示已从快照恢复并写回主文件；false 表示无需恢复或无可用快照。
 */
export function restoreAccountBackupIfNeeded(storePath: string): boolean {
  if (fs.existsSync(storePath) && looksValid(storePath)) return false
  const backup = accountBackupPath(storePath)
  if (!fs.existsSync(backup)) return false
  try {
    const content = fs.readFileSync(backup, 'utf-8')
    JSON.parse(content) // 快照本身也必须是合法 JSON
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.writeFileSync(storePath, content, { encoding: 'utf-8', mode: 0o600 })
    return true
  } catch {
    return false
  }
}
