/**
 * certTrust.ts — MC-Launcher 自签名证书的一键信任（Windows）
 * 打包时用我们的 Authenticode 证书给 exe 签名（品牌「MC-Launcher / baikun」）。
 * 本模块负责：检测证书是否已装入系统「受信任的根证书」，未信任时引导用户一键导入
 * （需一次 UAC 确认，导入后所有后续版本启动均不再弹「Windows 保护电脑」）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const execFileP = promisify(execFile)
const CERT_SUBJECT = 'MC-Launcher'

/** 打包后的证书位于 resources/mclauncher.cer；开发环境回退 build/。 */
export function certCerPath(): string {
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'mclauncher.cer')
    if (fs.existsSync(p)) return p
  }
  return path.join(__dirname, '../../../build/mclauncher.cer')
}

/** 检测证书是否已装入「受信任的根证书颁发机构」（LocalMachine\Root）。 */
export async function isCertTrusted(): Promise<boolean> {
  if (process.platform !== 'win32') return true
  try {
    const { stdout } = await execFileP('certutil', ['-store', 'Root', CERT_SUBJECT], { windowsHide: true })
    return stdout.includes(CERT_SUBJECT)
  } catch {
    return false
  }
}

/** 一键信任：以管理员权限把我们的证书导入 LocalMachine\Root（会弹一次 UAC 确认）。 */
export async function trustCert(): Promise<boolean> {
  if (process.platform !== 'win32') return true
  if (await isCertTrusted()) return true
  const cer = certCerPath()
  if (!fs.existsSync(cer)) throw new Error('未找到内置证书文件')
  // 写一个临时 PowerShell 脚本，交给 UAC 提升的进程执行
  const ps1 = path.join(os.tmpdir(), `mc-trust-${process.pid}.ps1`)
  const script =
    `$ErrorActionPreference='Stop'\n` +
    `Import-Certificate -FilePath ${JSON.stringify(cer)} -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null\n`
  fs.writeFileSync(ps1, '\uFEFF' + script, 'utf8')
  try {
    await execFileP(
      'powershell.exe',
      ['-NoProfile', '-Command',
        `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${JSON.stringify(ps1)}`],
      { windowsHide: true }
    )
    // 提升进程可能异步完成，等确认装好
    for (let i = 0; i < 20; i++) {
      if (await isCertTrusted()) return true
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  } finally {
    try { fs.rmSync(ps1, { force: true }) } catch { /* 忽略 */ }
  }
}
