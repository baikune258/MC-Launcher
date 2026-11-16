import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { lookupChineseNameByEnglish } from './mcmodSearch'

/**
 * 模组中文名缓存：英文名 → 百科确认的中文名。
 * 存在 userData/mod-zh-names.json（随安装目录）。命中缓存的搜索不再联网，
 * 所以第一次搜过某个模组之后，后续展示都是即时的中文名。
 */
interface Entry { zh: string; at: number }
const memory = new Map<string, Entry>()
let loaded = false, loading: Promise<void> | null = null, writeTimer: NodeJS.Timeout | null = null, dirty = false

const keyOf = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
const file = () => path.join(app.getPath('userData'), 'mod-zh-names.json')

async function load(): Promise<void> {
  if (loaded) return
  if (loading) return loading
  loading = (async () => {
    try {
      const raw = JSON.parse(await fs.readFile(file(), 'utf8'))
      if (raw && typeof raw === 'object') for (const [k, v] of Object.entries<any>(raw)) {
        if (typeof v?.zh === 'string' && v.zh) memory.set(k, { zh: v.zh, at: Number(v.at) || 0 })
      }
    } catch { /* 首次或文件损坏都当作空缓存 */ }
    loaded = true
  })()
  return loading
}

function scheduleWrite(): void {
  dirty = true
  if (writeTimer) return
  writeTimer = setTimeout(() => { writeTimer = null; void flushModZhNames() }, 800)
}

export async function flushModZhNames(): Promise<void> {
  if (!dirty) return
  dirty = false
  try {
    const data: Record<string, Entry> = {}
    const entries = [...memory.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, 20_000)
    for (const [k, v] of entries) data[k] = v
    await fs.mkdir(path.dirname(file()), { recursive: true })
    const temporary = `${file()}.${process.pid}.tmp`
    await fs.writeFile(temporary, JSON.stringify(data), 'utf8')
    await fs.rename(temporary, file())
  } catch { /* 缓存写失败只影响下次是否重查 */ }
}

/** 有英文且不含中文的才需要外部补全。 */
const translatable = (name: string) => /[A-Za-z]/.test(name) && !/[一-鿿]/.test(name)

/**
 * 批量补全中文名：总预算内（默认 2.4 秒）优先补最靠前的结果，
 * 超时立刻返回已拿到的部分，不阻塞搜索结果展示。
 */
export async function enrichChineseNames(items: Array<{ title: string; zh?: string }>, budgetMs = 2_400): Promise<string[]> {
  await load()
  const names: string[] = items.map(i => i.zh ?? memory.get(keyOf(i.title))?.zh ?? '')
  const missing = items.map((item, index) => ({ index, english: item.title.trim() }))
    .filter(x => !names[x.index] && translatable(x.english) && x.english.length <= 60)
    .slice(0, 8)
  if (!missing.length) return names
  const deadline = Date.now() + budgetMs
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(2, missing.length) }, async () => {
    while (cursor < missing.length) {
      const item = missing[cursor++]
      if (Date.now() > deadline) return
      try {
        const hit = await lookupChineseNameByEnglish(item.english)
        if (hit) { names[item.index] = hit.zh; const key = keyOf(item.english); memory.set(key, { zh: hit.zh, at: Date.now() }); scheduleWrite() }
      } catch { /* 单个查询失败不影响其他结果 */ }
    }
  }))
  return names
}

/** 只读缓存（不联网）：给已安装模组列表用，避免打开目录时卡在联网查询。 */
export async function cachedNames(names: string[]): Promise<Record<string, string>> {
  await load()
  const map: Record<string, string> = {}
  for (const name of names) { const zh = memory.get(keyOf(name))?.zh; if (zh) map[name] = zh }
  return map
}
