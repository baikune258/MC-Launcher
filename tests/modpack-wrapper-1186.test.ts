import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { probeImport } from '../src/main/core/importProbe'

async function fixture(entries: Record<string, string>, run: (file: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kamucl-wrapper-'))
  try {
    const zip = new AdmZip(), file = path.join(root, '整合包.zip')
    for (const [name, data] of Object.entries(entries)) zip.addFile(name, Buffer.from(data))
    zip.writeZip(file)
    await run(file)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('外层套任意命名文件夹的整合包（包名/mods/config）也能识别', async () => {
  await fixture({
    '1.20.1 整合包/mods/example.jar': 'jar',
    '1.20.1 整合包/mods/中文模组.jar': 'jar',
    '1.20.1 整合包/config/example.toml': 'a=1',
    '1.20.1 整合包/options.txt': 'x'
  }, async file => {
    const result = await probeImport(file)
    assert.equal(result.kind, 'modpack')
    if (result.kind !== 'modpack') return
    assert.equal(result.info.format, 'archive')
  })
})

test('包名/minecraft/mods 双层目录同样识别，且不会吞掉子世界目录', async () => {
  await fixture({
    '包名/minecraft/mods/a.jar': 'jar',
    '包名/minecraft/config/a.toml': 'a=1',
    '包名/minecraft/saves/我的世界/level.dat': 'level'
  }, async file => {
    const result = await probeImport(file)
    assert.equal(result.kind, 'modpack')
    if (result.kind === 'modpack') assert.equal(result.info.format, 'archive')
  })
})

test('只有材质包内容的压缩包仍不当作整合包', async () => {
  await fixture({
    'assets/minecraft/textures/x.png': 'png',
    'pack.mcmeta': '{}'
  }, async file => {
    const result = await probeImport(file)
    assert.notEqual(result.kind, 'modpack')
  })
})
