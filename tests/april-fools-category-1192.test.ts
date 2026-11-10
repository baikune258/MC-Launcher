import assert from 'node:assert/strict'
import test from 'node:test'
import { filterVersions, isAprilFools, versionCategory, versionCategories } from '../src/shared/versionPicker'
import type { RemoteVersion } from '../src/shared/types'

const v = (id: string, type: RemoteVersion['type'], releaseTime: string): RemoteVersion => ({ id, type, releaseTime, url: 'https://example.com/' + id })

test('4 月 1 日的快照判为愚人节版本，当天发布的正式版不算', () => {
  assert.equal(isAprilFools(v('24w14potato', 'snapshot', '2024-04-01T00:00:00+00:00')), true)
  assert.equal(isAprilFools(v('26.1.1', 'release', '2026-04-01T00:00:00+00:00')), false)
  assert.equal(isAprilFools(v('1.20.1', 'release', '2023-06-12T00:00:00+00:00')), false)
})

test('愚人节分类排在分类列表里且能筛出全部愚人节版本', () => {
  assert.ok(versionCategories.some(c => c.value === 'aprilfools'))
  const list = [
    v('24w14potato', 'snapshot', '2024-04-01T00:00:00+00:00'),
    v('25w14craftmine', 'snapshot', '2025-04-01T00:00:00+00:00'),
    v('23w13a_or_b', 'snapshot', '2023-04-01T00:00:00+00:00'),
    v('1.21.4', 'release', '2024-12-03T00:00:00+00:00'),
    v('24w13a', 'snapshot', '2024-03-27T00:00:00+00:00')
  ]
  assert.equal(versionCategory(list[0]), 'aprilfools')
  assert.deepEqual(filterVersions(list, 'aprilfools', '').map(x => x.id), ['25w14craftmine', '24w14potato', '23w13a_or_b'])
  assert.equal(filterVersions(list, 'snapshot', '').length, 4)
})
