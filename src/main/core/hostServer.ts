/** 在线服务器（自建常驻服）：下载服务端（原版/模组）、后台常驻运行、状态探测与日志。 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { getVersionJson, fetchVersionManifest } from './versions'
import { downloadAll, type DownloadTask } from './download'
import { getSettings } from './settings'
import { downloadFetch } from './downloadFetch'
import AdmZip from 'adm-zip'
import { resolveCurseForgeDownload } from './curseforgeDownload'
import { cfChannel } from './curseforgeChannel'
import { scanJava } from './java'
import { pingServer } from './servers'
import { logScope } from './launcherLog'

const hostLog = logScope('host-server')

export type HostServerType = 'datapack' | 'modded'

export interface HostServerRecord {
  id: string
  name: string
  mcVersion: string
  port: number
  ramMb: number
  /** 服务器类型：数据包服务器 / 模组服务器 */
  type: HostServerType
  /** 启动器启动时自动拉起（一直开） */
  autoResume: boolean
  /** 正版验证（online-mode），默认关闭便于离线加入 */
  onlineMode: boolean
  createdAt: number
  pid?: number
  jarReady: boolean
}

export interface HostServerStatus {
  running: boolean
  online: boolean
  players?: number
  motd?: string
  address: string
  logTail: string
}

export interface HostServerCreateInput {
  name: string
  mcVersion: string
  type?: HostServerType
  port?: number
  ramMb?: number
  autoResume?: boolean
  onlineMode?: boolean
}

const STORE = 'host-servers.json'

function storeFile(): string {
  return path.join(app.getPath('userData'), STORE)
}
function serverDir(id: string): string {
  return path.join(app.getPath('userData'), 'host-server', id)
}
function logFile(id: string): string {
  return path.join(serverDir(id), 'server.log')
}
function serverJar(id: string): string {
  return path.join(serverDir(id), 'server.jar')
}

export function readHostServers(): HostServerRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf-8'))
    if (!Array.isArray(raw)) return []
    return raw
      .filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && typeof r.mcVersion === 'string')
      .map((r) => ({ type: 'datapack', ...r } as HostServerRecord))
  } catch {
    return []
  }
}
function writeHostServers(list: HostServerRecord[]): void {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
  fs.writeFileSync(storeFile(), JSON.stringify(list, null, 2), 'utf-8')
}
function findRecord(id: string): HostServerRecord | null {
  return readHostServers().find((r) => r.id === id) ?? null
}
function upsertRecord(record: HostServerRecord): void {
  const list = readHostServers()
  const i = list.findIndex((r) => r.id === record.id)
  if (i >= 0) list[i] = record
  else list.push(record)
  writeHostServers(list)
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 常驻服务进程的 stdin 引用（用于控制台命令）。启动器自身重启后无法重建该引用——
 *  服务器仍由原进程运行（detached），此时命令行输入不可用，属服务端进程架构限制。 */
const hostProcessStdin = new Map<string, NodeJS.WritableStream>()

/** 服务器常驻进程：spawn 时 detached 且不随启动器退出，stdout/stderr 全部进日志文件；
 *  stdin 改为管道，供「服务器控制台」发送 /op 等命令。 */
function launchServerProcess(record: HostServerRecord): ChildProcess {
  const dir = serverDir(record.id)
  const javas = scanJava()
  const java =
    javas.find((j) => j.major >= 17 && j.is64Bit !== false) ??
    javas.find((j) => j.major >= 8) ??
    javas[0]
  if (!java) throw new Error('未找到可用的 Java，请先在「设置-游戏」中配置或安装 Java 17')
  const args = [
    `-Xms${Math.min(record.ramMb, 1024)}M`,
    `-Xmx${record.ramMb}M`,
    '-jar',
    'server.jar',
    'nogui'
  ]
  const child = spawn(java.path, args, {
    cwd: dir,
    detached: true,
    windowsHide: true,
    stdio: ['pipe', fs.openSync(logFile(record.id), 'a'), fs.openSync(logFile(record.id), 'a')]
  })
  hostProcessStdin.set(record.id, child.stdin!)
  child.once('exit', () => { hostProcessStdin.delete(record.id) })
  child.unref()
  return child
}

/** 向运行中的服务器发送一条控制台命令（如 /op 玩家名、/gamemode creative），
 *  命令直接写入服务端 stdin，由服务端解析执行，无 shell 注入面。 */
export function sendHostCommand(id: string, command: string): void {
  const cmd = (command ?? '').trim()
  if (!cmd) throw new Error('请输入要执行的命令')
  const record = findRecord(id)
  if (!record) throw new Error('服务器不存在')
  if (!record.pid || !processAlive(record.pid)) throw new Error('服务器未在运行，无法执行命令')
  const stdin = hostProcessStdin.get(id)
  if (!stdin || stdin.destroyed) {
    // 启动器重启过、原进程仍由系统托管（detached）时无法写入；给出明确提示
    throw new Error('该服务器不是由当前启动器会话启动（可能已重启过启动器），控制台命令暂不可用；可重启服务器后再操作')
  }
  if (cmd.length > 200) throw new Error('命令过长（最多 200 字符）')
  if (!/^[\/]?[\w@\-. ]+$/.test(cmd) && !/^[\/][\w@\-. ]+$/.test(cmd)) throw new Error('命令格式不正确')
  stdin.write(cmd + '\n')
  hostLog.info(`[控制台] > ${cmd}`)
}

function localAddress(port: number): string {
  const nets = os.networkInterfaces()
  for (const list of Object.values(nets)) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) return `${n.address}:${port}`
    }
  }
  return `127.0.0.1:${port}`
}

