/**
 * Content Pagination Engine
 * Splits HTML content into pages based on available space
 */

import {
  PAGE_FONT_SIZE, PAGE_LINE_HEIGHT, PAGE_PAD_TOP, PAGE_PAD_BOTTOM,
  PAGE_PAD_H, PAGE_NUM_H, PAGE_SAFETY
} from '../constants.js'
import { escHtml, escAttr } from '../constants.js'

const $ = window.$ || window.jQuery

export function extractBlocks(html) {
  const $tmp = $('<div/>').html(html)
  const rawBlocks = []

  $tmp.children().each(function() {
    const $el = $(this)
    const tag = (this.tagName || '').toLowerCase()
    if (tag === 'div' && !hasDirectText(this) && $el.children().length > 0) {
      $el.children().each(function() {
        rawBlocks.push($(this).clone())
      })
    } else {
      rawBlocks.push($el.clone())
    }
  })

  if (!rawBlocks.length) return [$tmp.clone()]
  if (isTocLikeContent($tmp, rawBlocks)) return rawBlocks

  const merged = []
  let i = 0
  while (i < rawBlocks.length) {
    const $block = rawBlocks[i]
    const tag = ($block.prop('tagName') || '').toLowerCase()

    if (tag !== 'p') {
      merged.push($block)
      i++
      continue
    }

    const text = $block.text().trim()
    if (text && /[.!?]["')"]?$/.test(text)) {
      merged.push($block)
      i++
      continue
    }

    const $mergedBlock = $block.clone()
    let j = i + 1
    while (j < rawBlocks.length) {
      const $next = rawBlocks[j]
      const nextTag = ($next.prop('tagName') || '').toLowerCase()
      if (nextTag !== 'p') break

      const nextText = $next.text().trim()
      const nextCls = $next.attr('class') || ''
      if (/title|head/i.test(nextCls)) break

      const currentText = $mergedBlock.text()
      $mergedBlock.html(currentText + nextText)
      j++

      if (/[.!?]["')"]?$/.test(nextText)) break
    }

    merged.push($mergedBlock)
    i = j
  }

  return merged.length ? merged : [$tmp.clone()]
}

export function hasDirectText(el) {
  for (const node of el.childNodes) {
    if (node.nodeType === 3 && node.textContent.trim()) return true
  }
  return false
}

export function isTocLikeContent($root, blocks = []) {
  const text = $root.text().replace(/\s+/g, '')
  const headingText = $root.find('h1, h2, h3, [class*="title"], [class*="head"]').first().text().trim()
  const paragraphs = blocks.filter($block => (($block.prop('tagName') || '').toLowerCase() === 'p'))
  if (paragraphs.length < 6) return false

  const headingLooksLikeToc = /目录 | 目次|contents/i.test(headingText) || /^目录/.test(text)
  const shortParagraphs = paragraphs.filter($block => {
    const line = $block.text().replace(/\s+/g, '').trim()
    return line && line.length <= 40
  })
  const tocStyledParagraphs = paragraphs.filter($block => {
    const line = $block.text().replace(/\s+/g, '').trim()
    return /^(第 | 卷 | 章 | 回 | 节 | 部 | 篇 | 序 | 终 | 后 | 附)/.test(line) ||
      /^[0-9 一二三四五六七八九十百千万]+[、.．章节回卷篇部]/.test(line)
  })

  return headingLooksLikeToc || (
    shortParagraphs.length >= Math.ceil(paragraphs.length * 0.7) &&
    tocStyledParagraphs.length >= 3
  )
}

export function splitLargeBlock($block, usableH, $ruler) {
  const text = $block.text()
  const tag = ($block.prop('tagName') || 'p').toLowerCase()
  const cls = $block.attr('class') || ''
  const result = []

  let start = 0
  let isFirstChunk = true
  while (start < text.length) {
    let lo = start + 1
    let hi = text.length
    let best = start + 1

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const chunk = text.slice(start, mid)
      const chunkCls = isFirstChunk ? cls : (cls ? cls + ' cont' : 'cont')
      $ruler.empty().html(`<${tag} class="${escAttr(chunkCls)}">${escHtml(chunk)}</${tag}>`)
      if ($ruler[0].scrollHeight <= usableH) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }

    if (best === start) best = start + 1
    const outCls = isFirstChunk ? cls : (cls ? cls + ' cont' : 'cont')
    result.push(`<${tag} class="${escAttr(outCls)}">${escHtml(text.slice(start, best))}</${tag}>`)
    start = best
    isFirstChunk = false
  }

  return result
}

