// 素材编码器：把二进制素材转成 base64 文本（.b64），供仓库推送。
//
// 背景：GitHub 推送工具只接受 UTF-8 文本文件，二进制（GLB/PNG/HDR/M4A/
// WOFF2）会被拒（"snapshot file is not UTF-8"）。所以仓库里的 assets/ 只存
// base64 文本，运行时由 js/assets.js 解码回 ArrayBuffer 再用。
//
// 用法（在仓库根目录 ~/workspace/fps-range 下执行）：
//
//   node tools/encode-assets.mjs                 # 默认：就地编码 assets/
//   node tools/encode-assets.mjs <src> <dest>     # 从 <src> 编码到 <dest>（镜像目录结构）
//
// 规则：
// - 每个二进制文件写成 <相对路径>.b64（base64，每 76 字符换行，纯 ASCII）；
// - 已存在的 .b64 文件跳过（可重复执行，不会重复编码）；
// - .txt/.md 文件是纯文本，原样保留/复制，不编码（许可证文本保持可读）；
// - 本脚本只写 .b64，不删除源二进制文件。确认解码无误后，手动删除
//   assets/ 下的二进制文件（或用：find assets -type f ! -name '*.b64' ! -name '*.txt' -delete）。
// - 二进制原件的权威来源是 ~/workspace/impasse-assets/（staging），不要从那里删。
//
// 验证解码是否与原件逐字节一致（编码后、删二进制前必须跑）：
//
//   cd assets && for f in $(find . -name '*.b64'); do \
//     base64 -d "$f" | sha256sum; done  # 与原件 sha256sum 对照
//
// Node 无依赖。

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAP = 72; // base64 换行宽度（必须是 4 的倍数）；解码端会去掉空白符

function wrapBase64(b64) {
  if (b64.length <= WRAP) return b64 + '\n';
  let out = '';
  for (let i = 0; i < b64.length; i += WRAP) out += b64.slice(i, i + WRAP) + '\n';
  return out;
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(full)));
    else if (e.isFile()) files.push(full);
  }
  return files.sort();
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..');
  const srcDir = path.resolve(process.argv[2] || path.join(repoRoot, 'assets'));
  const destDir = path.resolve(process.argv[3] || srcDir);
  const inPlace = srcDir === destDir;

  const files = await walk(srcDir);
  let encoded = 0;
  let skipped = 0;
  let totalIn = 0;
  let totalOut = 0;
  for (const full of files) {
    const rel = path.relative(srcDir, full);
    if (rel.endsWith('.b64')) { skipped++; continue; }
    if (/\.(txt|md)$/i.test(rel)) { skipped++; continue; } // 纯文本：原样保留
    const data = await readFile(full);
    const b64 = wrapBase64(data.toString('base64'));
    const dest = path.join(destDir, rel + '.b64');
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, b64, 'utf8');
    const hash = createHash('sha256').update(data).digest('hex').slice(0, 12);
    console.log(`${rel} -> ${path.relative(destDir, dest)}  ${data.length} bytes  sha256:${hash}…`);
    encoded++;
    totalIn += data.length;
    totalOut += Buffer.byteLength(b64, 'utf8');
  }
  console.log(`\nencoded ${encoded} files (${totalIn} bytes -> ${totalOut} bytes base64), skipped ${skipped} (already .b64 / plain text)${inPlace ? ' [in-place]' : ''}.`);
  console.log('Next: verify decoded bytes match the originals (see header comment), then delete the binaries from assets/.');
}

main().catch((e) => { console.error(e); process.exit(1); });
