#!/usr/bin/env node
/**
 * 面部 SDF 烘焙 —— 从几何生成终末地格式的人脸阴影阈值场
 *
 * 用法:
 *   node pipeline/bake-face-sdf.mjs assets/models/<id>.charter.glb --out assets/models/<id>.face-sdf.png
 *   选项: --size 512(采样网格) --angles 72(半球扫光步数) --elev 0.3(光仰角) --eps 0.002(起点外推)
 *
 * 原理（终末地 / 米哈游系「脸部 SDF 阴影」的几何烘焙版——官方图是美术手绘多角度
 * 阴影后合成的阈值场，这里用光线投射直接算）：
 *   对脸部 UV 岛内每个 texel：
 *     ① UV → 模型空间位置 p 与法线 n（bind pose）
 *     ② 水平扫光：光从正前(0°)扫到正后(180°)，左半球(R)与右半球(G)各一遍，
 *        光方向 = forward·cosθ ± left·sinθ + up·elev
 *     ③ 每个角度做遮挡测试：从 p + n·ε 沿光方向投射线，命中任何网格(正面命中) = 阴影
 *     ④ 阈值 = 最后一次仍被照亮的角度 / 180° —— 与官方 SDF 的 R/G 同语义：
 *       1 = 光转到背后才变暗，0 = 光稍偏就暗
 *   A 通道 = 鼻尖 mask（脸上最前突处径向衰减，黑 = 鼻尖；渲染端光到侧后方时加深鼻尖投影）
 *   B 通道 = max(R, G)（占位；官方 B 是另一张染色/阴影场，语义未逆向，暂不用）
 *
 * 依赖：three + three-mesh-bvh（BVH 加速，全模 ~4 万三角形在数秒内可烘完）。
 * 烘完跑一次 pipeline/charter-glb.mjs 重转契约版（faceSdf 字段指向产物）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const glbPath = argv.find((a) => !a.startsWith('--') && a !== argv[argv.indexOf('--out') + 1]);
const outPath = arg('out', null) ?? glbPath.replace(/\.charter\.glb$/, '.face-sdf.png').replace(/\.glb$/, '.face-sdf.png');
const SIZE = parseInt(arg('size', '512'), 10);
const ANGLES = parseInt(arg('angles', '72'), 10);
const ELEV = parseFloat(arg('elev', '0.3'));
const EPS = parseFloat(arg('eps', '0.002'));

if (!glbPath || !fs.existsSync(glbPath)) {
  console.error('用法: node pipeline/bake-face-sdf.mjs assets/models/<id>.charter.glb --out <png> [--size 512] [--angles 72]');
  process.exit(1);
}

console.log(`读 ${glbPath}`);
const io = new NodeIO();
const doc = await io.read(glbPath);
const root = doc.getRoot();

/* ---------- 收集几何：脸部 prims（采样对象）与全模 prims（遮挡体） ---------- */

const facePrims = [];
const occluders = [];
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const role = prim.getMaterial()?.getExtras()?.charter?.role;
    const pos = prim.getAttribute('POSITION');
    const uv = prim.getAttribute('TEXCOORD_0');
    const idx = prim.getIndices();
    if (!pos || !uv || !idx) continue;
    const rec = {
      pos: pos.getArray(),
      uv: uv.getArray(),
      idx: idx.getArray(),
      tris: idx.getCount() / 3,
      role,
    };
    if (role === 'face') facePrims.push(rec);
    // 遮挡体：整模（含脸自身——鼻梁/眉弓的自遮挡正是 SDF 要捕捉的形状）
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rec.pos), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(rec.idx), 1));
    g.computeBoundsTree();
    occluders.push(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.FrontSide })));
  }
}
if (!facePrims.length) {
  console.error('✗ 没找到 role=face 的网格（需要契约版 GLB）');
  process.exit(1);
}
console.log(`脸部 prims ${facePrims.length}（${facePrims.reduce((n, p) => n + p.tris, 0)} tri）· 遮挡体 ${occluders.length} 个网格`);

// 模型包围半径 → 射线最大距离与 ε
const box = new THREE.Box3();
for (const o of occluders) box.expandByObject(o);
const diag = box.getSize(new THREE.Vector3()).length();
const maxDist = diag * 1.5;
const eps = diag * EPS;
console.log(`模型对角 ${diag.toFixed(2)} · 射线上限 ${maxDist.toFixed(2)} · ε=${eps.toFixed(4)}`);

