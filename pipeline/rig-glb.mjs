/**
 * 骨骼契约生成器 —— 按 pipeline/rig-rules.mjs 的约定解析每个模型，产出
 * **assets/models/rig-manifest.json**（运行期唯一数据源）。
 *
 * 做四件事（全部靠 GLB 实测，不靠命名猜）：
 *   ① **槽位解析**：候选骨名有序表 → 取「有权重者优先」的第一个
 *   ② **语义轴**：算每个槽位骨的 rest 世界旋转（四元数），运行期用它把
 *      语义欧拉换算到该骨的局部轴（§语义轴换算）
 *   ③ **物理链**：识别裙/发/袖/披肩的骨链（次级运动的对象）
 *   ④ **自检**：对解析出的槽位做「语义探针」——绕语义轴转 +15°，看末端
 *      是否朝预期的身体方向移动。这是防止槽位解析悄悄错位的兜底。
 *
 * 用法：
 *   node pipeline/rig-glb.mjs                 # 全部已登记模型
 *   node pipeline/rig-glb.mjs yelan si        # 指定模型
 *   node pipeline/rig-glb.mjs yelan --quiet   # 只写文件，不打印表
 */

import { NodeIO } from '@gltf-transform/core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  RIG_VERSION, AXES, slotDefs, fingerDefs, PHYS_RULES, ADDITIVE_PRESETS, HAND_POSES,
} from './rig-rules.mjs';

const io = new NodeIO();
const argv = process.argv.slice(2);
const quiet = argv.includes('--quiet');
const ids = argv.filter((a) => !a.startsWith('--'));

/* ---------------- 四元数小工具（顺序与 three 一致：x,y,z,w） ---------------- */

const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
const qAxis = (ax, rad) => {
  const s = Math.sin(rad / 2);
  const n = Math.hypot(...ax) || 1;
  return [(ax[0] / n) * s, (ax[1] / n) * s, (ax[2] / n) * s, Math.cos(rad / 2)];
};
const qRot = (q, v) => {
  // v' = q v q*
  const t = qMul(qMul(q, [v[0], v[1], v[2], 0]), qConj(q));
  return [t[0], t[1], t[2]];
};

/* ---------------- 主流程 ---------------- */

/** 已登记模型清单（从 charter manifest 读，保证与材质契约同一份名单） */
function modelList() {
  const p = 'assets/models/charter-manifest.json';
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')).models ?? [];
}

const all = modelList();
const wanted = ids.length ? all.filter((m) => ids.includes(m.id)) : all;
const unknown = ids.filter((i) => !all.some((m) => m.id === i));
if (unknown.length) console.warn(`⚠ 未在 charter manifest 登记，跳过: ${unknown.join(', ')}`);

const manifest = {
  rigVersion: RIG_VERSION,
  generatedAt: new Date().toISOString(),
  axes: AXES,
  // 与模型无关的两份预设也写进 manifest：运行期因此**只读 manifest**，
  // 不必去 import pipeline/ 下的约定文件（src 与 tools 的边界要守住）
  additives: ADDITIVE_PRESETS,
  handPoses: HAND_POSES,
  models: [],
};

/** three GLTFLoader 的名字清理规则（PropertyBinding.sanitizeNodeName） */
const sanitize = (n) => n.replace(/\s/g, '_').replace(/[[\].:/]/g, '');

