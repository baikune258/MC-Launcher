import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { probeImport } from '../src/main/core/importProbe'

async function fixture(entries: Record<string, string>, fileName: string, run: (file: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kamucl-wrapped-pack-'))
  try {
    const zip = new AdmZip(), file = path.join(root, fileName)
    for (const [name, data] of Object.entries(entries)) zip.addFile(name, Buffer.from(data))
    zip.writeZip(file)
    await run(file)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

const mrpackIndex = (name: string) => JSON.stringify({
  formatVersion: 1,
  game: 'minecraft',
  versionId: '1.0.0',
  name,
  dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.9' },
  files: [{
    path: 'mods/example.jar',
    hashes: { sha1: 'a'.repeat(40) },
    downloads: ['https://cdn.modrinth.com/data/example.jar'],
    fileSize: 1024
  }]
})

const cfManifest = (name: string) => JSON.stringify({
  minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
  manifestType: 'minecraftModpack',
  manifestVersion: 1,
  name,
  version: '1.0.0',
  files: []
})

test('被多套一层目录的 .mrpack 仍按 Modrinth 整合包识别', async () => {
  await fixture({
    '1.20.1整合包/modrinth.index.json': mrpackIndex('套壳包'),
    '1.20.1整合包/overrides/config/example.toml': 'a=1'
  }, '套壳.mrpack', async file => {
    const result = await probeImport(file)
    assert.equal(result.kind, 'modpack')
    if (result.kind !== 'modpack') return
    assert.equal(result.info.format, 'mrpack')
    assert.equal(result.info.innerName, '套壳包')
    assert.equal(result.info.mcVersion, '1.20.1')
    assert.equal(result.info.loader, 'fabric')
    assert.equal(result.info.fileCount, 1)
    assert.equal(result.info.downloadBytes, 1024)
    assert.equal(result.info.hasOverrides, true)
  })
})

test('被多套一层目录的 CurseForge 包同样识别', async () => {
  await fixture({
    '我的整合包/manifest.json': cfManifest('CF套壳包'),
    '我的整合包/overrides/config/example.toml': 'a=1'
  }, 'cf.zip', async file => {
    const result = await probeImport(file)
    assert.equal(result.kind, 'modpack')
    if (result.kind !== 'modpack') return
    assert.equal(result.info.format, 'curseforge')
    assert.equal(result.info.innerName, 'CF套壳包')
    assert.equal(result.info.mcVersion, '1.20.1')
    assert.equal(result.info.loader, 'forge')
  })
})

test('多个一级目录都带清单时不猜，保持报无法识别', async () => {
  await fixture({
    'a/modrinth.index.json': mrpackIndex('A'),
    'b/modrinth.index.json': mrpackIndex('B')
  }, 'multi.mrpack', async file => {
    await assert.rejects(() => probeImport(file), /无法识别的整合包格式/)
  })
})
