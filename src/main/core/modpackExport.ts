import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import yazl from 'yazl'
import type { InstalledVersion } from '../../shared/types'
import { instanceDirectoryState } from './instances'
import { readVersionJson } from './versions'
import { getSettings } from './settings'
import { httpFetch } from './httpClient'
import { logScope } from './launcherLog'

/**
 * 导出整合包：把实例里的模组、配置与资源整理成标准 .mrpack，
 * 能在 Modrinth App、Prism、HMCL/PCL 与本启动器之间互相导入。
 * 已能从 Modrinth 认领的模组只写「下载地址 + 哈希」，其余文件进 overrides/ 随包携带。
 * 默认不打包存档、截图、日志与游戏本体（这些属于玩家个人数据或可重新下载的内容）。
 */

const exportLog = logScope('modpack-export')
const UA = { 'User-Agent': 'MC-Launcher (github.com/baikune258/MC-Launcher)' }
const TIMEOUT = 20_000
/** 单个随包文件上限，避免误把上百 MB 的整合包/存档塞进来 */
const MAX_BUNDLED_BYTES = 200 * 1024 * 1024

/** 允许随包导出的目录（相对游戏目录），其余一律忽略 */
const PACK_DIRS = [
  'mods',
  'config',
  'defaultconfigs',
  'kubejs',
  'resourcepacks',
  'shaderpacks',
  'datapacks',
  'custom',
  'packmenu'
]

const LOADER_KEY = {
  forge: 'forge',
  neoforge: 'neoforge',
  fabric: 'fabric-loader',
  quilt: 'quilt-loader'
} as const

export interface ModpackExportRequest {
  versionId: string
  folder?: string
  name?: string
  version?: string
  /** 额外把 options.txt 带上（键位/视频设置等作者预设） */
  includeOptions?: boolean
  /** zip = 通用压缩包；mrpack = Modrinth 标准包；list = 纯文本清单（几 KB，可直接发给 AI） */
  format?: 'zip' | 'mrpack' | 'list'
}

export interface ModpackExportResult {
  path: string
  format: 'zip' | 'mrpack' | 'list'
  name: string
  version: string
  /** 交给启动器在线下载的模组数 */
  linked: number
  /** 随包携带的文件数 */
  bundled: number
  bytes: number
}

interface MrFile {
  path?: string
  hashes?: { sha1?: string; sha512?: string }
  url?: string
  filename?: string
  size?: number
}
interface MrVersionResp {
  files?: MrFile[]
}

function sha1Of(file: string): string {
  const hash = crypto.createHash('sha1')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex')
}

/** 递归收集目录内文件（跳过符号链接与超限文件），rel 使用正斜杠 */
function walkFiles(root: string, rel: string, out: Array<{ rel: string; abs: string; size: number }>, skipped: string[]): void {
  const abs = path.join(root, ...rel.split('/'))
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const childRel = `${rel}/${entry.name}`
    const childAbs = path.join(abs, entry.name)
    try {
      const st = fs.lstatSync(childAbs)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        walkFiles(root, childRel, out, skipped)
        continue
      }
      if (!st.isFile()) continue
      if (st.size > MAX_BUNDLED_BYTES) {
        skipped.push(childRel)
        continue
      }
      out.push({ rel: childRel, abs: childAbs, size: st.size })
    } catch {
      /* 单个文件读不到就跳过，不中断整包导出 */
    }
  }
}

function mrBases(): string[] {
  const bases = ['https://api.modrinth.com/v2', 'https://mod.mcimirror.top/modrinth/v2']
  return getSettings().mirror === 'bmclapi' ? [...bases].reverse() : bases
}

