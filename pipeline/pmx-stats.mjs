#!/usr/bin/env node
/**
 * PMX 测绘脚本：把一个 PMX 的真实规格全部量出来（材质分布 / 骨骼 / 变形 / 物理 / 贴图）。
 *
 * 用法:
 *   NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules \
 *     node pipeline/pmx-stats.mjs <file.pmx> [--json]
 *
 * 只读，不改文件。目的：为「还原度评估」提供事实数据，不靠肉眼猜。
 */

import fs from 'node:fs';
import path from 'node:path';
import { MMDParser } from 'mmd-parser';

const argv = process.argv.slice(2);
const inputPath = path.resolve(argv[0]);
const asJson = argv.includes('--json');
const pmx = new MMDParser.Parser().parsePmx(
  (() => {
    const buf = fs.readFileSync(inputPath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  })(),
);
const dir = path.dirname(inputPath);

const fmt = (n) => n.toLocaleString('en-US');

// ---------- 贴图分辨率（读文件头，不解码整图） ----------
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
function tgaSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 18) return null;
  const w = b.readUInt16LE(12);
  const h = b.readUInt16LE(14);
  const bpp = b[16];
  return { w, h, bpp };
}

// ---------- 顶点变形类型分布 ----------
const deform = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, other: 0 };
for (const v of pmx.vertices) deform[v.type] ??= 0, deform[v.type]++;
const DEFORM_NAME = { 0: 'BDEF1（单骨骼）', 1: 'BDEF2（两骨骼）', 2: 'BDEF4（四骨骼）', 3: 'SDEF（球面）', 4: 'QDEF（四元数）' };

// ---------- 材质 ----------
const materials = [];
let faceCursor = 0;
for (const m of pmx.materials) {
  const tex = m.textureIndex >= 0 ? pmx.textures[m.textureIndex] : null;
  const sphere = m.sphereTextureIndex >= 0 ? pmx.textures[m.sphereTextureIndex] : null;
  const toon = m.toonFlag === 1 ? `内建 ${m.toonTextureIndex}` : (m.toonTextureIndex >= 0 && pmx.textures[m.toonTextureIndex]) || null;
  materials.push({
    name: m.name,
    triangles: m.faceCount,
    texture: tex,
    sphere,
    sphereMode: m.sphereMode,
    toon,
    diffuse: m.diffuse,
    specular: m.specular,
    edge: { flag: m.edgeFlag, size: m.edgeSize, color: m.edgeColor },
    flags: {
      doubleSided: !!(m.drawFlag & 1),
      groundShadow: !!(m.drawFlag & 2),
      selfShadowMap: !!(m.drawFlag & 4),
      selfShadow: !!(m.drawFlag & 8),
      edge: !!(m.drawFlag & 16),
    },
  });
  faceCursor += m.faceCount;
}

// ---------- 骨骼 ----------
const bones = pmx.bones ?? [];
const ikBones = bones.filter((b) => b.parentIndex !== undefined && b.type === 1);
const deformBones = bones.filter((b) => b.type === 2);

// ---------- 变形器 ----------
const morphs = pmx.morphs ?? [];
const morphByType = {};
const MORPH_TYPE = { 0: 'group', 1: 'vertex', 2: 'bone', 3: 'uv', 4: 'uv1', 5: 'uv2', 6: 'uv3', 7: 'uv4', 8: 'material', 9: 'flip', 10: 'impulse' };
for (const mo of morphs) {
  const t = MORPH_TYPE[mo.type] ?? `type${mo.type}`;
  morphByType[t] = (morphByType[t] ?? 0) + 1;
}

