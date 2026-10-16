/**
 * 舞台（Stage）—— 引擎的**技术总装**：渲染器 / 灯光 / IBL / NPR / 正交 diorama 相机 /
 * 视窗缩放平移 / 后期（Bloom + 调色）/ 帧循环 / 角色加载。
 *
 * ⚠️ 它**不认识任何具体场景**：场景内容由 `pack`（ScenePack，见 src/scenes/types.ts）注入。
 * 引擎自带示例包 `scenes/workshop.ts`；内容侧实现同一接口就能换自己的房间/关卡，
 * 不需要改这个文件（迁移路径见 docs/职责边界.md）。
 *
 * 动画层帧率可配置（房间渲染架构的分层接口，MVP 跑 30fps）：内容动画统一在
 * `pack.update(animStep, elapsed)` 里推进，别用真实帧 dt。
 */

import * as THREE from 'three';
import { loadCharacter, loadProps, type CharacterHandles } from './character';
import { workshopScene } from './scenes/workshop';
import type { ScenePack } from './scenes/types';
import {
  applyEnvironment,
  applyNprToObject,
  createColoredEnvironment,
  createGradePass,
  createNprUniforms,
  updateNprUniforms,
  type NprUniforms,
} from './npr';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const ANIM_FPS = 30;

/** 取景：场景任一维不超过视窗的 62%（四周留白给背景） */
const ROOM_FRAC = 0.62;
const ZOOM_MIN = 1;
const ZOOM_MAX = 3.2;
const ZOOM_DEFAULT = 1.35;

export interface Stage<H = unknown> {
  renderer: THREE.WebGLRenderer;
  camera: THREE.OrthographicCamera;
  scene: THREE.Scene;
  /** 内容包句柄（房间锚点/灯位/粒子等的联合体，类型由内容包给出） */
  content: H;
  /** raycast 用（挂交互层） */
  raycaster: THREE.Raycaster;
  resize(): void;
  /** 视窗 rig：虚拟视窗（box）内缩放 / 平移，窗口本身大小不变 */
  view: {
    zoom: number;
    /** f > 1 放大；ndc 为缩放锚点（省略则缩放视窗中心） */
    zoomBy(f: number, ndc?: { x: number; y: number }): void;
    /** 按屏幕像素平移（拖拽） */
    panByPx(dxPx: number, dyPx: number): void;
    reset(): void;
  };
  /** 渲染一帧（dt 为真实秒） */
  render(dt: number, elapsed: number): void;
  /** Bloom 开关（氛围主角可 A/B；默认开） */
  setBloom(on: boolean): void;
  /** NPR 手法开关（终末地复刻子集；默认开，?npr=0 关） */
  setNpr(on: boolean): void;
  /** 角色句柄（异步加载，可能为 null） */
  character(): CharacterHandles | null;
  /**
   * 世界坐标 → 页面客户端像素（交互层把 3D 端口 / 设备投回 DOM 芯片位置用）。
   * 投影属于渲染职责，所以游戏侧不需要碰相机与矩阵。
   */
  clientPos(world: THREE.Vector3): { x: number; y: number };
  /** 取 Object3D 的世界坐标 → 页面客户端像素（同上） */
  objectClientPos(obj: THREE.Object3D): { x: number; y: number };
  /** 调试句柄（编辑器用；业务侧不碰） */
  debug: {
    lights: {
      hemi: THREE.HemisphereLight;
      key: THREE.DirectionalLight;
      moon: THREE.DirectionalLight;
      fill: THREE.PointLight;
    };
    bloomPass: UnrealBloomPass;
  };
}

export interface StageOptions<H> {
  /** 内容包（省略 = 引擎自带示例：工坊 diorama） */
  pack?: ScenePack<H>;
  /** 加载角色与陈设（默认 true；场景编辑器关掉它做纯环境调试） */
  withCharacter?: boolean;
  /** 角色资产 id（契约版模型，默认 yelan） */
  characterId?: string;
  /** 加载静态陈设（默认跟随 withCharacter） */
  withProps?: boolean;
}