export function listHostServers(): HostServerRecord[] {
  return readHostServers()
}

/** 创建进度回调：阶段标签 + 0-100 百分比 */
export type HostCreateProgress = (label: string, percent: number) => void

export async function createHostServer(input: HostServerCreateInput, onProgress?: HostCreateProgress): Promise<HostServerRecord> {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('请填写服务器名称')
  if (name.length > 40) throw new Error('服务器名称过长（最多 40 字符）')
  if (/[\\/:*?"<>|]/.test(name)) throw new Error('服务器名称不能包含 \\ / : * ? " < > | 字符')
  const port = Math.max(1, Math.min(65535, Math.trunc(input.port ?? 25565)))
  if (port !== Math.trunc(input.port ?? 25565)) throw new Error('端口需为 1-65535 的整数')
  const type = input.type === 'modded' ? 'modded' : 'datapack'
  const manifest = await fetchVersionManifest('official', false)
  const entry = manifest.find((v) => v.id === input.mcVersion && v.type === 'release')
  if (!entry) throw new Error('只能基于正式版（Release）创建服务器，请选择原版正式版本')
  const id = randomUUID()
  const dir = serverDir(id)
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true })
  const record: HostServerRecord = {
    id,
    name,
    mcVersion: entry.id,
    port,
    ramMb: Math.max(512, Math.min(16384, Math.trunc(input.ramMb ?? 2048))),
    type,
    autoResume: input.autoResume !== false,
    onlineMode: input.onlineMode === true,
    createdAt: Date.now(),
    jarReady: false
  }
  // 下载服务端 jar：数据包服务器 = 原版服务端；模组服务器 = Fabric 服务端
  hostLog.info(`下载 ${entry.id}${type === 'modded' ? '（Fabric 模组）' : ''}服务端…`)
  const mirror = getSettings().mirror
  onProgress?.('获取版本信息', 2)
  if (type === 'modded') {
    // Fabric Loader 版本列表：https://meta.fabricmc.net/v2/versions/loader/<mc>
    const loaderRes = await downloadFetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(entry.id)}`, { signal: AbortSignal.timeout(15000) })
    if (!loaderRes.ok) throw new Error('获取 Fabric 加载器版本失败，请检查网络后重试')
    const loaderList = (await loaderRes.json()) as Array<{ loader?: { version?: string } }>
    if (!Array.isArray(loaderList) || !loaderList.length) {
      throw new Error(`Minecraft ${entry.id} 暂不支持 Fabric 模组服务器`)
    }
    // Fabric server/jar 标准 URL 为 4 段：loader/{mc}/{loader}/{installer}/server/jar，缺 installer 段必然 404。
    // 先取最新 installer 版本，再依次探测前 8 个 Loader 组合（个别 Loader 与该版本组合可能 404/超时）。
    const installerRes = await downloadFetch('https://meta.fabricmc.net/v2/versions/installer', { signal: AbortSignal.timeout(15000) })
    if (!installerRes.ok) throw new Error('获取 Fabric 安装器版本失败，请检查网络后重试')
    const installerList = (await installerRes.json()) as Array<{ version?: string; stable?: boolean }>
    const installer = (Array.isArray(installerList) ? installerList.find((i) => i.stable === true) ?? installerList[0] : undefined)?.version
    if (!installer) throw new Error('获取 Fabric 安装器版本失败，请检查网络后重试')
    let serverUrl: string | null = null
    for (const item of loaderList.slice(0, 8)) {
      const lv = item?.loader?.version
      if (!lv) continue
      const candidate = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(entry.id)}/${encodeURIComponent(lv)}/${encodeURIComponent(installer)}/server/jar`
      try {
        const probe = await downloadFetch(candidate, { method: 'HEAD', signal: AbortSignal.timeout(15000) })
        if (probe.ok) { serverUrl = candidate; break }
        await probe.body?.cancel()
      } catch { /* 单次探测失败继续尝试下一个 */ }
    }
    if (!serverUrl) throw new Error(`Minecraft ${entry.id} 暂不支持 Fabric 模组服务器（未找到可用 Loader，Fabric 官方可能暂未提供该版本的服务器端）`)
    onProgress?.('下载 Fabric 服务端', 5)
    await downloadAll([
      {
        url: serverUrl,
        urls: [serverUrl],
        dest: serverJar(id)
      }
    ], (done, total) => onProgress?.('下载 Fabric 服务端', 5 + Math.round((done / Math.max(1, total)) * 90)), 1, mirror)
    fs.mkdirSync(path.join(dir, 'mods'), { recursive: true })
  } else {
    onProgress?.('获取版本信息', 2)
    const vj = await getVersionJson(entry.id, path.join(dir, 'version.json'))
    const server = (vj.downloads as { server?: { url?: string; sha1?: string; size?: number } } | undefined)?.server
    if (!server?.url) throw new Error(`版本 ${entry.id} 未提供服务端下载`)
    const tasks: DownloadTask[] = [
      {
        url: server.url,
        dest: serverJar(id),
        sha1: server.sha1,
        size: server.size
      }
    ]
    onProgress?.('下载原版服务端', 5)
    await downloadAll(tasks, (done, total) => onProgress?.('下载原版服务端', 5 + Math.round((done / Math.max(1, total)) * 90)), 1, mirror)
    fs.mkdirSync(path.join(dir, 'world', 'datapacks'), { recursive: true })
  }
  onProgress?.('写入配置', 97)
  // 基础配置：同意 EULA；离线服（online-mode 由用户控制）
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n', 'utf-8')
  fs.writeFileSync(
    path.join(dir, 'server.properties'),
    [
      `server-port=${port}`,
      `online-mode=${record.onlineMode}`,
      'motd=MC-Launcher 在线服务器',
      'level-name=world',
      'view-distance=10',
      'spawn-protection=0',
      'max-players=20'
    ].join('\n') + '\n',
    'utf-8'
  )
  record.jarReady = true
  upsertRecord(record)
  onProgress?.('创建完成', 100)
  hostLog.info(`服务器「${name}」创建完成（${entry.id}${type === 'modded' ? ' · Fabric 模组' : ' · 数据包'}，端口 ${port}）`)
  return record
}

