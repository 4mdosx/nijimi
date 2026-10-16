# nijimi — Agent 约定

nijimi（滲み）是轻量级 WebGL diorama 渲染引擎。职责边界见 `docs/职责边界.md`：引擎只管怎么渲，不写游戏概念。

## 目录约定

| 路径 | 放什么 |
| --- | --- |
| `src/` | 引擎运行时。入口 `src/index.ts`。技术层 `charter` / `npr` / `materials` / `textures` / `particles` / `stage`；角色层 `character` / `rig` / `anim`；内容层 `kits/`、`scenes/` |
| `editors/` | 四台编辑器：人物 `character`、姿势 `pose`、场景 `scene`、集成 `integrated`。`npm run dev` → http://localhost:5200 |
| `pipeline/` | **全部转模型与资产脚本**（Node `.mjs`）。仓库里没有 `tools/` |
| `assets/models/` | 模型本体与转换产物。整目录 gitignore，只有 `README.md` 入库。开发期经 `/models/**` serve |
| `assets/refs/` | 拆包参考：PMX 原文、官方贴图、`REPORT.md`。gitignore |
| `docs/` | 引擎技术文档。先读 `docs/README.md` 和 `docs/职责边界.md` |
| `screenshots/` | **所有截图**。gitignore，只留本机 |
| `public/` | 可进构建的静态文件。拆包模型禁止放这里 |
| `vite.mjs` | 给消费方用的 Vite 插件 `assetCorpus` |
| `dist/` | 构建产物，不手改 |

运行期 URL 只有两种：`/models/**`（本仓 `assets/models/`）和 `/assets/models/**`（消费方 `public/assets/models/` 里可分发的资产）。

旧文档里的 `tools/`、`design/concept/`、`docs/concept/` 已过期。脚本以 `pipeline/` 为准，截图以 `screenshots/` 为准。`assets/models/README.md` 仍写着 `tools/`，不要跟着它走。

## 截图

浏览器验证、诊断、前后对照，截图一律写到仓库根目录 `screenshots/`。

- 不要写到 `docs/`、`docs/concept/`、`design/concept/`，也不要留在对话临时目录。
- 文件名用小写连字符，带主题前缀，例如 `verify-pose.png`、`diag-si-stand.png`。
- 目录已在 `.gitignore`。文档里引用时写 `screenshots/<文件名>`。

## 转模型工具

位置：`pipeline/`。用 `node pipeline/<脚本>.mjs` 调用。

新模型入料：

```bash
node pipeline/ingest-model-zip.mjs assets/models/<zip> --id <名>
node pipeline/glb-audit.mjs assets/models/<id>.glb --fix
npm run charter && npm run rig
```

| 脚本 | 作用 | 产物 |
| --- | --- | --- |
| `pipeline/ingest-model-zip.mjs` | 解压 zip、测绘、转主 PMX | `assets/refs/<id>/`、`assets/models/<id>.glb`、`REPORT.md` |
| `pipeline/pmx2glb.mjs` | PMX → 原版 GLB | `assets/models/<id>.glb`（原版永不改写） |
| `pipeline/glb-audit.mjs` | PMX→GLB 体检；`--fix` 就地修（先备份 `.bak`） | 同一个 GLB |
| `pipeline/charter-rules.mjs` | 材质契约约定。改规则改这里 | 被转换器读取 |
| `pipeline/charter-glb.mjs` | 原版 → 契约版。`npm run charter` 即 `--all` | `assets/models/<id>.charter.glb`、`charter-manifest.json` |
| `pipeline/rig-rules.mjs` | 骨骼槽位约定。改槽位改这里 | 被生成器读取 |
| `pipeline/rig-glb.mjs` | 骨骼 manifest。`npm run rig` | `assets/models/rig-manifest.json` |
| `pipeline/anim-audit.mjs` | 动画 GLB 体检。`npm run anim-audit` | 终端报告 |
| `pipeline/bake-face-sdf.mjs` | 面部 SDF 烘焙 | 贴图进契约资产 |

只读或诊断：`pmx-stats.mjs`、`pmx-eye-diag.mjs`、`model-survey.mjs`、`rig-survey.mjs`、`uv-audit.mjs`、`uv-own.mjs`、`sdf-dbg.mjs`、`make-demo-anim.mjs`。

改材质规则改 `pipeline/charter-rules.mjs` 再跑 `npm run charter`；改骨骼槽位改 `pipeline/rig-rules.mjs` 再跑 `npm run rig`。运行期读 `src/charter.ts`、`src/rig.ts`，不要在运行期用名字猜材质或骨骼。

拆包模型（原神 / 异环 / 终末地等）只留在 `assets/models/` 和 `assets/refs/`，禁止进 `public/`、`dist/` 和 git。
