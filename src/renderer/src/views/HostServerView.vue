<script setup lang="ts">
// 在线服务器：自建常驻服独立板块
import { computed, onMounted, onBeforeUnmount, reactive, ref, nextTick } from 'vue'
import {
  copyText,
  errText,
  listHostServers,
  createHostServer,
  startHostServer,
  stopHostServer,
  hostServerStatus,
  deleteHostServer,
  uploadHostServerDatapack,
  uploadHostServerMod,
  onHostServerProgress,
  openHostServerFolder,
  sendHostCommand,
  getManifest
} from '../api'
import { toast } from '../store'
import type { HostServerRecord, HostServerStatus, HostServerCreateInput, HostServerType, RemoteVersion } from '@shared/types'

const hostServers = ref<HostServerRecord[]>([])
const hostStatus = reactive<Record<string, HostServerStatus>>({})
const hostBusy = ref('')
const hostCreate = reactive({ open: false, busy: false, error: '', name: '', mcVersion: '', type: 'datapack' as HostServerType, port: 25565, ramMb: 2048, autoResume: true, onlineMode: false, progressLabel: '', progressPercent: 0 })
let offHostProgress: (() => void) | null = null
function onHostCreateProgress(r: { label: string; percent: number }) {
  hostCreate.progressLabel = r.label
  hostCreate.progressPercent = Math.max(0, Math.min(100, r.percent))
}
const hostCreateBusyText = computed(() => {
  if (!hostCreate.busy) return '创建并启动'
  if (hostCreate.progressLabel) return `${hostCreate.progressLabel} ${hostCreate.progressPercent}%`
  return '创建中…'
})
const hostVersions = ref<RemoteVersion[]>([])
const hostLogOpen = ref<Record<string, boolean>>({})
const hostConsole = ref<Record<string, { open: boolean; command: string; sending: boolean }>>({})
function consoleOf(id: string) { return (hostConsole.value[id] ??= { open: false, command: '', sending: false }) }
async function onHostConsoleOpen(id: string) {
  consoleOf(id).open = true
  try { await refreshHostStatuses() } catch { /* 忽略 */ }
}
async function onHostConsoleSend(id: string) {
  const c = consoleOf(id)
  const cmd = c.command.trim()
  if (!cmd) { toast('请输入命令，如 /op 玩家名', 'error'); return }
  c.sending = true
  try {
    await sendHostCommand(id, cmd)
    c.command = ''
    toast('命令已发送', 'success')
    setTimeout(() => { void refreshHostStatuses() }, 800)
  } catch (e) {
    toast('命令发送失败：' + errText(e), 'error')
  } finally { c.sending = false }
}
const hostLoaded = ref(false)
const hostUploadBusy = ref('')
let pollTimer: ReturnType<typeof setInterval> | undefined

