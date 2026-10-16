#!/usr/bin/env node
/**
 * GLB 材质审查：按「PMX→GLB 三条铁律」体检拆包模型（新模型入料后必跑）。
 *
 * 用法:
 *   node pipeline/glb-audit.mjs assets/models/<id>.glb [--fix]
 *
 * 三条铁律（来源：design/NPR渲染复刻-终末地少前2手法拆解与落地.md §5.1）:
 *   ① metallicFactor 必须为 0 —— PMX 无 PBR 数据，glTF 默认 1.0 会让漫反射归零，暗处纯黑
 *   ② 贴图有镂空（alpha=0 占比 >2%）却标 OPAQUE 的材质 → MASK(0.5) / BLEND（按中间 alpha 占比选）
 *   ③ 眼球/睫毛/口腔等脸部叠加件应由渲染层走 unlit（本脚本只报告名字，判定在 src/render/npr.ts）
 *
 * --fix 就地修 ① ②（写回同一文件；先备份为 <name>.glb.bak）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { PNG } from 'pngjs';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const fix = argv.includes('--fix');
if (!file) {
  console.error('用法: node pipeline/glb-audit.mjs assets/models/<id>.glb [--fix]');
  process.exit(1);
}

/** PNG alpha 统计（pngjs 只吃 Buffer，喂 Uint8Array 会抛异常被吞 —— 已踩过） */
function pngAlphaStats(bytes) {
  try {
    const png = PNG.sync.read(Buffer.from(bytes));
    const total = png.width * png.height;
    let zero = 0, partial = 0;
    for (let i = 3; i < png.data.length; i += 4) {
      const a = png.data[i];
      if (a === 0) zero++;
      else if (a < 250) partial++;
    }
    return { zero: zero / total, partial: partial / total, size: `${png.width}×${png.height}` };
  } catch {
    return null;
  }
}

const io = new NodeIO();
const doc = await io.read(file);
const root = doc.getRoot();

const stats = new Map();
for (const t of root.listTextures()) {
  const img = t.getImage();
  stats.set(t, img && t.getMimeType() === 'image/png' ? pngAlphaStats(img) : null);
}

const problems = [];
console.log(`\n材质审查：${path.basename(file)}（${root.listMaterials().length} 个材质）\n`);
console.log('名称'.padEnd(14) + 'metal  rough  alphaMode   镂空');
console.log('-'.repeat(70));

for (const m of root.listMaterials()) {
  const bc = m.getBaseColorTexture();
  const st = bc ? stats.get(bc) : null;
  const metal = m.getMetallicFactor();
  const rough = m.getRoughnessFactor();
  const mode = m.getAlphaMode() ?? 'OPAQUE';
  const hole = st ? `${(st.zero * 100).toFixed(1)}% @ ${st.size}` : '—';

  console.log(
    (m.getName() || '(未命名)').padEnd(14)
    + String(metal).padEnd(7) + String(rough).padEnd(7)
    + mode.padEnd(12) + hole.padEnd(18)
    + m.getBaseColorFactor().map((v) => v.toFixed(2)).join(','),
  );

// 铁律 ①
if (metal > 0) problems.push(`① ${m.getName()}: metallicFactor=${metal}（应为 0，否则暗处纯黑）`);
// 铁律 ②
if (st && st.zero > 0.02 && mode === 'OPAQUE') {
  const want = st.partial < 0.05 ? 'MASK' : 'BLEND';
  problems.push(`② ${m.getName()}: 贴图 ${(st.zero * 100).toFixed(1)}% 像素 alpha=0 但为 OPAQUE → 应 ${want}`);
}
// 铁律 ③ 提示
if (/目|睫|眉|口|齿|表情|highlight|eye|teeth/i.test(m.getName() || '')) {
  console.log(`   ↳ 脸部叠加件候选：确认 src/render/npr.ts 的 UNLIT_HINTS 覆盖了「${m.getName()}」`);
}
}

console.log('');
if (!problems.length) {
  console.log('✓ 三条铁律全部通过');
} else {
  console.log(`发现 ${problems.length} 处问题：`);
  for (const p of problems) console.log('  ✗ ' + p);
}

if (fix) {
  const bak = file.replace(/\.glb$/i, '.glb.bak');
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  let n = 0;
  for (const m of root.listMaterials()) {
    if (m.getMetallicFactor() > 0) { m.setMetallicFactor(0).setRoughnessFactor(0.9); n++; }
    const st = m.getBaseColorTexture() ? stats.get(m.getBaseColorTexture()) : null;
    if (st && st.zero > 0.02 && (m.getAlphaMode() ?? 'OPAQUE') === 'OPAQUE') {
      if (st.partial < 0.05) m.setAlphaMode('MASK').setAlphaCutoff(0.5);
      else m.setAlphaMode('BLEND');
      n++;
    }
  }
  await io.write(file, doc);
  console.log(`\n已修 ${n} 处并写回（备份 ${path.basename(bak)}）`);
}
