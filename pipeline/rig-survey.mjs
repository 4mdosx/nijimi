/**
 * 骨骼调查（RIG SURVEY）—— 动作库的地基工具。
 *
 * 回答三个问题，全部靠 GLB 实测，不靠命名猜：
 *   ① **哪些骨真的驱动网格**（按顶点权重统计）—— 区分 语义骨 / 物理骨 / 表情骨，
 *      动作库只该碰前者 + 少量后者；
 *   ② **每根骨的局部轴对应哪个语义方向**（前后俯仰 / 左右侧摆 / 自身扭转）——
 *      对手摆动作与外部动画重定向都是必需信息；
 *   ③ 骨架**层级与规模**（总 joint 数 vs 有效骨数）。
 *
 * 原理（②）：对骨施加 ±θ 绕局部单轴的旋转，重算其子树世界矩阵，
 * 量测「测量末端」的世界位移 Δ，再把 Δ 投影到身体语义轴。
 * 身体语义轴由实测锚定，不用猜：角色左 = -X（左目 x<0）、前 = -Z（つま先 z<0）、上 = +Y。
 *
 * 用法：
 *   node pipeline/rig-survey.mjs <id> [...]          # 全部骨（长）
 *   node pipeline/rig-survey.mjs <id> --core         # 只看语义骨候选（推荐）
 *   node pipeline/rig-survey.mjs <id> --json         # 机器可读，供 rig-rules 生成
 */

import { NodeIO } from '@gltf-transform/core';
import { writeFileSync } from 'node:fs';

/* ---------------- 极简 mat4 / vec3（列主序，与 glTF 一致） ---------------- */

const m4 = () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function mul(a, b) {
  const o = m4();
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

function fromTRS(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return new Float64Array([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ]);
}

/** 四元数 → 旋转矩阵（列主序） */
function fromQ(q) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return new Float64Array([
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ]);
}

function quatMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

const axisAngle = (axis, rad) => {
  const s = Math.sin(rad / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2)];
};

const AXES = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

/** 4x4 变换点 */
function xf(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/* ---------------- 语义骨候选（MMD 标准骨架，三只模型实测一致） ---------------- */

/**
 * MMD 标准骨架的语义骨名（日文原名）。日/中/英混用的都收。
 * 拆包 PMX 一律是 MMD 标准骨架 —— 这是本项目能「一套动作库跑所有模型」的事实基础。
 */
const CORE = [
  '全ての親', 'センター', 'センター2', 'グルーブ', 'グルーブ2', '腰',
  '上半身', '上半身1', '上半身2', '下半身',
  '首', '頭', '両目', '左目', '右目',
  '左肩', '右肩', '左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首',
  '左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首', '左つま先', '右つま先',
  // —— 下面这些是「权重真正的落点」或 MMD 辅助骨，是否入槽位由实测决定 ——
  '左足D', '右足D', '左ひざD', '右ひざD', '左足首D', '右足首D', '左足先EX', '右足先EX',
  '左腕捩', '右腕捩', '左腕捩1', '右腕捩1', '腰キャンセル左', '腰キャンセル右',
  '左足ＩＫ', '右足ＩＫ', '左足IK親', '右足IK親', '左つま先ＩＫ', '右つま先ＩＫ',
];

/** 物理/辅助骨判定：这些骨在 PMX 里由物理或 IK 驱动，动作库不该直接 K */
const PHYS_RE = /^(裙|Bone_|Hair|hair|スカート|胸|尻|袖|マント)|捩|補助|付与|^.*IK($|親)|ＩＫ|先EX|^目先$/;

/* ---------------- 主流程 ---------------- */

const io = new NodeIO();
const args = process.argv.slice(2);
const coreOnly = args.includes('--core');
const asJson = args.includes('--json');
const topN = (() => {
  const i = args.indexOf('--top');
  return i >= 0 ? parseInt(args[i + 1], 10) : 0; // 0 = 全部
})();
const ids = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));

