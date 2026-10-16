/**
 * nijimi（滲み）—— 字面是「墨在纸上洇开」。轻量级 WebGL diorama 渲染引擎。
 *
 * 消费方（游戏侧）从这里取一切渲染能力：
 *
 *   import { createStage, workshopScene } from 'nijimi';
 *   const stage = createStage(container, { pack: workshopScene });
 *   stage.render(dt, elapsed);
 *
 * 三层结构：
 *   ① 技术层  charter / npr / materials / textures / particles / stage
 *   ② 角色层  character / rig / anim（契约化资产 + 骨骼槽位 + 外部动画）
 *   ③ 内容层  kits/*（可复用构件）、scenes/*（内容包，含示例场景）
 *
 * 引擎不认识任何游戏概念；反过来，游戏也不需要认识 three.js 与任何着色细节。
 * 职责边界与迁移路径见 docs/职责边界.md。
 */

/* ① 技术层 */
export * from './charter';
export * from './npr';
export * from './materials';
export * from './textures';
export * from './particles';
export * from './stage';

/* ② 角色层 */
export * from './character';
export * from './rig';
export * from './anim';

/* ③ 内容层（构件 + 内容包契约 + 自带示例场景） */
export * from './kits/industrial';
export * from './kits/conduits';
export * from './scenes/types';
export * from './scenes/workshop';

/**
 * three.js 命名空间再导出 —— 内容侧（游戏）拼几何 / 材质 / 向量时统一从这里取：
 *
 *   import { THREE } from 'nijimi';
 *   const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
 *
 * 这样游戏仓**不必依赖 three**——渲染栈只由引擎一处引入（版本单点，
 * 升级 three 不用通知任何一个消费方）。游戏侧仍然可以直接 author 内容几何，
 * 因为「场景里长什么样」本来就属于内容职责（见 scenes/types.ts）。
 */
export * as THREE from 'three';
