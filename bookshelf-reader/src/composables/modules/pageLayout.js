/**
 * Page Size Calculation and Layout Management
 * Handles responsive page sizing for different screen layouts
 */

import { computePageScale, applyPageScaleToCSS } from '../constants.js'

export function isSinglePageLayout() {
  if (typeof window === 'undefined') return true
  const narrowScreen = window.innerWidth <= 900
  const coarsePointer = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false
  return narrowScreen || coarsePointer
}

export function calculatePageSize() {
  const singlePage = isSinglePageLayout()
  const horizontalPadding = singlePage ? Math.max(window.innerWidth * 0.04, 12) : 50
  const topOffset = singlePage ? 92 : 130
  const bottomOffset = singlePage ? 132 : 64
  const vpH = Math.max(window.innerHeight - topOffset - bottomOffset, 320)
  const vpW = Math.max(window.innerWidth - horizontalPadding * 2, 220)
  const isWide = !singlePage && window.innerWidth > window.innerHeight
  const ratio = isWide ? (2482 * 2) / 3368 : 2482 / 3368

  let height = vpH
  let width = ratio * height
  if (width > vpW) {
    width = vpW
    height = width / ratio
  }

  width = Math.floor(width / 2) * 2
  height = Math.floor(height)

  return {
    pageW: isWide ? width / 2 : width,
    pageH: height,
    bookW: width,
    bookH: height,
    isWide,
    isSinglePage: singlePage
  }
}

export function setupViewportHeightWatcher() {
  function fixViewportHeight() {
    const vh = window.visualViewport ? window.visualViewport.height * 0.01 : window.innerHeight * 0.01
    document.documentElement.style.setProperty('--vh', `${vh}px`)
    applyPageScaleToCSS(computePageScale())
  }
  
  fixViewportHeight()
  
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fixViewportHeight)
    window.visualViewport.addEventListener('scroll', fixViewportHeight)
  }
  window.addEventListener('resize', fixViewportHeight)
  
  return fixViewportHeight
}

export function getCloseAnimationThreshold() {
  return 8
}
