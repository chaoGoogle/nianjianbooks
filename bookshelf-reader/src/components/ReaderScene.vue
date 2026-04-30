<!-- ===== ReaderScene.vue ===== -->
<!-- 修改点：无需改动模板，reader-bottom-controls 在移动端由 CSS 隐藏 -->
<template>
  <div class="reader-scene">
    <div class="reader-topbar">
      <div class="reader-info">
        <img class="reader-title" src="/logo.png" alt="">
      </div>
    </div>

    <!-- 目录按钮悬浮在右上角（PC端显示，移动端由 reader-bottom-controls 中的目录按钮代替） -->
    <button 
      v-if="tocList.length > 0" 
      class="toc-floating-btn" 
      @click="emit('toggle-toc')"
    >目录</button>

    <BookFlipbook
      ref="flipbookRef"
      :current-book="currentBook"
      :total-pages="totalPages"
      :display-total-pages="displayTotalPages"
      :current-page="currentPage"
      @page-changed="(page) => emit('page-changed', page)"
    />

    <div v-if="tocVisible" class="toc-sidebar" @click.self="emit('toggle-toc')">
      <aside class="toc-panel">
        <div class="toc-header">
          <span class="toc-title-text">目 录</span>
          <button class="toc-close-btn" @click="emit('toggle-toc')" aria-label="关闭目录">×</button>
        </div>
        <div class="toc-list">
          <button
            v-for="(item, index) in tocList"
            :key="index"
            type="button"
            class="toc-item"
            :class="{ active: item.targetPage > 0 && item.targetPage === currentPage }"
            @click="emit('jump-to-toc-item', item)"
          >
            <span class="toc-item-text">{{ item.label || item.title || '未知章节' }}</span>
          </button>
        </div>
      </aside>
    </div>

    <!-- 桌面端底部按钮（移动端隐藏，由 BookFlipbook 中的 mobile-nav-controls 替代） -->
    <div class="reader-bottom-controls">
      <button
        v-if="currentPage > 2"
        type="button"
        class="reader-control-btn reader-control-btn--back"
        @click.stop="flipToPage2"
      >
        返回首页
      </button>
      <button
        type="button"
        class="reader-control-btn"
        :disabled="currentPage <= 1"
        @click.stop="prevPage"
      >
        上一页
      </button>
      <button
        type="button"
        class="reader-control-btn"
        :disabled="currentPage >= totalPages"
        @click.stop="nextPage"
      >
        下一页
      </button>
      <button
        v-if="tocList.length > 0"
        type="button"
        class="reader-control-btn reader-control-btn--toc"
        @click.stop="emit('toggle-toc')"
      >
        目录
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import BookFlipbook from './BookFlipbook.vue'

defineProps({
  currentBook: {
    type: Object,
    default: () => ({})
  },
  totalPages: {
    type: Number,
    required: true
  },
  displayTotalPages: {
    type: Number,
    required: true
  },
  currentPage: {
    type: Number,
    required: true
  },
  pageLoading: {
    type: Boolean,
    required: true
  },
  tocList: {
    type: Array,
    default: () => []
  },
  tocVisible: {
    type: Boolean,
    required: true
  }
})

const emit = defineEmits([
  'close-book',
  'page-changed',
  'toggle-toc',
  'jump-to-toc-item'
])

const flipbookRef = ref(null)

function prevPage() {
  flipbookRef.value?.prevPage()
}

function nextPage() {
  flipbookRef.value?.nextPage()
}

function flipToPage2() {
  flipbookRef.value?.flipToPageImmediately(1)
}

defineExpose({
  initFlipbook: () => flipbookRef.value?.initFlipbook(),
  destroyFlipbook: () => flipbookRef.value?.destroyFlipbook(),
  flipToPage: (page) => flipbookRef.value?.flipToPage(page),
  animateCloseToCover: () => flipbookRef.value?.animateCloseToCover(),
  flipToPageImmediately: (page) => flipbookRef.value?.flipToPageImmediately(page),
  prevPage: () => flipbookRef.value?.prevPage(),
  nextPage: () => flipbookRef.value?.nextPage(),
  refreshPage: () => flipbookRef.value?.refreshPage()
})
</script>