/**
 * UV 归属审查（一次性诊断）：多材质 UV 覆盖三色叠加在同一张贴图上，
 * 判断图集各区域的语义归属。红=第1个材质 绿=第2个 蓝=第3个。
 * 用法: node pipeline/uv-own.mjs <glb> <材质名,材质名,材质名> [输出路径]
 */
import { NodeIO } from '@gltf-transform/core';
import { PNG } from 'pngjs';
import fs from 'node:fs';

const [, , glbPath, matList, outPath = '/tmp/uv-own.png'] = process.argv;
const NAMES = matList.split(',');
const COLORS = [[255, 40, 40], [40, 220, 80], [60, 90, 255]];
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

// 收集各材质（首贴图）的掩码，同贴图才可比
const byTex = new Map(); // texture name -> {tex, masks: [{name, mask}]}
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial();
    const name = mat ? mat.getName() : '?';
    if (!NAMES.includes(name)) continue;
    const bc = mat.getBaseColorTexture();
    if (!bc) continue;
    const key = bc.getName();
    if (!byTex.has(key)) byTex.set(key, { tex: bc, masks: [] });
    byTex.get(key).masks.push({ name, mask: uvMask(prim, W) });
  }
}

for (const [texName, { tex, masks }] of byTex) {
  const png = PNG.sync.read(Buffer.from(tex.getImage()));
  const out = new PNG({ width: W, height: W });
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const sx = Math.min(png.width - 1, Math.round((x / W) * png.width));
      const sy = Math.min(png.height - 1, Math.round((y / W) * png.height));
      const s = (sy * png.width + sx) * 4;
      let r = Math.round(png.data[s] * 0.3);
      let g = Math.round(png.data[s + 1] * 0.3);
      let b = Math.round(png.data[s + 2] * 0.3);
      masks.forEach(({ name, mask }, i) => {
        if (!mask[y * W + x]) return;
        const c = COLORS[i % COLORS.length];
        r = Math.max(r, c[0]); g = Math.max(g, c[1]); b = Math.max(b, c[2]);
      });
      out.data[o] = r; out.data[o + 1] = g; out.data[o + 2] = b; out.data[o + 3] = 255;
    }
  }
  const f = outPath.replace(/\.png$/, '') + `-${texName}.png`;
  fs.writeFileSync(f, PNG.sync.write(out));
  console.log(`${f}（${NAMES.map((n, i) => ['红', '绿', '蓝'][i] + '=' + n).join(' ')}）`);
}
