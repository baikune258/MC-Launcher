import assert from 'node:assert/strict'
import test from 'node:test'
import { mirrorPackages, zuluPackage } from '../src/main/core/javaSources'
import { isCancelError } from '../src/main/core/tasks'

const hash = 'a'.repeat(64)

/** Azul 的列表接口会无视 hw_bitness 先返回 32 位 i686 包；旧代码直接取第一条，
 *  详情校验必然失败并抛出「Azul 返回的 Java 版本或平台不匹配」。 */
test('Azul 跳过 32 位包，选中 64 位 JRE', async () => {
  const list = [
    { package_uuid: 'd8fcfbb2-b11b-4796-832f-6f39df333afa', java_version: [17], availability_type: 'CA', download_url: 'https://cdn.azul.com/zulu/bin/zulu17.70.113-ca-jre17.0.21.0.3-win_i686.zip' },
    { package_uuid: 'c4fae530-35c9-44ce-95c3-6f0744cf0be7', java_version: [17], availability_type: 'CA', download_url: 'https://cdn.azul.com/zulu/bin/zulu17.70.113-ca-jre17.0.21.0.3-win_x64.zip' }
  ]
  const details: Record<string, any> = {
    'd8fcfbb2-b11b-4796-832f-6f39df333afa': { java_version: [17], os: 'windows', arch: 'x86', hw_bitness: 32, java_package_type: 'jre', archive_type: 'zip', availability_type: 'CA', download_url: 'https://cdn.azul.com/zulu/bin/zulu17.70.113-ca-jre17.0.21.0.3-win_i686.zip', sha256_hash: hash, size: 40905100 },
    'c4fae530-35c9-44ce-95c3-6f0744cf0be7': { java_version: [17], os: 'windows', arch: 'x86', hw_bitness: 64, java_package_type: 'jre', archive_type: 'zip', availability_type: 'CA', download_url: 'https://cdn.azul.com/zulu/bin/zulu17.70.113-ca-jre17.0.21.0.3-win_x64.zip', sha256_hash: hash, size: 48000000 }
  }
  const read = async (url: string) => url.includes('/packages/?') ? list : details[url.split('/').pop()!]
  const pkg = await zuluPackage({ major: 17, os: 'windows', arch: 'x64' }, read as any)
  assert.match(pkg.url, /win_x64\.zip$/)
})

/** 一个镜像在某地区出现跳转循环时，安装流程必须还能用上另一个镜像。 */
test('镜像返回多个候选，首个失败不影响后续镜像', async () => {
  const readText = async (url: string) => {
    if (url.includes('mirrors.nju.edu.cn')) throw new Error('下载跳转次数过多')
    if (url.includes('mirrors.tuna.tsinghua.edu.cn')) return '<a href="OpenJDK17U-jre_x64_windows_hotspot_17.0.21_9.zip">x</a>'
    return '<a href="OpenJDK17U-jre_x64_windows_hotspot_17.0.19_7.zip">x</a>'
  }
  const { packages, errors } = await mirrorPackages({ major: 17, os: 'windows', arch: 'x64' }, readText)
  assert.deepEqual(packages.map(p => p.provider), ['清华镜像 Temurin', '中科大镜像 Temurin'])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /南大镜像/)
})

/** 下载超时不是用户取消：否则界面只会弹「任务已取消」，真实失败原因被隐藏。 */
test('超时类 abort 不被判定为用户取消', () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'AbortError' })
  assert.equal(isCancelError(timeout), false)
  const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  assert.equal(isCancelError(reset), false)
  const userCancel = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  assert.equal(isCancelError(userCancel), true)
  assert.equal(isCancelError(new Error('已取消')), true)
})
