import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeAccountBackup, restoreAccountBackupIfNeeded, accountBackupPath } from '../src/main/core/accountBackup'

/** 账号数据在版本更新后不得丢失：accounts.json 每次写入都留快照，
 * 主文件缺失/损坏时自动从快照恢复。 */
function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acct-backup-'))
}

test('写入主文件后同步产生一致的自动快照', () => {
  const dir = tempDir()
  const store = path.join(dir, 'MC-Launcher', 'data', 'accounts.json')
  const content = JSON.stringify({ accounts: [{ id: 'a', username: 'PlayerA' }], selectedId: 'a' }, null, 2)
  fs.mkdirSync(path.dirname(store), { recursive: true })
  fs.writeFileSync(store, content, 'utf-8')
  writeAccountBackup(store, content)
  assert.equal(fs.existsSync(accountBackupPath(store)), true)
  assert.equal(fs.readFileSync(accountBackupPath(store), 'utf-8'), content)
})

test('主文件被删除后从快照自动恢复', () => {
  const dir = tempDir()
  const store = path.join(dir, 'data', 'accounts.json')
  const backup = accountBackupPath(store)
  const content = JSON.stringify({ accounts: [{ id: 'a' }], selectedId: null })
  fs.mkdirSync(path.dirname(backup), { recursive: true })
  fs.writeFileSync(backup, content, 'utf-8')
  assert.equal(fs.existsSync(store), false)
  assert.equal(restoreAccountBackupIfNeeded(store), true)
  assert.equal(fs.existsSync(store), true)
  assert.equal(fs.readFileSync(store, 'utf-8'), content)
})

test('主文件损坏（JSON 无效）时从快照恢复', () => {
  const dir = tempDir()
  const store = path.join(dir, 'data', 'accounts.json')
  const content = JSON.stringify({ accounts: [] })
  fs.mkdirSync(path.dirname(store), { recursive: true })
  fs.writeFileSync(store, '{broken json', 'utf-8')
  writeAccountBackup(store, content)
  assert.equal(restoreAccountBackupIfNeeded(store), true)
  assert.equal(JSON.parse(fs.readFileSync(store, 'utf-8')).accounts.length, 0)
})

test('主文件完好时不触发恢复', () => {
  const dir = tempDir()
  const store = path.join(dir, 'data', 'accounts.json')
  fs.mkdirSync(path.dirname(store), { recursive: true })
  fs.writeFileSync(store, JSON.stringify({ accounts: [] }), 'utf-8')
  assert.equal(restoreAccountBackupIfNeeded(store), false)
})

test('主文件缺失且无快照时返回 false，不抛异常', () => {
  const dir = tempDir()
  const store = path.join(dir, 'data', 'accounts.json')
  assert.equal(restoreAccountBackupIfNeeded(store), false)
})
