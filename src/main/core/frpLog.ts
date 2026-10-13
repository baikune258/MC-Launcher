import { StringDecoder } from 'node:string_decoder'
import type { FrpStatus } from './frp'

export function parseFrpLine(raw: string): { status: FrpStatus | null; address: string | null; priority: number } {
  const text = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  let status: FrpStatus | null = null
  if (/invalid token|login to server failed|authorization failed|访问密钥.*(?:无效|失效)|认证失败/i.test(text)) status = 'auth_failed'
  else if (/tunnel not exists|tunnel offline|proxy not found|隧道不存在|隧道已被禁用/i.test(text)) status = 'tunnel_offline'
  else if (/start proxy (?:error|failed)|隧道启动失败/i.test(text)) status = 'error'
  else if (/\b(?:start )?proxy success\b|隧道启动成功/i.test(text)) status = 'running'

  // Accept addresses printed by frpc, never a local destination, timestamp or help URL.
  // 樱花穿透 frpc（0.51.x-sakura）输出常用「使用地址/访问方式/电信入口」等上下文，放宽匹配避免一直“等待服务返回地址”
  const contextual = /需要输\s*IP\s*[:：]\s*端口|远程地址|remote address|使用(?:下方)?地址|访问方式|连接地址|请使用.*地址|(?:电信|联通|移动)(?:入口)?\s*[:：]|tcp:\/\/|udp:\/\//i.test(text)
  const known = /(?:[\w-]+\.)*(?:natfrp\.cloud|nyatwork\.cn|frp-hub\.com|frp\.com|frp\.net)/i
  const candidates = [...text.matchAll(/(?:tcp:\/\/|udp:\/\/)?((?:[a-z0-9-]+\.)+[a-z0-9-]+|[a-z0-9-]+)\s*[:：]\s*(\d{1,5})(?!\d)/gi)]
    .map(m => ({ host: m[1], port: m[2], raw: m[0] }))
    .filter(c => !/^(?:127\.|0\.0\.0\.0$|localhost$)/.test(c.host) && Number(c.port) > 0 && Number(c.port) <= 65535)
    .filter(c => !/\.(?:go|ts|js|py|rs|c|cpp|java|rb|php|sh|json|log|txt)\s*[:：]\s*\d{1,5}$/i.test(c.raw))
  const match = candidates.find(c => known.test(c.host)) || (contextual ? (candidates.find(c => c.host.includes('.')) || candidates[0]) : null)
  return { status, address: match ? `${match.host}:${match.port}` : null,
    priority: /需要输\s*IP\s*[:：]\s*端口|远程地址|remote address|使用(?:下方)?地址|访问方式|(?:电信|联通|移动)(?:入口)?\s*[:：]/i.test(text) ? 2 : 1 }
}

/** Each pipe owns a decoder: UTF-8 characters and lines can cross chunk boundaries. */
export function frpLineReader(emit: (line: string) => void) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const drain = (text: string) => {
    pending += text
    let end: number
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, '')
      pending = pending.slice(end + 1)
      if (line.trim()) emit(line)
    }
  }
  return {
    write(chunk: Buffer | string) { drain(typeof chunk === 'string' ? chunk : decoder.write(chunk)) },
    end() { drain(decoder.end()); if (pending.trim()) emit(pending.replace(/\r$/, '')); pending = '' }
  }
}
