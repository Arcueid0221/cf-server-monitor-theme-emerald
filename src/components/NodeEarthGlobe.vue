<script setup lang="ts">
import type { Arc, COBEOptions, Globe, Marker } from 'cobe'
import type { ComponentPublicInstance } from 'vue'
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import {
  useDocumentVisibility,
  useElementSize,
  useElementVisibility,
  useRafFn,
} from '@vueuse/core'
import createGlobe from 'cobe'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { getApiAssetUrl } from '@/utils/api'
import { getCoordByCode, resolveNodeLocation } from '@/utils/geoHelper'
import { formatBytesPerSecondSplit } from '@/utils/helper'

const props = defineProps<{
  nodes?: NodeData[]
}>()

const appStore = useAppStore()
const nodesStore = useNodesStore()

const displayNodes = computed(() => props.nodes ?? nodesStore.earthNodes)

const containerRef = ref<HTMLDivElement>()
const canvasRef = ref<HTMLCanvasElement>()
const { width: containerWidth, height: containerHeight } = useElementSize(containerRef)

const documentVisibility = useDocumentVisibility()
const elementVisible = useElementVisibility(containerRef)
const shouldRender = computed(() => documentVisibility.value === 'visible' && elementVisible.value)
const shouldAutoRotate = computed(() => appStore.earthViewMode !== 'earth-stop')

let globe: Globe | null = null
const INITIAL_THETA = 0.22
/** 不缩放时上下倾斜的上限（约 37°）；放大到最大时放宽到 ZOOMED_MAX_THETA（约 60°），方便把高纬度地区转到正中 */
const BASE_MAX_THETA = 0.65
const ZOOMED_MAX_THETA = 1.05
const CHINA_COORD = getCoordByCode('CN') ?? [35.8617, 104.1954]
const DEFAULT_PHI = normalizePhi(-Math.PI / 2 - CHINA_COORD[1] * Math.PI / 180)
const GLOBE_RADIUS = 0.8
const MARKER_ELEVATION = 0
// 缩放：cobe 的 scale 参数放大地球本身，超出画布的部分被裁掉；标签投影用同一个倍数
const MIN_ZOOM = 1
const MAX_ZOOM = 4
const ZOOM_BUTTON_STEP = 1.5
const WHEEL_ZOOM_SENSITIVITY = 0.01
const zoom = ref(MIN_ZOOM)
let phi = DEFAULT_PHI
let targetPhi = phi
let theta = INITIAL_THETA
let targetTheta = INITIAL_THETA
let isPointerDown = false
let lastPointerX = 0
let lastPointerY = 0
let staticRedrawUntil = 0
// 双指捏合：记录每个触点的位置，两指时按距离变化缩放
const activePointers = new Map<number, { x: number, y: number }>()
let pinchStartDistance = 0
let pinchStartZoom = MIN_ZOOM

function normalizePhi(value: number): number {
  const circle = Math.PI * 2
  let next = value % circle
  if (next <= -Math.PI)
    next += circle
  if (next > Math.PI)
    next -= circle
  return next
}

function maxThetaForZoom(level: number): number {
  const t = (level - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)
  return BASE_MAX_THETA + (ZOOMED_MAX_THETA - BASE_MAX_THETA) * Math.min(Math.max(t, 0), 1)
}

function clampTheta(value: number): number {
  const limit = maxThetaForZoom(zoom.value)
  return Math.min(Math.max(value, -limit), limit)
}

function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM)
}

const isZoomed = computed(() => zoom.value > MIN_ZOOM + 1e-3)

function resetStoppedView() {
  phi = DEFAULT_PHI
  targetPhi = DEFAULT_PHI
  theta = INITIAL_THETA
  targetTheta = INITIAL_THETA
}

function triggerStaticRedrawWindow(duration = 1500) {
  if (typeof performance === 'undefined') {
    staticRedrawUntil = Date.now() + duration
    return
  }
  staticRedrawUntil = performance.now() + duration
}

