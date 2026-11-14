import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * 启动完整性校验的磁盘缓存：记录「路径 + 大小 + 修改时间 + 期望 sha1 → 已通过」。
 * 只在文件大小、mtime 和期望 sha1 完全一致时复用结论；任一变化都会退回完整哈希。
 * 作用：第二次及以后的启动不再重复哈希几百 MB 的依赖库和客户端 jar。
 */
interface Entry { size: number; mtimeMs: number; sha1: string }
const MAX_ENTRIES = 20000
const entries = new Map<string, Entry>()
let loaded = false
let dirty = false
let flushTimer: NodeJS.Timeout | null = null

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'launch-verify.json')
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue
        const entry = value as Partial<Entry>
        if (!Number.isFinite(entry.size) || !Number.isFinite(entry.mtimeMs) || typeof entry.sha1 !== 'string') continue
        entries.set(key, { size: entry.size as number, mtimeMs: entry.mtimeMs as number, sha1: entry.sha1 })
      }
    }
  } catch {
    /* 无缓存或缓存损坏：下次启动重新校验并重建 */
  }
}

function flush(): void {
  flushTimer = null
  if (!dirty) return
  dirty = false
  try {
    const file = cacheFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = file + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(entries)), 'utf8')
    fs.renameSync(temporary, file)
  } catch {
    /* 缓存写失败不影响启动，只是下次会重新校验 */
  }
}

function schedule(): void {
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(flush, 800)
  flushTimer.unref?.()
}

export function isVerifiedArtifact(dest: string, sha1: string | undefined, size: number, mtimeMs: number): boolean {
  load()
  const entry = entries.get(path.resolve(dest))
  return !!entry && entry.size === size && entry.mtimeMs === mtimeMs && entry.sha1 === (sha1 ?? '')
}

export function rememberVerifiedArtifact(dest: string, sha1: string | undefined, size: number, mtimeMs: number): void {
  load()
  const key = path.resolve(dest)
  if (entries.size >= MAX_ENTRIES && !entries.has(key)) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) entries.delete(oldest)
  }
  const next: Entry = { size, mtimeMs, sha1: sha1 ?? '' }
  const current = entries.get(key)
  if (current && current.size === next.size && current.mtimeMs === next.mtimeMs && current.sha1 === next.sha1) return
  entries.set(key, next)
  schedule()
}

/** 校验结论作废（修复/重新下载后由调用方显式清除） */
export function forgetVerifiedArtifact(dest: string): void {
  load()
  if (entries.delete(path.resolve(dest))) schedule()
}

/** 进程退出前确保落盘 */
export function flushVerifyCache(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  flush()
}
