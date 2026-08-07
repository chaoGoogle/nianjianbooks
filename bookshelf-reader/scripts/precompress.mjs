import { brotliCompress } from 'zlib';
import { promisify } from 'util';
import path from 'path';

const brotliCompressAsync = promisify(brotliCompress);
const distDir = path.join(import.meta.dir, '../dist');
const COMPRESSIBLE = /\.(js|css|html|svg|json|woff2?)$/;

const glob = new Bun.Glob('**/*');
let compressed = 0;
let savedBytes = 0;

for await (const file of glob.scan({ cwd: distDir, onlyFiles: true })) {
  if (!COMPRESSIBLE.test(file) || file.endsWith('.br')) continue;
  const filePath = path.join(distDir, file);
  const source = await Bun.file(filePath).arrayBuffer();
  const out = await brotliCompressAsync(Buffer.from(source));
  await Bun.write(`${filePath}.br`, out);
  compressed += 1;
  savedBytes += source.byteLength - out.byteLength;
}

console.log(`[precompress] ${compressed} files brotli-compressed, saved ${(savedBytes / 1024).toFixed(1)}KB`);