function shouldKeepStaticRedraw(): boolean {
  const now = typeof performance === 'undefined' ? Date.now() : performance.now()
  return now < staticRedrawUntil
}

// 减少高采样导致的性能问题
function getCappedDpr(): number {
  if (typeof window === 'undefined')
    return 1
  return Math.min(window.devicePixelRatio || 1, 2)
}

interface RegionCluster {
  /** 聚合键：国家代码，或配了精确位置时的 `国家@纬度,经度` */
  key: string
  code: string
  coord: [number, number]
  servers: number
  onlineServers: number
}

function clusterKey(c: RegionCluster) {
  return `${c.key}:${c.servers}:${c.onlineServers}`
}

interface RegionRate {
  up: number
  down: number
}

// 节点按位置聚合：主题设置 nodeLocations 里配了坐标的按坐标，否则按国家
const regionClusters = computed<RegionCluster[]>(() => {
  const map = new Map<string, RegionCluster>()
  for (const node of displayNodes.value) {
    const loc = resolveNodeLocation(node, appStore.nodeLocations)
    if (!loc)
      continue

    let entry = map.get(loc.key)
    if (!entry) {
      entry = { key: loc.key, code: loc.code, coord: loc.coord, servers: 0, onlineServers: 0 }
      map.set(loc.key, entry)
    }
    entry.servers += 1
    if (node.online)
      entry.onlineServers += 1
  }
  return Array.from(map.values()).sort((a, b) => b.servers - a.servers)
})

const regionRates = computed<Map<string, RegionRate>>(() => {
  const map = new Map<string, RegionRate>()
  // 始终使用 nodesStore.nodes 绕过 earthNodes 60s 节流，使速率实时更新
  for (const node of nodesStore.nodes) {
    if (!node.online)
      continue
    const loc = resolveNodeLocation(node, appStore.nodeLocations)
    if (!loc)
      continue
    let entry = map.get(loc.key)
    if (!entry) {
      entry = { up: 0, down: 0 }
      map.set(loc.key, entry)
    }
    entry.up += node.net_out || 0
    entry.down += node.net_in || 0
  }
  return map
})

const arcsEnabled = computed(() => appStore.visitorInfoCardEnabled && appStore.visitorCountryCode != null)
const userCoord = computed<[number, number] | null>(() => {
  if (!appStore.visitorInfoCardEnabled)
    return null
  return getCoordByCode(appStore.visitorCountryCode)
})

const clusterOverlayEls = new Map<string, HTMLDivElement>()
const clusterOverlayRefBinders = new Map<string, (el: Element | ComponentPublicInstance | null) => void>()

function coordToGlobePoint([lat, lon]: [number, number]): [number, number, number] {
  const latRad = lat * Math.PI / 180
  const lonRad = lon * Math.PI / 180 - Math.PI
  const cosLat = Math.cos(latRad)
  return [
    -cosLat * Math.cos(lonRad),
    Math.sin(latRad),
    cosLat * Math.sin(lonRad),
  ]
}

function getRenderSize() {
  const width = containerWidth.value || canvasRef.value?.clientWidth || 320
  const height = containerHeight.value || canvasRef.value?.clientHeight || width
  return { width, height }
}

