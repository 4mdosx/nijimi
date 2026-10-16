#!/usr/bin/env node
/**
 * 模型 zip 入料脚本：解压 → 找 PMX → 测绘 → 转 GLB → 出报告。
 *
 * 用法:
 *   node pipeline/ingest-model-zip.mjs <model.zip> [--id 短名] [--refs refs] [--models models] [--no-glb]
 *
 * 做四件事:
 *   1. 解压（zip 里中文文件名常是 GBK 编码且未标 UTF-8 → cp437 还原再按 GBK 解码）→ assets/refs/<id>/
 *   2. 对每个 .pmx 跑 pipeline/pmx-stats.mjs（顶点/面/骨骼/morph/物理/材质/贴图）
 *   3. 对主 PMX（体积最大者）跑 pipeline/pmx2glb.mjs → assets/models/<id>.glb（供人物编辑器实测）
 *   4. 汇总为 assets/refs/<id>/REPORT.md，含「使用规约」原文与缺失贴图类型推断
 *
 * 目录约定（两个都已 gitignore）:
 *   assets/models/  模型资产本体（*.zip 投料 + *.glb 转换产物）
 *   assets/refs/    拆包参考（PMX 原文、贴图、REPORT.md、缩略图）+ 代码参照项目
 *
 * 注意：商业游戏拆包模型禁止进 public/ 与构建产物。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

// ---------- CLI ----------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const afterFlag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
if (!positional[0]) {
  console.error('用法: node pipeline/ingest-model-zip.mjs <model.zip> [--id 短名] [--refs refs] [--models models] [--no-glb]');
  process.exit(1);
}
const zipPath = path.resolve(positional[0]);
if (!fs.existsSync(zipPath)) { console.error(`zip 不存在: ${zipPath}`); process.exit(1); }

const refsRoot = path.resolve(ROOT, afterFlag('refs', 'refs'));
const modelsRoot = path.resolve(ROOT, afterFlag('models', 'models'));
const id = afterFlag('id', guessId(path.basename(zipPath, '.zip')));
const destDir = path.join(refsRoot, id);

/** 从 zip 文件名猜一个短目录名：去括号标签、去 _by_作者_哈希 尾巴 */
function guessId(base) {
  return base
    .replace(/^[【【][^】】]*[】】]/, '')
    .replace(/[_\-]?by[_\-].*$/i, '')
    .replace(/[_\-][0-9a-f]{16,}$/i, '')
    .trim() || 'model';
}

