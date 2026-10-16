/**
 * 一次性诊断：si 脸部 UV × 官方 SDF 贴图对齐检查 + 通道拆解。
 * 用法: node /tmp/sdf-dbg.mjs
 */
import { NodeIO } from '@gltf-transform/core';
import { PNG } from 'pngjs';
import fs from 'node:fs';

const GLB = 'assets/models/si.charter.glb';
const SDF_PATH = 'assets/refs/si/other tex/T_actor_common_female_face_01_SDF.png';
const OUT = '/tmp/sdf-dbg';
fs.mkdirSync(OUT, { recursive: true });

const io = new NodeIO();
const doc = await io.read(GLB);

// 1) 列出全部材质与贴图名
for (const mat of doc.getRoot().listMaterials()) {
  const bc = mat.getBaseColorTexture();
  console.log(`mat「${mat.getName()}」 role=${JSON.stringify(mat.getExtras())} bc=${bc ? bc.getName() : '-'}`);
}

// 2) 找脸部材质（名字含「颜」或 face）
const sdf = PNG.sync.read(fs.readFileSync(SDF_PATH));
console.log(`SDF: ${sdf.width}x${sdf.height}`);

function channelPng(png, ch, name) {
  const out = new PNG({ width: png.width, height: png.height });
  for (let i = 0; i < png.width * png.height; i++) {
    const v = png.data[i * 4 + ch];
    out.data[i * 4] = v; out.data[i * 4 + 1] = v; out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(`${OUT}/${name}.png`, PNG.sync.write(out));
}

// 通道统计
const stats = [0, 1, 2, 3].map((ch) => ({ min: 255, max: 0, sum: 0, n: 0 }));
for (let i = 0; i < sdf.width * sdf.height; i++) {
  for (const ch of [0, 1, 2, 3]) {
    const v = sdf.data[i * 4 + ch];
    const s = stats[ch];
    s.min = Math.min(s.min, v); s.max = Math.max(s.max, v); s.sum += v; s.n++;
  }
}
console.log('通道统计 min/max/mean:');
stats.forEach((s, ch) => console.log(`  ${'RGBA'[ch]}: ${s.min}/${s.max}/${(s.sum / s.n).toFixed(1)}`));

channelPng(sdf, 0, 'sdf_R');
channelPng(sdf, 1, 'sdf_G');
channelPng(sdf, 2, 'sdf_B');
channelPng(sdf, 3, 'sdf_A');

// 3) 脸部 UV 掩码叠加到 SDF 上（青色高亮）
const W = 512;
const mask = new Uint8Array(W * W);
let hit = 0;
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial();
    const n = mat ? mat.getName() : '';
    if (!/颜|面|face/i.test(n)) continue;
    const uv = prim.getAttribute('TEXCOORD_0').getArray();
    const idx = prim.getIndices().getArray();
    const P = (i) => [uv[i * 2] * W, uv[i * 2 + 1] * W];
    for (let t = 0; t < idx.length; t += 3) {
      const [x1, y1] = P(idx[t]), [x2, y2] = P(idx[t + 1]), [x3, y3] = P(idx[t + 2]);
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
          if (l1 >= -0.002 && l2 >= -0.002 && l3 >= -0.002) { const o = y * W + x; if (!mask[o]) { mask[o] = 1; hit++; } }
        }
      }
    }
    console.log(`脸部网格「${n}」UV 点数=${uv.length / 2}`);
  }
}
console.log(`UV 掩码覆盖 ${hit} px / ${W * W}`);

const ov = new PNG({ width: W, height: W });
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const sx = Math.min(sdf.width - 1, Math.round((x / W) * sdf.width));
    const sy = Math.min(sdf.height - 1, Math.round((y / W) * sdf.height));
    const s = (sy * sdf.width + sx) * 4;
    const m = mask[y * W + x];
    ov.data[o] = m ? Math.min(255, sdf.data[s] * 0.4 + 100) : sdf.data[s] * 0.5;
    ov.data[o + 1] = m ? Math.min(255, sdf.data[s + 1] * 0.4 + 100) : sdf.data[s + 1] * 0.5;
    ov.data[o + 2] = m ? 255 : sdf.data[s + 2] * 0.5;
    ov.data[o + 3] = 255;
  }
}
fs.writeFileSync(`${OUT}/sdf_uv_overlay.png`, PNG.sync.write(ov));
console.log(`输出: ${OUT}/sdf_{R,G,B,A}.png + sdf_uv_overlay.png`);
