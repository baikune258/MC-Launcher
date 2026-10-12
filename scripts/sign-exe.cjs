#!/usr/bin/env node
/** 对打包产物 MC-Launcher.exe 做 Authenticode 自签名（品牌：MC-Launcher / baikun）。
 *  私钥存 ~/.mclauncher-cert/（不进 git）；证书 10 年有效，信任一次长期不弹窗。
 *  用法：node scripts/sign-exe.cjs [exePath] */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const home = os.homedir()
const certDir = process.env.MC_CERT_DIR || path.join(home, '.mclauncher-cert')
const exe = process.argv[2] || path.resolve(__dirname, '../release/MC-Launcher.exe')
if (!fs.existsSync(exe)) { console.error('未找到产物：' + exe); process.exit(1) }
const cer = path.join(certDir, 'mclauncher.cer')
const key = path.join(certDir, 'mclauncher.key')
if (!fs.existsSync(cer) || !fs.existsSync(key)) { console.error('缺少签名证书（' + certDir + '），跳过签名'); process.exit(0) }
const tmp = exe + '.signed'
execFileSync('osslsigncode', ['sign', '-certs', cer, '-key', key,
  '-n', 'MC-Launcher', '-i', 'https://github.com/baikune258/MC-Launcher',
  '-in', exe, '-out', tmp], { stdio: 'pipe' })
fs.renameSync(tmp, exe)
console.log('signed: ' + exe)