export function cleanHtml(html, type) {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
  
  if (type !== 'epub' && !cleaned.includes('<')) {
    return cleaned
      .split(/\n{2,}|\f/)
      .map(block => block.trim())
      .filter(Boolean)
      .map(block => block
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => `<p>${escHtml(line)}</p>`)
        .join(''))
      .join('')
  }

  cleaned = cleaned.replace(/<p[^>]*>(\s|&nbsp;|&#160;|\u3000|\u00a0)*<\/p>/gi, '')
  cleaned = cleaned.replace(/(<br\s*\/?>\s*){3,}/gi, '<br/>')
  return cleaned
}

export function splitContentToPages(rawHtml, type, pageW, pageH) {
  const width = pageW || Math.max(window.innerWidth > window.innerHeight ? 420 : 340, 320)
  const height = pageH || Math.max(window.innerHeight - 180, 480)

  const scale = computePageScale()
  const scaledFontSize = PAGE_FONT_SIZE * scale
  const scaledPadTop = PAGE_PAD_TOP * scale
  const scaledPadBottom = PAGE_PAD_BOTTOM * scale
  const scaledPadH = PAGE_PAD_H * scale
  const scaledNumH = PAGE_NUM_H * scale
  const scaledSafety = Math.max(PAGE_SAFETY * scale, 12)

  const $probe = $('<div/>').css({
    position: 'absolute',
    top: '-99999px',
    left: '-99999px',
    width: `${width}px`,
    height: `${height}px`,
    overflow: 'hidden',
    visibility: 'hidden'
  })
  const $probeContent = $('<div class="page-content"/>')
  $probe.append($probeContent)
  $('body').append($probe)
  const contentInnerH = $probeContent[0].clientHeight || height
  $probe.remove()

  const usableH = Math.max(contentInnerH - scaledPadTop - scaledPadBottom - scaledNumH - scaledSafety, 60)
  const usableW = width - scaledPadH
  if (usableH <= 0 || usableW <= 0) return [rawHtml]

  let html = cleanHtml(rawHtml, type)
  if (!html.trim()) return []

  const $ruler = $('<div/>').css({
    position: 'absolute',
    top: '-99999px',
    left: '-99999px',
    width: `${usableW}px`,
    fontSize: `${scaledFontSize}px`,
    lineHeight: PAGE_LINE_HEIGHT,
    fontFamily: "'PingFang SC','Microsoft YaHei','Noto Serif SC',serif",
    wordBreak: 'break-all',
    overflow: 'visible',
    visibility: 'hidden'
  })
  $('body').append($ruler)

  const blocks = extractBlocks(html)
  
  const pages = []
  let bucket = []
  let bucketH = 0

  function flush() {
    if (!bucket.length) return
    const $wrapper = $('<div/>')
    bucket.forEach($node => $wrapper.append($node.clone()))
    pages.push($wrapper.html())
    bucket = []
    bucketH = 0
  }

  blocks.forEach($block => {
    const text = $block.text().replace(/[\s\u3000\u00a0]/g, '')
    if (!text && !$block.find('img').length) return

    $ruler.empty().append($block.clone())
    const blockHeight = $ruler[0].scrollHeight

    if (blockHeight >= usableH) {
      flush()
      splitLargeBlock($block, usableH, $ruler).forEach(subHtml => {
        pages.push(subHtml)
      })
      return
    }

    if (bucketH + blockHeight > usableH) flush()
    bucket.push($block)
    bucketH += blockHeight
  })

  flush()
  $ruler.remove()

  return pages.length ? pages : [html]
}
