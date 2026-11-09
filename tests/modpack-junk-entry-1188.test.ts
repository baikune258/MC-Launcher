import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { StreamPackZip } from '../src/main/core/streamPackZip'
import { probeModpack } from '../src/main/core/modpacks'

const FIXTURE = path.join(__dirname, 'fixtures', 'pack-junk-stored-entry.zip')

test('存储条目声明大小异常时不再把整个整合包判成损坏', async () => {
  const zip = await StreamPackZip.open(FIXTURE, 1000)
  try {
    const entries = zip.getEntries()
    assert.equal(entries.length, 3)
    const junk = entries.find((entry) => entry.entryName.endsWith('caches/aa'))
    assert.ok(junk, '异常条目应被保留')
    assert.deepEqual(junk!.header, { size: 0, compressedSize: 2 })
    // 多余的两个字节是打包工具的填充，不属于文件内容；按声明大小读成空文件。
    assert.equal((await junk!.getData()).length, 0)
    const normal = entries.find((entry) => entry.entryName === 'overrides/config/ok.txt')
    assert.equal((await normal!.getData()).toString(), 'ok')
  } finally {
    await zip.close()
  }
})

test('含异常条目的 mrpack 仍可正常探测', async () => {
  const info = await probeModpack(FIXTURE)
  assert.equal(info.format, 'mrpack')
  assert.equal(info.mcVersion, '1.20.1')
})
