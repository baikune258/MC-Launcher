/**
 * 启动器自更新：GitHub Releases 检查（latest/列表）、ETag 条件请求、结果缓存、
 * 跳过版本逻辑、SHA256SUMS 获取。所有网络失败静默降级（记日志，不打扰用户）。
 *
 * 限流应对（未认证 60 次/时/IP）：
 * - 启动自动检查 1 次 + 结果缓存 6 小时
 * - ETag/If-None-Match 命中 304 不计入额度
 * - 手动检查走同一缓存（force 才绕过），403 限流时回退缓存
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { GITHUB_REPO } from '../../shared/branding'
import { compareSemver, isNewerVersion } from '../../shared/semver'
import type { ReleaseInfo, UpdateCheckResult } from '../../shared/types'
import { downloadFetch } from './downloadFetch'
import { validateUpdateDownloadUrl } from './updateSources'
import { abortableDelay, inheritTaskControl, isTaskPaused, waitIfTaskPaused } from './tasks'
import { logScope } from './launcherLog'
import { isolatedUpdateTest, trustedUpdateRelease, updateAssetName } from './updateTrust'

const updateLog = logScope('self-update')

/** 检查缓存有效期 6 小时 */
const CACHE_TTL_MS = 6 * 3600_000
const API_TIMEOUT_MS = 10_000
export const updateBodyPolicy = { timeoutMs: API_TIMEOUT_MS, maxBytes: 1024 * 1024 }

/** GitHub API 基地址（env 覆盖供 mock 测试：KAMUCL_UPDATE_API_BASE=http://127.0.0.1:8310） */
function apiBase(): string {
  return (isolatedUpdateTest() ? process.env.KAMUCL_UPDATE_API_BASE! : 'https://api.github.com').replace(/\/+$/, '')
}
/** 备用检查通道：仓库根 update.json（raw.githubusercontent.com 直连，国内可达且无 API 限流）。
 * 每次发版都会同步更新该文件，内容与 Release 资产严格一致。 */
const RAW_UPDATE_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/update.json`
const RAW_UPDATE_CACHE_KEY = 'raw-update-cache'
/** 文件下载基地址（镜像/mock 用；默认空 = 用 API 返回的 browser_download_url 原样） */
function downloadBaseOverride(): string {
  return (isolatedUpdateTest() ? process.env.KAMUCL_UPDATE_DOWNLOAD_BASE || '' : '').replace(/\/+$/, '')
}

interface CheckCache {
  source?: string
  etag?: string
  checkedAt: number
  latest?: ReleaseInfo | null
}

/** 当前版本（env 覆盖供测试） */
export function currentVersion(): string {
  return (isolatedUpdateTest() && process.env.KAMUCL_VERSION_OVERRIDE) || app.getVersion()
}
/** userData 目录（env 覆盖供测试） */
function userDataDir(): string {
  return isolatedUpdateTest() ? process.env.KAMUCL_USERDATA_DIR! : app.getPath('userData')
}

function cacheFile(): string {
  return path.join(userDataDir(), 'update-check-cache.json')
}

function readCache(): CheckCache | null {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf-8'))
    if (j && typeof j === 'object' && (!j.source || j.source === apiBase()) && (!j.latest || trustedCachedRelease(j.latest))) return j as CheckCache
  } catch { /* 无缓存 */ }
  return null
}

/** 缓存可接受范围：API 严格校验（资产精确匹配），或本仓库 download URL 前缀的合法版本（raw 备用通道写入） */
function trustedCachedRelease(r: ReleaseInfo): boolean {
  return trustedUpdateRelease(r) ||
    (/^\d+\.\d+\.\d+$/.test(r.version) && !!r.assetName && !!r.assetUrl && r.assetUrl.startsWith(`https://github.com/${GITHUB_REPO}/releases/download/`))
}

function writeCache(cache: CheckCache): void {
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true })
    fs.writeFileSync(cacheFile(), JSON.stringify({ ...cache, source: apiBase() }), 'utf-8')
  } catch (e) {
    updateLog.debug('检查缓存写入失败（不影响功能）', e)
  }
}