/** 按 sha1 批量反查 Modrinth 版本；任一镜像可用即可，失败返回空表（全部进 overrides 仍可离线用） */
async function lookupModrinth(hashes: string[]): Promise<Record<string, MrVersionResp>> {
  const found: Record<string, MrVersionResp> = {}
  for (let at = 0; at < hashes.length; at += 100) {
    const batch = hashes.slice(at, at + 100)
    let lastErr: unknown = null
    for (const base of mrBases()) {
      try {
        const init = {
          method: 'POST',
          signal: AbortSignal.timeout(TIMEOUT),
          headers: { ...UA, 'Content-Type': 'application/json' },
          body: JSON.stringify({ hashes: batch, algorithm: 'sha1' })
        }
        let res: Response
        try {
          res = await httpFetch(`${base}/version_files`, init)
        } catch (error) {
          if (!process.versions.electron || !(error instanceof TypeError)) throw error
          res = await httpFetch(`${base}/version_files`, { ...init, systemProxy: true })
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as Record<string, MrVersionResp>
        for (const [hash, version] of Object.entries(body ?? {})) found[hash.toLowerCase()] = version
        lastErr = null
        break
      } catch (error) {
        lastErr = error
      }
    }
    if (lastErr) exportLog.warn(`Modrinth 反查失败，本批 ${batch.length} 个模组改为随包携带：${String(lastErr)}`)
  }
  return found
}


/** 老实例可能没写 _loaderVersion，从库坐标里兜底取，避免导出的包缺加载器依赖 */
function loaderVersionFromLibraries(json: ReturnType<typeof readVersionJson>, loader?: string): string | undefined {
  if (!loader) return undefined
  const libs = json.libraries ?? []
  const pick = (re: RegExp): string | undefined => {
    for (const lib of libs) {
      const hit = re.exec(lib.name ?? '')
      if (hit?.[1]) return hit[1]
    }
    return undefined
  }
  if (loader === 'fabric') return pick(/^net\.fabricmc:fabric-loader:(\S+)$/)
  if (loader === 'quilt') return pick(/^org\.quiltmc:quilt-loader:(\S+)$/)
  const raw = pick(loader === 'forge' ? /^net\.minecraftforge:forge:(\S+)$/ : /^net\.neoforged:forge:(\S+)$/)
  // Forge 坐标形如 1.20.1-47.2.0，mrpack 只要加载器版本
  return raw?.includes('-') ? raw.slice(raw.indexOf('-') + 1) : raw
}

/** 从实例信息推导 mrpack dependencies；缺加载器版本时退回版本 json 的自定义字段 */
function packDependencies(
  target: Pick<InstalledVersion, 'mcVersion' | 'loader' | 'loaderVersion'>,
  json: ReturnType<typeof readVersionJson>
): Record<string, string> {
  const deps: Record<string, string> = { minecraft: target.mcVersion || json.clientVersion || '' }
  const loader = target.loader ?? json._loader
  const loaderVersion = target.loaderVersion || json._loaderVersion || loaderVersionFromLibraries(json, loader)
  if (loader && loaderVersion) deps[LOADER_KEY[loader as keyof typeof LOADER_KEY]] = loaderVersion
  return deps
}


/** 原子写文本文件：先写临时文件再改名，避免半截清单 */
async function writeAtomicText(outputPath: string, text: string): Promise<void> {
  const temporary = `${outputPath}.${crypto.randomUUID()}.tmp`
  await fs.promises.writeFile(temporary, text, 'utf8')
  await fs.promises.rename(temporary, outputPath)
}

type ZipEntry = { kind: 'file'; name: string; abs: string } | { kind: 'buffer'; name: string; data: Buffer }

/** 原子写 ZIP：先写临时文件再改名，避免中途失败留下半截包 */
async function writeZip(outputPath: string, entries: ZipEntry[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile()
    const temporary = `${outputPath}.${crypto.randomUUID()}.tmp`
    const stream = fs.createWriteStream(temporary)
    stream.on('close', () => {
      try {
        fs.renameSync(temporary, outputPath)
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    stream.on('error', (error) => {
      try {
        fs.rmSync(temporary, { force: true })
      } catch {
        /* ignore */
      }
      reject(error)
    })
    zip.outputStream.pipe(stream)
    for (const entry of entries) {
      if (entry.kind === 'file') zip.addFile(entry.abs, entry.name)
      else zip.addBuffer(entry.data, entry.name)
    }
    zip.end()
  })
}

export async function exportInstanceModpack(
  target: InstalledVersion & { folder?: string },
  outputPath: string,
  opts: ModpackExportRequest
): Promise<ModpackExportResult> {
  const versionId = opts.versionId
  const json = readVersionJson(versionId)
  const gameDir = instanceDirectoryState(versionId, json, opts.folder ?? target.folder).path
  if (!fs.existsSync(gameDir)) throw new Error('实例目录不存在或已被移动')

  const name = (opts.name || target.modpackName || versionId).trim() || versionId
  const version = (opts.version || target.modpackVersion || '1.0.0').trim() || '1.0.0'

  const files: Array<{ rel: string; abs: string; size: number }> = []
  const skipped: string[] = []
  for (const dir of PACK_DIRS) {
    const abs = path.join(gameDir, dir)
    if (!fs.existsSync(abs)) continue
    walkFiles(gameDir, dir, files, skipped)
  }
  if (opts.includeOptions !== false) {
    for (const leaf of ['options.txt', 'optionsof.txt']) {
      const abs = path.join(gameDir, leaf)
      if (fs.existsSync(abs)) {
        const size = fs.statSync(abs).size
        if (size <= MAX_BUNDLED_BYTES) files.push({ rel: leaf, abs, size })
      }
    }
  }
  if (!files.length) throw new Error('这个实例里没有可打包的模组或配置，请先安装模组再导出')

  const format: 'zip' | 'mrpack' | 'list' =
    opts.format === 'mrpack' ? 'mrpack' : opts.format === 'list' ? 'list' : 'zip'
  const deps = packDependencies(target, json)
  const loaderText = Object.entries(deps)
    .filter(([key]) => key !== 'minecraft')
    .map(([key, value]) => `${key} ${value}`)
    .join('、')

  if (format === 'list') {
    // 纯文本清单：几 KB，AI 与手机都能直接打开，用来让 AI 分析整合包里装了什么。
    const byTop = new Map<string, typeof files>()
    for (const file of files) {
      const top = file.rel.split('/')[0]
      const list = byTop.get(top)
      if (list) list.push(file)
      else byTop.set(top, [file])
    }
    const fmtSize = (bytes: number): string => (bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)
    const dirTitle: Record<string, string> = {
      mods: '模组（mods）',
      config: '配置（config）',
      defaultconfigs: '默认配置（defaultconfigs）',
      kubejs: 'KubeJS 脚本',
      resourcepacks: '资源包',
      shaderpacks: '光影包',
      datapacks: '数据包',
      custom: '其他自定义目录',
      packmenu: '主菜单定制'
    }
    const lines: string[] = [
      `# 整合包清单：${name}`,
      '',
      `- 整合包版本：${version}`,
      `- Minecraft：${deps.minecraft || '未知'}`,
      `- 加载器：${loaderText || '原版（未安装加载器）'}`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      `- 文件总数：${files.length}（合计 ${fmtSize(files.reduce((sum, file) => sum + file.size, 0))}）`,
      '- 说明：这是实例内容的文字清单，供 AI 阅读与分析；完整文件请用「通用整合包（ZIP）」导出。'
    ]
    for (const [top, group] of [...byTop.entries()].sort()) {
      lines.push('', `## ${dirTitle[top] ?? top}（${group.length} 个文件）`, '')
      if (top === 'mods') {
        lines.push('| 文件名 | 大小 |', '| --- | --- |')
        for (const file of group.sort((a, b) => a.rel.localeCompare(b.rel))) {
          lines.push(`| ${file.rel.slice('mods/'.length)} | ${fmtSize(file.size)} |`)
        }
        continue
      }
      const subDirs = new Map<string, number>()
      for (const file of group) {
        const rest = file.rel.split('/').slice(1)
        const key = rest.length > 1 ? rest[0] : '（根目录文件）'
        subDirs.set(key, (subDirs.get(key) ?? 0) + 1)
      }
      for (const [dir, count] of [...subDirs.entries()].sort()) lines.push(`- ${dir}：${count} 个文件`)
      const leaves = group.filter((file) => file.rel.split('/').length === 2)
      if (leaves.length) {
        // config 根目录下的文件名对排查很关键（能看出装了哪些模组的配置），列上限 300 条
        const limit = top === 'config' ? 300 : 200
        lines.push('', '根目录文件：')
        for (const file of leaves.slice(0, limit)) lines.push(`- ${file.rel}（${fmtSize(file.size)}）`)
        if (leaves.length > limit) lines.push(`- ……另有 ${leaves.length - limit} 个文件未列出`)
      }
    }
    const text = `${lines.join('\n')}\n`
    await writeAtomicText(outputPath, text)
    const bytes = fs.statSync(outputPath).size
    exportLog.info(`已导出整合包清单 ${path.basename(outputPath)}（${name} ${version}）：${files.length} 个文件，${bytes} 字节`)
    return { path: outputPath, format, name, version, linked: 0, bundled: files.length, bytes }
  }

  if (format === 'zip') {
    // 通用整合包：CurseForge 目录规范（根 manifest.json + overrides/），HMCL、PCL2、Prism、
    // CurseForge App 都能直接识别导入；同时根目录附一份中文说明，手动解压也看得懂。
    const listing = files
      .map((file) => `${file.rel}\t${file.size}`)
      .sort()
      .join('\n')
    const readme = [
      `整合包名称：${name}`,
      `整合包版本：${version}`,
      `Minecraft：${deps.minecraft || '未知'}`,
      `加载器：${loaderText || '原版（未装加载器）'}`,
      `导出时间：${new Date().toLocaleString('zh-CN')}`,
      `文件数：${files.length}`,
      '',
      '包内结构（CurseForge 标准）：manifest.json 描述版本与加载器，overrides/ 里就是游戏目录',
      '（mods/ 为模组，config/ 为配置，resourcepacks/ 为资源包，shaderpacks/ 为光影）。',
      '不包含存档、截图、日志与游戏本体，导入后启动器会自动装对应版本与加载器。',
      '',
      '文件清单（相对路径 / 字节）：',
      listing
    ].join('\n')
    // CurseForge manifest：模组全部随 overrides 携带，files 留空即可
    const loaderId = deps.minecraft
      ? Object.entries(deps)
          .filter(([key]) => key !== 'minecraft')
          .map(([key, value]) => `${key === 'fabric-loader' ? 'fabric' : key === 'quilt-loader' ? 'quilt' : key}-${value}`)
          .slice(0, 1)
      : []
    const manifest = {
      minecraft: {
        version: deps.minecraft || '',
        modLoaders: loaderId.map((id) => ({ id, primary: true }))
      },
      manifestType: 'minecraftModpack',
      manifestVersion: 1,
      name,
      version,
      author: 'KAMUCL',
      files: [],
      overrides: 'overrides'
    }
    const info = {
      format: 'kamucl-zip-pack',
      name,
      version,
      minecraft: deps.minecraft || '',
      loader: loaderText || '',
      exportedAt: new Date().toISOString(),
      files
    }
    await writeZip(outputPath, [
      { kind: 'buffer', name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
      { kind: 'buffer', name: '整合包信息.txt', data: Buffer.from(readme, 'utf8') },
      { kind: 'buffer', name: 'kamucl-pack.json', data: Buffer.from(JSON.stringify(info, null, 2), 'utf8') },
      ...files.map((file) => ({ kind: 'file' as const, name: `overrides/${file.rel}`, abs: file.abs }))
    ])
    const bytes = fs.statSync(outputPath).size
    exportLog.info(`已导出通用整合包 ${path.basename(outputPath)}（${name} ${version}）：${files.length} 个文件，${bytes} 字节`)
    return { path: outputPath, format, name, version, linked: 0, bundled: files.length, bytes }
  }

  const modJars = files.filter((f) => /^mods\/[^/]+\.jar$/i.test(f.rel))
  const hashes = modJars.map((f) => sha1Of(f.abs))
  const modrinth = hashes.length ? await lookupModrinth(hashes) : {}

  const linked: Array<Record<string, unknown>> = []
  const bundled: typeof files = []
  const usedNames = new Set<string>()
  for (const file of modJars) {
    const hash = hashes[modJars.indexOf(file)]
    const versionInfo = modrinth[hash]
    const matched = versionInfo?.files?.find((entry) => entry.hashes?.sha1?.toLowerCase() === hash)
    if (!matched?.url) {
      bundled.push(file)
      continue
    }
    let entryPath = file.rel
    // 同一 sha1 被两个不同文件名引用时（常见于重复下载），改用源站文件名并去重
    if (usedNames.has(entryPath.toLowerCase())) entryPath = `mods/${matched.filename || path.basename(file.rel)}`
    usedNames.add(entryPath.toLowerCase())
    linked.push({
      path: entryPath,
      hashes: { sha1: matched.hashes?.sha1 ?? hash, sha512: matched.hashes?.sha512 },
      downloads: [matched.url],
      fileSize: matched.size ?? file.size,
      env: { client: 'required', server: 'required' }
    })
  }
  // 非模组文件全部随包携带（配置、资源包、光影等）
  for (const file of files) if (!modJars.includes(file)) bundled.push(file)

  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: `${name} ${version}`,
    name,
    summary: '由 MC-Launcher 导出的整合包',
    files: linked,
    dependencies: packDependencies(target, json)
  }

  await writeZip(outputPath, [
    { kind: 'buffer', name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index, null, 2), 'utf8') },
    ...bundled.map((file) => ({ kind: 'file' as const, name: `overrides/${file.rel}`, abs: file.abs }))
  ])

  const bytes = fs.statSync(outputPath).size
  exportLog.info(
    `已导出整合包 ${path.basename(outputPath)}（${name} ${version}）：在线引用 ${linked.length} 个，随包 ${bundled.length} 个，${bytes} 字节`
  )
  if (skipped.length) exportLog.warn(`以下文件超过 ${MAX_BUNDLED_BYTES} 字节被跳过：${skipped.slice(0, 5).join('、')}`)
  return { path: outputPath, format, name, version, linked: linked.length, bundled: bundled.length, bytes }
}