const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
raycaster.far = maxDist;

/* ---------- UV 栅格化：每个 texel 存位置/法线 ---------- */

const N = SIZE * SIZE;
const pxPos = new Float32Array(N * 3);
const pxNrm = new Float32Array(N * 3);
const island = new Uint8Array(N);
let islandCount = 0;

for (const prim of facePrims) {
  const { pos, uv, idx } = prim;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const u = [uv[a * 2], uv[b * 2], uv[c * 2]];
    const v = [uv[a * 2 + 1], uv[b * 2 + 1], uv[c * 2 + 1]];
    const X = [pos[a * 3], pos[b * 3], pos[c * 3]];
    const Y = [pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1]];
    const Z = [pos[a * 3 + 2], pos[b * 3 + 2], pos[c * 3 + 2]];
    const minX = Math.max(0, Math.floor(Math.min(...u) * SIZE));
    const maxX = Math.min(SIZE - 1, Math.ceil(Math.max(...u) * SIZE));
    const minY = Math.max(0, Math.floor(Math.min(...v) * SIZE));
    const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(...v) * SIZE));
    const d = (v[1] - v[2]) * (u[0] - u[2]) + (u[2] - u[1]) * (v[0] - v[2]);
    if (Math.abs(d) < 1e-12) continue;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const x = (px + 0.5) / SIZE, y = (py + 0.5) / SIZE;
        const l1 = ((v[1] - v[2]) * (x - u[2]) + (u[2] - u[1]) * (y - v[2])) / d;
        const l2 = ((v[2] - v[0]) * (x - u[2]) + (u[0] - u[2]) * (y - v[2])) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < -0.001 || l2 < -0.001 || l3 < -0.001) continue;
        const o = py * SIZE + px;
        pxPos[o * 3] = X[0] * l1 + X[1] * l2 + X[2] * l3;
        pxPos[o * 3 + 1] = Y[0] * l1 + Y[1] * l2 + Y[2] * l3;
        pxPos[o * 3 + 2] = Z[0] * l1 + Z[1] * l2 + Z[2] * l3;
        // 面法线（几何法线，bind pose）
        const e1 = new THREE.Vector3(X[1] - X[0], Y[1] - Y[0], Z[1] - Z[0]);
        const e2 = new THREE.Vector3(X[2] - X[0], Y[2] - Y[0], Z[2] - Z[0]);
        const nrm = e1.cross(e2).normalize();
        pxNrm[o * 3] = nrm.x; pxNrm[o * 3 + 1] = nrm.y; pxNrm[o * 3 + 2] = nrm.z;
        if (!island[o]) { island[o] = 1; islandCount++; }
      }
    }
  }
}
console.log(`UV 岛 texel ${islandCount.toLocaleString()} / ${N.toLocaleString()}`);

/* ---------- 扫光：每个 texel 左右半球各找「最后一次被照亮的角度」 ---------- */