interface GhAsset { name?: string; browser_download_url?: string; size?: number; digest?: string }
interface GhRelease {
  tag_name?: string
  name?: string
  body?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
  assets?: GhAsset[]
}

/** 从 Release JSON 提取便携 exe 资产（排除 zip 与 SHA256SUMS） */
function pickPortableExe(assets: GhAsset[] | undefined, version: string): GhAsset | null {
  if (!Array.isArray(assets)) return null
  return assets.find((a) => a.name === updateAssetName(version)) ?? null
}

function toReleaseInfo(j: GhRelease): ReleaseInfo | null {
  const version = String(j.tag_name ?? '').replace(/^v/i, '')
  if (!version) return null
  const asset = pickPortableExe(j.assets, version)
  const release: ReleaseInfo = {
    version,
    publishedAt: String(j.published_at ?? ''),
    body: String(j.body ?? ''),
    assetUrl: asset?.browser_download_url ?? '',
    assetSize: Number(asset?.size ?? 0),
    assetName: asset?.name ?? ''
  }
  return trustedUpdateRelease(release) ? release : null
}

function updateRequestDeadline(parent?: AbortSignal, timeoutMs = API_TIMEOUT_MS): { signal: AbortSignal; finish: () => void } {
  const controller = new AbortController(), signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  inheritTaskControl(parent, signal)
  let elapsed = 0, last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now(), delta = now - last; last = now
    if (!isTaskPaused(parent)) elapsed += delta
    if (elapsed >= timeoutMs) controller.abort(new DOMException('更新请求超时', 'TimeoutError'))
  }, 100)
  return { signal, finish: () => clearInterval(timer) }
}

/** Header arrival does not complete an API/checksum request. Own the body
 * deadline and actively cancel its reader, including bodies from test fetchers.
 */
async function readUpdateBody(response: Response, signal?: AbortSignal): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const deadline = updateRequestDeadline(signal, updateBodyPolicy.timeoutMs), reader = response.body.getReader(), chunks: Uint8Array[] = []
  const cancel = () => { void reader.cancel(deadline.signal.reason).catch(() => {}) }
  deadline.signal.addEventListener('abort', cancel, { once: true })
  let bytes = 0
  try {
    if (Number(response.headers.get('content-length')) > updateBodyPolicy.maxBytes) throw new Error('更新响应体超过安全大小上限')
    while (true) {
      await waitIfTaskPaused(deadline.signal)
      deadline.signal.throwIfAborted()
      const chunk = await reader.read()
      deadline.signal.throwIfAborted()
      if (chunk.done) break
      bytes += chunk.value.length
      if (bytes > updateBodyPolicy.maxBytes) throw new Error('更新响应体超过安全大小上限')
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks)
  } finally {
    deadline.signal.removeEventListener('abort', cancel)
    deadline.finish()
    await reader.cancel().catch(() => {}); reader.releaseLock()
  }
}

async function ghFetch(url: string, etag?: string, signal?: AbortSignal): Promise<Response> {
  // 国内网络对 GitHub TLS 偶发重置：失败后 1.5s 重试一次（幂等 GET 安全）
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted()
    const deadline = updateRequestDeadline(signal)
    try {
      return await downloadFetch(url, {
        signal: deadline.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'MC-Launcher',
          ...(etag ? { 'If-None-Match': etag } : {})
        }
      }, undefined, undefined, async next => validateUpdateDownloadUrl(next, isolatedUpdateTest()))
    } catch (e) {
      signal?.throwIfAborted()
      if (attempt === 1) throw e
      updateLog.debug('GitHub 请求失败，1.5s 后重试一次', e)
      await abortableDelay(1500, signal)
    } finally {
      deadline.finish()
    }
  }
  throw new Error('unreachable')
}

/**
 * 备用检查通道：读取仓库根 update.json（raw.githubusercontent.com）。
 * 内容格式与 Release 资产严格一致；仅在 API 通道网络失败/限流时启用，
 * 避免「检查不到新版本」被单通道网络问题卡死。返回经校验的 ReleaseInfo。
 */