async function loadHostServers() {
  try {
    hostServers.value = await listHostServers()
    hostLoaded.value = true
    refreshHostStatuses()
  } catch { /* 静默 */ }
}
async function refreshHostStatuses() {
  for (const s of hostServers.value) {
    try { hostStatus[s.id] = await hostServerStatus(s.id) } catch { /* 忽略 */ }
  }
}
const hostNameInput = ref<HTMLInputElement | null>(null)
async function openHostCreate() {
  hostCreate.error = ''
  if (!hostVersions.value.length) {
    try { hostVersions.value = (await getManifest()).filter((v) => v.type === 'release').slice(0, 30) } catch { hostCreate.error = '读取版本列表失败' }
  }
  hostCreate.mcVersion = hostCreate.mcVersion || hostVersions.value[0]?.id || ''
  hostCreate.open = true
  await nextTick()
  try { hostNameInput.value?.focus() } catch { /* 聚焦失败不影响 */ }
}
async function onHostCreate() {
  hostCreate.busy = true
  hostCreate.error = ''
  hostCreate.progressLabel = ''
  hostCreate.progressPercent = 0
  if (!offHostProgress) offHostProgress = onHostServerProgress(onHostCreateProgress)
  try {
    const input: HostServerCreateInput = {
      name: hostCreate.name,
      mcVersion: hostCreate.mcVersion,
      type: hostCreate.type,
      port: hostCreate.port,
      ramMb: hostCreate.ramMb,
      autoResume: hostCreate.autoResume,
      onlineMode: hostCreate.onlineMode
    }
    await createHostServer(input)
    hostServers.value = await listHostServers()
    hostCreate.open = false
    hostCreate.name = ''
    toast('服务器已创建，正在启动…', 'success')
    const created = hostServers.value[hostServers.value.length - 1]
    if (created) await onHostStart(created.id)
  } catch (e) {
    hostCreate.error = errText(e)
  } finally {
    hostCreate.busy = false
    hostCreate.progressLabel = ''
    if (offHostProgress) { offHostProgress(); offHostProgress = null }
  }
}
async function onHostStart(id: string) {
  hostBusy.value = id
  try {
    hostStatus[id] = await startHostServer(id)
    toast(hostStatus[id]?.online ? '服务器已就绪，可以加入' : '服务器进程已启动，等待就绪…', 'info')
  } catch (e) {
    toast('启动失败：' + errText(e), 'error')
  } finally {
    hostBusy.value = ''
  }
}
async function onHostStop(id: string) {
  hostBusy.value = id
  try {
    await stopHostServer(id)
    const st = await hostServerStatus(id)
    hostStatus[id] = { ...st, running: false, online: false }
    toast('服务器已停止', 'info')
  } catch (e) {
    toast('停止失败：' + errText(e), 'error')
  } finally {
    hostBusy.value = ''
  }
}
async function onHostDelete(id: string) {
  if (!confirm('确定删除该服务器吗？服务器目录（世界存档）会一并删除。')) return
  try {
    await deleteHostServer(id)
    hostServers.value = hostServers.value.filter((s) => s.id !== id)
    delete hostStatus[id]
    toast('服务器已删除', 'success')
  } catch (e) {
    toast('删除失败：' + errText(e), 'error')
  }
}
async function copyHostAddress(id: string) {
  const st = hostStatus[id]
  // 已公开穿透时优先复制公网地址（好友可直接全网加入），否则复制局域网地址
  const frp = frpStateOf(id).remoteAddress
  if (frp) { try { toast(await copyText(frp) ? '公网地址已复制，发给好友即可全网联机' : '复制失败', 'info') } catch (e) { toast('复制失败：' + errText(e), 'error') } return }
  if (!st?.address) return
  try { toast(await copyText(st.address) ? '局域网地址已复制，发给同一网络的好友' : '复制失败', 'info') }
  catch (e) { toast('复制失败：' + errText(e), 'error') }
}
async function copyLocalAddress(id: string) {
  const st = hostStatus[id]
  if (!st?.address) return
  try { toast(await copyText(st.address) ? '局域网地址已复制，发给同一网络的好友' : '复制失败', 'info') }
  catch (e) { toast('复制失败：' + errText(e), 'error') }
}
async function onHostUploadDatapack(id: string) {
  hostUploadBusy.value = id
  try {
    const name = await uploadHostServerDatapack(id)
    if (name) toast(`数据包「${name}」已装入，新世界会自动加载；已生成的世界请先备份存档再使用 /reload 或重启服务器生效`, 'success')
  } catch (e) {
    toast('上传数据包失败：' + errText(e), 'error')
  } finally {
    hostUploadBusy.value = ''
  }
}
async function onHostOpenFolder(id: string) {
  try { await openHostServerFolder(id) }
  catch (e) { toast('打开文件夹失败：' + errText(e), 'error') }
}
async function onHostUploadMod(id: string) {
  hostUploadBusy.value = id
  try {
    const name = await uploadHostServerMod(id)
    if (name) toast(`模组「${name}」已装入，重启服务器后生效`, 'success')
  } catch (e) {
    toast('上传模组失败：' + errText(e), 'error')
  } finally {
    hostUploadBusy.value = ''
  }
}
const hostTypeText = (s: HostServerRecord) => (s.type === 'modded' ? '模组服务器 · Fabric' : '数据包服务器 · 原版')
const hostTypeHint = (s: HostServerRecord) =>
  s.type === 'modded'
    ? '模组装入 mods 目录，重启服务器生效；数据包服务器需要把数据包放进世界 datapacks 目录'
    : '数据包装入世界 datapacks 目录，新世界自动加载'