// ---------- 最小 zip 读取（stored + deflate，支持 GBK 文件名） ----------
function* zipEntries(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效 zip（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录记录损坏 @${p}`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    yield { method, compSize, localOff, rawName, decoded: decodeName(rawName) };
    p += 46 + nameLen + extraLen + commentLen;
  }
}

/** zip 条目名解码：UTF-8 标志在本地头；否则 cp437 字节原样按 GBK 解（中文 zip 的常态） */
function decodeName(rawName) {
  try {
    return new TextDecoder('gbk').decode(rawName);
  } catch {
    return rawName.toString('utf8');
  }
}

function extractZip(zipFile, outDir) {
  const buf = fs.readFileSync(zipFile);
  const written = [];
  for (const e of zipEntries(buf)) {
    const name = e.decoded.replaceAll('\\', '/');
    const target = path.join(outDir, name);
    if (!target.startsWith(outDir)) throw new Error(`条目逃逸出目标目录: ${name}`);
    if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 数据区起点：本地头 30 字节 + 本地头里的名字/扩展字段长度（可能与中央目录不同）
    const nameLen = buf.readUInt16LE(e.localOff + 26);
    const extraLen = buf.readUInt16LE(e.localOff + 28);
    const start = e.localOff + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.compSize);
    const data = e.method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    fs.writeFileSync(target, data);
    written.push({ name, bytes: data.length });
  }
  return written;
}

// ---------- 子脚本调用（共享隔离依赖） ----------
const WORKSPACE_MODULES = '/Users/token/.workbuddy/binaries/node/workspace/node_modules';
const childEnv = { ...process.env, NODE_PATH: process.env.NODE_PATH ?? WORKSPACE_MODULES };
function runTool(tool, args, label) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', tool), ...args], {
    env: childEnv, encoding: 'utf8', maxBuffer: 1 << 28,
  });
  if (r.status !== 0) {
    // 拼成一行会丢掉堆栈里的路径行（排查 pmx2glb 打不开文件时全靠它）
    const err = (r.stderr || '').trim().split('\n').slice(0, 10)
      .map((l) => `      ${l}`).join('\n');
    console.warn(`[${label}] 失败（exit ${r.status}）:\n${err}`);
    return null;
  }
  return r.stdout;
}

// ---------- 主流程 ----------
console.log(`[1/4] 解压 ${path.basename(zipPath)} → ${path.relative(ROOT, destDir)}`);
fs.mkdirSync(destDir, { recursive: true });
const files = extractZip(zipPath, destDir);
console.log(`      ${files.length} 个文件，${(files.reduce((s, f) => s + f.bytes, 0) / 1024 / 1024).toFixed(1)} MB`);

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  return d.isDirectory() ? walk(p) : [p];
});
const pmxFiles = walk(destDir).filter((f) => f.toLowerCase().endsWith('.pmx'))
  .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
if (!pmxFiles.length) { console.error('压缩包里没有 .pmx 文件'); process.exit(1); }

console.log(`[2/4] 测绘 ${pmxFiles.length} 个 PMX`);
const statsList = [];
for (const f of pmxFiles) {
  const json = runTool('pmx-stats.mjs', [f, '--json'], 'pmx-stats');
  // ⚠️ 展开顺序：pmx-stats 的 JSON 里也有 file 字段（且是 basename），
  // 若写成 { file: f, ...json } 会被覆盖 → 下一步 pmx2glb 拿到裸文件名，去 cwd 找不到。
  statsList.push(json ? { ...JSON.parse(json), file: f } : { file: f, error: true });
}

const mainStats = statsList.find((s) => !s.error);

console.log(`[3/4] 转换主模型 → GLB`);
let glbOut = null;
if (!flags.has('--no-glb') && mainStats) {
  fs.mkdirSync(modelsRoot, { recursive: true });
  glbOut = path.join(modelsRoot, `${id}.glb`);
  runTool('pmx2glb.mjs', [mainStats.file, glbOut, '--name', id], 'pmx2glb');
}

// ---------- 报告 ----------
console.log(`[4/4] 写报告`);
const fmt = (n) => n.toLocaleString('en-US');
const BYTES = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// 贴图类型推断：UE 命名习惯 _d/_n/_r/_m/_s/_e/_ao
const SUFFIX = { _d: 'albedo/diffuse', _n: 'normal', _r: 'roughness', _m: 'metallic/mask', _s: 'specular', _e: 'emissive', _ao: 'ambient occlusion', _c: 'color mask', _sdf: 'SDF 脸部阴影' };
const texNames = statsList.flatMap((s) => (s.textures ?? []).map((t) => t.rel));
const foundKinds = new Set();
for (const n of texNames) {
  const base = path.basename(n).replace(/\.(png|tga|jpg|bmp|dds)$/i, '').toLowerCase();
  for (const [k, v] of Object.entries(SUFFIX)) if (base.endsWith(k)) foundKinds.add(v);
}
const missingKinds = Object.values(SUFFIX).filter((v) => !foundKinds.has(v));

// 授权/说明类文件（排除贴图目录，也排除上一次跑生成的 REPORT.md —— 否则重跑会把报告自己当规约收进去）
const regTextures = walk(destDir).filter((f) => /\.(txt|md|pdf|jpg|jpeg|webp)$/i.test(f)
  && !/textures?\//i.test(f)
  && path.basename(f) !== 'REPORT.md');

let md = `# 模型入料报告：${id}\n\n`;
md += `> 由 \`pipeline/ingest-model-zip.mjs\` 自动生成（${new Date().toISOString().slice(0, 16).replace('T', ' ')}）。\n`;
md += `> 源包：\`${path.basename(zipPath)}\`（${BYTES(fs.statSync(zipPath).size)}）\n`;
md += `> 解压位置：\`${path.relative(ROOT, destDir)}/\`（assets/refs/ 与 assets/models/ 均已 gitignore，不进构建产物）\n\n`;

md += `## 1. 授权事实（原始文件原文，最高优先级）\n\n`;
if (regTextures.length) {
  for (const f of regTextures.slice(0, 3)) {
    md += `### \`${path.relative(destDir, f)}\`\n\n\`\`\`\n${fs.readFileSync(f, 'utf8').slice(0, 2000).trim()}\n\`\`\`\n\n`;
  }
} else {
  md += `⚠️ 包内未见「使用规约 / readme」类文件。**默认按「禁止商用」处理**——商业游戏拆包模型在取得书面授权前不得进入构建产物。\n\n`;
}

md += `## 2. 几何与结构（实测）\n\n`;
md += `| 文件 | 顶点 | 三角面 | 材质 | 骨骼 | morph | 物理刚体 | 关节 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
for (const s of statsList) {
  if (s.error) { md += `| \`${path.relative(destDir, s.file)}\` | 解析失败 | | | | | | |\n`; continue; }
  md += `| \`${path.relative(destDir, s.file)}\` | ${fmt(s.geometry.vertices)} | ${fmt(s.geometry.triangles)} | ${s.geometry.materials} | ${s.bones.total} | ${s.morphs.total} | ${s.physics.rigidBodies} | ${s.physics.joints} |\n`;
}
md += `\n`;
for (const s of statsList) {
  if (s.error) continue;
  md += `**${path.relative(destDir, s.file)}**\n\n`;
  md += `- 顶点蒙皮：${Object.entries(s.deformDistribution).filter(([, v]) => v).map(([k, v]) => `${k} ${fmt(v)}`).join(' / ')}\n`;
  md += `- 变形器类型：${JSON.stringify(s.morphs.byType)}\n`;
  md += `- 刚体演算模式：${JSON.stringify(s.physics.byMode)}；形状：${JSON.stringify(s.physics.byShape)}\n\n`;
  md += `材质（按面数降序）：\n\n| 面数 | 名称 | 贴图 | 描边 | 备注 |\n| --- | --- | --- | --- | --- |\n`;
  for (const m of [...s.materials].sort((a, b) => b.triangles - a.triangles)) {
    const note = [];
    if (m.diffuse?.[3] !== undefined && m.diffuse[3] < 1) note.push(`alpha=${m.diffuse[3]}`);
    if (!m.texture && m.triangles > 100) note.push('**无贴图**');
    md += `| ${fmt(m.triangles)} | ${m.name} | \`${(m.texture ?? '—').replace(/^textures\\/, '')}\` | ${m.edge?.flag ? m.edge.size?.toFixed(2) : 'off'} | ${note.join('，') || ''} |\n`;
  }
  md += `\n`;
}

