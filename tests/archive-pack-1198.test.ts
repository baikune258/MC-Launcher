import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { writeNbt } from '../src/main/core/nbt'
import { probeImport } from '../src/main/core/importProbe'

const world = () => zlib.gzipSync(writeNbt({ Data: { LevelName: 'fixture', DataVersion: 3465, Version: { Name: '1.20.1', Id: 3465 } } }))

async function fixture(entries: Record<string, Buffer | string>, run: (file: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kamucl-archive-'))
  try {
    const zip = new AdmZip(), file = path.join(root, '整合包.zip')
    for (const [name, data] of Object.entries(entries)) zip.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data))
    zip.writeZip(file)
    await run(file)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('无清单整合包（zip 根含 mods/config）识别为可导入整合包', async () => {
  await fixture({
    'mods/example.jar': 'jar',
    'mods/中文模组.jar': 'jar',
    'config/example.toml': 'a=1',
    'resourcepacks/字体包.zip': 'pack'
  }, async file => {
    const result = await probeImport(file)
    assert.equal(result.kind, 'modpack')
    if (result.kind !== 'modpack') return
    assert.equal(result.info.format, 'archive')
    assert.equal(result.info.fileCount, 4)
    assert.equal(result.info.mcVersion, '')
  })
})

test('带 .minecraft 前缀的无清单整合包同样识别，且只取内容最多的那个前缀', async () => {
  await fixture({
    '我的整合包/.minecraft/mods/a.jar': 'jar',
    '我的整合包/.minecraft/mods/b.jar': 'jar',
    '我的整合包/.minecraft/config/a.toml': 'a=1'
  }, async file => {
    const result = await probeImport(file)
    assert.equal(result.kind, 'modpack')
    if (result.kind === 'modpack') assert.equal(result.info.format, 'archive')
  })
})

test('纯材质包与纯光影压缩包不被当成整合包', async () => {
  await fixture({ 'assets/minecraft/lang/zh_cn.json': '{}', 'pack.mcmeta': '{}' }, async file => {
    assert.notEqual((await probeImport(file)).kind, 'modpack')
  })
  await fixture({ 'shaderpacks/demo.zip': 'shader' }, async file => {
    assert.notEqual((await probeImport(file)).kind, 'modpack')
  })
})

test('世界存档压缩包仍按存档识别，不被整合包判定抢占', async () => {
  await fixture({ 'world/level.dat': world(), 'world/region/r.0.0.mca': 'region' }, async file => {
    const result = await probeImport(file)
    assert.equal(result.kind, 'world')
  })
})

test('既有清单格式优先级高于无清单判定', async () => {
  await fixture({
    'modrinth.index.json': JSON.stringify({ game: 'minecraft', formatVersion: 1, name: 'p', versionId: '1', dependencies: { minecraft: '1.20.1' }, files: [] }),
    'overrides/mods/a.jar': 'jar'
  }, async file => {
    const result = await probeImport(file)
    assert.equal(result.kind, 'modpack')
    if (result.kind === 'modpack') assert.equal(result.info.format, 'mrpack')
  })
})
