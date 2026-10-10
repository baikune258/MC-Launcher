import fs from 'node:fs'
import path from 'node:path'

/** 便携版默认游戏目录跟随软件安装位置（PCL 风格）：EXE 旁的 .minecraft，不占系统盘。 */
export const defaultGameFolder = (appData: string): string => {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  return portable ? path.join(path.dirname(portable), '.minecraft') : path.join(appData, '.minecraft')
}

/** Only the launcher-owned default may be created implicitly; missing external roots stay missing. */
export function ensureDefaultGameFolder(appData: string, folders: readonly { path: string }[]): void {
  // A registered legacy default remains supported without moving existing games.
  const roots = [defaultGameFolder(appData), path.join(appData, '.minecraft'), path.join(appData, '.kamucl')]
  for (const root of roots) {
    if (folders.some(folder => path.resolve(folder.path) === path.resolve(root))) {
      fs.mkdirSync(root, { recursive: true })
    }
  }
}
