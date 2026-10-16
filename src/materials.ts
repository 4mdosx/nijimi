/**
 * 现代材质库（黄铜 + 深木 + 玻璃三件套）——《现代魔法世界-终末地风格融合定稿》§4.1。
 * 从视觉样张 src/sample/modern.ts 沉淀进正式渲染层：
 * 黄铜承担全部暖结构件（它的暖色相让工业感不滑向废土感，温馨版关键替换），
 * 铁只做小面积（箍/腿），玻璃/液体做元素流可视化。
 * 共享单例：同一材质跨对象复用，draw call 友好。
 */

import * as THREE from 'three';
import { liquidFlowTexture, woodFloorTexture } from './textures';

export interface ModernMaterials {
  /** 黄铜（暖结构件：管件/釜体/储罐/包边） */
  brass: THREE.MeshStandardMaterial;
  /** 暗黄铜（接头/阀门/喷嘴） */
  brassDark: THREE.MeshStandardMaterial;
  /** 铁（小面积：箍/腿/台下管） */
  iron: THREE.MeshStandardMaterial;
  /** 玻璃（视镜/液流管，低不透明度） */
  glass: THREE.MeshStandardMaterial;
  /** 元素液流（自发光 + 流动贴图；克隆给多个使用者各自滚 offset） */
  liquid: THREE.MeshStandardMaterial;
  /** 深木（台面/地板） */
  woodDark: THREE.MeshStandardMaterial;
  /** 深木平涂（无贴图降级档） */
  woodFlat: THREE.MeshStandardMaterial;
  /** 石材（基座/壁炉，程序化石砖） */
  stone: THREE.MeshStandardMaterial;
}

function std(opt: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial(opt);
}

let singleton: ModernMaterials | null = null;

export function modernMaterials(): ModernMaterials {
  if (singleton) return singleton;
  singleton = {
    brass: std({ color: 0xb08050, metalness: 0.85, roughness: 0.32 }),
    brassDark: std({ color: 0x6e543a, metalness: 0.8, roughness: 0.45 }),
    iron: std({ color: 0x4a4038, metalness: 0.7, roughness: 0.5 }),
    glass: std({ color: 0xcfe0e8, metalness: 0, roughness: 0.08, transparent: true, opacity: 0.16 }),
    liquid: std({
      color: 0xff9a3c, metalness: 0, roughness: 0.4,
      emissive: 0xff8c2a, emissiveIntensity: 1.1, map: liquidFlowTexture(),
    }),
    woodDark: std({ map: woodFloorTexture(), roughness: 0.88, color: 0xcdb9a5 }),
    woodFlat: std({ color: 0x5a3f2a, roughness: 0.88 }),
    stone: std({ color: 0x6e6862, roughness: 0.95 }),
  };
  return singleton;
}
