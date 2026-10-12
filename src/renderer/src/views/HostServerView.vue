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
  if (!st?.address) return
  try { toast(await copyText(st.address) ? '地址已复制，发给好友即可加入（同一网络）' : '复制失败', 'info') }
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

onMounted(() => {
  void loadHostServers()
  pollTimer = setInterval(() => { void refreshHostStatuses() }, 8000)
})
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })
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
            <button v-if="!hostStatus[s.id]?.running" class="btn btn-gold btn-sm" :disabled="hostBusy === s.id" @click="onHostStart(s.id)">启动</button>
            <button v-else class="btn btn-danger btn-sm" :disabled="hostBusy === s.id" @click="onHostStop(s.id)">停止</button>
            <button class="btn btn-ghost btn-sm" @click="hostLogOpen[s.id] = !hostLogOpen[s.id]">{{ hostLogOpen[s.id] ? '收起日志' : '日志' }}</button>
            <button class="btn btn-ghost btn-sm host-del" @click="onHostDelete(s.id)">删除</button>
          </div>
        </div>
        <div v-if="hostStatus[s.id]?.address" class="host-address">加入地址：<code>{{ hostStatus[s.id]?.address }}</code><span class="muted">（同一网络的好友可加入；公网联机可在「联机」页配置樱花穿透）</span></div>
        <p v-if="hostStatus[s.id]?.online && hostStatus[s.id]?.players" class="host-players muted">当前在线 {{ hostStatus[s.id]?.players }} 人</p>
        <p class="muted host-type-hint">{{ hostTypeHint(s) }}</p>
        <pre v-if="hostLogOpen[s.id]" class="host-log">{{ hostStatus[s.id]?.logTail || '暂无日志' }}</pre>
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
.host-address { margin:10px 0 0; font-size:13px; }
.host-address code { padding:2px 8px; border-radius:6px; background:var(--hover); font-size:13px; }
.host-players { margin:4px 0 0; font-size:12px; }
.host-log { margin:10px 0 0; max-height:200px; overflow:auto; padding:10px; border-radius:8px; background:var(--bg-2, #00000066); font-size:12px; line-height:1.6; white-space:pre-wrap; word-break:break-all; }
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