/** 数据包服务器：弹窗选择数据包 zip，装入世界 datapacks 目录（需先创建过世界再重载生效）。 */
export function uploadHostServerDatapack(id: string, sourcePath: string): string | null {
  const record = findRecord(id)
  if (!record) throw new Error('服务器不存在')
  const src = String(sourcePath ?? '')
  if (!src.trim()) return null
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error('数据包文件不存在')
  const target = path.join(serverDir(id), 'world', 'datapacks')
  fs.mkdirSync(target, { recursive: true })
  const fileName = path.basename(src)
  if (!/\.zip$/i.test(fileName)) throw new Error('数据包必须为 .zip 文件')
  const dest = path.join(target, fileName)
  fs.copyFileSync(src, dest)
  hostLog.info(`数据包「${fileName}」已装入服务器「${record.name}」`)
  return fileName
}

/** 模组服务器：弹窗选择模组 jar，装入 mods 目录。 */
export function uploadHostServerMod(id: string, sourcePath: string): string | null {
  const record = findRecord(id)
  if (!record) throw new Error('服务器不存在')
  const src = String(sourcePath ?? '')
  if (!src.trim()) return null
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error('模组文件不存在')
  const target = path.join(serverDir(id), 'mods')
  fs.mkdirSync(target, { recursive: true })
  const fileName = path.basename(src)
  if (!/\.jar$/i.test(fileName)) throw new Error('模组必须为 .jar 文件')
  const dest = path.join(target, fileName)
  fs.copyFileSync(src, dest)
  hostLog.info(`模组「${fileName}」已装入服务器「${record.name}」`)
  return fileName
}

