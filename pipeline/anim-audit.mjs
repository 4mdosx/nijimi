/**
 * 动画 GLB 审计器 —— Blender 导出的动画在进运行期**之前**的体检闸。
 *
 * 查四件事（全部对着 rig-manifest / 角色 GLB 的真实骨名）：
 *   ① track 的节点名能不能绑到角色骨架 —— 绑不上的列出来并给最接近的骨名建议；
 *   ② 有没有 scale 轨道 —— 外部动画混进 scale 会把模型拉变形（MMD 骨架不用 scale）；
 *   ③ 位移轨道都落在哪些骨上 —— 重心（センター/グルーブ/腰）合理，别的骨动位置多半是误烘；
 *   ④ 插值方式 —— STEP 会让动作一卡一卡（Blender 的 Constant 插值忘了改）。
 *
 * 用法:
 *   node pipeline/anim-audit.mjs assets/models/anims/<name>.anim.glb [--model yelan]
 *   （--model 省略时自动选 track 命中率最高的模型）
 *
 * 退出码：0 = 通过（可进运行期），1 = 有绑不上的轨道。
 */

import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const modelArgIdx = argv.indexOf('--model');
const modelArg = modelArgIdx >= 0 ? argv[modelArgIdx + 1] : null;

if (!file) {
  console.error('用法: node pipeline/anim-audit.mjs <file.anim.glb> [--model <id>]');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`✗ 文件不存在: ${file}`);
  process.exit(2);
}

/* ---- 读动画 GLB ---- */
const io = new NodeIO();
const animDoc = await io.read(file);
const animRoot = animDoc.getRoot();
const anims = animRoot.listAnimations();
if (!anims.length) {
  console.error('✗ 文件里没有动画（Blender 导出时记得勾 Animation）');
  process.exit(1);
}

/** 收集每条动画的 track 信息 */
function tracksOf(anim) {
  return anim.listChannels().map((ch) => {
    const target = ch.getTargetNode();
    const sampler = ch.getSampler();
    return {
      node: target?.getName() ?? '(null)',
      interpolation: sampler?.getInterpolation() ?? 'LINEAR',
      isScale: ch.getTargetPath() === 'scale',
      isTranslation: ch.getTargetPath() === 'translation',
      path: ch.getTargetPath(),
    };
  });
}

/* ---- 读角色 GLB 的骨名（默认选命中率最高的模型） ---- */
const candidates = modelArg ? [modelArg] : ['yelan', 'si', 'akane'];
const charInfos = [];
for (const id of candidates) {
  const p = `assets/models/${id}.charter.glb`;
  if (!fs.existsSync(p)) continue;
  const doc = await io.read(p);
  const names = new Set();
  const walk = (n) => { if (n.getName()) names.add(n.getName()); for (const c of n.listChildren()) walk(c); };
  for (const s of doc.getRoot().listScenes()) for (const n of s.listChildren()) walk(n);
  charInfos.push({ id, names });
}
if (!charInfos.length) {
  console.error('✗ assets/models/ 下找不到任何 <id>.charter.glb（先跑 node pipeline/charter-glb.mjs --all）');
  process.exit(2);
}

const HINTS = (nodeName) => {
  // 最接近的骨名建议（包含式匹配：名字互相包含或前缀一致）
  const all = charInfos.flatMap((c) => [...c.names]);
  return all.filter((n) => n.includes(nodeName) || nodeName.includes(n)).slice(0, 3);
};

let fatal = false;
console.log(`# ${file}\n`);
for (const anim of anims) {
  const tracks = tracksOf(anim);
  const nodeNames = new Set(tracks.map((t) => t.node));

  // 选覆盖率最高的角色
  let best = charInfos[0], bestHits = 0;
  for (const c of charInfos) {
    const hits = [...nodeNames].filter((n) => c.names.has(n)).length;
    if (hits > bestHits) { best = c; bestHits = hits; }
  }
  const missing = [...nodeNames].filter((n) => !best.names.has(n));

  console.log(`## ${anim.getName() || '(未命名)'} · ${anim.listChannels().length} 条轨道 · ${best.id} 命中 ${bestHits}/${nodeNames.size}`);

  const scales = tracks.filter((t) => t.isScale);
  if (scales.length) {
    fatal = true;
    console.log(`  ✗ scale 轨道 ${scales.length} 条（${scales.slice(0, 4).map((t) => t.node).join(', ')}…）——MMD 骨架不用 scale，会拉变形；在 Blender 里清掉缩放关键帧`);
  }
  const step = tracks.filter((t) => t.interpolation === 'STEP');
  if (step.length) {
    console.log(`  ⚠ ${step.length} 条 STEP 插值（动作会一卡一卡）——Blender 里把 Constant 关键帧改掉`);
  }
  const translations = [...new Set(tracks.filter((t) => t.isTranslation).map((t) => t.node))];
  const CENTER_OK = /^(全ての親|センター|グルーブ|腰|母音0|root)/;
  const badT = translations.filter((n) => !CENTER_OK.test(n));
  if (badT.length) {
    console.log(`  ⚠ 重心以外的位移轨道：${badT.slice(0, 6).join(', ')}${badT.length > 6 ? '…' : ''}——多半是误烘（IK/约束没清）`);
  }
  if (missing.length) {
    fatal = true;
    console.log(`  ✗ ${missing.length} 个节点绑不上 ${best.id} 的骨架:`);
    for (const n of missing.slice(0, 10)) {
      const hints = HINTS(n);
      console.log(`      ${n}${hints.length ? `  ——最接近: ${hints.join(' / ')}` : ''}`);
    }
    if (missing.length > 10) console.log(`      …共 ${missing.length} 个`);
    console.log('      常见原因：骨架被改名 / 加了 .001 后缀 / 导出了另一副骨架（Blend 里 Mirror 骨名工具会加 .L/.R）');
  }
  if (!scales.length && !missing.length) console.log('  ✓ 全部轨道可绑定，无 scale 轨道');
  console.log('');
}

console.log(fatal ? '结论: ✗ 不通过（先修再进运行期）' : '结论: ✓ 通过，可进运行期（rebindClip 兜底后交给 CharacterAnim）');
process.exit(fatal ? 1 : 0);
