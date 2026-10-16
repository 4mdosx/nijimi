/**
 * 外部动画支持 —— Blender 等外部 DCC 导出的动画 GLB 在运行期播放。
 *
 * 约定（详见 design/动画制作-Blender导出到运行时流程.md）：
 *   - 动画文件 = **动画-only GLB**：`models/anims/<名字>.anim.glb`
 *     （Blender 里删掉/不导网格，只导骨架 + Action；模型本体仍由 charter.glb 负责）
 *   - **骨架同名绑定**：动作必须做在 <id>.charter.glb 的同一副骨架上。
 *     MMD 标准骨架红利：三只模型骨名完全一致 → 同一份 clip 理论上可跨模型播放，
 *     但关节角相同 ≠ 轮廓相同（rest 臂角 yelan 44.8° / si 35.1° / akane 38.2°），
 *     跨模型复用要在 Blender 里换目标模型目视过一遍。
 *   - THREE.AnimationMixer 按骨名绑节点；对不上名的 track 丢弃并告警——
 *     导出侧由 tools/anim-audit.mjs 拦截，运行期兜底。
 *
 * 与 PosePlayer 的关系：**互斥**。动画期间 mixer 是唯一写骨者，姿势层冻结；
 * stop() 之后由调用方把姿势层接回来（setStatic / play）。两者同时写骨会打架。
 */

import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** 加载动画 GLB（动画-only；gltf.scene 用完即弃，只取 animations） */
export async function loadAnimClips(url: string): Promise<THREE.AnimationClip[]> {
  const gltf = await new Promise<GLTF>((resolve, reject) => {
    new GLTFLoader().load(url, resolve, undefined, reject);
  });
  return gltf.animations ?? [];
}

/** root 里所有节点名 → 对象（首个同名者赢，与 GLTFLoader 的去重一致） */
function nameIndex(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const map = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    if (o.name && !map.has(o.name)) map.set(o.name, o);
  });
  return map;
}

export interface BindReport {
  /** 成功绑定的 track 数 */
  bound: number;
  /** 丢弃的 track 节点名（角色骨架上不存在）——正常应为 0，非 0 先跑 anim-audit */
  dropped: string[];
  /** 经 sanitize 兜底重命名的（原始名 → 角色骨名） */
  renamed: [string, string][];
}

/**
 * 把外部 clip 的 track 重绑到角色骨架。
 *
 * Blender 导出的 track 名 = `<骨名>.quaternion` 等。99% 情况下骨名与角色 GLB
 * 完全一致，直接原样播放即可；这里做两层兜底：
 *   ① 精确名命中 → 原样保留；
 *   ② PropertyBinding.sanitizeNodeName 归一后命中 → 重写 track 名
 *      （GLTFLoader 会把某些字符替换掉，两侧各 sanitize 一次通常能对上）；
 *   ③ 都不命中 → 丢弃 + 记录（骨架被动过的信号，别静默吞掉）。
 */
export function rebindClip(clip: THREE.AnimationClip, root: THREE.Object3D): { clip: THREE.AnimationClip; report: BindReport } {
  const direct = nameIndex(root);
  const sanitized = new Map<string, THREE.Object3D>();
  for (const [name, obj] of direct) {
    const s = THREE.PropertyBinding.sanitizeNodeName(name);
    if (!sanitized.has(s)) sanitized.set(s, obj);
  }

  const tracks: THREE.KeyframeTrack[] = [];
  const dropped: string[] = [];
  const renamed: [string, string][] = [];
  for (const t of clip.tracks) {
    const dot = t.name.lastIndexOf('.');
    if (dot <= 0) { dropped.push(t.name); continue; }
    const nodeName = t.name.slice(0, dot);
    const prop = t.name.slice(dot);
    if (direct.has(nodeName)) { tracks.push(t); continue; }
    const viaSan = sanitized.get(THREE.PropertyBinding.sanitizeNodeName(nodeName));
    if (viaSan) {
      const nt = t.clone();
      nt.name = viaSan.name + prop;
      tracks.push(nt);
      renamed.push([nodeName, viaSan.name]);
      continue;
    }
    dropped.push(nodeName);
  }
  return {
    clip: new THREE.AnimationClip(clip.name, clip.duration, tracks),
    report: { bound: tracks.length, dropped, renamed },
  };
}

export interface PlayOptions {
  loop?: boolean;
  /** 淡入秒数（与上一个动作交叉淡化；首个动作无意义） */
  fade?: number;
  /** 播放完毕（非 loop）后自动回到 rest 并触发 onStop */
  returnToRest?: boolean;
}

/**
 * 角色动画播放器。**动画期间它是唯一写骨者**——姿势层（PosePlayer）必须冻结。
 * 每帧调 update(dt)；active === false 时调它也安全（no-op）。
 */
export class CharacterAnim {
  readonly mixer: THREE.AnimationMixer;
  /** 停止（或非 loop 播完）后回调——调用方在这里把姿势层接回来 */
  onStop?: () => void;
  private current: THREE.AnimationAction | null = null;
  private currentClip: THREE.AnimationClip | null = null;
  private done = false;

  constructor(root: THREE.Object3D) {
    this.mixer = new THREE.AnimationMixer(root);
  }

  get active() { return this.current !== null && !this.done; }
  get clipName() { return this.currentClip?.name ?? null; }

  play(clip: THREE.AnimationClip, opts: PlayOptions = {}) {
    const loop = opts.loop ?? true;
    const fade = opts.fade ?? 0;
    this.done = false;
    const next = this.mixer.clipAction(clip);
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = !loop;
    next.reset();
    if (this.current && fade > 0 && this.current !== next) {
      next.fadeIn(fade).play();
      this.current.fadeOut(fade);
    } else {
      next.play();
    }
    this.current = next;
    this.currentClip = clip;
  }

  stop() {
    if (this.current) {
      this.current.stop();
      this.current = null;
      this.currentClip = null;
      this.done = false;
      this.mixer.stopAllAction();
      this.onStop?.();
    }
  }

  update(dt: number) {
    if (!this.current || this.done) return;
    this.mixer.update(dt);
    // 非 loop 播完：clamp 在末帧，让调用方决定何时交还姿势层
    if (this.current.loop === THREE.LoopOnce && this.current.time >= this.current.getClip().duration - 1e-4) {
      this.done = true;
      this.onStop?.();
    }
  }
}
