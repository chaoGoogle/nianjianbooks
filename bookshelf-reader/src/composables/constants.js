// ===== 常量与工具函数 =====
// 页面布局常量
export const PAGE_FONT_SIZE = 15
export const PAGE_LINE_HEIGHT = 1.95
export const PAGE_PAD_TOP = 36
export const PAGE_PAD_BOTTOM = 36
export const PAGE_PAD_H = 60
export const PAGE_NUM_H = 28
// 安全余量：防止页面底部文字被裁剪或与页码重叠
export const PAGE_SAFETY = 44

// 等比缩放常量
export const DESIGN_BASE_HEIGHT = 700  // 设计基准高度
export const MIN_PAGE_SCALE = 0.55   // 缩放下限

// ===== 日志控制 =====
const DEBUG_MODE = false
export function log(...args) { if (DEBUG_MODE) console.log(...args) }
export function logWarn(...args) { if (DEBUG_MODE) console.warn(...args) }

// ===== 页面等比缩放 =====
export function computePageScale() {
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight
  if (vh >= DESIGN_BASE_HEIGHT) return 1
  return Math.max(MIN_PAGE_SCALE, vh / DESIGN_BASE_HEIGHT)
}

export function applyPageScaleToCSS(scale) {
  document.documentElement.style.setProperty('--page-scale', String(scale))
}

// ===== 通用工具 =====
export const enc = (str) => encodeURIComponent(str)
export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
export const isChrome = () => /Chrome/.test(navigator.userAgent) && !/Edg/.test(navigator.userAgent)

export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function escAttr(str) {
  return String(str).replace(/"/g, '&quot;')
}