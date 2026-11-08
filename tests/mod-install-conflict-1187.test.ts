import test from 'node:test'
import assert from 'node:assert/strict'
import AdmZip from 'adm-zip'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { prepareModInstall, executeModPlan } from '../src/main/core/modInstallPlan'
import type { CommunityFile, InstalledVersion } from '../src/shared/types'

const jar = (id: string, version = '1.0.0', extra: Record<string, unknown> = {}) => {
  const zip = new AdmZip()
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id, version, depends: { minecraft: '>=1.20 <1.21', fabricloader: '>=0.15' }, ...extra })))
  return zip.toBuffer()
}

function repoOf(file?: CommunityFile) {
  return {
    files: async () => file ? [file] : [],
    exact: async () => { if (!file) throw new Error('no file'); return file },
    find: async () => file
  }
}

function targetOf(root: string): InstalledVersion {
  return { id: '生存', folder: root, gameDirectory: path.join(root, 'isolated'), isolated: true, mcVersion: '1.20.1', loader: 'fabric', loaderVersion: '0.16.0' }
}

test('bundled nested library satisfies its own dependency instead of installing a duplicate mod id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kamucl-bundled-1187-'))
  try {
    // JEI ships mezz_config inside META-INF/jars and also declares it in depends.
    const bundled = new AdmZip()
    bundled.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id: 'mezz_config', version: '0.6.10' })))
    const jei = new AdmZip()
    jei.addFile('fabric.mod.json', Buffer.from(JSON.stringify({
      id: 'jei', version: '15.74.0.234',
      depends: { minecraft: '>=1.20 <1.21', fabricloader: '>=0.15', mezz_config: '>=0.6.10 <1.0.0' },
      jars: [{ file: 'META-INF/jars/mezz_config-0.6.10.jar' }]
    })))
    jei.addFile('META-INF/jars/mezz_config-0.6.10.jar', bundled.toBuffer())
    const source = path.join(root, 'jei.jar')
    fs.writeFileSync(source, jei.toBuffer())
    const depFile: CommunityFile = { source: 'modrinth', projectId: 'mezzconfig', fileId: 'mc-1', fileName: 'mezz_config.jar', version: '0.6.10', url: 'https://example.invalid/mezz_config.jar', size: 1, gameVersions: ['1.20.1'], loaders: ['fabric'], date: '', releaseType: 'release' }
    const target = targetOf(root)
    const plan = await prepareModInstall(target, { paths: [source] }, () => {}, undefined, repoOf(depFile))
    assert.equal(plan.files.filter(f => f.dependency).length, 0, 'bundled provider must not be downloaded again')
    await executeModPlan(plan.id, true, () => target, () => {})
    assert.deepEqual(fs.readdirSync(path.join(target.gameDirectory!, 'mods')), ['jei.jar'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('community JEI install skips the separately resolved mezz_config download', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kamucl-jei-1187-'))
  const bundled = new AdmZip()
  bundled.addFile('fabric.mod.json', Buffer.from(JSON.stringify({ id: 'mezz_config', version: '0.6.10' })))
  const jei = new AdmZip()
  jei.addFile('fabric.mod.json', Buffer.from(JSON.stringify({
    id: 'jei', version: '15.74.0.234',
    depends: { minecraft: '>=1.20 <1.21', fabricloader: '>=0.15', mezz_config: '>=0.6.10 <1.0.0' },
    jars: [{ file: 'META-INF/jars/mezz_config-0.6.10.jar' }]
  })))
  jei.addFile('META-INF/jars/mezz_config-0.6.10.jar', bundled.toBuffer())
  const body = jei.toBuffer()
  let requests = 0
  const server = http.createServer((_req, res) => { requests++; res.writeHead(200, { 'content-length': body.length }); res.end(body) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  try {
    const target = targetOf(root)
    const jeiFile: CommunityFile = { source: 'modrinth', projectId: 'u6dRKJwZ', fileId: 'jei-1', fileName: 'jei-1.20.1-fabric-15.74.0.234.jar', version: '15.74.0.234', url: `http://127.0.0.1:${(server.address() as any).port}/jei.jar`, sha1: crypto.createHash('sha1').update(body).digest('hex'), size: body.length, gameVersions: ['1.20.1'], loaders: ['fabric'], date: '', releaseType: 'release' }
    jeiFile.dependencies = [{ projectId: 'mezzconfig', required: true }]
    const depFile: CommunityFile = { source: 'modrinth', projectId: 'mezzconfig', fileId: 'mc-1', fileName: 'mezz_config.jar', version: '0.6.10', url: 'https://example.invalid/mezz_config.jar', size: 1, gameVersions: ['1.20.1'], loaders: ['fabric'], date: '', releaseType: 'release' }
    const repo = { files: async () => [depFile], exact: async () => jeiFile, find: async () => depFile }
    const plan = await prepareModInstall(target, { file: jeiFile }, () => {}, undefined, repo)
    assert.equal(plan.files.filter(f => f.dependency).length, 0)
    await executeModPlan(plan.id, true, () => target, () => {})
    assert.equal(requests, 1, 'only the selected JEI jar may be downloaded')
    assert.deepEqual(fs.readdirSync(path.join(target.gameDirectory!, 'mods')), ['jei-1.20.1-fabric-15.74.0.234.jar'])
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(root, { recursive: true, force: true }) }
})

test('older copy already in instance is parked as .disabled instead of blocking the install', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kamucl-replace-1187-'))
  try {
    const target = targetOf(root)
    const mods = path.join(target.gameDirectory!, 'mods'); fs.mkdirSync(mods, { recursive: true })
    fs.writeFileSync(path.join(mods, 'test_mod-1.0.0.jar'), jar('test_mod', '1.0.0'))
    const source = path.join(root, 'test_mod-1.2.3.jar'); fs.writeFileSync(source, jar('test_mod', '1.2.3'))
    const plan = await prepareModInstall(target, { paths: [source] }, () => {}, undefined, repoOf())
    await executeModPlan(plan.id, true, () => target, () => {})
    assert.deepEqual(fs.readdirSync(mods).sort(), ['test_mod-1.0.0.jar.disabled', 'test_mod-1.2.3.jar'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
