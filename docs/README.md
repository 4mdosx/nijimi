# nijimi/docs/ — 引擎技术文档

**nijimi（滲み）**：轻量级 WebGL diorama 渲染引擎。

三层结构
- 技术层 charter/npr/materials/textures/particles/stage 
- 角色层 character/rig/anim 
- 内容层 kits/scenes），入口 `src/index.ts`

编辑器在 `editors/`，资产管线在 `pipeline/`。

## 目录速查

```
src/index.ts        引擎入口（技术层 / 角色层 / 内容层三层 barrel）
src/stage.ts        舞台总装（createStage：渲染器/后期/相机 rig/帧循环）
src/scenes/         ScenePack 契约 + 自带示例内容包（workshop）
editors/            四台编辑器（人物 / 姿势动画 / 场景 / 集成），npm run dev → :5200
pipeline/           资产管线（pmx2glb → glb-audit → charter-glb → rig-glb → anim-audit）
assets/models/      契约资产语料（gitignore，dev 期经 /models/** serve）
assets/refs/        拆包参考（PMX 原文 / 官方贴图 / REPORT）
vite.mjs            消费方用的 Vite 插件（assetCorpus）
```

**新模型入料一条龙**：

```bash
node pipeline/ingest-model-zip.mjs assets/models/<zip> --id <名>
node pipeline/glb-audit.mjs assets/models/<id>.glb --fix   # 三条铁律体检
npm run charter && npm run rig                              # 契约版 + 骨骼 manifest
```
