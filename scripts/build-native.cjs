const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
if (process.platform === 'linux') {
  execFileSync(process.execPath, ['scripts/build-linux-native.cjs'], { stdio: 'inherit' })
  // 交叉编译 Windows portable 启动反馈组件（NSIS 模板注入 StartupFeedback.exe）：
  // Linux 上无 Windows csc，改用 mono mcs 生成 .NET 4.x WinForms 可执行文件。
  fs.mkdirSync(path.resolve('out/main'), { recursive: true })
  // Windows 辅助 exe 用 dotnet SDK 交叉编译 net48（当前沙箱 mcs 无法读取源文件）
  const dotnet = process.env.DOTNET_BIN || '/home/user/Doubao/chats/38446147967305730/kamucl-base/toolchain/dotnet/dotnet'
  const nb = path.resolve('toolchain/native-build')
  const put = (name) => {
    const src = path.join(nb, 'bin/Release/net48', `${name}.exe`)
    if (!fs.existsSync(src)) {
      execFileSync(dotnet, ['build', path.join(nb, `${name}.csproj`), '-c', 'Release', '-v', 'q'], { stdio: 'inherit' })
    }
    if (!fs.existsSync(src)) throw new Error(`dotnet 编译 ${name}.exe 失败`)
    fs.copyFileSync(src, path.resolve('out/main', `${name}.exe`))
  }
  for (const name of ['GameTitle', 'GameWindowFocus', 'WindowMaterial', 'StartupFeedback']) put(name)
}
if (process.platform === 'darwin') {
  fs.mkdirSync(path.resolve('out/main'), { recursive: true })
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  execFileSync('swiftc', ['-O', '-target', `${arch}-apple-macos13.0`, 'native/MacGameWindow.swift', '-o', 'out/main/MacGameWindow'], { stdio: 'inherit' })
}
if (process.platform === 'win32') {
  for (const name of ['WindowMaterial', 'GameWindowFocus', 'GameTitle']) {
  const output = path.resolve(`out/main/${name}.exe`)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const compiler = path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${output}`, path.resolve(`native/${name}.cs`)], { stdio: 'inherit', windowsHide: true })
  }
  const compiler = path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  execFileSync(compiler, ['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', `/out:${path.resolve('out/main/StartupFeedback.exe')}`, `/resource:${path.resolve('src/renderer/src/assets/splash-face.png')},face.png`, path.resolve('native/StartupFeedback.cs')], { stdio: 'inherit', windowsHide: true })
}