const hostStateText = (s: HostServerRecord) => {
  const st = hostStatus[s.id]
  if (st?.online) return '在线'
  if (st?.running) return '启动中'
  return '已停止'
}
const hostStateClass = (s: HostServerRecord) => {
  const st = hostStatus[s.id]
  if (st?.online) return 'host-online'
  if (st?.running) return 'host-booting'
  return 'host-off'
}
const onlineCount = computed(() => hostServers.value.filter((s) => hostStatus[s.id]?.online).length)

// ===== 一键樱花穿透（公网公开服务器） =====
interface FrpServerState { busy: boolean; status: string; remoteAddress: string | null; error: string }
const frpByServer = reactive<Record<string, FrpServerState>>({})
const frpKeyModal = ref(false)
const frpKeyTarget = ref('')
const frpKeyInput = ref('')
function frpStateOf(id: string): FrpServerState { return (frpByServer[id] ??= { busy: false, status: 'idle', remoteAddress: null, error: '' }) }
const frpActive = (s: HostServerRecord) => frpStateOf(s.id).status === 'running' || frpStateOf(s.id).status === 'starting'
function frpTunnelOf(tunnels: Array<{ config?: { localPort?: number }; status?: string; remoteAddress?: string | null; message?: string }>, port: number) {
  return (tunnels || []).find((x) => x.config?.localPort === port)
}
async function refreshFrpForServers() {
  try {
    const status = await kamucl.invoke('frp:status') as { tunnels: Array<{ config?: { localPort?: number }; status?: string; remoteAddress?: string | null; message?: string }> }
    for (const s of hostServers.value) {
      const t = frpTunnelOf(status.tunnels || [], s.port)
      const st = frpStateOf(s.id)
      if (t) {
        st.status = t.status || 'idle'
        st.remoteAddress = t.remoteAddress || null
        st.error = (t.status && !['running', 'starting', 'idle', 'stopped'].includes(t.status)) ? (t.message || '连接异常') : ''
      } else {
        st.status = 'idle'; st.remoteAddress = null; st.error = ''
      }
    }
  } catch { /* 忽略 */ }
}
async function onHostFrp(s: HostServerRecord) {
  const st = frpStateOf(s.id)
  if (st.busy) return
  st.busy = true; st.error = ''
  try {
    const status = await kamucl.invoke('frp:status') as { accessKey: string; tunnels: Array<{ id: string; config?: { localPort?: number }; name?: string; status?: string; remoteAddress?: string | null; message?: string }> }
    let key = status.accessKey
    if (!key) {
      frpKeyTarget.value = s.id
      frpKeyInput.value = ''
      frpKeyModal.value = true
      return
    }
    let t = frpTunnelOf(status.tunnels || [], s.port)
    let justCreated = false
    if (!t) {
      justCreated = true
      const nodesRes = await kamucl.invoke('frp:nodes', { accessKey: key }) as { nodes?: Array<{ id: number; free: boolean; online: boolean; canCreate: boolean }> }
      const nodes = nodesRes.nodes || []
      const node = nodes.find((n) => n.free && n.online && n.canCreate) || nodes.find((n) => n.online && n.canCreate)
      if (!node) throw new Error('没有可用节点，请稍后再试或到「联机」页手动创建')
      await kamucl.invoke('frp:create-tunnel', { accessKey: key, tunnel: { name: `MC-Launcher-${s.name}-${s.port}`, node: node.id, localPort: s.port } })
      const after = await kamucl.invoke('frp:nodes', { accessKey: key }) as { tunnels?: Array<{ id: string; config?: { localPort?: number }; name?: string }> }
      t = (after.tunnels || []).find((x) => x.config?.localPort === s.port)
    }
    if (!t?.id) throw new Error('隧道创建后未找到，请到「联机」页检查')
    // 新建隧道需等待樱花平台生效，稍候再启动，避免 frpc 立即启动连不上
    if (justCreated) await new Promise((r) => setTimeout(r, 1200))
    await kamucl.invoke('frp:start', { id: t.id })
    toast('已启动樱花穿透，正在连接公网…', 'info')
    // 快速轮询拿公网地址（frpc 建立隧道通常 1~3 秒）
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 800))
      await refreshFrpForServers()
      if (frpStateOf(s.id).remoteAddress) break
    }
  } catch (e) {
    st.error = errText(e)
    toast('樱花穿透失败：' + st.error, 'error')
  } finally {
    st.busy = false
    await refreshFrpForServers()
  }
}
async function onHostFrpStop(s: HostServerRecord) {
  const st = frpStateOf(s.id)
  if (st.busy) return
  st.busy = true
  try {
    const status = await kamucl.invoke('frp:status') as { tunnels: Array<{ id: string; config?: { localPort?: number } }> }
    const t = frpTunnelOf(status.tunnels || [], s.port)
    if (t?.id) await kamucl.invoke('frp:stop', { id: t.id })
    st.status = 'stopped'; st.remoteAddress = null; st.error = ''
    toast('已停止樱花穿透', 'success')
  } catch (e) {
    toast('停止穿透失败：' + errText(e), 'error')
  } finally {
    st.busy = false
    await refreshFrpForServers()
  }
}
async function copyFrpAddress(s: HostServerRecord) {
  const addr = frpStateOf(s.id).remoteAddress
  if (!addr) return
  try { toast(await copyText(addr) ? '公网地址已复制，发给好友即可全网联机' : '复制失败', 'info') }
  catch (e) { toast('复制失败：' + errText(e), 'error') }
}
async function saveFrpKey() {
  const key = frpKeyInput.value.trim()
  if (!key) { toast('请粘贴访问密钥', 'error'); return }
  try {
    await kamucl.invoke('frp:nodes', { accessKey: key, refresh: true })
    await kamucl.invoke('frp:save-key', { accessKey: key })
    toast('密钥已保存并记住，以后无需再输入，正在公开服务器…', 'info')
    frpKeyModal.value = false
    const target = hostServers.value.find((x) => x.id === frpKeyTarget.value)
    if (target) await onHostFrp(target)
  } catch (e) {
    toast('密钥校验失败：' + errText(e), 'error')
  }
}
let offFrpEvent: (() => void) | undefined
let frpPollTimer: ReturnType<typeof setInterval> | undefined