for (const id of ids) {
  const doc = await io.read(`assets/models/${id}.charter.glb`);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];

  // ---- 层级：node → parent / children ----
  const parent = new Map();
  const all = [];
  const walk = (n) => { all.push(n); for (const c of n.listChildren()) { parent.set(c, n); walk(c); } };
  if (scene) for (const c of scene.listChildren()) walk(c);

  /** rest 局部矩阵（glTF 节点可能是 matrix 或 TRS） */
  const localRest = (n) => {
    const mm = n.getMatrix();
    if (mm && !mm.every((v, i) => Math.abs(v - m4()[i]) < 1e-9)) return new Float64Array(mm);
    return fromTRS(n.getTranslation(), n.getRotation(), n.getScale());
  };

  const restCache = new Map();
  const restWorld = (n) => {
    if (restCache.has(n)) return restCache.get(n);
    const p = parent.get(n);
    const m = p ? mul(restWorld(p), localRest(n)) : localRest(n);
    restCache.set(n, m);
    return m;
  };

  // ---- 骨骼集合（skin joints） ----
  const bones = new Set();
  for (const sk of root.listSkins()) for (const j of sk.listJoints()) bones.add(j);

  // ---- ① 权重统计：每根骨影响多少顶点（跨所有 primitive 累加） ----
  const vcount = new Map();
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const J = prim.getAttribute('JOINTS_0');
      const W = prim.getAttribute('WEIGHTS_0');
      if (!J || !W) continue;
      const ja = J.getArray(), wa = W.getArray();
      const comp = J.getComponentType?.() === 5123 ? 1 : 0; // ushort vs ubyte（这里都按元素读）
      void comp;
      const count = J.getCount();
      const idxList = [...bones];
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < 4; k++) {
          const w = wa[i * 4 + k];
          if (w <= 0.001) continue;
          const ji = ja[i * 4 + k];
          const b = idxList[ji];
          if (b) vcount.set(b, (vcount.get(b) ?? 0) + 1);
        }
      }
    }
  }

  // ---- ② 三轴旋向实测：把每根骨的局部单轴旋转投影到语义空间 ----
  const IDENTITY_REST = (() => { const t = m4(); return t; })();
  void IDENTITY_REST;

  /** 世界矩阵（在指定骨上叠加额外局部旋转） */
  const worldWith = (n, extraBone, extraQ) => {
    const p = parent.get(n);
    let local = localRest(n);
    if (n === extraBone) local = mul(local, fromQ(extraQ)); // 右乘 = 局部轴后置旋转
    return p ? mul(worldWith(p, extraBone, extraQ), local) : local;
  };

  /** 测量末端：骨后代的第一个「有权重的骨」，没有则用第一个子骨 */
  const measureEnd = (b) => {
    const stack = [...b.listChildren()];
    let firstChild = stack[0] ?? null;
    while (stack.length) {
      const n = stack.shift();
      if (bones.has(n) && (vcount.get(n) ?? 0) > 0) return n;
      stack.push(...n.listChildren());
    }
    return firstChild;
  };

  const axisProbe = (b) => {
    const end = measureEnd(b);
    if (!end) return null;
    const base = xf(restWorld(end), [0, 0, 0]);
    const out = {};
    for (const [name, ax] of Object.entries(AXES)) {
      const q = axisAngle(ax, Math.PI / 12); // 15°
      const wm = worldWith(end, b, q);
      const p = xf(wm, [0, 0, 0]);
      const d = [p[0] - base[0], p[1] - base[1], p[2] - base[2]];
      const len = Math.hypot(...d);
      out[name] = {
        // 语义方向：上=+Y / 前=-Z / 左=-X
        up: +d[1].toFixed(4), fwd: +(-d[2]).toFixed(4), left: +(-d[0]).toFixed(4),
        len: +len.toFixed(4),
      };
    }
    return out;
  };

  // ---- ③ 输出 ----
  const byName = new Map();
  for (const b of bones) byName.set(b.getName() || '(unnamed)', b);

  const rows = [];
  for (const b of bones) {
    const name = b.getName() || '(unnamed)';
    const vc = vcount.get(b) ?? 0;
    const isCore = CORE.includes(name);
    if (coreOnly && !isCore) continue;
    rows.push({ name, vcount: vc, children: b.listChildren().length, phys: PHYS_RE.test(name), core: isCore });
  }
  rows.sort((a, b) => (b.vcount - a.vcount) || a.name.localeCompare(b.name));
  const shown = topN > 0 ? rows.slice(0, topN) : rows;

  const totalBones = bones.size;
  const withWeight = [...bones].filter((b) => (vcount.get(b) ?? 0) > 0).length;
  const coreBones = [...bones].filter((b) => CORE.includes(b.getName() || ''));
  const coreWeight = coreBones.filter((b) => (vcount.get(b) ?? 0) > 0).length;

  const lines = [];
  lines.push(`# ${id}`);
  lines.push(`  joints=${totalBones}  有权重的骨=${withWeight}  语义骨命中=${coreBones.length}/${CORE.length}（其中有权重 ${coreWeight}）`);
  lines.push(`  共 ${rows.length} 行${shown.length < rows.length ? `，只列前 ${shown.length}` : ''}`);
  lines.push('');
  lines.push(`${'骨名'.padEnd(20)} ${'权重顶点'.padStart(9)} 子 物理 探针（绕局部轴 +15° → 末端位移）`);
  for (const r of shown) {
    const b = byName.get(r.name);
    const probe = axisProbe(b);
    const fm = (k) => {
      if (!probe) return '-';
      const v = probe[k];
      const parts = [];
      if (Math.abs(v.up) > 0.004) parts.push(v.up > 0 ? '↑' : '↓');
      if (Math.abs(v.fwd) > 0.004) parts.push(v.fwd > 0 ? '前' : '后');
      if (Math.abs(v.left) > 0.004) parts.push(v.left > 0 ? '左' : '右');
      return `${parts.join('') || '·'}`;
    };
    lines.push(
      `${r.name.padEnd(20)} ${String(r.vcount).padStart(9)} ${String(r.children).padStart(2)} `
      + ` ${r.phys ? '物' : ' '}   X:${fm('X').padEnd(5)} Y:${fm('Y').padEnd(5)} Z:${fm('Z')}`,
    );
  }

  const text = lines.join('\n');
  if (asJson) {
    writeFileSync(`/tmp/rig-${id}.json`, JSON.stringify({
      id, totalBones, withWeight,
      bones: rows.map((r) => ({ ...r, probe: axisProbe(byName.get(r.name)) })),
    }, null, 2));
  } else {
    writeFileSync(`/tmp/rig-${id}.txt`, text);
  }
  console.log(text.split('\n').slice(0, 4).join('\n'));
  console.log(`  → /tmp/rig-${id}.${asJson ? 'json' : 'txt'}\n`);
}