// iOS Safari 对 cobe 内部 marker anchor 的 DOM/style 行为不稳定，
// overlay 改为组件内自行投影定位，避免回落到容器左上角。
function syncClusterOverlayPosition(cluster: RegionCluster, el: HTMLDivElement) {
  const { width, height } = getRenderSize()
  if (width <= 0 || height <= 0) {
    el.style.opacity = '0'
    el.style.filter = 'blur(20px)'
    return
  }

  const aspect = width / height
  const cosTheta = Math.cos(theta)
  const sinTheta = Math.sin(theta)
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)
  const markerRadius = GLOBE_RADIUS + MARKER_ELEVATION
  const visibleThreshold = GLOBE_RADIUS * GLOBE_RADIUS
  const [baseX, baseY, baseZ] = coordToGlobePoint(cluster.coord)
  const x = baseX * markerRadius
  const y = baseY * markerRadius
  const z = baseZ * markerRadius
  const screenX = cosPhi * x + sinPhi * z
  const screenY = sinPhi * sinTheta * x + cosTheta * y - cosPhi * sinTheta * z
  const visible = (
    -sinPhi * cosTheta * x + sinTheta * y + cosPhi * cosTheta * z >= 0
    || screenX * screenX + screenY * screenY >= visibleThreshold
  )
  const scale = zoom.value
  const xPx = ((screenX / aspect) * scale + 1) * width / 2
  const yPx = ((-screenY) * scale + 1) * height / 2
  // 放大后转到画布外的标签也隐藏
  const inside = xPx >= 0 && xPx <= width && yPx >= 0 && yPx <= height
  const shown = visible && inside

  el.style.transform = `translate3d(${xPx}px, ${yPx}px, 0)`
  el.style.opacity = shown ? '1' : '0'
  el.style.filter = shown ? 'blur(0px)' : 'blur(20px)'
}

function syncClusterOverlayPositions() {
  for (const cluster of regionClusters.value) {
    const el = clusterOverlayEls.get(cluster.key)
    if (!el)
      continue
    syncClusterOverlayPosition(cluster, el)
  }
}

function setClusterOverlayEl(key: string, el: Element | ComponentPublicInstance | null) {
  if (el instanceof HTMLDivElement) {
    el.style.willChange = 'transform, opacity, filter'
    clusterOverlayEls.set(key, el)

    const cluster = regionClusters.value.find(item => item.key === key)
    if (cluster) {
      syncClusterOverlayPosition(cluster, el)
    }
    else {
      el.style.opacity = '0'
      el.style.filter = 'blur(20px)'
    }
    return
  }

  clusterOverlayEls.delete(key)
}

function bindClusterOverlayRef(key: string): (el: Element | ComponentPublicInstance | null) => void {
  const existingBinder = clusterOverlayRefBinders.get(key)
  if (existingBinder)
    return existingBinder

  const binder = (el: Element | ComponentPublicInstance | null) => setClusterOverlayEl(key, el)
  clusterOverlayRefBinders.set(key, binder)
  return binder
}

const markers = computed<Marker[]>(() => {
  return regionClusters.value.map(cluster => ({
    location: cluster.coord,
    size: 0, // 不渲染圆点
  }))
})

// 从各地区汇聚到用户当前位置；无用户坐标时回退到 hub 拓扑
const arcs = computed<Arc[]>(() => {
  const clusters = regionClusters.value
  const user = userCoord.value
  if (!arcsEnabled.value || !user || clusters.length === 0)
    return []
  return clusters.map(cluster => ({
    from: cluster.coord,
    to: user,
  }))
})

const themeColors = computed(() => {
  if (appStore.isDark) {
    return {
      dark: 1,
      mapBrightness: 4,
      baseColor: [0.32, 0.33, 0.4] as [number, number, number],
      markerColor: [0.4, 0.7, 1.0] as [number, number, number],
      glowColor: [0.2, 0.25, 0.45] as [number, number, number],
      arcColor: [0.45, 0.75, 1.0] as [number, number, number],
    }
  }
  return {
    dark: 0,
    mapBrightness: 6,
    baseColor: [1, 1, 1] as [number, number, number],
    markerColor: [0.21, 0.51, 0.93] as [number, number, number],
    glowColor: [1, 1, 1] as [number, number, number],
    arcColor: [0.21, 0.51, 0.93] as [number, number, number],
  }
})

