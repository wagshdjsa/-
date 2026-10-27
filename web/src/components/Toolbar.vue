<script setup>
import { computed } from 'vue'

const props = defineProps({
  modelValue: { type: String, required: true },
  color: { type: String, default: '#1f2430' },
  width: { type: Number, default: 3 },
  stats: { type: Object, default: () => ({}) }
})
const emit = defineEmits([
  'update:modelValue',
  'update:color',
  'update:width',
  'clear', 'export', 'import', 'replay'
])

const tools = [
  { key: 'pen', label: '画笔', icon: '✎' },
  { key: 'line', label: '直线', icon: '╱' },
  { key: 'rect', label: '矩形', icon: '▭' },
  { key: 'ellipse', label: '椭圆', icon: '◯' },
  { key: 'eraser', label: '橡皮', icon: '⌫' },
  { key: 'text', label: '文字', icon: 'T' }
]

const palette = ['#1f2430', '#4f8cff', '#f2545b', '#2fb96b', '#f5a623', '#9b59f6', '#00b8c4']
const widths = [2, 3, 5, 9]

const cur = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})
</script>

<template>
  <aside class="toolbar">
    <div class="group">
      <div class="title">工具</div>
      <button
        v-for="t in tools" :key="t.key"
        class="tool" :class="{ active: cur === t.key }"
        :title="t.label"
        @click="cur = t.key"
      >{{ t.icon }}<span>{{ t.label }}</span></button>
    </div>

    <div class="group">
      <div class="title">颜色</div>
      <div class="colors">
        <button
          v-for="c in palette" :key="c"
          class="swatch" :class="{ active: color === c }"
          :style="{ background: c }"
          @click="emit('update:color', c)"
        />
      </div>
    </div>

    <div class="group">
      <div class="title">粗细</div>
      <div class="widths">
        <button
          v-for="w in widths" :key="w"
          class="dot-btn" :class="{ active: width === w }"
          @click="emit('update:width', w)"
        ><i :style="{ width: w + 2 + 'px', height: w + 2 + 'px' }" /></button>
      </div>
    </div>

    <div class="group">
      <div class="title">协作</div>
      <button class="act" @click="emit('replay')">历史回放</button>
      <button class="act" @click="emit('export')">导出快照</button>
      <button class="act" @click="emit('import')">导入合并</button>
      <button class="act danger" @click="emit('clear')">清空画板</button>
    </div>

    <div v-if="stats.offlineEdits" class="offline-tip">
      离线中已缓存 <b>{{ stats.offlineEdits }}</b> 次编辑，联网后自动合并
    </div>
  </aside>
</template>

<style scoped>
.toolbar {
  width: 156px; flex-shrink: 0;
  background: #fff; border-right: 1px solid #e8eaf0;
  padding: 14px 12px; display: flex; flex-direction: column; gap: 20px;
  overflow-y: auto;
}
.title {
  font-size: 11px; color: #98a1b3; text-transform: uppercase;
  letter-spacing: .08em; margin-bottom: 8px; font-weight: 600;
}
.tool {
  display: flex; align-items: center; gap: 9px; width: 100%;
  padding: 8px 10px; margin-bottom: 4px;
  border: 1px solid transparent; border-radius: 8px;
  background: transparent; cursor: pointer; font-size: 13px; color: #3c465a;
  transition: all .12s;
}
.tool:hover { background: #f4f6fa; }
.tool.active { background: #eaf1ff; border-color: #bed4ff; color: #2b6cff; font-weight: 600; }
.tool span { font-size: 12px; }
.colors { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.swatch {
  width: 100%; aspect-ratio: 1; border-radius: 6px; cursor: pointer;
  border: 2px solid transparent; transition: transform .1s;
}
.swatch:hover { transform: scale(1.12); }
.swatch.active { border-color: #1f2430; box-shadow: 0 0 0 2px #fff inset; }
.widths { display: flex; gap: 6px; }
.dot-btn {
  flex: 1; height: 30px; display: flex; align-items: center; justify-content: center;
  border: 1px solid #e8eaf0; background: #fff; border-radius: 7px; cursor: pointer;
}
.dot-btn.active { border-color: #4f8cff; background: #eaf1ff; }
.dot-btn i { display: block; border-radius: 50%; background: #3c465a; }
.act {
  display: block; width: 100%; padding: 8px; margin-bottom: 6px;
  border: 1px solid #e8eaf0; background: #fff; border-radius: 8px;
  cursor: pointer; font-size: 12px; color: #3c465a; transition: all .12s;
}
.act:hover { border-color: #bed4ff; color: #2b6cff; background: #f7faff; }
.act.danger:hover { border-color: #ffc9cc; color: #f2545b; background: #fff7f7; }
.offline-tip {
  font-size: 11px; color: #a86a10; background: #fff7e8;
  border: 1px solid #ffe4b5; border-radius: 8px; padding: 8px; line-height: 1.5;
}
</style>