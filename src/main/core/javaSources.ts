/** Official OpenJDK distributors. Each fallback is a new package with its own
 * trusted metadata/hash; never resume a Temurin archive into a Zulu archive. */
export interface JavaPackage { provider: string; url: string; sha256?: string; size?: number }
export interface JavaTarget { major: number; os: 'windows' | 'mac' | 'linux'; arch: 'x64' | 'aarch64' }
type ReadJson = (url: string) => Promise<any>
export type ReadText = (url: string) => Promise<string>

function verifiedPackage(provider: string, url: unknown, hash: unknown, size: unknown, hosts: string[]): JavaPackage {
  const parsed = new URL(String(url))
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !hosts.includes(parsed.hostname) ||
      typeof hash !== 'string' || !/^[a-f\d]{64}$/i.test(hash) || !Number.isSafeInteger(size) || Number(size) <= 0) {
    throw new Error(`${provider} 返回的 Java 下载元数据不完整或无效`)
  }
  return { provider, url: parsed.href, sha256: hash, size: Number(size) }
}

export async function temurinPackage(target: JavaTarget, read: ReadJson): Promise<JavaPackage> {
  const { major, os, arch } = target
  const assets = await read(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${arch}&image_type=jre&os=${os}&vendor=eclipse`)
  const asset = Array.isArray(assets) && assets.find(a => a.version?.major === major && a.binary?.os === os && a.binary?.architecture === arch && a.binary?.image_type === 'jre')
  const pkg = asset?.binary?.package
  if (!pkg) throw new Error(`Adoptium 没有匹配 Java ${major} ${os}/${arch} 的 JRE`)
  return verifiedPackage('Eclipse Temurin', pkg.link, pkg.checksum, pkg.size, ['github.com'])
}

export async function zuluPackage(target: JavaTarget, read: ReadJson): Promise<JavaPackage> {
  const { major, os, arch } = target
  const system = os === 'mac' ? 'macos' : os, cpu = arch === 'aarch64' ? 'arm' : 'x86', archive = os === 'windows' ? 'zip' : 'tar.gz'
  const query = new URLSearchParams({ java_version: String(major), os: system, arch: cpu, hw_bitness: '64', archive_type: archive, java_package_type: 'jre', javafx_bundled: 'false', release_status: 'ga', availability_types: 'CA', latest: 'true' })
  const list = await read(`https://api.azul.com/metadata/v1/zulu/packages/?${query}`)
  // The Azul listing ignores hw_bitness in practice and can return 32-bit
  // (win_i686) builds first, so every candidate is re-checked against its own
  // detail record instead of trusting the first entry.
  const candidates = Array.isArray(list)
    ? list.filter(a => a.java_version?.[0] === major && a.availability_type === 'CA' && /^[\da-f-]{36}$/i.test(a.package_uuid))
    : []
  if (!candidates.length) throw new Error(`Azul 没有匹配 Java ${major} ${system}/${cpu} 的 JRE`)
  const mismatched: string[] = []
  for (const item of candidates.sort((a, b) => Number(String(b.download_url ?? '').includes('x64')) - Number(String(a.download_url ?? '').includes('x64')))) {
    const detail = await read(`https://api.azul.com/metadata/v1/zulu/packages/${item.package_uuid}`)
    if (detail.java_version?.[0] !== major || detail.os !== system || detail.arch !== cpu || detail.hw_bitness !== 64 ||
        detail.java_package_type !== 'jre' || detail.archive_type !== archive || detail.availability_type !== 'CA') {
      mismatched.push(`${String(detail.arch)}/${String(detail.hw_bitness)}`)
      continue
    }
    return { ...verifiedPackage('Azul Zulu', detail.download_url, detail.sha256_hash, detail.size, ['cdn.azul.com']), size: undefined }
  }
  throw new Error(`Azul 返回的 Java 版本或平台不匹配（仅有 ${mismatched.slice(0, 3).join('、') || '不兼容包'}，需要 ${system}/${cpu} 64 位）`)
}

export async function javaPackageSize(pkg: JavaPackage, head: (url: string) => Promise<Response>): Promise<number | undefined> {
  if (pkg.size !== undefined) return pkg.size
  try {
    const response = await head(pkg.url)
    const size = Number(response.headers.get('content-length'))
    await response.body?.cancel()
    return response.ok && Number.isSafeInteger(size) && size > 0 && !response.headers.get('content-encoding') ? size : undefined
  } catch { return undefined } // Streaming transfer still enforces the full SHA256.
}

export function javaNetworkError(error: unknown): string {
  const parts: string[] = []
  let current = error
  for (let i = 0; current && i < 3; i++) {
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code
      parts.push(`${current.message}${code ? ` (${code})` : ''}`); current = current.cause
    } else { parts.push(String(current)); break }
  }
  return parts.join('；')
}

/** Trusted Adoptium mirrors, tried in order. The official endpoints
 * (api.adoptium.net, the github.com release assets and cdn.azul.com) are
 * frequently unreachable or very slow from mainland China, where the previous
 * serial provider list could stall the “Java 环境” stage for about a minute and
 * then fail the launch. Mirrors publish no checksum sidecar, so a mirror
 * download is gated by archive structure plus actually running the extracted
 * runtime before it is published; when the mirror carries the same archive the
 * official metadata describes, the official SHA256 is still enforced.
 * Layout under each base is /<major>/jre/<arch>/<os>/<archive> — arch before
 * os, the reverse of the official distribution hostnames. */