export async function startHostServer(id: string): Promise<HostServerStatus> {
  const record = findRecord(id)
  if (!record) throw new Error('服务器不存在')
  if (!record.jarReady || !fs.existsSync(serverJar(id))) throw new Error('服务端未就绪，请删除后重新创建')
  if (processAlive(record.pid)) return hostServerStatus(id)
  const child = launchServerProcess(record)
  record.pid = child.pid
  upsertRecord(record)
  hostLog.info(`服务器「${record.name}」已启动（PID ${child.pid}）`)
  // 等待服务端就绪：最多 90 秒轮询 SLP
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const st = await hostServerStatus(id)
    if (st.online) return st
    if (!processAlive(record.pid)) break
  }
  return hostServerStatus(id)
}

export async function stopHostServer(id: string): Promise<void> {
  const record = findRecord(id)
  if (!record) return
  if (record.pid && processAlive(record.pid)) {
    try {
      process.kill(record.pid)
    } catch {
      /* 继续 */
    }
    await new Promise((r) => setTimeout(r, 1500))
    if (processAlive(record.pid)) {
      // Windows 下强杀进程树
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true })
          await new Promise((r) => setTimeout(r, 1500))
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  record.pid = undefined
  hostProcessStdin.delete(id)
  upsertRecord(record)
}

export async function hostServerStatus(id: string): Promise<HostServerStatus> {
  const record = findRecord(id)
  if (!record) throw new Error('服务器不存在')
  const running = processAlive(record.pid)
  let online = false
  let players: number | undefined
  let motd: string | undefined
  if (running) {
    try {
      const ping = await pingServer(`127.0.0.1:${record.port}`)
      online = ping.online === true
      const parts = String(ping.players ?? '').split('/')
      if (parts.length === 2) players = Number(parts[0]) || 0
      motd = ping.motd || undefined
    } catch {
      online = false
    }
  }
  return {
    running,
    online,
    players,
    motd,
    address: localAddress(record.port),
    logTail: readLogTail(id, 60)
  }
}

function readLogTail(id: string, lines: number): string {
  try {
    const raw = fs.readFileSync(logFile(id), 'utf-8')
    const all = raw.split(/\r?\n/).filter(Boolean)
    return all.slice(-lines).join('\n')
  } catch {
    return ''
  }
}

export function hostServerLog(id: string, lines = 200): string {
  return readLogTail(id, lines)
}

export async function deleteHostServer(id: string): Promise<void> {
  const record = findRecord(id)
  if (!record) return
  if (record.pid && processAlive(record.pid)) {
    // 删除前先停服并等待进程完全退出，否则旧进程仍占用端口，
    // 用户紧接着用同一端口重建服务器时会启动失败
    await stopHostServer(id)
  }
  const list = readHostServers().filter((r) => r.id !== id)
  writeHostServers(list)
  try {
    fs.rmSync(serverDir(id), { recursive: true, force: true })
  } catch {
    /* 文件占用时保留目录 */
  }
}