async function fetchRawUpdate(signal?: AbortSignal): Promise<ReleaseInfo | null> {
  try {
    const res = await ghFetch(RAW_UPDATE_URL, undefined, signal)
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return null }
    const j = JSON.parse((await readUpdateBody(res)).toString('utf8')) as {
      latest?: string; assetName?: string; assetUrl?: string; publishedAt?: string; body?: string; sha256SumsUrl?: string
    }
    const version = String(j.latest ?? '').replace(/^v/i, '')
    if (!/^\d+\.\d+\.\d+$/.test(version)) return null
    const name = updateAssetName(version)
    // v1.1.42 起 Windows 安装包固定命名为 MC-Launcher.exe（版本号只在启动器内显示）。
    // 为让任意旧版本（≤1.1.41 按 MC-Launcher-<版本>.exe 查找、≥1.1.42 按 MC-Launcher.exe 查找）
    // 都能走通备用通道更新到最新版，两种资产名均接受；assetUrl 缺失时按仓库规范拼接，
    // sha256SumsUrl 缺失时同样按规范拼接，不因字段格式差异阻断「每个版本都能更新到最新版本」。
    const legacyName = process.platform === 'win32' ? `MC-Launcher-${version}.exe` : null
    const assetName = j.assetName === name || j.assetName === legacyName ? j.assetName : (legacyName ?? name)
    const expectedUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${assetName}`
    if (j.assetUrl && j.assetUrl !== expectedUrl) return null
    const expectedSumsUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/SHA256SUMS.txt`
    if (j.sha256SumsUrl && j.sha256SumsUrl !== expectedSumsUrl) return null
    const release: ReleaseInfo = {
      version,
      publishedAt: String(j.publishedAt ?? ''),
      body: String(j.body ?? ''),
      assetUrl: expectedUrl,
      assetSize: 0,
      assetName
    }
    return release
  } catch (e) {
    updateLog.debug('备用更新通道读取失败', e)
    return null
  }
}

/**
 * 检查最新 Release。force=false 时 6h 缓存有效直接返回缓存；
 * 网络失败/限流静默降级（有缓存回退缓存，否则走备用 raw 通道）。
 */
