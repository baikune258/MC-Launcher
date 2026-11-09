import assert from 'node:assert/strict'
import test from 'node:test'
import { downloadCandidates } from '../src/main/core/download'

const EDGE = 'https://edge.forgecdn.net/files/6117/927/deltaboxlib-1.1.3.jar'

test('官方源模式下 CurseForge 文件仍保留同类 CDN 与社区镜像兜底', () => {
  const list = downloadCandidates([EDGE], 'official')
  assert.equal(list[0], 'https://mediafilez.forgecdn.net/files/6117/927/deltaboxlib-1.1.3.jar')
  assert.ok(list.includes(EDGE), '原地址仍应保留')
  assert.equal(list[list.length - 1], 'https://mod.mcimirror.top/files/6117/927/deltaboxlib-1.1.3.jar')
})

test('镜像源模式下社区镜像优先，且不重复候选地址', () => {
  const list = downloadCandidates([EDGE], 'bmclapi')
  const unique = new Set(list)
  assert.equal(unique.size, list.length)
  assert.equal(list[0], 'https://mod.mcimirror.top/files/6117/927/deltaboxlib-1.1.3.jar')
})

test('Modrinth CDN 文件同样带社区镜像兜底', () => {
  const url = 'https://cdn.modrinth.com/data/aabbcc/versions/1.2.3/mod.jar'
  const list = downloadCandidates([url], 'official')
  assert.equal(list[0], url)
  assert.equal(list[1], 'https://mod.mcimirror.top/data/aabbcc/versions/1.2.3/mod.jar')
})

test('普通地址不会被强行改写', () => {
  const url = 'https://example.com/a.jar'
  assert.deepEqual(downloadCandidates([url], 'official'), [url])
})