/** 启动器启动时自动拉起「一直开」的服务器（异步，不阻断启动） */
export function resumeHostServers(): void {
  const want = readHostServers().filter((r) => r.autoResume && r.jarReady)
  if (!want.length) return
  void (async () => {
    for (const record of want) {
      try {
        const st = await hostServerStatus(record.id)
        if (!st.online && !processAlive(record.pid)) {
          await startHostServer(record.id)
          hostLog.info(`已自动拉起服务器「${record.name}」`)
        }
      } catch (error) {
        hostLog.info(`自动拉起「${record.name}」失败：${String(error)}`)
      }
    }
  })()
}

// ---------------- 整合包安装到服务器 ----------------
/** 规范化压缩包内路径（统一斜杠、去 ./ 前缀）。 */
function normPackEntry(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** 服务器目录内安全拼接：拒绝越界路径。 */
function safeServerJoin(root: string, rel: string): string {
  const p = path.resolve(root, rel)
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`整合包路径越界：${rel}`)
  return p
}

/** CurseForge 下载元数据源（与 modpacks.ts 同策略：官方 key / mcimirror 镜像）。 */
async function hostCfSources(): Promise<Array<{ base: string; headers?: Record<string, string> }>> {
  const channel = cfChannel()
  const official = { base: channel.base, headers: channel.official ? { 'x-api-key': channel.key } : undefined }
  const mirror = { base: 'https://mod.mcimirror.top/curseforge/v1' }
  return channel.official ? (getSettings().mirror === 'bmclapi' ? [mirror, official] : [official, mirror]) : [mirror]
}

/** 把整合包 overrides/server-overrides 里的文件应用（复制）到服务器根目录。 */
function applyOverridesToServer(tmp: string, serverRoot: string, prefix: string): number {
  const src = path.join(tmp, prefix)
  if (!fs.existsSync(src)) return 0
  let n = 0
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else {
        const dest = safeServerJoin(serverRoot, r)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(path.join(dir, e.name), dest)
        n++
      }
    }
  }
  walk(src, '')
  return n
}

/** 自包含整合包：把 mods/ 下的 jar 复制到服务器 mods 目录。 */
function copyModsFromTree(tmp: string, modsDir: string): number {
  const src = path.join(tmp, 'mods')
  if (!fs.existsSync(src)) return 0
  let n = 0
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isFile() && /\.jar$/i.test(e.name)) {
      fs.copyFileSync(path.join(src, e.name), path.join(modsDir, e.name))
      n++
    }
  }
  return n
}

/**
 * 把整合包（Modrinth .mrpack / CurseForge .zip / 自包含 zip）安装到模组服务器。
 * mrpack 按清单下载 mods；CurseForge 按 manifest 解析下载；自包含 zip 直接解压 mods。
 * overrides / server-overrides 应用到服务器目录。返回 { mods, overrides }。
 */