export async function checkLatest(force = false): Promise<UpdateCheckResult> {
  const current = currentVersion()
  const cache = readCache()
  if (!force && cache?.checkedAt && Date.now() - cache.checkedAt < CACHE_TTL_MS && cache.latest !== undefined) {
    const has = !!cache.latest && isNewerVersion(cache.latest.version, current)
    return { ok: true, hasUpdate: has, release: cache.latest ?? undefined, fromCache: true }
  }
  try {
    // 手动强制检查不带旧 ETag，避免命中 304 返回过时缓存；失败时也不静默回退旧缓存伪装"已是最新"
    const res = await ghFetch(`${apiBase()}/repos/${GITHUB_REPO}/releases/latest`, force ? undefined : cache?.etag)
    if (!res.ok) await res.body?.cancel().catch(() => {})
    if (res.status === 304) {
      // 未变化：刷新缓存时间，沿用上次结果（304 不计限流）
      const latest = cache?.latest ?? null
      writeCache({ etag: cache?.etag, checkedAt: Date.now(), latest })
      const has = !!latest && isNewerVersion(latest.version, current)
      return { ok: true, hasUpdate: has, release: latest ?? undefined, fromCache: true }
    }
    if (res.status === 403 || res.status === 429) {
      const remain = res.headers.get('x-ratelimit-remaining')
      updateLog.info(`GitHub API 限流（remaining=${remain}），走备用通道`)
      const raw = await fetchRawUpdate()
      if (raw) {
        writeCache({ etag: cache?.etag, checkedAt: Date.now(), latest: raw })
        const has = isNewerVersion(raw.version, current)
        return { ok: true, hasUpdate: has, release: raw, reason: 'rate-limited' }
      }
      if (!force && cache?.latest !== undefined) {
        const has = !!cache.latest && isNewerVersion(cache.latest.version, current)
        return { ok: true, hasUpdate: has, release: cache.latest ?? undefined, fromCache: true, reason: 'rate-limited' }
      }
      return { ok: false, hasUpdate: false, reason: 'rate-limited' }
    }
    if (res.status === 404) {
      // 仓库还没有任何 Release：等同于"已是最新"，记缓存避免每次启动重试
      writeCache({ etag: res.headers.get('etag') ?? cache?.etag, checkedAt: Date.now(), latest: null })
      return { ok: true, hasUpdate: false }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = JSON.parse((await readUpdateBody(res)).toString('utf8')) as GhRelease
    const latest = toReleaseInfo(json)
    writeCache({ etag: res.headers.get('etag') ?? cache?.etag, checkedAt: Date.now(), latest })
    const has = !!latest && isNewerVersion(latest.version, current)
    return { ok: true, hasUpdate: has, release: latest ?? undefined }
  } catch (e) {
    updateLog.info('更新检查失败，走备用通道', e)
    const raw = await fetchRawUpdate()
    if (raw) {
      writeCache({ etag: cache?.etag, checkedAt: Date.now(), latest: raw })
      const has = isNewerVersion(raw.version, current)
      return { ok: true, hasUpdate: has, release: raw, reason: 'network' }
    }
    if (!force && cache?.latest !== undefined) {
      const has = !!cache.latest && isNewerVersion(cache.latest.version, current)
      return { ok: true, hasUpdate: has, release: cache.latest ?? undefined, fromCache: true, reason: 'network' }
    }
    return { ok: false, hasUpdate: false, reason: 'network' }
  }
}

/** 是否应向用户弹更新提示：有更新且未被跳过（跳过的版本不再提示，直到更新的版本出现） */
export function shouldPrompt(release: ReleaseInfo | undefined, skipVersion: string | undefined, current: string): boolean {
  if (!release) return false
  if (!isNewerVersion(release.version, current)) return false
  if (skipVersion && compareSemver(release.version, skipVersion) <= 0) return false
  return true
}

/**
 * 检查到更新后的动作决策（纯函数，可测试）：
 * - none：无更新/已跳过/已在下载/已有同版或更新版就绪待装
 * - auto-download：自动安装模式（默认）且运行形态支持 → 静默后台下载
 * - prompt：弹窗询问模式（自动安装关闭或不支持自更新的形态）
 */
export function decideUpdateAction(opts: {
  release?: ReleaseInfo
  skipVersion?: string
  current: string
  autoUpdate: boolean
  supported: boolean
  downloading: boolean
  pendingVersion?: string
}): 'auto-download' | 'prompt' | 'none' {
  if (!shouldPrompt(opts.release, opts.skipVersion, opts.current)) return 'none'
  const version = opts.release!.version
  if (opts.downloading) return 'none'
  if (opts.pendingVersion && compareSemver(opts.pendingVersion, version) >= 0) return 'none'
  if (opts.autoUpdate && opts.supported) return 'auto-download'
  return 'prompt'
}

/** 品牌化起点版本：回退与历史列表的最低版本（2.0.0 起为自有品牌，排除原作者 1.x 版本） */
export const ROLLBACK_MIN_VERSION = '1.1.22'

/** 版本回退候选：品牌化后的正式 Release，仅含「当前版本以前」的版本（按发布时间倒序；最低到 1.1.22） */
export async function listReleases(): Promise<ReleaseInfo[]> {
  try {
    const current = currentVersion()
    const res = await ghFetch(`${apiBase()}/repos/${GITHUB_REPO}/releases?per_page=20`)
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`HTTP ${res.status}`) }
    const list = JSON.parse((await readUpdateBody(res)).toString('utf8')) as GhRelease[]
    return list
      .filter((r) => !r.draft && !r.prerelease)
      .map(toReleaseInfo)
      .filter((r): r is ReleaseInfo => !!r && !!r.assetUrl)
      .filter((r) => compareSemver(r.version, ROLLBACK_MIN_VERSION) >= 0 && compareSemver(r.version, current) < 0)
      // 回退候选最多保留最近 10 个版本（GitHub 按发布时间倒序返回）
      .slice(0, 10)
  } catch (e) {
    updateLog.info('获取历史版本列表失败', e)
    return []
  }
}

/** 解析 SHA256SUMS.txt（sha256sum 标准格式：`<hash>  <filename>` 每行一条） */
export function parseSha256Sums(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim())
    if (m) {
      // 兼容带目录前缀的清单（如 release/MC-Launcher-1.1.31.exe），统一按文件 basename 登记，避免校验清单被误拒
      const key = m[2].trim().split(/[\\/]/).pop()
      if (key) map.set(key, m[1].toLowerCase())
    }
  }
  return map
}