md += `## 3. 贴图清单（实测分辨率）\n\n`;
md += `| 尺寸 | 体积 | 文件 | 用途 |\n| --- | --- | --- | --- |\n`;
for (const s of statsList) {
  for (const t of s.textures ?? []) {
    md += `| ${t.dimension} | ${BYTES(t.bytes)} | \`${path.basename(t.rel)}\` | ${t.usedBy.join(' / ') || '（未引用）'} |\n`;
  }
}
md += `\n**贴图类型推断**：存在 ${[...foundKinds].join('、') || '（无）'}；\n`;
md += `**缺失** ${missingKinds.join('、') || '（无）'}。\n\n`;
md += `> 只带 albedo 的拆包（「diffuse-only rip」）意味着：**法线、粗糙度、自发光、脸部 SDF 等全部缺失**，\n`;
md += `> 这些观感在原游戏里由引擎 shader 提供，用通用 PBR 管线加载时无法复现，只能自己补或放弃。\n\n`;

if (glbOut && fs.existsSync(glbOut)) {
  md += `## 4. 转换产物\n\n- \`${path.basename(glbOut)}\`（${BYTES(fs.statSync(glbOut).size)}）— 主模型，已按 MMD→glTF 左手系转换\n- 编辑器实测：character.html → 模型下拉选对应条目（研究用，不进构建）\n\n`;
} else if (glbOut) {
  md += `## 4. 转换产物\n\n⚠️ **GLB 转换失败**，\`${path.basename(glbOut)}\` 未生成。手动重试：\n\n`
    + '```bash\nnode pipeline/pmx2glb.mjs "' + path.relative(ROOT, mainStats.file) + `" ${path.relative(ROOT, glbOut)} --name ${id}\n\`\`\`\n\n`;
}

fs.writeFileSync(path.join(destDir, 'REPORT.md'), md);
console.log(`完成 → ${path.relative(ROOT, path.join(destDir, 'REPORT.md'))}`);
