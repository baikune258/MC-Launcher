/** 在线服务器 IPC 注册：列表/创建/启动/停止/状态/日志/删除/自动拉起 */
import type { IpcMain } from 'electron'
import {
  listHostServers,
  createHostServer,
  startHostServer,
  stopHostServer,
  hostServerStatus,
  hostServerLog,
  deleteHostServer,
  resumeHostServers,
  type HostServerCreateInput,
  type HostServerRecord,
  type HostServerStatus
} from './hostServer'

export const HOST_SERVER_IPC = {
  list: 'host-server:list',
  create: 'host-server:create',
  start: 'host-server:start',
  stop: 'host-server:stop',
  status: 'host-server:status',
  log: 'host-server:log',
  delete: 'host-server:delete',
  resume: 'host-server:resume'
} as const

export function registerHostServerIpc(ipcMain: IpcMain): void {
  ipcMain.handle(HOST_SERVER_IPC.list, (_e): HostServerRecord[] => listHostServers())
  ipcMain.handle(HOST_SERVER_IPC.create, (_e, input: HostServerCreateInput): Promise<HostServerRecord> => createHostServer(input ?? {}))
  ipcMain.handle(HOST_SERVER_IPC.start, (_e, id: string): Promise<HostServerStatus> => startHostServer(String(id)))
  ipcMain.handle(HOST_SERVER_IPC.stop, (_e, id: string): Promise<void> => stopHostServer(String(id)))
  ipcMain.handle(HOST_SERVER_IPC.status, (_e, id: string): Promise<HostServerStatus> => hostServerStatus(String(id)))
  ipcMain.handle(HOST_SERVER_IPC.log, (_e, id: string): string => hostServerLog(String(id)))
  ipcMain.handle(HOST_SERVER_IPC.delete, (_e, id: string): void => deleteHostServer(String(id)))
  ipcMain.handle(HOST_SERVER_IPC.resume, (): void => resumeHostServers())
}