// 进入页面自动读取已保存密钥对应的隧道与节点，穿透状态直接可见，不再弹出密钥输入框
async function autoLoadFrpState() {
  try {
    const status = await kamucl.invoke('frp:status') as { accessKey?: string }
    if (status?.accessKey) {
      await kamucl.invoke('frp:nodes', { accessKey: status.accessKey })
    }
  } catch { /* 网络异常静默，轮询会继续兜底 */ }
  await refreshFrpForServers()
}

onMounted(() => {
  void loadHostServers()
  pollTimer = setInterval(() => { void refreshHostStatuses() }, 8000)
  offFrpEvent = kamucl.on('frp:event', () => { void refreshFrpForServers() })
  frpPollTimer = setInterval(() => { void refreshFrpForServers() }, 6000)
  void autoLoadFrpState()
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (frpPollTimer) clearInterval(frpPollTimer)
  offFrpEvent?.()
})
</script>

<template>
  <div class="connect-page host-page">
    <header class="connection-header">
      <div><h1>在线服务器 <small>{{ hostServers.length }} 个 · {{ onlineCount }} 个在线</small></h1></div>
      <button class="btn btn-gold" @click="openHostCreate()"><span aria-hidden="true">＋</span> 创建服务器</button>
    </header>
    <p class="connection-muted host-intro">自建常驻服务器：数据包服务器（原版）或模组服务器（Fabric），后台一直运行（关闭启动器也不停），地址发给好友即可加入。</p>

    <div v-if="!hostLoaded" class="connection-panel host-empty">正在读取服务器…</div>
    <div v-else-if="!hostServers.length" class="connection-panel host-empty host-empty-card">
      <span class="connection-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="8" rx="2"/><rect x="2" y="12" width="20" height="8" rx="2"/><path d="M6 8h.01M6 16h.01M14 8h4M14 16h4"/></svg></span>
      <h3>开一个一直在线等好友的服务器</h3>
      <p>选择正式版版本，自动下载服务端（数据包服务器为原版、模组服务器为 Fabric）；启动后后台常驻，即使关闭启动器也继续运行。</p>
      <button class="btn btn-gold" @click="openHostCreate()">创建第一个服务器</button>
    </div>
    <div v-else class="host-server-list">
      <div v-for="s in hostServers" :key="s.id" class="host-server-card">
        <div class="host-card-main">
          <span class="host-state" :class="hostStateClass(s)"><i aria-hidden="true"></i>{{ hostStateText(s) }}</span>
          <div class="host-card-info">
            <strong>{{ s.name }} <span class="host-type-tag">{{ hostTypeText(s) }}</span></strong>
            <span class="muted host-meta">{{ s.mcVersion }} · 端口 {{ s.port }} · {{ s.ramMb }}M · {{ s.autoResume ? '自动拉起' : '手动启动' }}</span>
          </div>
          <div class="host-card-actions">
            <button v-if="s.type === 'datapack'" class="btn btn-ghost btn-sm" :disabled="hostUploadBusy === s.id" @click="onHostUploadDatapack(s.id)">上传数据包</button>
            <button v-else class="btn btn-ghost btn-sm" :disabled="hostUploadBusy === s.id" @click="onHostUploadMod(s.id)">上传模组</button>
            <button class="btn btn-ghost btn-sm" @click="onHostOpenFolder(s.id)">打开文件夹</button>
            <button class="btn btn-ghost btn-sm" :disabled="hostBusy === s.id" @click="copyHostAddress(s.id)">复制地址</button>
            <button class="btn btn-gold btn-sm host-frp-btn" :class="{ 'frp-stop': frpActive(s) }" :disabled="frpStateOf(s.id).busy || hostBusy === s.id" @click="frpActive(s) ? onHostFrpStop(s) : onHostFrp(s)">{{ frpStateOf(s.id).busy ? '穿透中…' : (frpActive(s) ? '停止穿透' : '樱花公开') }}</button>
            <button v-if="!hostStatus[s.id]?.running" class="btn btn-gold btn-sm" :disabled="hostBusy === s.id" @click="onHostStart(s.id)">启动</button>
            <button v-else class="btn btn-danger btn-sm" :disabled="hostBusy === s.id" @click="onHostStop(s.id)">停止</button>
            <button class="btn btn-ghost btn-sm" @click="onHostConsoleOpen(s.id)">控制台</button>
            <button class="btn btn-ghost btn-sm" @click="hostLogOpen[s.id] = !hostLogOpen[s.id]">{{ hostLogOpen[s.id] ? '收起日志' : '日志' }}</button>
            <button class="btn btn-ghost btn-sm host-del" @click="onHostDelete(s.id)">删除</button>
          </div>
        </div>
        <div v-if="hostStatus[s.id]?.address" class="host-address">局域网加入地址：<code>{{ hostStatus[s.id]?.address }}</code><button class="btn btn-ghost btn-sm" :disabled="hostBusy === s.id" @click="copyLocalAddress(s.id)">复制本地</button><span class="muted">（同一网络的好友可加入）</span></div>
        <div v-if="frpActive(s) && frpStateOf(s.id).remoteAddress" class="host-address host-frp-address">公网加入地址：<code>{{ frpStateOf(s.id).remoteAddress }}</code><button class="btn btn-ghost btn-sm" :disabled="frpStateOf(s.id).busy" @click="copyFrpAddress(s)">复制</button><span class="muted">（发给好友即可全网联机）</span></div>
        <p v-if="frpStateOf(s.id).error" class="host-frp-error">{{ frpStateOf(s.id).error }}</p>
        <p v-if="hostStatus[s.id]?.online && hostStatus[s.id]?.players" class="host-players muted">当前在线 {{ hostStatus[s.id]?.players }} 人</p>
        <p class="muted host-type-hint">{{ hostTypeHint(s) }}</p>
        <pre v-if="hostLogOpen[s.id]" class="host-log">{{ hostStatus[s.id]?.logTail || '暂无日志' }}</pre>
        <Teleport to="body">
          <div v-if="consoleOf(s.id).open" class="modal-mask connection-modal" @pointerdown.self="consoleOf(s.id).open = false">
            <div class="modal host-console-modal" role="dialog" aria-modal="true" aria-label="服务器控制台">
              <h3 class="modal-title">服务器控制台 · {{ s.name }}</h3>
              <p class="connection-muted">输入服务端命令并回车执行。给玩家 OP：输入 <code>/op 玩家名</code>；常用：<code>/gamemode creative 玩家名</code>、<code>/give 玩家名 minecraft:diamond 64</code>、<code>/say 你好</code>。</p>
              <pre class="host-log">{{ hostStatus[s.id]?.logTail || '暂无日志' }}</pre>
              <div class="host-console-input">
                <input v-model="consoleOf(s.id).command" class="input mono" spellcheck="false" placeholder="/op 玩家名" maxlength="200" @keydown.enter.prevent="onHostConsoleSend(s.id)" />
                <button class="btn btn-gold" :disabled="consoleOf(s.id).sending" @click="onHostConsoleSend(s.id)">{{ consoleOf(s.id).sending ? '发送中…' : '发送' }}</button>
              </div>
              <div class="modal-actions"><button class="btn btn-ghost" @click="consoleOf(s.id).open = false">关闭</button></div>
            </div>
          </div>
        </Teleport>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="hostCreate.open" class="modal-mask connection-modal" @pointerdown.self="!hostCreate.busy && (hostCreate.open = false)">
        <div class="modal" role="dialog" aria-modal="true" aria-label="创建在线服务器">
          <h3 class="modal-title">创建在线服务器</h3><p class="connection-muted">自动下载服务端并后台常驻运行，关闭启动器也不会停；地址发给好友即可加入。</p><p v-if="hostCreate.error" class="connection-error" role="alert">{{ hostCreate.error }}</p>
          <label for="host-server-name" class="modal-label">服务器名称</label>
          <input id="host-server-name" ref="hostNameInput" v-model="hostCreate.name" class="input" placeholder="例如：我的生存服" maxlength="40" autocomplete="off" spellcheck="false" />
          <label class="modal-label">服务器类型</label>
          <div class="host-type-picker">
            <label class="host-type-option" :class="{ 'host-type-active': hostCreate.type === 'datapack' }">
              <input type="radio" value="datapack" v-model="hostCreate.type" />
              <span class="host-type-name">数据包服务器</span>
              <span class="muted host-type-desc">原版服务端，可装入数据包（.zip）</span>
            </label>
            <label class="host-type-option" :class="{ 'host-type-active': hostCreate.type === 'modded' }">
              <input type="radio" value="modded" v-model="hostCreate.type" />
              <span class="host-type-name">模组服务器</span>
              <span class="muted host-type-desc">Fabric 服务端，可装入模组（.jar）</span>
            </label>
          </div>
          <label for="host-server-version" class="modal-label">游戏版本（正式版）</label>
          <select id="host-server-version" v-model="hostCreate.mcVersion" class="select">
            <option v-for="v in hostVersions" :key="v.id" :value="v.id">{{ v.id }}</option>
          </select>
          <div class="host-form-row">
            <div><label for="host-server-port" class="modal-label">端口</label><input id="host-server-port" v-model.number="hostCreate.port" type="number" class="input" min="1" max="65535" /></div>
            <div><label for="host-server-ram" class="modal-label">内存（MB）</label><input id="host-server-ram" v-model.number="hostCreate.ramMb" type="number" class="input" min="512" max="16384" step="256" /></div>
          </div>
          <label class="modal-check"><input type="checkbox" v-model="hostCreate.autoResume" /> 启动器每次打开时自动拉起（一直开）</label>
          <label class="modal-check"><input type="checkbox" v-model="hostCreate.onlineMode" /> 开启正版验证（online-mode，离线皮肤玩家无法加入）</label>
          <div class="modal-actions">
            <button class="btn btn-ghost" :disabled="hostCreate.busy" @click="hostCreate.open = false">取消</button>
            <button class="btn btn-gold" :disabled="hostCreate.busy || !hostCreate.name.trim() || !hostCreate.mcVersion" @click="onHostCreate">
              {{ hostCreateBusyText }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
    <Teleport to="body">
      <div v-if="frpKeyModal" class="modal-mask connection-modal" @pointerdown.self="frpKeyModal = false">
        <div class="modal" role="dialog" aria-modal="true" aria-label="填写樱花穿透访问密钥">
          <h3 class="modal-title">樱花穿透访问密钥</h3>
          <p class="connection-muted">首次「樱花公开」需要访问密钥：登录 <code>natfrp.com</code> → 用户信息页复制访问密钥粘贴到下面，之后自动记住，可直接一键公开。</p>
          <input v-model="frpKeyInput" class="input" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴 natfrp.com 的访问密钥" @keydown.enter.prevent="saveFrpKey()" />
          <div class="modal-actions">
            <button class="btn btn-ghost" @click="frpKeyModal = false">取消</button>
            <button class="btn btn-gold" :disabled="!frpKeyInput.trim()" @click="saveFrpKey()">保存并公开</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.host-page { display:flex; flex-direction:column; gap:16px; padding:20px; }
.host-page .connection-header { margin:0; padding:0; }
.host-page .connection-header h1 small { font-size:12px; font-weight:400; color:var(--text-dim); margin-left:12px; }
.host-intro { margin:0; }
.host-empty-card { text-align:center; padding:40px 24px; }
.host-empty-card .connection-symbol { width: 28px; height: 28px; }
.host-empty-card .connection-symbol svg { width: 18px; height: 18px; }
.host-empty-card h3 { margin:14px 0 8px; }
.host-empty-card p { max-width:420px; margin:0 auto 18px; line-height:1.7; }
.host-server-list { display:flex; flex-direction:column; gap:12px; }
.host-server-card { border:1px solid var(--border); border-radius:var(--radius-md); padding:14px 16px; background:var(--surface-content); }
.host-card-main { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.host-state { display:inline-flex; align-items:center; gap:6px; font-size:12px; min-width:58px; }
.host-state i { width:8px; height:8px; border-radius:50%; background:currentColor; }
.host-online { color:var(--success, #4ade80); }
.host-booting { color:var(--accent-2); }
.host-off { color:var(--text-dim); }
.host-card-info { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }
.host-meta { font-size:12px; }
.host-card-actions { display:flex; gap:8px; flex-wrap:wrap; }
.host-del { color:var(--danger); }
.host-frp-btn.frp-stop { background:var(--danger); border-color:var(--danger); color:#fff; }
.host-frp-address { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.host-frp-address code { background:var(--accent-soft, #1e3a2f); color:var(--accent); }
.host-frp-error { margin:6px 0 0; font-size:12px; color:var(--danger); }
.host-address { margin:10px 0 0; font-size:13px; }
.host-address code { padding:2px 8px; border-radius:6px; background:var(--hover); font-size:13px; }
.host-players { margin:4px 0 0; font-size:12px; }
.host-log { margin:10px 0 0; max-height:200px; overflow:auto; padding:10px; border-radius:8px; background:var(--bg-2, #00000066); font-size:12px; line-height:1.6; white-space:pre-wrap; word-break:break-all; }
.host-console-modal { width:min(640px, calc(100vw - 32px)); }
.host-console-modal .host-log { max-height:300px; margin:10px 0; }
.host-console-input { display:flex; gap:8px; }
.host-console-input .input { flex:1; }
.host-console-input .btn { flex:none; }
.host-console-modal code { padding:1px 6px; border-radius:4px; background:var(--hover); font-size:12px; }
.host-form-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.host-type-picker { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.host-type-option { display:flex; flex-direction:column; gap:4px; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius-md); cursor:pointer; transition:border-color .15s, background .15s; }
input[id^="host-server-"], .connection-modal input { user-select: text; -webkit-user-select: text; }
.host-type-option input { position:absolute; opacity:0; pointer-events:none; }
.host-type-option.host-type-active { border-color:var(--accent); background:var(--hover); }
.host-type-name { font-size:14px; font-weight:700; }
.host-type-desc { font-size:12px; line-height:1.5; }
.host-type-tag { font-size:11px; font-weight:400; color:var(--accent); border:1px solid var(--border); border-radius:999px; padding:1px 8px; margin-left:6px; vertical-align:2px; }
.host-type-hint { margin:6px 0 0; font-size:12px; }
.modal-check { display:flex; align-items:center; gap:8px; margin:10px 0 0; font-size:13px; color:var(--text-dim); cursor:pointer; }
.modal-check input { width:16px; height:16px; accent-color:var(--accent); }
</style>
