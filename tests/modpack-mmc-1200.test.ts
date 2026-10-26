import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { probeImport } from '../src/main/core/importProbe'
import { extractOverrides } from '../src/main/core/modpacks'

async function fixture(entries: Record<string, Buffer | string>, run: (file: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kamucl-mmc-'))
  try {
    const zip = new AdmZip(), file = path.join(root, '整合包.zip')
    for (const [name, data] of Object.entries(entries)) zip.addFile(name, Buffer.isBuffer(data) ? data : Buffer.from(data))
    zip.writeZip(file)
    await run(file)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

const mmcPackJson = (components: unknown) => JSON.stringify({ formatVersion: 1, components })
const cfg = (intended?: string) => `InstanceType=OneSix\nconsole=false\n${intended ? `IntendedVersion=${intended}\n` : ''}IconKey=default`

test('MultiMC 整合包（.minecraft 子目录模式）识别并解析出版本与加载器', async () => {
  await fixture({
    'MyPack/minecraft/patches/net.minecraftforge.json': '{}',
    'MyPack/minecraft/options.txt': 'lang:zh_cn',
    'MyPack/.minecraft/mods/example.jar': 'jar',
    'MyPack/.minecraft/config/example.toml': 'a=1',
    'MyPack/mmc-pack.json': mmcPackJson([
      { uid: 'net.minecraft', version: '1.20.1' },
      { uid: 'net.minecraftforge', version: '47.2.0' }
    ]),
    'MyPack/instance.cfg': cfg()
  }, async file => {
    const result = await probeImport(file)
    assert.equal(result.kind, 'modpack')
    const info = (result as { kind: 'modpack'; info: { format: string; mcVersion: string; loader: string; loaderVersion: string; innerName: string } }).info
    assert.equal(info.format, 'mmc')
    assert.equal(info.mcVersion, '1.20.1')
    assert.equal(info.loader, 'forge')
    assert.equal(info.loaderVersion, '47.2.0')
    assert.ok(info.innerName.includes('整合包'))
  })
})

test('MultiMC 整合包（zip 根即游戏内容）识别；neoforge/fabric uid 正确映射', async () => {
  await fixture({
    'mods/neoforge-example.jar': 'jar',
    'config/example.toml': 'a=1',
    'mmc-pack.json': mmcPackJson([
      { uid: 'net.minecraft', version: '1.21.1' },
      { uid: 'net.neoforged', version: '21.1.99' }
    ]),
    'instance.cfg': cfg()
  }, async file => {
    const info = (await probeImport(file)) as { kind: 'modpack'; info: { format: string; mcVersion: string; loader: string; loaderVersion: string } }
    assert.equal(info.kind, 'modpack')
    assert.equal(info.info.format, 'mmc')
    assert.equal(info.info.mcVersion, '1.21.1')
    assert.equal(info.info.loader, 'neoforge')
    assert.equal(info.info.loaderVersion, '21.1.99')
  })
})

test('mmc-pack.json 缺 net.minecraft 组件时用 instance.cfg 的 IntendedVersion 兜底', async () => {
  await fixture({
    'mods/fabric-example.jar': 'jar',
    'mmc-pack.json': mmcPackJson([
      { uid: 'net.fabricmc.fabric-loader', version: '0.15.11' }
    ]),
    'instance.cfg': cfg('1.19.4')
  }, async file => {
    const info = (await probeImport(file)) as { kind: 'modpack'; info: { format: string; mcVersion: string; loader: string; loaderVersion: string } }
    assert.equal(info.kind, 'modpack')
    assert.equal(info.info.format, 'mmc')
    assert.equal(info.info.mcVersion, '1.19.4')
    assert.equal(info.info.loader, 'fabric')
    assert.equal(info.info.loaderVersion, '0.15.11')
  })
})

test('mmc-pack.json 损坏时报友好错误', async () => {
  await fixture({
    'mods/example.jar': 'jar',
    'mmc-pack.json': '{broken json',
    'instance.cfg': cfg()
  }, async file => {
    await assert.rejects(probeImport(file), /mmc-pack\.json 已损坏/)
  })
})

test('MultiMC 包即使含 versions 目录也优先识别为 mmc（不被全量包吞掉）', async () => {
  await fixture({
    'mods/example.jar': 'jar',
    'versions/1.20.1/1.20.1.json': JSON.stringify({ id: '1.20.1' }),
    'mmc-pack.json': mmcPackJson([
      { uid: 'net.minecraft', version: '1.20.1' }
    ]),
    'instance.cfg': cfg()
  }, async file => {
    const info = (await probeImport(file)) as { kind: 'modpack'; info: { format: string } }
    assert.equal(info.kind, 'modpack')
    assert.equal(info.info.format, 'mmc')
  })
})

test('MultiMC zip 根内容解压时排除 mmc-pack.json / instance.cfg 元文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kamucl-mmc-extract-'))
  try {
    const zip = new AdmZip()
    zip.addFile('mods/example.jar', Buffer.from('jar'))
    zip.addFile('config/example.toml', Buffer.from('a=1'))
    zip.addFile('mmc-pack.json', Buffer.from('{}'))
    zip.addFile('instance.cfg', Buffer.from('IntendedVersion=1.20.1'))
    zip.addFile('icon.png', Buffer.from('png'))
    const dest = path.join(root, 'instance')
    const exclude = (rel: string): boolean => {
      const parts = rel.split('/').filter(Boolean)
      if (!parts.length || parts.includes('..')) return true
      if (rel === 'mmc-pack.json' || rel === 'instance.cfg') return true
      if (parts.includes('__MACOSX')) return true
      if (/^[^/]*\.(png|jpg|jpeg|ico|icns)$/i.test(rel)) return true
      return false
    }
    const extracted = await extractOverrides(zip as unknown as Parameters<typeof extractOverrides>[0], '', dest, undefined, undefined, exclude)
    assert.ok(extracted.includes('mods/example.jar'))
    assert.ok(extracted.includes('config/example.toml'))
    assert.ok(!extracted.includes('mmc-pack.json'))
    assert.ok(!extracted.includes('instance.cfg'))
    assert.ok(!extracted.includes('icon.png'))
    assert.ok(fs.existsSync(path.join(dest, 'mods', 'example.jar')))
    assert.ok(fs.existsSync(path.join(dest, 'config', 'example.toml')))
    assert.ok(!fs.existsSync(path.join(dest, 'mmc-pack.json')))
    assert.ok(!fs.existsSync(path.join(dest, 'icon.png')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('.minecraft 前缀模式解压保持相对路径（去 .minecraft 包装）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kamucl-mmc-mc-'))
  try {
    const zip = new AdmZip()
    zip.addFile('MyPack/.minecraft/mods/a.jar', Buffer.from('jar'))
    zip.addFile('MyPack/.minecraft/config/b.toml', Buffer.from('b=2'))
    const dest = path.join(root, 'instance')
    const extracted = await extractOverrides(zip as unknown as Parameters<typeof extractOverrides>[0], 'MyPack/.minecraft', dest)
    assert.ok(extracted.includes('mods/a.jar'))
    assert.ok(extracted.includes('config/b.toml'))
    assert.ok(fs.existsSync(path.join(dest, 'mods', 'a.jar')))
    assert.ok(fs.existsSync(path.join(dest, 'config', 'b.toml')))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('普通材质包/光影 zip 仍不误判为 MultiMC', async () => {
  await fixture({
    'pack.png': 'png',
    'assets/minecraft/textures/block/stone.png': 'stone'
  }, async file => {
    const result = await probeImport(file)
    assert.notEqual(result.kind, 'modpack')
  })
})
