import fs from 'node:fs'
import path from 'node:path'

/** 网吧/公共电脑适配：安装目录不可写（还原盘、只读盘、权限受限）时，
 * 依次在同盘和其余固定盘建立可写数据目录，避免启动即崩或静默写失败。
 * 全程不写注册表、不请求管理员权限。 */
export interface PortableEnvironment {
  baseDir: string
  dataDir: string
  writable: boolean
  systemDrive: boolean
  relocated: boolean
}

let cached: PortableEnvironment | undefined

function canWrite(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.kamucl-write-${process.pid}.tmp`)
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    return true
  } catch { return false }
}

function driveRoot(file: string): string {
  const parsed = path.parse(path.resolve(file))
  return parsed.root || '\\'
}

function systemDrive(): string {
  return (process.env.SystemDrive || 'C:').toUpperCase()
}

/** 网吧机器常见的候选盘：同盘根目录优先，其次 D–Z 中第一个可写的固定盘。 */
function pickDataDir(preferred: string): { dir: string; relocated: boolean } | undefined {
  const candidates = [preferred]
  const root = driveRoot(preferred)
  candidates.push(path.join(root, 'MC-Launcher-data'))
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${letter}:`
    if (drive === root.slice(0, 2).toUpperCase()) continue
    if (!fs.existsSync(`${drive}\\`)) continue
    candidates.push(path.join(`${drive}\\`, 'MC-Launcher-data'))
  }
  for (const dir of candidates) {
    if (canWrite(dir)) return { dir, relocated: path.resolve(dir) !== path.resolve(preferred) }
  }
  return undefined
}

/** 必须在 app.setPath('userData') 之前调用；结果供环境提示复用。 */
export function resolvePortableEnvironment(baseDir: string, preferredDataDir: string): PortableEnvironment {
  if (cached) return cached
  const system = systemDrive()
  const onSystem = driveRoot(baseDir).toUpperCase().startsWith(system)
  const chosen = pickDataDir(preferredDataDir)
  cached = chosen
    ? { baseDir, dataDir: chosen.dir, writable: true, systemDrive: onSystem, relocated: chosen.relocated }
    : { baseDir, dataDir: preferredDataDir, writable: false, systemDrive: onSystem, relocated: false }
  return cached
}

export function portableEnvironment(): PortableEnvironment | undefined {
  return cached
}