export const JAVA_MIRRORS: readonly { label: string; base: string }[] = [
  { label: '南大镜像', base: 'https://mirrors.nju.edu.cn/adoptium' },
  { label: '清华镜像', base: 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium' },
  { label: '中科大镜像', base: 'https://mirrors.ustc.edu.cn/adoptium' }
]

/** Release-asset basename, so a mirror archive can be matched against the
 * officially described one regardless of the hosting path. */
export function javaArchiveBaseName(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') } catch { return '' }
}

/** Every mirror archive that matches the target, in preferred order. A single
 * first-hit mirror is not enough: one region can see a redirect loop on the
 * first mirror while the next one answers normally, so the caller keeps the
 * full list and only gives up after all of them fail. */
export async function mirrorPackages(target: JavaTarget, readText: ReadText): Promise<{ packages: JavaPackage[]; errors: string[] }> {
  const { major, os, arch } = target
  const archPath = arch === 'aarch64' ? 'aarch64' : 'x64'
  const osPath = os === 'mac' ? 'mac' : os
  const suffix = os === 'windows' ? '.zip' : '.tar.gz'
  const wanted = new RegExp(`jre[_-]${archPath}[_-]${osPath}`, 'i')
  const errors: string[] = []
  const packages: JavaPackage[] = []
  for (const mirror of JAVA_MIRRORS) {
    const dir = `${mirror.base}/${major}/jre/${archPath}/${osPath}/`
    try {
      const html = await readText(dir)
      const names = [...html.matchAll(/href="([^"?#]+\.(?:zip|tar\.gz))"/gi)].map(match => match[1].split('/').pop() ?? '')
      const selected = names.filter(name => name.toLowerCase().endsWith(suffix) && wanted.test(name)).sort().pop()
      if (!selected) { errors.push(`${mirror.label}：没有匹配 Java ${major} ${osPath}/${archPath} 的 JRE`); continue }
      packages.push({ provider: `${mirror.label} Temurin`, url: new URL(selected, dir).href })
    } catch (error) { errors.push(`${mirror.label}：${javaNetworkError(error)}`) }
  }
  if (!packages.length) errors.push(`国内镜像没有匹配 Java ${major} ${osPath}/${archPath} 的 JRE`)
  return { packages, errors }
}

/** Microsoft Build of OpenJDK: a Microsoft-operated CDN that is reliably reachable
 * from mainland China. No public checksum sidecar, so it is treated like a mirror
 * (structure + actually running the runtime before it is published). */
export async function microsoftPackage(target: JavaTarget): Promise<JavaPackage> {
  const { major, os, arch } = target
  const platform = os === 'windows' ? 'windows' : os === 'mac' ? 'macos' : 'linux'
  const archive = os === 'windows' ? '.zip' : '.tar.gz'
  const url = `https://aka.ms/download-jdk/microsoft-jdk-${major}-${platform}-${arch === 'aarch64' ? 'aarch64' : 'x64'}${archive}`
  return { provider: 'Microsoft OpenJDK', url }
}

export async function provisionJava<T>(target: JavaTarget, read: ReadJson, readText: ReadText, install: (pkg: JavaPackage) => Promise<T>, report: (text: string) => void, signal?: AbortSignal): Promise<T> {
  const errors: string[] = []
  signal?.throwIfAborted()
  report(`正在准备 Java ${target.major}（${target.arch}）`)
  // Official metadata and a reachable mirror are requested together: the mirror
  // is often the only endpoint that answers, while the official SHA256 is worth
  // waiting for whenever it does arrive.
  const attempt = async <T>(work: () => Promise<T>): Promise<{ value: T | null; error: unknown }> =>
    work().then(value => ({ value, error: null as unknown }), error => { signal?.throwIfAborted(); return { value: null, error } })
  const [official, mirrored, microsoft] = await Promise.all([
    attempt(() => temurinPackage(target, read)),
    attempt(() => mirrorPackages(target, readText)),
    attempt(async () => microsoftPackage(target)),
  ])
  signal?.throwIfAborted()
  const plan: JavaPackage[] = []
  const mirroredPackages = mirrored.value
  const mirrors: JavaPackage[] = mirroredPackages?.packages ?? []
  let acceleratedUrl = ''
  if (official.value) {
    // Same archive on both sides: take the mirror's transfer, keep the official hash.
    const twin = mirrors.find(pkg => javaArchiveBaseName(pkg.url) === javaArchiveBaseName(official.value!.url))
    if (twin) { plan.push({ ...official.value, provider: `${official.value.provider}（${twin.provider} 加速）`, url: twin.url }); acceleratedUrl = twin.url }
    else plan.push(official.value)
  } else errors.push(`Adoptium：${javaNetworkError(official.error)}`)
  for (const pkg of mirrors) if (pkg.url !== acceleratedUrl) plan.push(pkg)
  errors.push(...(mirroredPackages?.errors ?? []))
  if (microsoft.value) plan.push(microsoft.value)
  else errors.push(`Microsoft：${javaNetworkError(microsoft.error)}`)
  for (const pkg of plan) {
    try { signal?.throwIfAborted(); return await install(pkg) }
    catch (error) { signal?.throwIfAborted(); errors.push(`${pkg.provider}：${javaNetworkError(error)}`) }
  }
  signal?.throwIfAborted()
  report(`${errors.length ? '切换备用源：' : ''}正在准备 Java ${target.major}（Azul · ${target.arch}）`)
  try { const pkg = await zuluPackage(target, read); signal?.throwIfAborted(); return await install(pkg) }
  catch (error) { signal?.throwIfAborted(); errors.push(`Azul：${javaNetworkError(error)}`) }
  throw new Error(`Java ${target.major}（${target.os}/${target.arch}）自动准备失败，游戏尚未启动。请检查网络或系统代理后重试，也可在设置中选择已安装的对应 Java，或在设置中手动指定本机 Java。\n${errors.join('\n')}`)
}
