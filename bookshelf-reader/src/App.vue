<template>
  <div class="scene-transition-mask" :class="{ active: transitioning }"></div>

  <div v-if="scene !== 'reader'" class="startup-screen">
    <div class="startup-panel">
      <div v-if="loading" class="startup-state">
        <div class="loading-spinner"></div>
        <h1>正在连接书库</h1>
        <p>后端启动后，已加载的内容会立即显示，剩余内容继续懒加载。</p>
      </div>

      <div v-else-if="error" class="startup-state">
        <h1>无法连接后端</h1>
        <p>{{ error }}</p>
        <p class="startup-hint">请确认后端服务已启动，然后点击重新连接。</p>
        <button class="startup-btn" @click="retryLoad">重新连接</button>
      </div>

      <div v-else class="startup-state">
        <h1>书库为空</h1>
        <p>当前没有可显示的书籍，可以稍后再刷新列表。</p>
        <button class="startup-btn" @click="retryLoad">刷新列表</button>
      </div>
    </div>
  </div>

  <ReaderScene
    v-show="scene === 'reader'"
    :key="readerSessionKey"
    ref="readerRef"
    :current-book="currentBook"
    :total-pages="totalPages"
    :display-total-pages="displayTotalPages"
    :current-page="currentPage"
    :page-loading="pageLoading"
    :toc-list="tocList"
    :toc-visible="tocVisible"
    @close-book="closeBook"
    @prev-page="prevPage"
    @next-page="nextPage"
    @toggle-toc="toggleToc"
    @jump-to-toc-item="handleJumpToTocItem"
    @page-changed="page => currentPage = page"
  />
</template>

<script setup>
import { ref, onMounted, provide, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ReaderScene from './components/ReaderScene.vue'
import { useBookReader, delay } from './composables/useBookReader'

const OPEN_MASK_MIN_DURATION = 120
const OPEN_READER_INIT_DELAY = 16
const OPEN_MASK_RELEASE_DELAY = 24
const CLOSE_MASK_HOLD_DELAY = 60
const CLOSE_DESK_SETTLE_DELAY = 1100

const readerState = useBookReader()
provide('readerState', readerState)

const {
  scene,
  transitioning,
  books,
  loading,
  error,
  currentBook,
  totalPages,
  displayTotalPages,
  currentPage,
  pageLoading,
  tocList,
  tocVisible,
  toggleToc,
  jumpToTocItem,
  loadToc,
  fetchBooks,
  abortAllRequests,
  prepareBook,
  resetBookState,
  fetchBookByName
} = readerState

const readerRef = ref(null)
const readerSessionKey = ref(0)

const route = useRoute()
const router = useRouter()

async function openBook(book) {
  if (transitioning.value) return

  try {
    const prepareTask = prepareBook(book)

    await delay(OPEN_MASK_MIN_DURATION)
    transitioning.value = true
    await delay(OPEN_MASK_MIN_DURATION)

    currentBook.value = book
    currentPage.value = 1
    scene.value = 'reader'

    await delay(OPEN_READER_INIT_DELAY)
    await prepareTask

    await readerRef.value?.initFlipbook()
    await delay(OPEN_MASK_RELEASE_DELAY)
    transitioning.value = false
  } catch (openError) {
    if (openError?.name !== 'AbortError') {
      console.warn('打开书籍失败:', openError)
    }
    transitioning.value = false
  }
}

async function closeBook() {
  if (transitioning.value) return

  if (readerRef.value) {
    try {
      await readerRef.value.animateCloseToCover()
    } catch (closeError) {
      console.warn('关闭书籍失败:', closeError)
    }
  }

  transitioning.value = true
  await delay(CLOSE_MASK_HOLD_DELAY)

  abortAllRequests()
  if (readerRef.value) {
    readerRef.value.destroyFlipbook()
  }

  scene.value = 'desk'
  resetBookState()

  transitioning.value = false
  router.push('/')
  await delay(CLOSE_DESK_SETTLE_DELAY)
}

function prevPage() {
  readerRef.value?.prevPage()
}

function nextPage() {
  readerRef.value?.nextPage()
}

function handleJumpToTocItem(item) {
  jumpToTocItem(item, (page) => readerRef.value?.flipToPageImmediately(page))
}

async function retryLoad() {
  await fetchBooks({ forceRefresh: true })
}

onMounted(async () => {
  await fetchBooks()
})

watch(
  () => books.value[0]?.file,
  async firstBookFile => {
    if (!firstBookFile) return
    if (currentBook.value?.file || scene.value !== 'desk' || transitioning.value) return
    if (route.params.bookName) return
    await openBook(books.value[0])
  }
)

watch(() => route.params, async (params) => {
  if (transitioning.value) return

  const bookName = params.bookName
  if (bookName) {
    const book = await fetchBookByName(bookName)
    if (book) {
      await openBook(book)
    } else {
      router.replace('/')
    }
  } else {
    if (scene.value === 'reader') {
      await closeBook()
    }
  }
}, { immediate: true })
</script>

<style scoped>
.startup-screen {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(circle at top, rgba(211, 186, 140, 0.18), transparent 36%),
    linear-gradient(180deg, #17120d 0%, #0c0907 100%);
  color: #f3eadb;
}

.startup-panel {
  width: min(560px, 100%);
  padding: 32px 28px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 24px;
  background: rgba(27, 21, 16, 0.9);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
}

.startup-state {
  display: grid;
  gap: 12px;
  justify-items: start;
}

.startup-state h1 {
  margin: 0;
  font-size: 32px;
  line-height: 1.1;
}

.startup-state p {
  margin: 0;
  color: rgba(243, 234, 219, 0.76);
  line-height: 1.6;
}

.startup-hint {
  font-size: 14px;
}

.startup-btn {
  margin-top: 8px;
  padding: 10px 18px;
  border: 0;
  border-radius: 999px;
  background: #d0ab67;
  color: #17120d;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.startup-btn:hover {
  background: #e2ba72;
}

@media (max-width: 640px) {
  .startup-panel {
    padding: 24px 20px;
    border-radius: 20px;
  }

  .startup-state h1 {
    font-size: 26px;
  }
}
</style>
