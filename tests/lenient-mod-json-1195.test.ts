import assert from 'node:assert/strict'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { parseModArchive } from '../src/main/core/modMetadata'
import { parseLenientJson } from '../src/main/core/lenientJson'

/** 真实 MOD（spatial-gui 1.11.0）把换行直接写进了 fabric.mod.json 的 description；
 *  Gson 宽松解析能读，严格 JSON.parse 报 Bad control character。
 *  启动器必须按游戏同样的宽松语义读，否则整包准备阶段直接失败。 */
test('fabric.mod.json 字符串内含裸换行时仍能解析出 mod id 与前置', () => {
  const raw = `{
  "schemaVersion": 1,
  "id": "spatial_gui",
  "version": "1.11.0",
  "name": "Spatial GUI",
  "description": "A client-side mod that renders screens as a 3D plane.
§e[!] §cStill in early development.",
  "depends": {"fabricloader": ">=0.14", "minecraft": "1.20.1", "fabric-api": "*", "yet_another_config_lib_v3": "*"}
}`
  assert.throws(() => JSON.parse(raw))
  const parsed = parseLenientJson<{ id: string }>(raw)
  assert.equal(parsed.id, 'spatial_gui')
})

test('含注释与尾逗号的 MOD 元数据也能解析', () => {
  const raw = `{
    // 注释行
    "id": "demo",
    "version": "1.0",
    "depends": {"minecraft": "1.20.1"},
  }`
  const parsed = parseLenientJson<{ id: string; depends: Record<string, string> }>(raw)
  assert.equal(parsed.id, 'demo')
  assert.equal(parsed.depends.minecraft, '1.20.1')
})

test('打包后的 MOD 归档能读出元数据与必要前置', () => {
  const zip = new AdmZip()
  zip.addFile('fabric.mod.json', Buffer.from(`{
  "schemaVersion": 1,
  "id": "spatial_gui",
  "version": "1.11.0",
  "name": "Spatial GUI",
  "description": "line1
line2 with §c control chars",
  "depends": {"minecraft": "1.20.1", "fabric-api": "*"}
}`))
  const file = '/tmp/kamucl-lenient-mod-test.jar'
  zip.writeZip(file)
  const info = parseModArchive(new AdmZip(file), file, 'spatial-gui-1.11.0+1.20.1-fabric.jar')
  assert.equal(info.error, undefined)
  assert.equal(info.id, 'spatial_gui')
  assert.equal(info.mcRange, '1.20.1')
  assert.deepEqual(info.dependencies, ['fabric-api'])
})
