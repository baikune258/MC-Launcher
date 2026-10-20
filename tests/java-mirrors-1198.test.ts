import test from 'node:test'
import assert from 'node:assert/strict'
import { javaArchiveBaseName, mirrorPackage, provisionJava } from '../src/main/core/javaSources'

/** Mainland-China reachability fix: the official Adoptium/GitHub/Azul endpoints
 * used to stall the “Java 环境” preparation stage for about a minute and then
 * fail the launch. Trusted university mirrors publish the same Adoptium archive
 * without a checksum sidecar, so mirror installs are matched against the
 * official package name and still gated by structure plus a real run. */
const win = { major: 21, os: 'windows' as const, arch: 'x64' as const }
const listing = (names: string[]) => names.map(name => `<a href="${name}">${name}</a>`).join('\n')

test('镜像目录解析：只挑出与平台/架构/大版本匹配的 JRE 压缩包', async () => {
  const html = listing([
    'OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.msi',
    'OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip',
    'OpenJDK21U-jre_aarch64_windows_hotspot_21.0.12.1_1.zip',
    'OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip'
  ])
  const pkg = await mirrorPackage(win, async url => {
    assert.equal(url, 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jre/x64/windows/')
    return html
  })
  assert.equal(javaArchiveBaseName(pkg.url), 'OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip')
  assert.equal(pkg.sha256, undefined)
  assert.equal(pkg.url.startsWith('https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jre/x64/windows/'), true)
})

test('镜像包缺失时按顺序切换，不在无匹配的镜像上停留', async () => {
  const seen: string[] = []
  const pkg = await mirrorPackage(win, async url => {
    seen.push(url)
    if (url.includes('tuna')) throw new TypeError('fetch failed')
    return listing(['OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip'])
  })
  assert.equal(seen.length, 2)
  assert.match(seen[0], /tuna/)
  assert.match(seen[1], /nju/)
  assert.equal(pkg.provider.includes('南大镜像'), true)
})

test('镜像与官方同一文件时走镜像传输但仍强制官方 SHA256', async () => {
  const official = [{
    version: { major: 21 },
    binary: {
      os: 'windows', architecture: 'x64', image_type: 'jre',
      package: {
        link: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip',
        checksum: 'c'.repeat(64), size: 111
      }
    }
  }]
  const installed: { provider: string; url: string; sha256?: string }[] = []
  const result = await provisionJava(win, async () => official, async () => listing(['OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip']), async pkg => {
    installed.push(pkg)
    return '/mirror/java'
  }, () => {})
  assert.equal(result, '/mirror/java')
  assert.equal(installed.length, 1)
  assert.match(installed[0].url, /^https:\/\/mirrors\.tuna\.tsinghua\.edu\.cn\//)
  assert.equal(installed[0].sha256, 'c'.repeat(64))
  assert.match(installed[0].provider, /加速/)
})

test('官方元数据不可达时，镜像包在没有哈希的情况下依然可以被安装', async () => {
  const installed: { provider: string; url: string; sha256?: string }[] = []
  const result = await provisionJava(win, async () => { throw new TypeError('fetch failed') }, async () => listing(['OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip']), async pkg => {
    installed.push(pkg)
    return '/mirror/java'
  }, () => {})
  assert.equal(result, '/mirror/java')
  assert.equal(installed.length, 1)
  assert.equal(installed[0].sha256, undefined)
  assert.match(installed[0].provider, /清华镜像/)
})

test('macOS 与 Linux 使用 tar.gz，Windows 使用 zip', async () => {
  for (const target of [{ major: 21, os: 'mac' as const, arch: 'aarch64' as const }, { major: 17, os: 'linux' as const, arch: 'x64' as const }]) {
    const suffix = target.os === 'windows' ? '.zip' : '.tar.gz'
    const name = `OpenJDK${target.major}U-jre_${target.arch}_${target.os}_hotspot_${target.major}.0.1_1${suffix}`
    const pkg = await mirrorPackage(target, async url => {
      assert.equal(url, `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${target.major}/jre/${target.arch}/${target.os}/`)
      return listing([`${name}.sha256.txt`, name])
    })
    assert.equal(javaArchiveBaseName(pkg.url), name)
  }
})

test('javaArchiveBaseName 解码百分号转义，并对非 URL 输入返回空串', () => {
  assert.equal(javaArchiveBaseName('https://example.com/a/jdk-21.0.12.1%2B1.zip'), 'jdk-21.0.12.1+1.zip')
  assert.equal(javaArchiveBaseName('not a url'), '')
})