export async function installModpackToHostServer(id: string, filePath: string, onProgress?: HostCreateProgress): Promise<{ mods: number; overrides: number }> {
  const record = findRecord(id)
  if (!record) throw new Error('服务器不存在')
  if (record.type !== 'modded') throw new Error('只有模组服务器（Fabric）支持安装整合包')
  const src = String(filePath ?? '')
  if (!src.trim() || !fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error('整合包文件不存在')
  const serverRoot = serverDir(id)
  const modsDir = path.join(serverRoot, 'mods')
  fs.mkdirSync(modsDir, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(serverRoot, '.hostpack-tmp-'))
  try {
    const zip = new AdmZip(src)
    const names = new Set(zip.getEntries().map((e) => normPackEntry(e.entryName)))
    zip.extractAllTo(tmp, true)
    let mods = 0, overrides = 0
    if (names.has('modrinth.index.json')) {
      onProgress?.('解析 Modrinth 整合包', 5)
      const idx = JSON.parse(fs.readFileSync(path.join(tmp, 'modrinth.index.json'), 'utf8')) as {
        files?: Array<{ path?: string; downloads?: string[]; size?: number }>
      }
      const tasks: DownloadTask[] = []
      for (const f of idx.files ?? []) {
        const p = normPackEntry(f.path ?? '')
        if (!p.startsWith('mods/') || !/\.jar$/i.test(p)) continue
        const url = (f.downloads ?? []).find((u) => typeof u === 'string' && /^https?:/.test(u))
        if (!url) continue
        const sha1 = f.hashes?.sha1?.toLowerCase()
        const sha512 = f.hashes?.sha512?.toLowerCase()
        const fileName = path.basename(p)
        tasks.push({ label: fileName, url, urls: [url], dest: path.join(modsDir, fileName), size: f.size, sha1, sha512 })
      }
      if (tasks.length) {
        await downloadAll(tasks, (d, t, _speed, detail) => {
          const doneN = detail.completedFiles ?? Math.min(d, t)
          const active = detail.activeFiles?.length ? `（${detail.activeFiles.join('、')}）` : ''
          const waited = detail.waits?.length ? ' · 下载源繁忙，正在重试' : ''
          onProgress?.(`下载整合包模组 ${doneN}/${tasks.length}${active}${waited}`, 5 + Math.round((doneN / tasks.length) * 85))
        }, 4, getSettings().mirror)
      }
      mods = tasks.length
      overrides += applyOverridesToServer(tmp, serverRoot, 'overrides') + applyOverridesToServer(tmp, serverRoot, 'server-overrides')
    } else if (names.has('manifest.json')) {
      onProgress?.('解析 CurseForge 整合包', 5)
      const mf = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8')) as {
        files?: Array<{ projectID?: number; fileID?: number }>
      }
      const sources = await hostCfSources()
      const files = (mf.files ?? []).filter((f) => Number.isSafeInteger(f?.projectID) && Number.isSafeInteger(f?.fileID))
      for (let i = 0; i < files.length; i++) {
        const f = files[i] as { projectID: number; fileID: number }
        try {
          const dl = await resolveCurseForgeDownload(f.projectID, f.fileID, sources, AbortSignal.timeout(15000))
          await downloadAll([{ label: dl.fileName, url: dl.url, urls: [dl.url], dest: path.join(modsDir, dl.fileName), sha1: dl.sha1, size: dl.size }], () => onProgress?.(`下载整合包模组 ${i + 1}/${files.length}（${dl.fileName}）`, 5 + Math.round(((i + 1) / files.length) * 85)), 1, getSettings().mirror)
          mods++
        } catch (err) {
          hostLog.warn(`整合包模组下载失败（${f.projectID}/${f.fileID}）：${String(err)}`)
        }
      }
      overrides += applyOverridesToServer(tmp, serverRoot, 'overrides') + applyOverridesToServer(tmp, serverRoot, 'server-overrides')
    } else {
      onProgress?.('解压整合包', 5)
      mods = copyModsFromTree(tmp, modsDir)
      overrides += applyOverridesToServer(tmp, serverRoot, 'overrides') + applyOverridesToServer(tmp, serverRoot, 'server-overrides')
      const dpSrc = path.join(tmp, 'datapacks')
      if (fs.existsSync(dpSrc)) {
        const dpDst = path.join(serverRoot, 'world', 'datapacks')
        fs.mkdirSync(dpDst, { recursive: true })
        for (const e of fs.readdirSync(dpSrc, { withFileTypes: true })) {
          if (e.isFile() && /\.zip$/i.test(e.name)) fs.copyFileSync(path.join(dpSrc, e.name), path.join(dpDst, e.name))
        }
      }
    }
    onProgress?.('安装完成', 100)
    hostLog.info(`整合包已装入服务器「${record.name}」：${mods} 个模组 / ${overrides} 个覆盖文件`)
    return { mods, overrides }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
  }
}

/** 打开服务器数据文件夹（mods / world 等），返回目录路径。 */
export function openHostServerFolder(id: string): string {
  const record = findRecord(id)
  if (!record) throw new Error('服务器不存在')
  const dir = serverDir(id)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