function buildInitialOptions(): COBEOptions {
  const colors = themeColors.value
  const { width, height } = getRenderSize()
  return {
    devicePixelRatio: getCappedDpr(),
    width,
    height,
    phi,
    theta,
    dark: colors.dark,
    diffuse: 1.2,
    mapSamples: 10000, // 地图采样点数，默认 16000
    mapBrightness: colors.mapBrightness,
    baseColor: colors.baseColor,
    markerColor: colors.markerColor,
    glowColor: colors.glowColor,
    markers: markers.value,
    arcs: arcs.value,
    arcColor: colors.arcColor,
    arcWidth: 0.8,
    arcHeight: 0.4,
    markerElevation: MARKER_ELEVATION,
    scale: zoom.value,
  }
}

function updateGlobeFrame() {
  if (!globe)
    return
  const { width, height } = getRenderSize()
  globe.update({ phi, theta, width, height, scale: zoom.value })
  syncClusterOverlayPositions()
}

// phi 收敛/静止时整帧跳过 globe.update，WebGL + overlay 位置更新双双归零
const ORIENTATION_IDLE_EPSILON = 1e-5
const { pause: pauseRaf, resume: resumeRaf } = useRafFn(
  () => {
    if (!globe)
      return
    const prevPhi = phi
    const prevTheta = theta
    // 放大时停止自转，方便盯着某个地区看
    if (!isPointerDown && shouldAutoRotate.value && !isZoomed.value)
      targetPhi += 0.002
    phi += (targetPhi - phi) * 1
    theta += (targetTheta - theta) * 1
    if (
      Math.abs(phi - prevPhi) < ORIENTATION_IDLE_EPSILON
      && Math.abs(theta - prevTheta) < ORIENTATION_IDLE_EPSILON
    ) {
      if (!shouldAutoRotate.value && shouldKeepStaticRedraw())
        updateGlobeFrame()
      return
    }
    updateGlobeFrame()
  },
  { immediate: false }, // , fpsLimit: 30
)

function syncRafState() {
  if (!globe)
    return

  if (shouldRender.value && ((shouldAutoRotate.value && !isZoomed.value) || isPointerDown)) {
    resumeRaf()
    return
  }

  pauseRaf()
  if (shouldRender.value)
    updateGlobeFrame()
}

function startGlobe() {
  if (!canvasRef.value)
    return
  if (appStore.earthViewMode === 'earth-stop') {
    resetStoppedView()
    triggerStaticRedrawWindow()
  }
  globe = createGlobe(canvasRef.value, buildInitialOptions())
  syncClusterOverlayPositions()
  // 静止地球没有自转帧，首帧需要在实际尺寸稳定后主动重绘一次。
  requestAnimationFrame(() => {
    updateGlobeFrame()
  })
  // documentVisibility 同步可读；useElementVisibility 需等 IntersectionObserver 首回调
  // 先按"前台"启动，若实际不可见，shouldRender 的 watch 会在下一帧 pause
  syncRafState()
}

// cobe 不会清理自己创建的 wrapper，这里手动收尾。
function stopGlobe() {
  pauseRaf()
  globe?.destroy()
  globe = null
  if (canvasRef.value && containerRef.value) {
    const cobeWrapper = canvasRef.value.parentElement
    if (cobeWrapper && cobeWrapper !== containerRef.value) {
      // Keep the canvas before the overlays so Cobe's next wrapper remains below them.
      containerRef.value.insertBefore(canvasRef.value, containerRef.value.firstChild)
      cobeWrapper.remove()
    }
  }
}

function rebuildGlobe() {
  stopGlobe()
  startGlobe()
}

onMounted(() => {
  startGlobe()
})

onBeforeUnmount(() => {
  stopGlobe()
})

// 切换主题时重建 globe
watch(() => appStore.isDark, () => {
  rebuildGlobe()
})

watch(
  [containerWidth, containerHeight],
  ([width, height]) => {
    if (!globe || width <= 0 || height <= 0)
      return
    updateGlobeFrame()
  },
)

watch(
  () => appStore.earthViewMode,
  (mode) => {
    if (mode === 'earth-stop')
      resetStoppedView()
    triggerStaticRedrawWindow()
    syncRafState()
  },
)

