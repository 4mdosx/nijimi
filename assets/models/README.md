# models/ — 模型资产投料区

**整目录已 gitignore。** 这里放模型文件本体，不放结论、不放文档。

| 类型 | 例子 | 来源 |
| --- | --- | --- |
| `*.zip` | `【明日方舟：终末地】祀_by_...zip` | 外部下载的原始包 |
| `*.glb` | `yelan.glb` / `si.glb` / `akane.glb` / `akane-weapon.glb` | **原版**：PMX 经 `tools/pmx2glb.mjs` 直出，忠于 PMX 命名与材质序（溯源 / 回归对照，运行期不用） |
| `*.charter.glb` | `yelan.charter.glb` … | **契约版**：按 [design/材质契约-终末地核心.md](../design/材质契约-终末地核心.md) 归一（材质族 / 层序 / alpha / 通道溯源），**运行期唯一使用** |
| `charter-manifest.json` | — | 转换器产出的登记表：模型档案 + 材质表 + 贴图表 + 超标项 |

两个版本并存，**原版永不改写**——契约映射改坏了观感时，同机位 A/B 一眼定位。

```bash
# 产出契约版（全部模型）
node tools/charter-glb.mjs --all
# 单模型（PMX 源在库内时自动做贴图通道溯源）
node tools/charter-glb.mjs models/<id>.glb
```

新模型入料后必跑体检（PMX→GLB 四条铁律，含眼层渲染顺序）：

```bash
node tools/glb-audit.mjs models/<id>.glb          # 体检
node tools/glb-audit.mjs models/<id>.glb --fix    # 就地修（先备份 .bak）
```

配套脚本：

```bash
# 投料即分析：解压到 refs/<id>/ + 测绘 + 转 GLB 到 models/<id>.glb + 出 REPORT.md
node tools/ingest-model-zip.mjs models/<xxx>.zip --id <短名>
```

## ⚠️ 授权纪律（硬约束）

游戏拆包模型 **版权属原厂商**。因此：

- ✅ 允许：本地研究、渲染实验、还原度评估、风格参照
- ❌ 禁止：进 `public/`、进构建产物、进版本控制、用于任何对外交付物
- 每个包的规约原文由 `tools/ingest-model-zip.mjs` 自动抓进 `refs/<id>/REPORT.md`，
  并由契约转换器写进 manifest 与 GLB 的 scene extras（编辑器面板展示的就是这份原文）

CC0 / 已授权资产 不适用本约束，但同样建议放这里做来源隔离。
