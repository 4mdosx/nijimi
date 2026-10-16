/**
 * 演示动画生成器 —— 生成 `assets/models/anims/demo-wave.anim.glb`（挥手，2.4s 循环）。
 *
 * 用途有两个：
 *   ① 给姿势实验台的「外部动画」面板一份能直接试播的资产（Blender 还没进流程时）；
 *   ② **走契约生成**：关键帧按语义欧拉写，经 rig-manifest 的 restQ 换算成骨局部四元数
 *      ——和运行期 Rig 同一条数学路径，等于给管线做了一次端到端验证。
 *
 * 产出是**动画-only GLB**：场景里只放被驱动的骨架同名 stub 节点
 * （glTF 规范要求 channel 必须指向文件内节点）。真实生产流程在 Blender 里做，
 * 见 design/动画制作-Blender导出到运行时流程.md。
 *
 * 用法: node pipeline/make-demo-anim.mjs [--model yelan] [--out assets/models/anims/demo-wave.anim.glb]
 */

import fs from 'node:fs';
import path from 'node:path';
import { NodeIO, Document } from '@gltf-transform/core';
import { RIG_VERSION } from './rig-rules.mjs';

const argv = process.argv.slice(2);
const argOf = (k, dflt) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const modelId = argOf('--model', 'yelan');
const outPath = argOf('--out', 'assets/models/anims/demo-wave.anim.glb');

const manifest = JSON.parse(fs.readFileSync('assets/models/rig-manifest.json', 'utf-8'));
const model = manifest.models.find((m) => m.id === modelId);
if (!model) {
  console.error(`✗ rig-manifest 里没有 ${modelId}（先跑 node pipeline/rig-glb.mjs）`);
  process.exit(1);
}

const DEG = Math.PI / 180;

/** 语义欧拉 → 骨局部四元数（与 src/render/rig.ts 的 localOf 同式：q_local = conj(R)·q_world·R） */
function semanticToLocal(slot, pitch, yaw, roll) {
  // 手写欧拉 YXZ → 四元数（不引 three，工具侧保持零运行时依赖）
  const q = eulerYXZ(pitch * DEG, yaw * DEG, roll * DEG);
  const R = slot.q; // rest 世界旋转 [x,y,z,w]
  return quatConjMul(R, q); // conj(R) · q_world · R
}

function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const quatConj = (q) => [-q[0], -q[1], -q[2], q[3]];
/** conj(R) · q · R */
function quatConjMul(R, q) {
  const c = quatConj(R);
  return quatMul(quatMul(c, q), R);
}

/** 欧拉 YXZ（先转 yaw、再 pitch、最后 roll）→ 四元数 q_world = Ry·Rx·Rz */
function eulerYXZ(x, y, z) {
  const cx = Math.cos(x / 2), sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2), sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2), sz = Math.sin(z / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

/* ------------------------------------------------------------------ *
 * 关键帧：挥手（左臂抬起 + 前臂左右摆）+ 躯干轻微侧倾
 * 语义欧拉的数值是「身体空间」的——换模型不用改这里。
 * ------------------------------------------------------------------ */

const DURATION = 2.4;
const KEYS = [
  // t     └─ 左上臂 [pitch,yaw,roll] ─ 左前臂 ─ 左手腕 ─ 脊柱
  { t: 0.0, upperarm_l: [0, 0, -48], lowerarm_l: [0, 0, 0], wrist_l: [0, 0, 0], spine: [0, 0, 0] },
  { t: 0.3, upperarm_l: [0, 0, -55], lowerarm_l: [0, 25, 20], wrist_l: [0, 10, 0], spine: [0, 0, 2] },
  { t: 0.9, upperarm_l: [0, 0, -55], lowerarm_l: [0, -25, 20], wrist_l: [0, -12, 0], spine: [0, 0, -2] },
  { t: 1.5, upperarm_l: [0, 0, -55], lowerarm_l: [0, 25, 20], wrist_l: [0, 10, 0], spine: [0, 0, 2] },
  { t: 2.1, upperarm_l: [0, 0, -55], lowerarm_l: [0, -25, 20], wrist_l: [0, -12, 0], spine: [0, 0, -2] },
  { t: 2.4, upperarm_l: [0, 0, -48], lowerarm_l: [0, 0, 0], wrist_l: [0, 0, 0], spine: [0, 0, 0] },
];

// 生成每根骨的时间轴与四元数序列
const boneTracks = new Map(); // 骨名 → { times: number[], quats: number[] }
for (const key of KEYS) {
  const t = key.t;
  for (const [slotId, eul] of Object.entries(key)) {
    if (slotId === 't') continue;
    const slot = model.slots[slotId];
    if (!slot) { console.error(`✗ ${modelId} 没有 ${slotId} 槽位`); process.exit(1); }
    const q = semanticToLocal(slot, eul[0], eul[1], eul[2]);
    const tr = boneTracks.get(slot.bone) ?? { times: [], quats: [] };
    tr.times.push(t);
    tr.quats.push(...q);
    boneTracks.set(slot.bone, tr);
  }
}

/* ------------------------------------------------------------------ *
 * 写动画-only GLB
 * ------------------------------------------------------------------ */

const io = new NodeIO();
const doc = new Document();
doc.createBuffer(); // accessor 的二进制载体（GLB 写出时会自动打包进 buffer）
doc.getRoot().listScenes()[0] ?? doc.createScene('Scene');
const scene = doc.getRoot().listScenes()[0];
const anim = doc.createAnimation(`wave (rig v${RIG_VERSION}, demo)`);

for (const [boneName, tr] of boneTracks) {
  // stub 节点：动画-only GLB 的 channel 必须指向文件内节点，名字=骨架骨名
  const node = doc.createNode(boneName);
  scene.addChild(node);
  const input = doc.createAccessor(`${boneName}.times`)
    .setType('SCALAR').setArray(new Float32Array(tr.times));
  const output = doc.createAccessor(`${boneName}.quat`)
    .setType('VEC4').setArray(new Float32Array(tr.quats));
  const sampler = doc.createAnimationSampler()
    .setInput(input).setOutput(output).setInterpolation('LINEAR');
  const channel = doc.createAnimationChannel()
    .setTargetNode(node).setTargetPath('rotation').setSampler(sampler);
  anim.addChannel(channel).addSampler(sampler);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
await io.write(outPath, doc);
const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
console.log(`→ ${outPath}（${kb} KB，${boneTracks.size} 条四元数轨道，${DURATION}s 循环）`);
console.log('  到姿势实验台的「外部动画」面板试播，或 node pipeline/anim-audit.mjs ' + outPath);