watch(
  [() => regionClusters.value.map(clusterKey).join(','), userCoord],
  async () => {
    if (!globe)
      return
    globe.update({ markers: markers.value, arcs: arcs.value })
    await nextTick()
    syncClusterOverlayPositions()
    if (!shouldAutoRotate.value)
      triggerStaticRedrawWindow(600)
  },
)

watch(shouldRender, () => {
  if (!globe)
    return
  syncRafState()
})

function setZoom(next: number) {
  const clamped = clampZoom(next)
  if (Math.abs(clamped - zoom.value) < 1e-4)
    return
  zoom.value = clamped
  // 缩小时倾斜上限变小，当前角度要跟着收回来
  targetTheta = clampTheta(targetTheta)
  theta = clampTheta(theta)
  updateGlobeFrame()
  syncRafState()
}

function zoomIn() {
  setZoom(zoom.value * ZOOM_BUTTON_STEP)
}

function zoomOut() {
  setZoom(zoom.value / ZOOM_BUTTON_STEP)
}

function resetZoom() {
  setZoom(MIN_ZOOM)
}

// 只在按住 ⌘/Ctrl 时缩放（Mac 触控板双指捏合在浏览器里也是 ctrlKey 的 wheel），
// 普通滚轮照常滚动页面
function onWheel(e: WheelEvent) {
  if (!e.ctrlKey && !e.metaKey)
    return
  e.preventDefault()
  setZoom(zoom.value * Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY))
}

