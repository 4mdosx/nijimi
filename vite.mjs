/**
 * nijimi/vite —— 给消费方（游戏侧）用的 Vite 插件。
 *
 * 引擎运行期只认两个 URL 前缀，消费方复刻这两个映射即可（见 README「消费方式」）：
 *   /models/**        契约资产语料（引擎仓的 assets/models/，gitignore：不进构建产物，开发期直接 serve）
 *   /assets/models/** 随包世界通用资产（消费方 public/assets/models/，CC0 可分发）
 *
 * 用法（消费方 vite.config.mjs）：
 *   import { assetCorpus } from 'nijimi/vite';
 *   export default defineConfig({ plugins: [assetCorpus()] });          // 默认指向引擎仓 assets/models
 *   export default defineConfig({ plugins: [assetCorpus('./models')] }); // 或指向本仓自己的语料目录
 *
 * 生产构建不含这些资产——正式发行时把需要的那几个 .charter.glb 拷进 public/assets/models/
 * （契约版模型可分发；原始 PMX / 拆包参考永久留在引擎仓的 gitignore 区）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_ROOT = path.dirname(fileURLToPath(import.meta.url));

/** 引擎仓自带的资产语料目录（绝对路径） */
export const DEFAULT_MODELS_DIR = path.join(ENGINE_ROOT, 'assets', 'models');

const TYPES = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
};

/**
 * 开发期把 `/models/**` 映射到资产语料目录。
 * @param {string} [modelsDir] 语料目录；省略 = 引擎仓 assets/models
 */
export function assetCorpus(modelsDir = DEFAULT_MODELS_DIR) {
  const root = path.resolve(modelsDir);
  return {
    name: 'nijimi-asset-corpus',
    configureServer(server) {
      server.middlewares.use('/models', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]);
        const file = path.join(root, rel);
        if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          next();
          return;
        }
        res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}