// 模型空间轴向（PMX 转出 rot=0 正面朝 -Z，已实证）
const FWD = new THREE.Vector3(0, 0, -1);
const LEFT = new THREE.Vector3(-1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

const thrR = new Float32Array(N); // 左半球（光从角色左侧来）
const thrG = new Float32Array(N); // 右半球
const p = new THREE.Vector3();
const n = new THREE.Vector3();
const L = new THREE.Vector3();
const angles = [];
for (let i = 0; i <= ANGLES; i++) angles.push((i / ANGLES) * Math.PI); // 0..180°

function sweep(side, out) {
  for (let o = 0; o < N; o++) {
    if (!island[o]) continue;
    p.set(pxPos[o * 3], pxPos[o * 3 + 1], pxPos[o * 3 + 2]);
    n.set(pxNrm[o * 3], pxNrm[o * 3 + 1], pxNrm[o * 3 + 2]);
    p.addScaledVector(n, eps); // 沿法线外推，避免起始自交
    let lastLit = 0;
    for (let i = angles.length - 1; i >= 0; i--) {
      // 从背后往回找第一个被照亮的角度（大多数 texel 在背后是暗的）
      const th = angles[i];
      L.copy(FWD).multiplyScalar(Math.cos(th)).addScaledVector(side, Math.sin(th)).addScaledVector(UP, ELEV).normalize();
      raycaster.set(p, L);
      const hit = raycaster.intersectObjects(occluders, false);
      if (!hit.length) { lastLit = th; break; }
    }
    out[o] = lastLit / Math.PI;
  }
}

console.time('扫光·左半球');
sweep(LEFT, thrR);
console.timeEnd('扫光·左半球');
console.time('扫光·右半球');
sweep(LEFT.clone().negate(), thrG);
console.timeEnd('扫光·右半球');

/* ---------- 鼻尖 mask：脸中部最前突的 texel ---------- */

let noseO = -1, noseScore = -Infinity;
const bh = box.max.y - box.min.y;
for (let o = 0; o < N; o++) {
  if (!island[o]) continue;
  const y = pxPos[o * 3 + 1], z = pxPos[o * 3 + 2];
  if (pxNrm[o * 3 + 2] > -0.5) continue;           // 法线要朝前
  // 脸在全身包围盒的上部（角色是站姿）：72%–95% 高度带 ≈ 眉眼到下巴
  const relY = (y - box.min.y) / bh;
  if (relY < 0.72 || relY > 0.95) continue;
  if (-z > noseScore) { noseScore = -z; noseO = o; }
}
const noseA = new Float32Array(N).fill(1);
if (noseO >= 0) {
  const nx = pxPos[noseO * 3], ny = pxPos[noseO * 3 + 1], nz = pxPos[noseO * 3 + 2];
  const sigma = diag * 0.02;
  for (let o = 0; o < N; o++) {
    if (!island[o]) continue;
    const dx = pxPos[o * 3] - nx, dy = pxPos[o * 3 + 1] - ny, dz = pxPos[o * 3 + 2] - nz;
    const d2 = dx * dx + dy * dy + dz * dz;
    noseA[o] = Math.min(1, Math.max(0.05, Math.exp(-d2 / (2 * sigma * sigma))));
  }
  console.log(`鼻尖 @ (${nx.toFixed(2)}, ${ny.toFixed(2)}, ${nz.toFixed(2)})`);
} else {
  console.log('⚠ 未定位到鼻尖（A 通道全白，渲染端鼻尖加深不生效）');
}

/* ---------- 3×3 高斯平滑（阈值场去射线噪声，只动岛内） ---------- */

function blur(field) {
  const src = field.slice();
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      const o = y * SIZE + x;
      if (!island[o]) continue;
      let sum = 0, wsum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = (y + dy) * SIZE + (x + dx);
          if (!island[k]) continue;
          const w = dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
          sum += src[k] * w; wsum += w;
        }
      }
      field[o] = wsum ? sum / wsum : src[o];
    }
  }
}
blur(thrR); blur(thrG); blur(thrR); blur(thrG);

/* ---------- 写 PNG ---------- */

const png = new PNG({ width: SIZE, height: SIZE });
for (let o = 0; o < N; o++) {
  const r = island[o] ? Math.round(thrR[o] * 255) : 0;
  const g = island[o] ? Math.round(thrG[o] * 255) : 0;
  const b = island[o] ? Math.round(Math.max(thrR[o], thrG[o]) * 255) : 0;
  const a = island[o] ? Math.round(noseA[o] * 255) : 255;
  png.data[o * 4] = r; png.data[o * 4 + 1] = g; png.data[o * 4 + 2] = b; png.data[o * 4 + 3] = a;
}
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, PNG.sync.write(png));

// 阈值场直方图（ sanity check：健康的场应该在 0.3–0.9 之间连续分布）
const bins = new Array(10).fill(0);
for (let o = 0; o < N; o++) if (island[o]) bins[Math.min(9, Math.floor(thrR[o] * 10))]++;
console.log(`阈值分布(R): ${bins.map((b, i) => `${i / 10}-${(b / islandCount * 100).toFixed(0)}%`).join(' ')}`);
console.log(`✓ ${outPath}（${SIZE}×${SIZE}）`);
console.log('下一步: 跑 node pipeline/charter-glb.mjs 重转契约版（若档案里 faceSdf 指向本产物则字段已就绪）');
