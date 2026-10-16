/**
 * UV 覆盖审查（一次性诊断脚本）：把指定材质网格的 UV 三角形栅格化到掩码，
 * 在贴图上以红色高亮覆盖区 → 直观判断「这个网格实际取的是贴图哪些语义区域」。
 * 用法: node pipeline/uv-audit.mjs <glb> <材质名,...> [输出前缀]
 */
import { NodeIO } from '@gltf-transform/core';
import { PNG } from 'pngjs';
import fs from 'node:fs';

const [, , glbPath, matList, outPrefix = '/tmp/uv-audit'] = process.argv;
const TARGETS = new Set(matList.split(','));
const W = 1024;

const io = new NodeIO();
const doc = await io.read(glbPath);

function uvMask(prim, W) {
  const uv = prim.getAttribute('TEXCOORD_0').getArray();
  const idx = prim.getIndices().getArray();
  const mask = new Uint8Array(W * W);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const P = (i) => [uv[i * 2] * W, uv[i * 2 + 1] * W];
    const [x1, y1] = P(a), [x2, y2] = P(b), [x3, y3] = P(c);
    const minX = Math.max(0, Math.floor(Math.min(x1, x2, x3)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(x1, x2, x3)));
    const minY = Math.max(0, Math.floor(Math.min(y1, y2, y3)));
    const maxY = Math.min(W - 1, Math.ceil(Math.max(y1, y2, y3)));
    const d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
    if (Math.abs(d) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const l1 = ((y2 - y3) * (x + 0.5 - x3) + (x3 - x2) * (y + 0.5 - y3)) / d;
        const l2 = ((y3 - y1) * (x + 0.5 - x3) + (x1 - x3) * (y + 0.5 - y3)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 >= -0.002 && l2 >= -0.002 && l3 >= -0.002) mask[y * W + x] = 1;
      }
    }
  }
  return mask;
}

for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial();
    const name = mat ? mat.getName() : '?';
    if (!TARGETS.has(name)) continue;
    const bc = mat.getBaseColorTexture();
    if (!bc) { console.log(`${name}: 无贴图，跳过`); continue; }
    const png = PNG.sync.read(Buffer.from(bc.getImage()));
    const mask = uvMask(prim, W);
    const out = new PNG({ width: W, height: W });
    // 贴图缩到 W² 后叠红。掩码 y 与贴图 v 同向（v 向下），PNG 行序自上而下，
    // 阵列第 0 行 = v=0 = 贴图顶行 → 直接顺序写即对齐。
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const sx = Math.min(png.width - 1, Math.round((x / W) * png.width));
        const sy = Math.min(png.height - 1, Math.round((y / W) * png.height));
        const s = (sy * png.width + sx) * 4;
        const cov = mask[y * W + x];
        out.data[o]     = cov ? 255 : Math.round(png.data[s] * 0.35);
        out.data[o + 1] = cov ? Math.round(png.data[s + 1] * 0.35) : Math.round(png.data[s + 1] * 0.35);
        out.data[o + 2] = cov ? Math.round(png.data[s + 2] * 0.35) : Math.round(png.data[s + 2] * 0.35);
        out.data[o + 3] = 255;
      }
    }
    const f = `${outPrefix}-${name}.png`;
    fs.writeFileSync(f, PNG.sync.write(out));
    let cov = 0;
    for (let k = 0; k < mask.length; k++) cov += mask[k];
    console.log(`${name}: 覆盖率 ${(cov / (W * W) * 100).toFixed(1)}% → ${f}`);
  }
}
