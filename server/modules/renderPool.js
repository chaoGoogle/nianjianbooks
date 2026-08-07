import os from 'os';

function getCpuCount() {
  const parallelism = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : undefined;
  if (Number.isFinite(parallelism) && parallelism > 0) return parallelism;
  return os.cpus()?.length || 4;
}

const CPU_COUNT = getCpuCount();

const WORKER_MEMORY_BUDGET = 1536 * 1024 * 1024;
const maxWorkersByMemory = Math.max(1, Math.floor(os.freemem() / WORKER_MEMORY_BUDGET));

export const RENDER_POOL_SIZE = Math.max(
  1,
  Math.min(CPU_COUNT - 1, 4, maxWorkersByMemory, parseInt(process.env.RENDER_POOL_SIZE || '4', 10) || 4)
);

let pool = null;
let poolFailed = false;
let roundRobinIndex = 0;
let nextTaskId = 0;
const pendingTasks = new Map();
const workerRss = [];

function createPool() {
  if (poolFailed) return null;
  if (pool) return pool;

  try {
    pool = Array.from({ length: RENDER_POOL_SIZE }, (_, index) => {
      const worker = new Worker(new URL('./renderWorker.js', import.meta.url));
      worker.onmessage = (e) => {
        const { id, ok, buffer, error, rss } = e.data;
        if (Number.isFinite(rss)) workerRss[index] = rss;
        const task = pendingTasks.get(id);
        if (!task) return;
        pendingTasks.delete(id);
        if (ok) {
          task.resolve(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
        } else {
          task.reject(new Error(error || 'render failed'));
        }
      };
      worker.onerror = (err) => {
        console.error('[render-pool] worker error:', err?.message || err);
      };
      return worker;
    });
    console.log(`[render-pool] started ${RENDER_POOL_SIZE} render workers`);
    return pool;
  } catch (err) {
    console.error('[render-pool] failed to start workers, falling back to main-thread render:', err?.message || err);
    poolFailed = true;
    pool = null;
    return null;
  }
}

export function isRenderPoolAvailable() {
  return createPool() !== null;
}

export function getRenderWorkerMemory() {
  return workerRss.map((rss, index) => ({ worker: index, rss }));
}

export function purgeRenderWorkers() {
  const workers = createPool();
  if (!workers) return;
  for (const worker of workers) {
    worker.postMessage({ id: ++nextTaskId, purge: true });
  }
}

export function renderPageInWorker(pdfPath, pageNum, width) {
  const workers = createPool();
  if (!workers) return null;

  const id = ++nextTaskId;
  const worker = workers[roundRobinIndex];
  roundRobinIndex = (roundRobinIndex + 1) % workers.length;

  return new Promise((resolve, reject) => {
    pendingTasks.set(id, { resolve, reject });
    worker.postMessage({ id, pdfPath, pageNum, width });
  });
}