// ---------- 物理 ----------
const rigidBodies = pmx.rigidBodies ?? [];
const constraints = pmx.constraints ?? pmx.joints ?? [];
// mmd-parser: 刚体演算模式在 `type`（0=静止跟随 1=物理演算 2=物理+位置匹配），形状在 `shapeType`
const PHYS_MODE = { 0: '静止跟随', 1: '物理演算', 2: '物理+骨骼位置匹配' };
const SHAPE = { 0: '球', 1: '盒', 2: '胶囊' };
const physByMode = {};
const physByShape = {};
for (const rb of rigidBodies) {
  const k = PHYS_MODE[rb.type] ?? `mode${rb.type}`;
  physByMode[k] = (physByMode[k] ?? 0) + 1;
  const s = SHAPE[rb.shapeType] ?? `shape${rb.shapeType}`;
  physByShape[s] = (physByShape[s] ?? 0) + 1;
}

// ---------- 贴图清单 ----------
const textures = (pmx.textures ?? []).map((rel) => {
  const file = path.resolve(dir, rel.replaceAll('\\', '/'));
  const exists = fs.existsSync(file);
  const ext = path.extname(file).toLowerCase();
  let size = null;
  if (exists) {
    try {
      if (ext === '.png') size = pngSize(file);
      else if (ext === '.tga') size = tgaSize(file);
    } catch { /* 忽略 */ }
  }
  return {
    rel,
    exists,
    bytes: exists ? fs.statSync(file).size : 0,
    ext,
    dimension: size ? `${size.w}×${size.h}${size.bpp ? ` ${size.bpp}bpp` : ''}` : (ext === '.tga' ? 'TGA（未解析）' : '—'),
    usedBy: materials.filter((m) => m.texture === rel).map((m) => m.name),
    usedAsSphere: materials.filter((m) => m.sphere === rel).map((m) => m.name),
  };
});

const totalTris = materials.reduce((s, m) => s + m.triangles, 0);
const report = {
  file: path.basename(inputPath),
  bytes: fs.statSync(inputPath).size,
  geometry: { vertices: pmx.vertices.length, triangles: totalTris, materials: materials.length },
  deformDistribution: Object.fromEntries(Object.entries(deform).map(([k, v]) => [DEFORM_NAME[k] ?? k, v])),
  bones: { total: bones.length, ik: ikBones.length, deform: deformBones.length },
  morphs: { total: morphs.length, byType: morphByType },
  physics: { rigidBodies: rigidBodies.length, joints: constraints.length, byMode: physByMode, byShape: physByShape },
  materials,
  textures,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`# ${report.file}  (${(report.bytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`顶点 ${fmt(report.geometry.vertices)} | 三角面 ${fmt(totalTris)} | 材质 ${materials.length} | 骨骼 ${bones.length}（IK ${ikBones.length} / 变形 ${deformBones.length}）`);
  console.log(`变形器 ${morphs.length}  ${JSON.stringify(morphByType)}`);
  console.log(`物理刚体 ${rigidBodies.length}  ${JSON.stringify(physByMode)} | 关节 ${constraints.length}`);
  console.log(`\n顶点蒙皮分布:`);
  for (const [k, v] of Object.entries(report.deformDistribution)) console.log(`  ${k.padEnd(18)} ${fmt(v)}`);
  console.log(`\n材质（按面数降序）:`);
  for (const m of [...materials].sort((a, b) => b.triangles - a.triangles)) {
    const flags = Object.entries(m.flags).filter(([, v]) => v).map(([k]) => k).join(',');
    console.log(
      `  ${String(fmt(m.triangles)).padStart(8)} 面  ${m.name.padEnd(22)} tex=${(m.texture ?? '—').padEnd(30)} sphere=${m.sphere ?? '—'}${m.sphereMode ? `(${m.sphereMode})` : ''} toon=${m.toon ?? '—'} edge=${m.edge.flag ? m.edge.size.toFixed(2) : 'off'} [${flags}]`,
    );
  }
  console.log(`\n贴图:`);
  for (const t of textures) {
    console.log(`  ${t.dimension.padEnd(14)} ${(t.bytes / 1024 / 1024).toFixed(1)}MB  ${t.rel}  → ${t.usedBy.join(' / ') || '（未引用）'}`);
  }
}