/** Resolve the requested release's checksums, never a different latest version's manifest. */
export async function fetchSha256Sums(releaseAssetUrlHint?: string, fetcher: typeof ghFetch = ghFetch, signal?: AbortSignal): Promise<Map<string, string> | null> {
  signal?.throwIfAborted()
  const urls: string[] = []
  const expectedName = releaseAssetUrlHint?.split('/').at(-1)
  const read = async (url: string): Promise<Map<string, string> | null> => {
    const deadline = updateRequestDeadline(signal)
    try {
      signal?.throwIfAborted()
      const readSignal = deadline.signal
      const res = fetcher === ghFetch ? await downloadFetch(url, { signal: readSignal, headers: { 'User-Agent': 'MC-Launcher', 'accept-encoding': 'identity' } }, undefined, undefined,
        async next => validateUpdateDownloadUrl(next, isolatedUpdateTest())) : await fetcher(url, undefined, readSignal)
      if (!res.ok) { await res.body?.cancel().catch(() => {}); return null }
      const sums = parseSha256Sums((await readUpdateBody(res, signal)).toString('utf8'))
      return sums.size && (!expectedName || sums.has(expectedName)) ? sums : null
    } catch { signal?.throwIfAborted(); return null }
    finally { deadline.finish() }
  }
  if (releaseAssetUrlHint) {
    const exact = await read(releaseAssetUrlHint.replace(/[^/]+$/, 'SHA256SUMS.txt'))
    if (exact) return exact
    // Release CDN access and API access can fail independently. GitHub publishes
    // an asset's SHA256 digest in its official release API; it is a trusted
    // fallback when the canonical checksum file cannot be reached. Never ask a
    // download mirror for both the executable and its expected checksum.
    const prefix = `https://github.com/${GITHUB_REPO}/releases/download/`
    const match = releaseAssetUrlHint.startsWith(prefix) && /^(v\d+\.\d+\.\d+)\/([^/?#]+)$/.exec(releaseAssetUrlHint.slice(prefix.length))
    if (match) {
      try {
        const response = await fetcher(`${apiBase()}/repos/${GITHUB_REPO}/releases/tags/${match[1]}`, undefined, signal)
        if (response.ok) {
          const release = JSON.parse((await readUpdateBody(response, signal)).toString('utf8')) as GhRelease
          if (release.tag_name === match[1] && !release.draft && !release.prerelease && Array.isArray(release.assets)) {
            const asset = release.assets.find(asset => asset.name === expectedName && asset.browser_download_url === releaseAssetUrlHint && (asset.size ?? 0) > 0)
            const digest = /^sha256:([a-f\d]{64})$/i.exec(asset?.digest ?? '')
            if (digest) return new Map([[expectedName!, digest[1].toLowerCase()]])
          }
        } else await response.body?.cancel().catch(() => {})
      } catch { signal?.throwIfAborted() /* Keep legacy manifest fallbacks for older GitHub assets. */ }
    }
  }
  // mock/测试：下载基地址覆盖时直接从该基地址取
  const dlBase = downloadBaseOverride()
  if (dlBase) urls.push(`${dlBase}/SHA256SUMS.txt`)
  try {
    const res = await fetcher(`${apiBase()}/repos/${GITHUB_REPO}/releases/latest`, undefined, signal)
    if (res.ok) {
      const json = JSON.parse((await readUpdateBody(res, signal)).toString('utf8')) as GhRelease
      const sums = (json.assets ?? []).find((a) => a.name === 'SHA256SUMS.txt')
      if (sums?.browser_download_url) urls.push(sums.browser_download_url)
    } else await res.body?.cancel().catch(() => {})
  } catch { signal?.throwIfAborted() /* 继续用候选 */ }
  for (const url of urls) {
    const sums = await read(url)
    if (sums) return sums
  }
  return null
}

/** 计算文件的 SHA256（hex 小写） */
export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const crypto = await import('node:crypto')
  const hash = crypto.createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file, { signal })
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return hash.digest('hex')
}
