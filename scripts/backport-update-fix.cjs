// Backport 修复脚本：对旧版本 worktree 应用与 v1.1.40 相同的三处更新链路修复
// 用法: node scripts/backport-update-fix.cjs <工程根>
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(process.argv[2])
if (!root) { console.error('usage: node backport-update-fix.cjs <root>'); process.exit(1) }

function patch(file, pairs) {
  let src = fs.readFileSync(file, 'utf8')
  for (const [oldStr, newStr] of pairs) {
    if (!src.includes(oldStr)) {
      console.error(`PATCH FAILED: ${file}\n缺少目标片段:\n${oldStr.slice(0, 200)}`)
      process.exit(1)
    }
    src = src.replace(oldStr, newStr)
  }
  fs.writeFileSync(file, src)
  console.log(`patched ${file}`)
}

const txn = path.join(root, 'src/main/core/updateTransaction.ts')
patch(txn, [[
`    const rel = path.relative(path.join(path.dirname(target), 'KAMUCL-update'), t.file)
    const key = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)
    if (t.schema !== 1 || !/^[a-f\\d-]{36}$/i.test(t.id) || key(t.target) !== key(target)
      || !rel || rel.startsWith('..') || path.isAbsolute(rel) || !/^[a-f\\d]{64}$/i.test(t.sha256)`,
`    // 更新包必须位于启动器同目录下的受信任更新子目录内（MC-Launcher-update 或旧命名 KAMUCL-update），
    // 防止任意路径被当作更新源。v1.1.35 起暂存目录改用 MC-Launcher 专属命名，此处须同时兼容新旧命名，
    // 否则下载完成的事务永远读不到，导致「重启后仍是老版本」。
    const rel = path.relative(path.dirname(target), t.file)
    const firstSeg = rel.split(/[\\\\/]/)[0]
    const trustedDir = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
      && (firstSeg === 'MC-Launcher-update' || firstSeg === 'KAMUCL-update')
    const key = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)
    if (t.schema !== 1 || !/^[a-f\\d-]{36}$/i.test(t.id) || key(t.target) !== key(target)
      || !trustedDir || !/^[a-f\\d]{64}$/i.test(t.sha256)`
]])

const apply = path.join(root, 'src/main/core/applyUpdate.ts')
patch(apply, [
  // 修复 2：cleanup 不删待应用更新包
  [
`  const base = path.dirname(exe)
  // 1. 更新标记残留（新旧两套命名都清）
  try {
    for (const name of fs.readdirSync(base)) {
      if (name.startsWith('.mclauncherupdate') || name.startsWith('.kamuclupdate')) {
        try { fs.rmSync(path.join(base, name), { force: true }) } catch { /* 占用时留待下次 */ }
      }
    }
  } catch { /* 目录不可读则跳过 */ }
  // 2. MC-Launcher-update 残留下载包与空目录（含旧命名 KAMUCL-update）
  try { fs.rmSync(path.join(base, 'MC-Launcher-update'), { recursive: true, force: true }) } catch { /* 跳过 */ }
  try { fs.rmSync(path.join(base, 'KAMUCL-update'), { recursive: true, force: true }) } catch { /* 跳过 */ }`,
`  const base = path.dirname(exe)
  // 0. 先判断是否存在活动更新事务（下载完成待应用/正在应用），存在则本轮不清除暂存更新包，
  //    否则会把已下载好的新版本删掉，造成「重启后仍是老版本」
  let hasActiveTransaction = false
  try {
    for (const name of fs.readdirSync(base)) {
      if (name.startsWith('.mclauncherupdate') || name.startsWith('.kamuclupdate')) { hasActiveTransaction = true; break }
    }
  } catch { /* 目录不可读则视为无标记 */ }
  // 1. 更新标记残留（新旧两套命名都清）
  try {
    for (const name of fs.readdirSync(base)) {
      if (name.startsWith('.mclauncherupdate') || name.startsWith('.kamuclupdate')) {
        try { fs.rmSync(path.join(base, name), { force: true }) } catch { /* 占用时留待下次 */ }
      }
    }
  } catch { /* 目录不可读则跳过 */ }
  // 2. MC-Launcher-update 残留下载包与空目录（含旧命名 KAMUCL-update）；有活动事务时保留
  if (!hasActiveTransaction) {
    try { fs.rmSync(path.join(base, 'MC-Launcher-update'), { recursive: true, force: true }) } catch { /* 跳过 */ }
    try { fs.rmSync(path.join(base, 'KAMUCL-update'), { recursive: true, force: true }) } catch { /* 跳过 */ }
  }`
  ],
  // 修复 3：更新中手动启动不放行旧版
  [
`    if (alive) return false
    // Interrupted helpers are quarantined, not restarted. A new explicit download may proceed.`,
`    if (alive) {
      // 更新助手正在替换启动器：不要打开旧版窗口。等待助手完成（替换成功后助手会自行
      // 拉起新版本并清理 claim），随后退出当前旧版实例，避免出现「重启后仍是老版本」。
      updateLog.info('检测到更新正在应用中，等待新版自动启动（最长 15s）')
      for (let n = 0; n < 30; n++) {
        if (!fs.existsSync(claim)) {
          updateLog.info('更新已由助手完成并清理标记，退出当前旧版实例')
          app.exit(0)
          return true
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      updateLog.info('等待更新完成超时，按中断处理恢复打开旧版')
    }
    // Interrupted helpers are quarantined, not restarted. A new explicit download may proceed.`
  ],
])

console.log(`BACKPORT OK: ${root}`)
