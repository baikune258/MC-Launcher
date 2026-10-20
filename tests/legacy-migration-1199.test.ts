import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { migrateLegacyUserData } from '../src/main/core/legacyDataMigration'

/** 旧 %APPDATA% 数据迁入安装目录时：增量搬移、绝不覆盖安装目录里的新账号，
 * 并清理 C 盘残留。 */
function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-mig-'))
}

test('安装目录为空时整体搬入全部历史文件', () => {
  const root = tempDir()
  const legacy = path.join(root, 'AppData-MC')
  const fresh = path.join(root, 'install', 'MC-Launcher', 'data')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'accounts.json'), JSON.stringify({ accounts: [{ id: 'a' }] }))
  fs.writeFileSync(path.join(legacy, 'settings.json'), '{"theme":"dark"}')
  const result = migrateLegacyUserData(legacy, fresh)
  assert.equal(result.imported, 2)
  assert.equal(result.skippedExisting, 0)
  assert.equal(fs.existsSync(path.join(fresh, 'accounts.json')), true)
  assert.equal(fs.existsSync(path.join(fresh, 'settings.json')), true)
  assert.equal(fs.existsSync(legacy), false)
})

test('安装目录已有更新账号时不被 C 盘旧账号覆盖，C 盘增量文件仍搬入', () => {
  const root = tempDir()
  const legacy = path.join(root, 'AppData-MC')
  const fresh = path.join(root, 'install', 'MC-Launcher', 'data')
  fs.mkdirSync(fresh, { recursive: true })
  fs.writeFileSync(path.join(fresh, 'accounts.json'), '{"accounts":[{"id":"new"}],"selectedId":"new"}')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'accounts.json'), '{"accounts":[{"id":"old"}]}')
  fs.writeFileSync(path.join(legacy, 'yggdrasil.json'), '{}')
  const result = migrateLegacyUserData(legacy, fresh)
  assert.equal(result.imported, 1)  // yggdrasil.json
  assert.equal(result.skippedExisting, 1)  // accounts.json 不覆盖
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, 'accounts.json'), 'utf-8')).accounts[0].id, 'new')
  assert.equal(fs.existsSync(path.join(fresh, 'yggdrasil.json')), true)
  assert.equal(fs.existsSync(legacy), false)
})

test('C 盘目录不存在时返回零结果且不创建安装目录垃圾', () => {
  const root = tempDir()
  const result = migrateLegacyUserData(path.join(root, 'nope'), path.join(root, 'fresh'))
  assert.deepEqual(result, { imported: 0, skippedExisting: 0 })
})