function pointerDistance(): number {
  const [a, b] = Array.from(activePointers.values())
  if (!a || !b)
    return 0
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function onPointerDown(e: PointerEvent) {
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (activePointers.size === 2) {
    pinchStartDistance = pointerDistance()
    pinchStartZoom = zoom.value
  }
  isPointerDown = true
  lastPointerX = e.clientX
  lastPointerY = e.clientY
  const target = e.currentTarget as HTMLElement
  target.setPointerCapture(e.pointerId)
  syncRafState()
}
function onPointerMove(e: PointerEvent) {
  if (activePointers.has(e.pointerId))
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (activePointers.size >= 2) {
    // 两指时只缩放不旋转
    if (pinchStartDistance > 0)
      setZoom(pinchStartZoom * pointerDistance() / pinchStartDistance)
    return
  }
  if (!isPointerDown)
    return
  const deltaX = e.clientX - lastPointerX
  const deltaY = e.clientY - lastPointerY
  lastPointerX = e.clientX
  lastPointerY = e.clientY
  // 放大后拖动按倍数变慢，便于对准小区域
  targetPhi += deltaX / (200 * zoom.value)
  targetTheta = clampTheta(targetTheta + deltaY / (300 * zoom.value))
}
function onPointerUp(e: PointerEvent) {
  activePointers.delete(e.pointerId)
  if (activePointers.size < 2)
    pinchStartDistance = 0
  const target = e.currentTarget as HTMLElement
  if (target.hasPointerCapture(e.pointerId))
    target.releasePointerCapture(e.pointerId)
  if (activePointers.size === 1) {
    // 捏合结束剩一根手指：从它当前位置继续拖，避免跳一下
    const [rest] = Array.from(activePointers.values())
    lastPointerX = rest!.x
    lastPointerY = rest!.y
    return
  }
  isPointerDown = false
  syncRafState()
}

const totalServers = computed(() => displayNodes.value.length)
const onlineServers = computed(() => displayNodes.value.filter(node => node.online).length)
const offlineServers = computed(() => totalServers.value - onlineServers.value)

function rateFor(key: string): RegionRate {
  return regionRates.value.get(key) ?? { up: 0, down: 0 }
}

function formatRate(bytesPerSec: number): string {
  const { value, unit } = formatBytesPerSecondSplit(bytesPerSec, appStore.byteDecimals)
  return `${value} ${unit}`
}
</script>

<template>
  <div ref="containerRef" class="relative aspect-square w-full max-w-md mx-auto -translate-y-6 md:-translate-y-12" @wheel="onWheel">
    <canvas
      ref="canvasRef"
      class="earth-globe-canvas absolute inset-0 w-full h-full select-none touch-none cursor-grab active:cursor-grabbing"
      @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp"
    />

    <template v-for="cluster in regionClusters" :key="cluster.key">
      <div
        :ref="bindClusterOverlayRef(cluster.key)"
        class="absolute -top-7.5 left-0 pointer-events-none rounded backdrop-blur transition-[opacity,filter] duration-500"
      >
        <img
          v-if="cluster.code"
          :src="getApiAssetUrl(`flags/${cluster.code.toLowerCase()}.svg`)" :alt="cluster.code"
          class="size-4 block absolute -bottom-2 -left-2 z-1 drop-shadow-[0_0_2px_rgba(0,0,0,0.1)]"
        >
        <div class="relative z-2 bg-background/60 rounded py-0.5 px-1 text-xs zoom-80 items-start justify-center text-nowrap">
          <div class="text-green-600 flex flex-row items-center gap-0.5">
            <Icon icon="tabler:chevron-up" width="12" height="12" /> {{ formatRate(rateFor(cluster.key).up) }}
          </div>
          <div class="text-blue-600 flex flex-row items-center gap-0.5">
            <Icon icon="tabler:chevron-down" width="12" height="12" /> {{ formatRate(rateFor(cluster.key).down) }}
          </div>
        </div>
      </div>
    </template>

    <div
      v-if="totalServers > 0"
      class="absolute top-6 md:top-12 left-0 text-[10px] text-muted-foreground pointer-events-none flex gap-2 items-center backdrop-blur-lg bg-background/60 rounded px-2 py-0.5"
    >
      <div v-if="onlineServers > 0" class="flex items-center gap-1">
        <span class="inline-block size-1.5 rounded-full bg-green-600 animate-pulse" />
        <span class="text-green-600">{{ onlineServers }}</span>
      </div>
      <div v-if="offlineServers > 0" class="flex items-center gap-1">
        <span class="inline-block size-1.5 rounded-full bg-yellow-600 animate-pulse" />
        <span class="text-yellow-600">{{ offlineServers }}</span>
      </div>
      <!-- <div v-if="totalServers > 0" class="flex items-center gap-1">
        <span class="inline-block size-1.5 rounded-full bg-blue-600 animate-pulse" />
        <span class="text-blue-600">{{ totalServers }}</span>
      </div> -->
    </div>

    <div
      class="absolute top-6 md:top-12 right-0 z-10 flex items-center gap-0.5 text-muted-foreground backdrop-blur-lg bg-background/60 rounded p-0.5"
      title="放大/缩小地球（也可按住 ⌘ 或 Ctrl 滚动滚轮、触控板或手机双指捏合）"
    >
      <button
        type="button" class="earth-zoom-btn" aria-label="放大地球"
        :disabled="zoom >= MAX_ZOOM - 1e-3" @click="zoomIn"
      >
        <Icon icon="tabler:plus" width="12" height="12" />
      </button>
      <button
        type="button" class="earth-zoom-btn" aria-label="缩小地球"
        :disabled="!isZoomed" @click="zoomOut"
      >
        <Icon icon="tabler:minus" width="12" height="12" />
      </button>
      <button
        v-if="isZoomed"
        type="button" class="earth-zoom-btn text-[10px] tabular-nums px-1 w-auto" aria-label="还原地球大小"
        @click="resetZoom"
      >
        {{ zoom.toFixed(1) }}×
      </button>
    </div>
  </div>
</template>

<style scoped>
.earth-globe-canvas {
  contain: layout paint;
}

.earth-zoom-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25rem;
  height: 1.25rem;
  border-radius: 0.2rem;
  cursor: pointer;
  transition:
    background-color 150ms,
    color 150ms;
}

.earth-zoom-btn:hover:not(:disabled) {
  background-color: color-mix(in srgb, currentColor 15%, transparent);
  color: var(--foreground, currentColor);
}

.earth-zoom-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
</style>
