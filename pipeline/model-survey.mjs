#!/usr/bin/env node
/**
 * 模型测绘：导出 GLB 的材质/贴图/骨架事实，作为「项目级材质契约」的设计依据。
 *
 * 用法:
 *   node pipeline/model-survey.mjs assets/models/<id>.glb [--json out.json]
 *
 * 输出的是**事实**，不含判定：材质名、metal/rough、alphaMode、baseColorFactor、
 * 贴图（mime/尺寸/alpha 零值占比/中间值占比）、extras、骨架与顶点规模。
 * 「哪个材质属于哪个部位角色」由 design/角色资产契约.md 的映射表裁定。
 *
 * 依赖同 pmx2glb.mjs（装在 ~/.workbuddy/binaries/node/workspace）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { PNG } from 'pngjs';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;
if (!file) {
  console.error('用法: node pipeline/model-survey.mjs assets/models/<id>.glb [--json out.json]');
  process.exit(1);
}

/** PNG alpha 统计（pngjs 只吃 Buffer，喂 Uint8Array 会抛异常被吞 —— 已踩过） */
function pngStats(bytes) {
  try {
    const png = PNG.sync.read(Buffer.from(bytes));
    const total = png.width * png.height;
    let zero = 0, partial = 0;
    for (let i = 3; i < png.data.length; i += 4) {
      const a = png.data[i];
      if (a === 0) zero++;
      else if (a < 250) partial++;
    }
    return { w: png.width, h: png.height, zero: +(zero / total).toFixed(4), partial: +(partial / total).toFixed(4) };
  } catch {
    return null;
  }
}

const io = new NodeIO();
const doc = await io.read(file);
const root = doc.getRoot();

// ---- 规模 ----
let verts = 0, tris = 0, prims = 0;
for (const mesh of root.listMeshes()) {
  for (const p of mesh.listPrimitives()) {
    prims++;
    const pos = p.getAttribute('POSITION');
    if (pos) verts += pos.getCount();
    const idx = p.getIndices();
    if (idx) tris += idx.getCount() / 3;
  }
}
let joints = 0;
for (const sk of root.listSkins()) joints += sk.listJoints().length;

// ---- 贴图 ----
const texInfo = new Map();
const texList = [];
for (const t of root.listTextures()) {
  const img = t.getImage();
  const mime = t.getMimeType() || '';
  const st = mime === 'image/png' && img ? pngStats(img) : null;
  const rec = {
    name: t.getName(),
    mime,
    kb: img ? +(img.byteLength / 1024).toFixed(1) : 0,
    alpha: st,
  };
  texInfo.set(t, rec);
  texList.push(rec);
}

// ---- 材质 ----
const mats = [];
for (const m of root.listMaterials()) {
  const bc = m.getBaseColorTexture();
  const em = m.getEmissiveTexture();
  const nm = m.getNormalTexture();
  const occ = m.getOcclusionTexture();
  const mr = m.getMetallicRoughnessTexture();
  mats.push({
    name: m.getName() || '(未命名)',
    baseColorFactor: m.getBaseColorFactor().map((v) => +v.toFixed(3)),
    metal: m.getMetallicFactor(),
    rough: m.getRoughnessFactor(),
    alphaMode: m.getAlphaMode() || 'OPAQUE',
    alphaCutoff: m.getAlphaCutoff(),
    doubleSided: m.getDoubleSided(),
    emissiveFactor: m.getEmissiveFactor().map((v) => +v.toFixed(3)),
    tex: {
      baseColor: bc ? texInfo.get(bc)?.name : null,
      emissive: em ? texInfo.get(em)?.name : null,
      normal: nm ? texInfo.get(nm)?.name : null,
      occlusion: occ ? texInfo.get(occ)?.name : null,
      metalRough: mr ? texInfo.get(mr)?.name : null,
    },
    extras: m.getExtras() ?? null,
    // 该材质的三角形数（PMX 材质序 = primitive 序）
    tris: null,
  });
}
// primitive → 材质三角形数
{
  const byMat = new Map();
  for (const mesh of root.listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      const mm = p.getMaterial();
      if (!mm) continue;
      const c = p.getIndices()?.getCount() ?? 0;
      byMat.set(mm, (byMat.get(mm) ?? 0) + c / 3);
    }
  }
  for (const m of root.listMaterials()) {
    const hit = mats.find((x) => x.name === (m.getName() || '(未命名)'));
    if (hit) hit.tris = byMat.get(m) ?? 0;
  }
}

// ---- 根节点 / 场景 extras ----
const sceneExtras = root.listScenes().map((s) => ({ name: s.getName(), extras: s.getExtras() ?? null }));

const out = {
  file: path.basename(file),
  mb: +(fs.statSync(file).size / 1024 / 1024).toFixed(2),
  stats: { verts, tris, prims, materials: root.listMaterials().length, textures: root.listTextures().length, joints, nodes: root.listNodes().length, animations: root.listAnimations().length },
  sceneExtras,
  textures: texList,
  materials: mats,
};

// ---- 打印 ----
console.log(`\n━━ ${out.file}  ${out.mb} MB ━━`);
console.log(`顶点 ${verts.toLocaleString()} · 三角 ${Math.round(tris).toLocaleString()} · primitive ${prims} · 材质 ${out.stats.materials} · 贴图 ${out.stats.textures} · 骨骼 ${joints} · 动画 ${out.stats.animations}`);
console.log(`\n贴图：`);
for (const t of texList) {
  const a = t.alpha ? `zero ${(t.alpha.zero * 100).toFixed(1)}% / mid ${(t.alpha.partial * 100).toFixed(1)}%` : '—';
  console.log(`  ${(t.name || '(未命名)').padEnd(22)} ${t.mime.replace('image/', '').padEnd(5)} ${(t.alpha ? `${t.alpha.w}×${t.alpha.h}` : '?').padEnd(10)} ${String(t.kb).padStart(7)}KB  ${a}`);
}
console.log(`\n材质：`);
console.log('  ' + '名称'.padEnd(16) + '三角'.padStart(8) + '  metal  rough  alphaMode  cut   DS  贴图');
console.log('  ' + '-'.repeat(104));
for (const m of mats) {
  console.log('  '
    + m.name.padEnd(16)
    + String(Math.round(m.tris ?? 0)).padStart(8)
    + '  ' + String(m.metal).padEnd(6) + String(m.rough).padEnd(6)
    + m.alphaMode.padEnd(10) + String(m.alphaCutoff).padEnd(5)
    + (m.doubleSided ? 'Y' : 'n').padEnd(5)
    + (m.tex.baseColor ?? '—')
    + (m.tex.emissive ? ' +E' : '')
    + (m.extras ? `  extras=${JSON.stringify(m.extras)}` : ''));
}
console.log('');

if (jsonOut) {
  fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2));
  console.log(`[json] ${jsonOut}\n`);
}
