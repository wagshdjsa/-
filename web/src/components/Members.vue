<script setup>
import { computed } from 'vue'

const props = defineProps({
  peers: { type: Array, default: () => [] },
  me: { type: Object, required: true },
  status: { type: String, default: 'connecting' },
  latency: { type: Number, default: null }
})

// peers 里包含自己（awareness 会把本端状态也回传），需要排除
const others = computed(() => props.peers.filter((p) => p.id !== props.me.id))

const statusText = computed(() => ({
  connected: '已连接',
  connecting: '连接中',
  disconnected: '已断开',
  offline: '离线编辑中',
  reconnecting: '重连中',
  synced: '已同步',
  syncing: '同步中'
}[props.status] || props.status))

const statusClass = computed(() => {
  if (props.status === 'connected' || props.status === 'synced') return 'ok'
  if (props.status === 'offline') return 'warn'
  return 'busy'
})
</script>

<template>
  <div class="members">
    <span class="status" :class="statusClass">
      <i class="dot" />{{ statusText }}
      <em v-if="latency != null"> · {{ Math.round(latency) }}ms</em>
    </span>
    <div class="avatars">
      <div
        v-for="p in others"
        :key="p.clientId"
        class="avatar"
        :style="{ background: p.color }"
        :title="p.name"
      >{{ (p.name || '?').slice(0, 1) }}</div>
      <div class="avatar me" :style="{ background: me.color }" :title="me.name + '（我）'">
        {{ (me.name || '?').slice(0, 1) }}
      </div>
    </div>
    <span class="count">{{ others.length + 1 }} 人在线</span>
  </div>
</template>

<style scoped>
.members {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 13px;
}
.status { display: flex; align-items: center; gap: 6px; color: #5b6478; }
.status .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.status.ok .dot { background: #2fb96b; box-shadow: 0 0 0 3px rgba(47,185,107,.16); }
.status.warn .dot { background: #f5a623; box-shadow: 0 0 0 3px rgba(245,166,35,.16); }
.status.busy .dot { background: #f2545b; box-shadow: 0 0 0 3px rgba(242,84,91,.16); }
.status em { font-style: normal; color: #98a1b3; }
.avatars { display: flex; }
.avatar {
  width: 28px; height: 28px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 12px; font-weight: 600;
  border: 2px solid #fff; margin-left: -7px;
  box-shadow: 0 1px 4px rgba(0,0,0,.12);
}
.avatar:first-child { margin-left: 0; }
.avatar.me { outline: 2px solid #4f8cff; }
.count { color: #98a1b3; }
</style>