for (const m of wanted) {
  const file = m.charterFile ?? `${m.id}.charter.glb`;
  const doc = await io.read(`assets/models/${file}`);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];

  // ---- 层级 ----
  const parent = new Map();
  const walk = (n) => { for (const c of n.listChildren()) { parent.set(c, n); walk(c); } };
  if (scene) for (const c of scene.listChildren()) walk(c);

  // ---- 骨骼集合 + 权重 ----
  const joints = [];
  for (const sk of root.listSkins()) for (const j of sk.listJoints()) joints.push(j);
  const jointIdx = new Map(joints.map((j, i) => [j, i]));

  // 道具件（武器 / 陈设）即使带几根骨，也不该出现在姿势编辑器里 ——
  // 判据用「语义骨命中数」而不是「有没有 skin」：武器有 skin 但一根语义骨都不占。
  if (!joints.length) {
    if (!quiet) console.log(`\n# ${m.id}（${m.name ?? ''}）无骨架，跳过（非角色资产）`);
    continue;
  }

  const vcount = new Map();
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const J = prim.getAttribute('JOINTS_0');
      const W = prim.getAttribute('WEIGHTS_0');
      if (!J || !W) continue;
      const ja = J.getArray(), wa = W.getArray();
      for (let i = 0; i < J.getCount(); i++) {
        for (let k = 0; k < 4; k++) {
          if (wa[i * 4 + k] <= 0.001) continue;
          const b = joints[ja[i * 4 + k]];
          if (b) vcount.set(b, (vcount.get(b) ?? 0) + 1);
        }
      }
    }
  }
  const weightOf = (b) => vcount.get(b) ?? 0;

  // ---- rest 世界变换（四元数 + 位置） ----
  const restQ = new Map();   // node → 世界旋转四元数
  const restP = new Map();   // node → 世界位置
  const worldOf = (n) => {
    if (restQ.has(n)) return;
    const p = parent.get(n);
    if (p) worldOf(p);
    const pq = p ? restQ.get(p) : [0, 0, 0, 1];
    const pp = p ? restP.get(p) : [0, 0, 0];
    const lq = n.getRotation();
    const lt = n.getTranslation();
    const q = qMul(pq, lq);
    const off = qRot(pq, lt);
    restQ.set(n, q);
    restP.set(n, [pp[0] + off[0], pp[1] + off[1], pp[2] + off[2]]);
  };
  for (const j of joints) worldOf(j);

  // ---- 名字索引（同名骨的第一个） ----
  const byName = new Map();
  for (const j of joints) {
    const n = j.getName() || '';
    if (!byName.has(n)) byName.set(n, j);
  }

  // ---- ① 槽位解析 ----
  const slots = {};
  const unresolved = [];
  for (const def of slotDefs()) {
    const cands = def.cands.map((c) => byName.get(c)).filter(Boolean);
    const bone = cands.find((b) => weightOf(b) > 0) ?? cands[0] ?? null;
    if (!bone) { unresolved.push(def.id); continue; }
    slots[def.id] = {
      bone: bone.getName(),
      key: sanitize(bone.getName()),   // 运行期按此匹配（GLTFLoader 会清理名字）
      cn: def.cn,
      side: def.side ?? null,
      weighted: weightOf(bone) > 0,
      verts: weightOf(bone),
      // rest 世界旋转 —— 语义轴换算的唯一依据
      q: restQ.get(bone).map((v) => +v.toFixed(6)),
    };
  }

  // 一根语义骨都没命中 → 不是角色资产（武器/陈设），不进 manifest
  if (!Object.keys(slots).length) {
    if (!quiet) console.log(`\n# ${m.id}（${m.name ?? ''}）无语义骨命中，跳过（非角色资产）`);
    continue;
  }

  // ---- ② 手指 ----
  const hands = {};  for (const fd of fingerDefs()) {
    const segs = fd.segs.map((n) => byName.get(n)).filter(Boolean);
    if (!segs.length) continue;
    const side = fd.side.slice(1); // l / r
    hands[side] ??= {};
    hands[side][fd.id.replace(/_[lr]$/, '')] = {
      cn: fd.cn,
      segs: segs.map((s) => sanitize(s.getName())),
      verts: segs.reduce((a, s) => a + weightOf(s), 0),
    };
  }

  // ---- ③ 物理链 ----
  const physBones = new Set(joints.filter((j) => PHYS_RULES.nameRe.test(j.getName() || '') && weightOf(j) > 0));
  const chains = [];
  for (const b of physBones) {
    const p = parent.get(b);
    if (p && physBones.has(p)) continue; // 只从链根起
    const segs = [];
    let cur = b;
    while (cur && physBones.has(cur) && segs.length < PHYS_RULES.maxSegs) {
      segs.push({ bone: sanitize(cur.getName()), verts: weightOf(cur) });
      const kids = cur.listChildren().filter((k) => physBones.has(k));
      cur = kids.length === 1 ? kids[0] : null; // 分叉就停（分叉不是一条链）
    }
    if (segs.length >= PHYS_RULES.minSegs) {
      chains.push({
        root: sanitize(b.getName()),
        rootQ: restQ.get(b).map((v) => +v.toFixed(6)),
        segs,
        verts: segs.reduce((a, s) => a + s.verts, 0),
      });
    }
  }
  chains.sort((a, b) => b.verts - a.verts);
  const keptChains = chains.slice(0, PHYS_RULES.maxChains);
  const physTotal = [...physBones].reduce((a, b) => a + weightOf(b), 0);

  // ---- ④ 自检：语义探针 ----
  /**
   * 绕某语义轴 +15° 时，末端相对该骨的位置向量怎么变。
   *
   * 为什么这等价于验证运行期的换算公式：
   *   设骨的世界旋转 R，运行期施加局部旋转 q = conj(R)·q_world·R
   *   （见 src/render/rig.ts 的语义轴换算），则末端新位置
   *     = P_bone + Rot(R · q) · rel     （rel = 末端相对骨的局部向量）
   *     = P_bone + Rot(R · conj(R) · q_world · R) · rel
   *     = P_bone + Rot(q_world) · (Rot(R) · rel)
   *     = P_bone + Rot(q_world) · (P_end − P_bone)
   *   —— 即「把末端相对骨的世界向量绕语义轴转 θ」。所以探针只要算后者。
   */
  const probe = (slotId) => {
    const s = slots[slotId];
    if (!s) return null;
    const bone = byName.get(s.bone);
    if (!bone) return null;
    // 测量末端：第一个有权重的后代，否则第一个子骨
    let end = null;
    const stack = [...bone.listChildren()];
    const first = stack[0] ?? null;
    while (stack.length) {
      const n = stack.shift();
      if (jointIdx.has(n) && weightOf(n) > 0) { end = n; break; }
      stack.push(...n.listChildren());
    }
    end ??= first;
    if (!end) return null;

    const bw = restP.get(bone), ew = restP.get(end);
    const rel = [ew[0] - bw[0], ew[1] - bw[1], ew[2] - bw[2]];
    const out = {};
    for (const [k, ax] of Object.entries({ pitch: AXES.right, yaw: AXES.up, roll: AXES.fwd })) {
      const q = qAxis(ax, Math.PI / 12);
      const d = qRot(q, rel);
      const dx = d[0] - rel[0], dy = d[1] - rel[1], dz = d[2] - rel[2];
      out[k] = {
        up: +dy.toFixed(3),
        fwd: +(-dz).toFixed(3),
        left: +(-dx).toFixed(3),
        len: +Math.hypot(dx, dy, dz).toFixed(3),
      };
    }
    return out;
  };

  const selfCheck = {};
  for (const id of Object.keys(slots)) {
    const p = probe(id);
    if (p) selfCheck[id] = p;
  }

  manifest.models.push({
    id: m.id,
    name: m.name,
    rigFile: file,
    stats: {
      joints: joints.length,
      weighted: [...joints].filter((j) => weightOf(j) > 0).length,
      slots: Object.keys(slots).length,
      slotTotal: slotDefs().length,
      physBones: physBones.size,
      physVerts: physTotal,
      physChains: chains.length,
    },
    slots,
    hands,
    physChains: keptChains,
    unresolvedSlots: unresolved,
    selfCheck,
  });

  // ---- 报告 ----
  if (!quiet) {
    const M = manifest.models.at(-1);
    console.log(`\n${'='.repeat(72)}`);
    console.log(`# ${m.id}（${m.name ?? ''}）  ${file}`);
    console.log(`  joints ${M.stats.joints} · 有权重 ${M.stats.weighted} · 槽位 ${M.stats.slots}/${M.stats.slotTotal}`
      + ` · 物理骨 ${M.stats.physBones}（${M.stats.physVerts} 权重顶点）· 物理链 ${M.stats.physChains}`);
    console.log(`\n  槽位                     骨名                  权重顶点  语义探针（+15° 末端去向）`);
    for (const [id, s] of Object.entries(slots)) {
      const p = selfCheck[id];
      const arrow = p ? `pitch ${fmt(p.pitch)}  yaw ${fmt(p.yaw)}  roll ${fmt(p.roll)}` : '';
      const bone = byName.get(s.bone);
      // 零权重不一定是问题：root/center/hip/twist 这类「结构骨」自身不吃权重，
      // 作用在子骨上（腰 是上下半身的分叉点，权重全在 下半身/上半身）。
      // 真问题只有「零权重 **且** 无子骨」——那种槽位驱动不了任何东西。
      const dead = !s.weighted && (!bone || bone.listChildren().length === 0);
      const flag = dead ? '⚠无效' : (s.weighted ? '' : '·结构');
      console.log(
        `  ${id.padEnd(22)} ${s.bone.padEnd(20)} ${String(s.verts).padStart(8)} ${flag.padEnd(6)} ${arrow}`,
      );
    }
    if (unresolved.length) console.log(`  ⚠ 未解析槽位: ${unresolved.join(', ')}`);
    const hL = hands.l ? Object.keys(hands.l) : [];
    console.log(`  手指: ${hL.length ? hL.join('/') : '—'}（左右各 ${hL.length} 指）`);
    console.log(`  物理链 top5: ${keptChains.slice(0, 5).map((c) => `${c.root}(${c.segs.length}段/${c.verts})`).join('  ')}`);
  }
}

function fmt(p) {
  const parts = [];
  if (Math.abs(p.up) > 0.012) parts.push(p.up > 0 ? '↑' : '↓');
  if (Math.abs(p.fwd) > 0.012) parts.push(p.fwd > 0 ? '前' : '后');
  if (Math.abs(p.left) > 0.012) parts.push(p.left > 0 ? '左' : '右');
  return (parts.join('') || '·').padEnd(4);
}

writeFileSync('assets/models/rig-manifest.json', JSON.stringify(manifest, null, 2));
const kb = (JSON.stringify(manifest).length / 1024).toFixed(1);
console.log(`\n→ assets/models/rig-manifest.json（${manifest.models.length} 个模型，${kb} KB，rig v${RIG_VERSION}）`);