/** 建舞台。容器尺寸决定视窗，内容包决定「里面有什么」。 */
export function createStage<H = unknown>(
  container: HTMLElement,
  opts: StageOptions<H> = {},
): Stage<H> {
  const pack = (opts.pack ?? (workshopScene as unknown as ScenePack<H>));
  const {
    withCharacter = true,
    characterId = 'yelan',
    withProps = withCharacter,
  } = opts;

  // 透明渲染：房间是悬浮 diorama，背景交给页面 CSS（桌宠多窗口前置形态）
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // r186：PCFSoft 已移除
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  // ---- 灯光（现代魔法世界：冷底 + 暖光，终末地纪律的温馨版）----
  // 环境冷底（紫蓝 hemisphere + 低 Ambient），暖色只走点光/方向光——
  // 「暖光是画面唯一高饱和区」白捡构图焦点（融合定稿 §2.6）。
  const hemi = new THREE.HemisphereLight(0x565a8a, 0x241d2e, 0.5);
  scene.add(hemi);
  scene.add(new THREE.AmbientLight(0x3a3355, 0.55));

  // 主光：暖色方向光（斜射，勾出黄铜与长袍的体积）
  const key = new THREE.DirectionalLight(0xffc890, 1.35);
  key.position.set(-3.5, 5.5, 2.6);
  key.target.position.set(0.3, 0.6, 0.1);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -7;
  key.shadow.camera.right = 7;
  key.shadow.camera.top = 7;
  key.shadow.camera.bottom = -7;
  key.shadow.camera.far = 16;
  key.shadow.bias = -0.0006;
  scene.add(key, key.target);

  // 窗外暮光（冷色补形，压低不抢暖）
  const moon = new THREE.DirectionalLight(0xb8cce8, 0.55);
  moon.position.set(2.2, 2.6, -2.2);
  scene.add(moon);

  // 房间常驻暖补光（壁炉/坩埚点光之外的环境暖）
  const fill = new THREE.PointLight(0xffd9a0, 6, 10, 1.6);
  fill.position.set(1.9, 1.8, -2.4);
  scene.add(fill);

  // ---- NPR 复刻子集（终末地/少前2 手法，验证记录见 docs/NPR渲染复刻-*.md）----
  // ① 彩色 IBL：只作用于 PBR 轨道（黄铜/铁/石材），给金属件带颜色的间接光；
  //    NPR 轨道走灯光，互不干扰。
  // ② 角色 NPR 注入：柔和 ramp + 冷暖撞色 + 随相机边缘光；环境材质不动（平涂是定稿）。
  const nprEnabled = new URLSearchParams(window.location.search).get('npr') !== '0';
  const nprUniforms: NprUniforms = createNprUniforms();
  const env = createColoredEnvironment(renderer, {
    sky: 0x4d5688, horizon: 0x746a86, ground: 0x382c3a,
    glow: 0xffc890, glowDir: new THREE.Vector3(-3.5, 5.5, 2.6).normalize(),
  });
  applyEnvironment(scene, env.texture, 0.6);
  nprUniforms.uNprEnable.value = nprEnabled ? 1 : 0;

  // ---- 正交等距相机（固定朝向，但可在虚拟视窗内缩放/平移）----
  // 视锥由「内容包声明的 span 占视口比例」反推：场景是视窗中央的悬浮 diorama，
  // 四周留白给背景。内容有多大由 pack 说，引擎不猜。
  const SPAN_W = pack.span.w;
  const SPAN_H = pack.span.h;
  const focus = pack.focus ?? [0, 0, 0];

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);
  const baseTarget = new THREE.Vector3(focus[0], focus[1], focus[2]);
  const target = baseTarget.clone();
  const camDir = new THREE.Vector3(1, 0.82, 1).normalize(); // 俯角约 30°，diorama 视角

  // 相机屏幕平面的右/上基向量（平移用）
  const camUp = new THREE.Vector3(0, 1, 0);
  const axisRight = new THREE.Vector3().crossVectors(camUp, camDir).normalize();
  const axisScreenUp = new THREE.Vector3().crossVectors(camDir, axisRight).normalize();

  let visW = 10;
  let visH = 10;
  let zoom = ZOOM_DEFAULT;

  function applyCamera() {
    camera.position.copy(target).addScaledVector(camDir, 18);
    camera.lookAt(target);
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
  }

  /** 把视窗中心钳制在场景附近，避免平移到空白 */
  function clampTarget() {
    const px = new THREE.Vector3().subVectors(target, baseTarget);
    const x = px.dot(axisRight);
    const y = px.dot(axisScreenUp);
    const limX = Math.max(0.5, ((visW / zoom - SPAN_W) / 2) * 0.85);
    const limY = Math.max(0.4, ((visH / zoom - SPAN_H) / 2) * 0.85);
    const cx = THREE.MathUtils.clamp(x, -limX, limX);
    const cy = THREE.MathUtils.clamp(y, -limY, limY);
    px.set(0, 0, 0).addScaledVector(axisRight, cx - x).addScaledVector(axisScreenUp, cy - y);
    target.add(px);
  }

  function resize() {
    const w = container.clientWidth;
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h);
    composer.setSize(w, h);
    const a = w / h;
    visW = SPAN_W / ROOM_FRAC;
    visH = visW / a;
    if (visH < SPAN_H / ROOM_FRAC) {
      visH = SPAN_H / ROOM_FRAC;
      visW = visH * a;
    }
    camera.left = -visW / 2;
    camera.right = visW / 2;
    camera.top = visH / 2;
    camera.bottom = -visH / 2;
    clampTarget();
    applyCamera();
  }
  window.addEventListener('resize', resize);

  // ---- 虚拟视窗 rig：box 大小恒定，只在 box 内部缩放/平移 ----
  const view: Stage<H>['view'] = {
    get zoom() {
      return zoom;
    },
    set zoom(_: number) {
      void _;
    },
    zoomBy(f: number, ndc?: { x: number; y: number }) {
      const z1 = zoom;
      const z2 = THREE.MathUtils.clamp(z1 * f, ZOOM_MIN, ZOOM_MAX);
      if (z2 === z1) return;
      // 缩放锚点：让锚点下的世界点保持不动（默认视窗中心）
      const nx = ndc ? ndc.x : 0;
      const ny = ndc ? ndc.y : 0;
      target
        .addScaledVector(axisRight, (nx * visW * (1 / z1 - 1 / z2)) / 2)
        .addScaledVector(axisScreenUp, (ny * visH * (1 / z1 - 1 / z2)) / 2);
      zoom = z2;
      clampTarget();
      applyCamera();
    },
    panByPx(dxPx: number, dyPx: number) {
      const wppX = visW / zoom / Math.max(1, container.clientWidth);
      const wppY = visH / zoom / Math.max(1, container.clientHeight);
      target.addScaledVector(axisRight, -dxPx * wppX).addScaledVector(axisScreenUp, dyPx * wppY);
      clampTarget();
      applyCamera();
    },
    reset() {
      zoom = ZOOM_DEFAULT;
      target.copy(baseTarget);
      applyCamera();
    },
  };

  // ---- 内容包（房间 / 工业簇 / 粒子 / 内容动画都归它）----
  const animStep = 1 / ANIM_FPS;
  const packInst = pack.build({ scene, animStep });
  const content: H = packInst.handles;

  // ---- 角色与陈设（异步加载，失败不阻塞场景；场景编辑器 withCharacter=false 跳过）----
  let character: CharacterHandles | null = null;
  if (withCharacter) {
    loadCharacter(characterId)
      .then(async (c) => {
        // 面部 SDF（契约 faceSdf 字段 → /models/<file>）：全量启用，无景别门控。
        // 加载失败不阻塞角色（退回普通 NPR 明暗），与「契约缺失宁可响」不冲突——
        // 贴图缺失是资产补齐问题，不该炸掉整个场景。
        let faceSdf: THREE.Texture | null = null;
        if (c.charter?.faceSdf) {
          try {
            faceSdf = await new THREE.TextureLoader().loadAsync(`/models/${c.charter.faceSdf}`);
          } catch (e) {
            console.warn(`[${characterId}] 面部 SDF 加载失败（face 走普通 NPR 明暗）: ${c.charter.faceSdf}`, e);
          }
        }
        if (nprEnabled) applyNprToObject(c.group, nprUniforms, { stylizeMetal: false, faceSdf });
        character = c;
        scene.add(c.group);
      })
      .catch((e) => { console.warn(`[${characterId}] 加载失败，场景照常`, e); });
    if (withProps) loadProps().then((p) => scene.add(p)).catch(() => { /* 同上 */ });
  }

  const raycaster = new THREE.Raycaster();

  /** 世界点 → 页面客户端像素（与 DOM 层对齐的投影，交互层唯一需要的相机知识） */
  const _pv = new THREE.Vector3();
  function projectClient(world: THREE.Vector3): { x: number; y: number } {
    _pv.copy(world).project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((_pv.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - _pv.y) / 2) * rect.height,
    };
  }

  // ---- Bloom（氛围主角：只拾自发光；样张实测多自发光叠加会过曝，强度已标定）----
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(
    container.clientWidth, container.clientHeight,
    { samples: 4, type: THREE.HalfFloatType },
  ));
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    0.62, 0.55, 0.74,
  );
  composer.addPass(bloomPass);
  // 暗角 + 冷暖分离调色（压视线向角色；Bloom 之后、色彩空间输出之前）
  const gradePass = createGradePass({
    vignette: 0.3,
    strength: 0.28,
    saturation: 1.04,
    shadowTint: new THREE.Color(0x8d93d8),
    highlightTint: new THREE.Color(0xfff0d8),
  });
  composer.addPass(gradePass);
  composer.addPass(new OutputPass());
  let bloomOn = true;
  resize(); // 初始尺寸（composer 就绪后）

  // ---- 渲染循环（动画层 30fps 节流；业务逻辑由外部驱动）----
  let lastAnim = 0;

  function render(dt: number, elapsed: number) {
    void dt;
    if (elapsed - lastAnim >= animStep) {
      lastAnim = elapsed;
      packInst.update?.(animStep, elapsed);
      updateNprUniforms(nprUniforms, camera, key);
      if (bloomOn) composer.render();
      else renderer.render(scene, camera);
    }
  }

  return {
    renderer, camera, scene, content, raycaster, resize, view, render,
    setBloom(on: boolean) { bloomOn = on; },
    setNpr(on: boolean) {
      nprUniforms.uNprEnable.value = on ? 1 : 0;
      scene.environmentIntensity = on ? 0.6 : 0;
      gradePass.enabled = on;
    },
    character: () => character,
    clientPos: projectClient,
    objectClientPos: (obj: THREE.Object3D) => projectClient(obj.getWorldPosition(new THREE.Vector3())),
    debug: {
      lights: { hemi, key, moon, fill },
      bloomPass,
    },
  };
}
