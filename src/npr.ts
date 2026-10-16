/**
 * NPR 复刻库 —— 《明日方舟：终末地》/《少女前线2：追放》公开拆解里的可移植手法，
 * 落到 three.js r186（WebGL2 / GLSL1）上。拆解与取舍见
 * `design/NPR渲染复刻-终末地少前2手法拆解与落地.md`。
 *
 * 六件事，全部与现有半 PBR 管线共存（不推翻 cozy 定稿）：
 *   1. 分离式光照 rig：角色主光方向锁在相机坐标系里，不跟随场景光源 → 永不阴阳脸。
 *   2. NPR 材质注入：柔和 ramp（不出现锐利半影）、冷暖撞色（暗部染色）、
 *      视角高光（高光方向随相机）、随相机边缘光（rim，颜色可换）。
 *   3. 彩色 IBL：程序化等距柱状渐变 → PMREM，给 PBR 件（黄铜/金属）带颜色的间接光。
 *   4. 反向 hull 描边：MeshBasicMaterial + onBeforeCompile 沿法线外扩，蒙皮自动兼容。
 *   5. PBR / NPR 分区：契约版资产按 `extras.charter.role` 查表定轨道
 *      （终末地 Hybrid NPR：面/发/布 NPR、身体与装甲 PBR）；无契约的资产
 *      （房间程序化材质、CC0 通用模型）退回材质名正则兜底。
 *   6. 后期：暗角 + 冷暖分离调色，一个 ShaderPass。
 *
 * 事实来源标注：[公开拆解] = 检索到的公开分析/复刻文章明确提到的；
 * [工程推断] = 我们为在 three.js 里落地做的替代实现。见文档 §2 逐条对照。
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { materialCharter, TRACK_OF_ROLE, type CharterRole } from './charter';

/* ------------------------------------------------------------------ *
 * 1. NPR 光照参数（共享 uniform 容器）
 * ------------------------------------------------------------------ */

/** 所有 NPR 材质共享同一组 IUniform 对象引用 → 改一次，全场生效。 */
export interface NprUniforms {
  /** 主光方向（世界空间，表面 → 光源，已归一化） */
  uNprKeyDir: THREE.IUniform<THREE.Vector3>;
  /** 主光颜色（乘在暗部→亮部过渡上的色） */
  uNprKeyColor: THREE.IUniform<THREE.Color>;
  /** 暗部保留比例：0 = 全黑，1 = 不做收敛（1 即关闭 ramp 收敛） */
  uNprRampLow: THREE.IUniform<number>;
  /** 明暗过渡带宽度（0.02 ≈ 硬边 cel；0.5 ≈ 几乎无阶跃）——终末地取「刻意避免锐利半影」 */
  uNprRampSoft: THREE.IUniform<number>;
  /** 暗部染色（冷暖撞色的冷端） */
  uNprShadowTint: THREE.IUniform<THREE.Color>;
  /** 亮部染色（冷暖撞色的暖端） */
  uNprLightTint: THREE.IUniform<THREE.Color>;
  /** 撞色强度 0–1 */
  uNprTintStrength: THREE.IUniform<number>;
  /** 视角高光：方向里混入相机朝向的比例（1 = 完全跟随相机 = 虚拟补光灯） */
  uNprSpecViewMix: THREE.IUniform<number>;
  uNprSpecStrength: THREE.IUniform<number>;
  uNprSpecPower: THREE.IUniform<number>;
  uNprSpecColor: THREE.IUniform<THREE.Color>;
  /** 随相机边缘光 */
  uNprRimColor: THREE.IUniform<THREE.Color>;
  uNprRimStrength: THREE.IUniform<number>;
  /** 边缘光宽度（指数越大越窄） */
  uNprRimPower: THREE.IUniform<number>;
  /** 全局开关：0 = 完全关掉注入（用于 A/B） */
  uNprEnable: THREE.IUniform<number>;
  /** 相机世界坐标（每帧写） */
  uNprCamPos: THREE.IUniform<THREE.Vector3>;
  /** 面部 SDF 总开关（共享；只有带 SDF 贴图的 face 材质会被置 1） */
  uNprSdfOn: THREE.IUniform<number>;
  /** 面部 SDF 调试输出：1=阈值场 2=最终明暗 3=光照衰减（共享） */
  uNprSdfDebug: THREE.IUniform<number>;
}

export function createNprUniforms(): NprUniforms {
  return {
    uNprKeyDir: { value: new THREE.Vector3(-0.4, 0.8, 0.45).normalize() },
    uNprKeyColor: { value: new THREE.Color(0xfff0dd) },
    uNprRampLow: { value: 0.5 },
    uNprRampSoft: { value: 0.34 },
    uNprShadowTint: { value: new THREE.Color(0x7d84c8) }, // 冷紫（与房间 hemi 同源）
    uNprLightTint: { value: new THREE.Color(0xfff1d8) },  // 暖白
    uNprTintStrength: { value: 0.5 },
    uNprSpecViewMix: { value: 0.7 },
    uNprSpecStrength: { value: 0.22 },
    uNprSpecPower: { value: 28 },
    uNprSpecColor: { value: new THREE.Color(0xfff4e2) },
    uNprRimColor: { value: new THREE.Color(0xffc890) },
    uNprRimStrength: { value: 0.3 },
    uNprRimPower: { value: 3.2 },
    uNprEnable: { value: 1 },
    uNprCamPos: { value: new THREE.Vector3() },
    uNprSdfOn: { value: 0 },
    uNprSdfDebug: { value: 0 },
  };
}

/** 把 NprUniforms 拆成 shader.uniforms 的补充表（保持对象引用，共享更新） */
function asShaderUniforms(u: NprUniforms): Record<string, THREE.IUniform> {
  return { ...u } as unknown as Record<string, THREE.IUniform>;
}

/* ------------------------------------------------------------------ *
 * 2. 材质注入
 * ------------------------------------------------------------------ */

const NPR_VERT_HEAD = /* glsl */ `
varying vec3 vNprWNormal;
varying vec3 vNprWPos;
varying vec3 vNprFwd;
varying vec3 vNprLeft;
// 自建 UV varying：r152 起 three 只在 USE_UV / USE_ANISOTROPY 下声明 vUv，
// 而 r186 的 WebGLProgram 从不定义 USE_UV（USE_MAP 只给 vMapUv）——直接引用
// vUv 会「未声明标识符」编译失败，把整个注入体连同调试分支一起废掉。
// 这里用标准 uv 属性自己传一份（attribute vec2 uv 是无条件声明的）。
varying vec2 vNprUv;
`;

const NPR_VERT_BODY = /* glsl */ `
	vNprWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
	vNprWNormal = normalize( mat3( modelMatrix ) * objectNormal );
	vNprFwd = normalize( mat3( modelMatrix ) * vec3( 0.0, 0.0, -1.0 ) );
	vNprLeft = normalize( mat3( modelMatrix ) * vec3( -1.0, 0.0, 0.0 ) );
	vNprUv = uv;
`;

const NPR_FRAG_HEAD = /* glsl */ `
uniform vec3 uNprKeyDir;
uniform vec3 uNprKeyColor;
uniform float uNprRampLow;
uniform float uNprRampSoft;
uniform vec3 uNprShadowTint;
uniform vec3 uNprLightTint;
uniform float uNprTintStrength;
uniform float uNprSpecViewMix;
uniform float uNprSpecStrength;
uniform float uNprSpecPower;
uniform vec3 uNprSpecColor;
uniform vec3 uNprRimColor;
uniform float uNprRimStrength;
uniform float uNprRimPower;
uniform float uNprEnable;
uniform vec3 uNprCamPos;
uniform float uNprSdfOn;
uniform float uNprSdfDebug;
uniform sampler2D uNprSdfMap;
varying vec3 vNprWNormal;
varying vec3 vNprWPos;
varying vec3 vNprFwd;
varying vec3 vNprLeft;
varying vec2 vNprUv;

// 保亮度的染色：只偏移色相 / 饱和度，不改变明度（冷暖撞色不能顺手把画面压暗）
vec3 nprTintKeepLuma( vec3 c, vec3 tint ) {
	float l0 = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	vec3 t = c * tint;
	float l1 = max( dot( t, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
	return t * ( l0 / l1 );
}
`;

/**
 * 注入主体。挂在 `#include <opaque_fragment>` 之前——此处 `outgoingLight` 与
 * `diffuseColor` 都已在作用域内，且 MeshStandardMaterial / MeshToonMaterial 同构，
 * 一份代码两条材质轨道通吃。
 *
 * 顺序：ramp 收敛（柔和明暗阶跃） → 冷暖撞色 → 视角高光 → 边缘光。
 */
const NPR_FRAG_BODY = /* glsl */ `
	if ( uNprEnable > 0.5 ) {
		vec3 nprN = normalize( vNprWNormal );
		vec3 nprV = normalize( uNprCamPos - vNprWPos );
		vec3 nprL = normalize( uNprKeyDir );

		// --- 明暗驱动 ---
		// 默认：柔和 ramp（smoothstep 重写 NdotL 过渡，抹掉锐利半影分割）。
		// face 专项：改用 SDF 阈值场驱动（终末地脸部阴影的正主），见下。
		float nprDriver = smoothstep( 0.5 - uNprRampSoft, 0.5 + uNprRampSoft, dot( nprN, nprL ) * 0.5 + 0.5 );

		// 面部 SDF：lightAtten = 光从正面(0)到背面(1)的水平进度；
		// R/G = 左右两个半球的阴影阈值场（美术烘的「光到哪个角度这块开始变暗」）。
		// 终末地柔化：edge0 = max(2a-1, 0), edge1 = min(2a, 1) ——
		// 正面(a=0)→RampU=1，侧面(a=0.5)→RampU=阈值本身，背面(a=1)→RampU=0，
		// 脸部光照随光源后移「慢慢软下来」而不是硬二分。
		// A 通道黑 = 鼻尖 mask：光到侧后方时鼻尖投影加深。
		float nprAtten = 1.0 - ( dot( nprL, normalize( vNprFwd ) ) * 0.5 + 0.5 );
		float nprThr = 0.0;
		#ifdef NPR_IS_FACE
		// 注意：这里不做 uNprSdfDebug 门控——调试模式也要把 nprDriver 算成 SDF 驱动，
		// 否则 dbg=2（最终明暗）显示的是默认 ramp 驱动，标定时会自欺。
		if ( uNprSdfOn > 0.5 ) {
			vec4 nprSdf = texture2D( uNprSdfMap, vNprUv );
			float nprSide = dot( nprL, normalize( vNprLeft ) );
			nprThr = nprSide > 0.0 ? nprSdf.r : nprSdf.g;
			float nprE0 = max( 2.0 * nprAtten - 1.0, 0.0 );
			float nprE1 = min( 2.0 * nprAtten, 1.0 );
			float nprLit = smoothstep( nprE0, nprE1, nprThr );
			float nprNose = ( 1.0 - nprSdf.a ) * smoothstep( 0.45, 0.75, nprAtten );
			nprDriver = nprLit * ( 1.0 - nprNose * 0.55 );
		}
		#endif

		float nprShade = mix( uNprRampLow, 1.0, nprDriver );

		// [工程推断] 只对「直射光」做风格化，环境/IBL 全额保留——对应拆解里
		// 「场景光源提供整体明暗与色彩氛围，角色光独立」的分工。
		// 若把环境光一起乘进 ramp，暗部会被二次压黑（实测：整身发灰发闷）。
		vec3 nprIndirect = reflectedLight.indirectDiffuse + reflectedLight.indirectSpecular;
		// PBR 轨道（金属/装甲）只 ramp 漫反射：GGX 高光是金属质感的本体，
		// 乘上 ramp 会把高光带一起压没（实测：黄铜件整根发黑）。
		#ifdef NPR_IS_PBR
			vec3 nprDirect = reflectedLight.directDiffuse * nprShade * uNprKeyColor + reflectedLight.directSpecular;
		#else
			vec3 nprDirect = ( reflectedLight.directDiffuse + reflectedLight.directSpecular ) * nprShade * uNprKeyColor;
		#endif

		// 自发光处理：face 的弱自发光随 SDF 明暗一起衰减（不然阴影区被自发光填平，
		// SDF 白烘）；其余轨道全额保留（glow 加法件「黑=不贡献」，不该被压）。
		#ifdef NPR_IS_FACE
			vec3 nprEmisTerm = totalEmissiveRadiance * mix( 0.35, 1.0, nprDriver );
		#else
			vec3 nprEmisTerm = totalEmissiveRadiance;
		#endif
		vec3 nprOut = nprIndirect + nprDirect + nprEmisTerm;

		// --- 冷暖撞色：暗部往冷端偏、亮部往暖端偏，保亮度 ---
		vec3 nprTint = mix( uNprShadowTint, uNprLightTint, nprDriver );
		vec3 nprTinted = nprTintKeepLuma( nprOut, nprTint );
		nprOut = mix( nprOut, nprTinted, uNprTintStrength );

		// --- 视角高光：高光方向 = 主光方向与相机方向的混合 ---
		// [公开拆解] 「服装和头发的高光方向会始终跟随摄像机视角，如同一个虚拟补光灯」
		vec3 nprH = normalize( mix( nprL, nprV, uNprSpecViewMix ) );
		float nprSpec = pow( clamp( dot( nprN, nprH ), 0.0, 1.0 ), max( uNprSpecPower, 1.0 ) );
		nprOut += uNprSpecColor * nprSpec * uNprSpecStrength;

		// --- 随相机边缘光：Fresnel 型 ---
		// [公开拆解] 「剧情过场中会根据场景色调应用不同颜色的边缘光，如红色或蓝色」
		float nprFres = 1.0 - clamp( dot( nprN, nprV ), 0.0, 1.0 );
		float nprRim = pow( nprFres, max( uNprRimPower, 0.5 ) );
		nprOut += uNprRimColor * nprRim * uNprRimStrength;

		// --- SDF 调试输出（标定侧别/方向用）：1=阈值场 2=最终明暗 3=光照衰减 ---
		#ifdef NPR_IS_FACE
		if ( uNprSdfOn > 0.5 && uNprSdfDebug > 0.5 ) {
			nprOut = uNprSdfDebug < 1.5 ? vec3( nprThr )
				: ( uNprSdfDebug < 2.5 ? vec3( nprDriver ) : vec3( nprAtten ) );
		}
		#endif

		outgoingLight = nprOut;
	}
`;

const nprCacheKeys = new WeakMap<THREE.Material, string>();

/** 把一个材质打上注入（幂等）。extra = 材质级 uniform（如各自的 SDF 贴图）。返回是否被打了。 */
function injectNpr(
  mat: THREE.Material,
  u: NprUniforms,
  extra?: Record<string, THREE.IUniform>,
): void {
  if (nprCacheKeys.has(mat)) return;
  const tag = `npr:${Math.random().toString(36).slice(2)}`;
  nprCacheKeys.set(mat, tag);

  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    // 共享 uniform 先并入，材质级（extra）后覆盖——face 材质用自己的 SDF 贴图与开关
    Object.assign(shader.uniforms, asShaderUniforms(u), extra ?? {});

    // 注入点都落在 `#include <common>` 之后——three 的 precision 前缀在那之前，
    // 自己往前加 varying 会在片元侧丢掉默认精度。
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${NPR_VERT_HEAD}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${NPR_VERT_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NPR_FRAG_HEAD}`)
      .replace('#include <opaque_fragment>', `${NPR_FRAG_BODY}\n\t#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => tag;
  mat.needsUpdate = true;
}

/* ------------------------------------------------------------------ *
 * 3. PBR / NPR 分区
 * ------------------------------------------------------------------ */

export type MaterialRole = 'npr' | 'pbr' | 'outline' | 'unlit' | 'auto';

/** [公开拆解] 「面部及皮肤着重 NPR，装甲武器以 PBR 为核心，布料皮革以 NPR 为主导」 */
const NPR_HINTS = ['皮肤', '脸', '面', '发', '毛', 'hair', 'skin', 'face', 'cloth', '服', '衣', '布', '裙', '丝', '袜', 'body', '体'];
const PBR_HINTS = ['金属', 'metal', '甲', 'armor', '武器', 'weapon', '刃', '刀', '枪', '剑', 'gear', '铁', '钢', '黄铜', 'brass', 'gear', 'glasses', '镜'];
const OUTLINE_HINTS = ['轮廓线', 'outline'];
/**
 * 脸部叠加件（眼球/睫毛/口腔/投影层）：不参与光照，直接出贴图色。
 * [实测] 这些件是贴在脸上的 BLEND 薄面，凹面法线背对相机锁定的主光，
 * Toon 轨道又吃不到 IBL，结果整个眼窝/口腔发黑（拆包模型通用问题）。
 * 现代 NPR 管线同样把这类件当 unlit 处理。
 *
 * 命名并集：夜兰「睫眉/白目/目/星目/口舌/齿」，终末地「睫眉/目白/目/目HL/目影/口内/表情/发影」。
 * 其中「发影」「目影」是半透明黑色投影层——走光照会被二次压暗，unlit 才是它的本意。
 */
const UNLIT_HINTS = [
  '睫眉', '眉睫', '目', '白目', '星目', '目hl', '目影', 'eye',
  '口舌', '口内', '齿', 'teeth', '表情',
  '发影', 'hairshadow', 'eyeshadow', 'highlight',
];

/** 按材质名猜角色部位（拆包模型的中文/英文材质名都吃得下） */
export function classifyMaterial(name: string): MaterialRole {
  const n = (name || '').toLowerCase();
  if (!n) return 'auto';
  for (const h of OUTLINE_HINTS) if (n.includes(h.toLowerCase())) return 'outline';
  for (const h of UNLIT_HINTS) if (n.includes(h.toLowerCase())) return 'unlit';
  for (const h of PBR_HINTS) if (n.includes(h.toLowerCase())) return 'pbr';
  for (const h of NPR_HINTS) if (n.includes(h.toLowerCase())) return 'npr';
  return 'auto';
}

/**
 * 契约族 → 渲染轨道。**这是角色资产的主路径**：契约版 GLB 的每个材质都带
 * `extras.charter.role`（见 src/render/charter.ts 与 tools/charter-rules.mjs），
 * 到这儿只是一次查表，没有任何名字匹配。
 *
 * 表本身在 `charter.ts` 的 `TRACK_OF_ROLE`（与 tools/charter-rules.mjs 的
 * FAMILIES[].track 同源），此处只加一条 v1 资产的兼容别名。
 */
const CHARTER_ROLE_TO_TRACK: Record<string, MaterialRole> = {
  ...TRACK_OF_ROLE,
  add: 'npr', // v1 契约的族名，v2 已改名 glow（保留别名免旧资产失效）
};

/**
 * 材质 → 轨道。优先读契约（角色资产），无契约时（房间程序化材质、CC0 通用模型）
 * 退回名字正则兜底。
 */
export function roleOfMaterial(mat: THREE.Material | null | undefined): MaterialRole {
  const c = materialCharter(mat);
  if (c?.role && CHARTER_ROLE_TO_TRACK[c.role]) return CHARTER_ROLE_TO_TRACK[c.role];
  return classifyMaterial(mat?.name ?? '');
}

/** 材质 → 契约族（无契约返回 null）。渲染端做族级分支时用这个，别自己读 userData。 */
export function charterRoleOf(mat: THREE.Material | null | undefined): CharterRole | null {
  return materialCharter(mat)?.role ?? null;
}

/* ------------------------------------------------------------------ *
 * 4. NPR ramp 贴图（柔和多段，替代硬 step）
 * ------------------------------------------------------------------ */

/**
 * 生成 ramp 贴图。`bands` 为色阶数，`soft` ∈ [0,1] 控制段间过渡宽度：
 * soft=0 → 硬 cel；soft=1 → 近乎连续。终末地取 middle（拆解原文：「刻意避免锐利的半影分割」）。
 * 注：统一着色模型落地后运行期走 smoothstep 注入项，本函数保留给需要贴图 ramp 的场合。
 */
export function makeRampTexture(bands = 4, soft = 0.55): THREE.DataTexture {
  const W = 256;
  const data = new Uint8Array(W * 4);
  for (let i = 0; i < W; i++) {
    const x = i / (W - 1);           // 0 = 全暗，1 = 全亮
    const t = x * bands;
    const f = t - Math.floor(t);
    const edge = Math.max(0.001, soft * 0.5);
    const local = THREE.MathUtils.smoothstep(f, 0.5 - edge, 0.5 + edge);
    const v = (Math.floor(t) + local) / bands;
    const shade = 0.42 + 0.58 * v;    // 暗部下限 0.42，避免死黑
    data[i * 4 + 0] = Math.round(255 * shade);
    data[i * 4 + 1] = Math.round(255 * shade);
    data[i * 4 + 2] = Math.round(255 * shade);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, W, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 * 5. 材质转换
 * ------------------------------------------------------------------ */

export interface NprMaterialOptions {
  /** 强制角色；省略则按材质名自动分类 */
  role?: MaterialRole;
  /** 色阶段数与柔和度（仅 NPR 轨道） */
  bands?: number;
  rampSoft?: number;
  /** 是否给 PBR 件加风格化高光（默认 true） */
  stylizeMetal?: boolean;
  /** 描边壳粗细（世界单位，仅 outline 轨道） */
  outlineWidth?: number;
  /**
   * 面部 SDF 阴影贴图（契约 model.charter.faceSdf 指向的文件）。
   * 传入后所有 face 族材质走 SDF 明暗（终末地脸部专项），全量启用、无景别门控。
   * 通道语义：R/G = 左/右半球阴影阈值场，A = 鼻尖 mask（黑=鼻尖）。
   */
  faceSdf?: THREE.Texture | null;
}

/**
 * 把 glTF 带来的 MeshStandardMaterial 转成 NPR 轨道材质，并注入风格化光照。
 * 保留 map / alphaMode / side / transparent / name / skinning 相关的一切——
 * 只换 shading 模型，不换外观数据（[工程推断] 等价于引擎侧的「材质替换」）。
 *
 * 轨道判定走 roleOfMaterial：契约版资产读 extras.charter.role，其余退回名字正则。
 */
export function toNprMaterial(
  src: THREE.Material,
  u: NprUniforms,
  opts: NprMaterialOptions = {},
): THREE.Material {
  const std = src as THREE.MeshStandardMaterial;
  const role = opts.role ?? roleOfMaterial(src);

  if (role === 'outline') {
    // 自带描边壳（契约 role=outline，如异环「发轮廓线」）：转成反向 hull——
    // 背面 + 沿法线外扩。PMX 里它靠 alpha=0 隐藏，这里才是它的正解。
    const m = makeOutlineMaterial({
      color: new THREE.Color(std.color ?? 0x241d2e),
      thickness: opts.outlineWidth ?? 0.008,
    });
    m.name = src.name;
    return m;
  }

  if (role === 'unlit') {
    // 脸部叠加件：保留贴图与透明设置，去掉所有光照反应
    const m = new THREE.MeshBasicMaterial({
      color: std.color ? std.color.clone() : new THREE.Color(0xffffff),
      map: std.map ?? null,
      side: std.side,
      transparent: std.transparent,
      opacity: std.opacity,
      alphaTest: std.alphaTest,
      depthWrite: std.depthWrite,
      fog: false,
    });
    m.name = src.name;
    return m;
  }

  if (role === 'pbr') {
    // PBR 轨道：保留物理反射。**只有金属族**做「重新定义金属」的高光改造——
    // 皮肤走 PBR 是终末地的部位分区（身体 PBR），不是要给它加高光带；
    // 曾经的写法对整条 PBR 轨道统一 stylizeMetal，会把皮肤粗糙度钳到 0.62 发亮。
    if (opts.stylizeMetal !== false && charterRoleOf(src) === 'metal') stylizeMetal(std);
    (std as THREE.MeshStandardMaterial).defines = { NPR_IS_PBR: '' };
    injectNpr(std, u);
    return std;
  }

  // ---- NPR 轨道（face 族先分流）----
  // 统一着色模型：MeshStandardMaterial + 注入（终末地路线是「PBR 各分量重映射」，
  // 不是 toon 材质打补丁）。曾经的 MeshToonMaterial + gradientMap 与注入 ramp
  // 是两级阶跃串联，且 toon 不吃 scene.environment——2026-10-16 起废弃。
  const isFace = charterRoleOf(src) === 'face';

  if (isFace && opts.faceSdf) {
    // face 专项：SDF 阴影驱动明暗（NPR_IS_FACE 分支）。皮肤无高光（roughness 拉满），
    // 弱自发光保底（契约 faceGlow，随 SDF 明暗调制，否则阴影区被填平）。
    const face = new THREE.MeshStandardMaterial({
      color: std.color ? std.color.clone() : new THREE.Color(0xffffff),
      map: std.map ?? null,
      roughness: 0.95,
      metalness: 0,
      emissive: std.emissive ? std.emissive.clone() : new THREE.Color(0x000000),
      emissiveMap: std.emissiveMap ?? null,
      emissiveIntensity: std.emissiveIntensity ?? 1,
      alphaMap: std.alphaMap ?? null,
      side: std.side,
      transparent: std.transparent,
      opacity: std.opacity,
      alphaTest: std.alphaTest,
      depthWrite: std.depthWrite,
    });
    face.name = src.name;
    face.defines = { NPR_IS_FACE: '' };
    opts.faceSdf.colorSpace = THREE.NoColorSpace; // 数据贴图，不做 sRGB 解码
    injectNpr(face, u, {
      uNprSdfMap: { value: opts.faceSdf },
      uNprSdfOn: { value: 1 },
    });
    return face;
  }

  const npr = new THREE.MeshStandardMaterial({
    color: std.color ? std.color.clone() : new THREE.Color(0xffffff),
    map: std.map ?? null,
    roughness: 0.9,
    metalness: 0,
    emissive: std.emissive ? std.emissive.clone() : new THREE.Color(0x000000),
    emissiveMap: std.emissiveMap ?? null,
    // 拷贝自发光强度——applyPmxAnimeFix 标定的 0.2 曾在这里被默认值 1 覆盖，
    // 脸部等于全强度自发光，过 Bloom 直接白炸（2026-10-16 集成编辑器实测）
    emissiveIntensity: std.emissiveIntensity ?? 1,
    alphaMap: std.alphaMap ?? null,
    side: std.side,
    transparent: std.transparent,
    opacity: std.opacity,
    alphaTest: std.alphaTest,
    depthWrite: std.depthWrite,
  });
  npr.name = src.name;
  if (isFace) npr.defines = { NPR_IS_FACE: '' }; // 无 SDF 贴图：face 分支内 uNprSdfOn=0，按普通 NPR 走
  injectNpr(npr, u);
  return npr;
}

/**
 * 风格化金属：常规 PBR 靠「油亮」表达金属，那不是二次元语感。
 * 做法是压金属度上限 + 抬粗糙度下限 + 降环境反射强度，把金属从镜面拉回「漫反射为主、
 * 高光成带」（带感由 NPR 注入的视角高光提供）。
 */
export function stylizeMetal(mat: THREE.MeshStandardMaterial): void {
  const m = mat.metalness ?? 0;
  mat.metalness = Math.min(m, 0.82);
  mat.roughness = THREE.MathUtils.clamp(mat.roughness ?? 0.5, 0.26, 0.62);
  mat.envMapIntensity = 0.8;
}

/** 遍历一棵子树，按分区规则换材质。返回换了几个。 */
export function applyNprToObject(
  root: THREE.Object3D,
  u: NprUniforms,
  opts: NprMaterialOptions = {},
): number {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.frustumCulled = false; // 蒙皮网格的包围盒不含骨骼位移
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // face 族不收 shadow map 实时阴影：SDF 是脸部阴影的唯一来源，
    // 两份叠加会把刘海影烘成死黑（夜兰无发影贴片，双重阴影尤其明显）
    const isFaceMesh = mats.some((m) => charterRoleOf(m) === 'face');
    mesh.receiveShadow = !isFaceMesh;
    const next = mats.map((m) => toNprMaterial(m, u, opts));
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
    n += next.length;
  });
  return n;
}

/* ------------------------------------------------------------------ *
 * 6. 反向 hull 描边
 * ------------------------------------------------------------------ */

export interface OutlineOptions {
  color?: THREE.ColorRepresentation;
  /** 世界单位（正交相机下即屏幕恒定粗细） */
  thickness?: number;
}

/**
 * 蒙皮安全的替身网格：蒙皮网格的顶点在 bind 空间，直接 new Mesh 会渲染成 bind pose
 * （T-pose）——替身必须以 SkinnedMesh + 同一 skeleton + 同一 bindMatrix 建，
 * 并挂成源网格的子节点（继承同一 world matrix，避免双重变换）。
 */
function makeTwinMesh(src: THREE.Mesh, material: THREE.Material): THREE.Mesh {
  const skinned = (src as THREE.SkinnedMesh).isSkinnedMesh === true;
  if (!skinned) {
    const m = new THREE.Mesh(src.geometry, material);
    m.frustumCulled = false;
    return m;
  }
  const sm = src as THREE.SkinnedMesh;
  const twin = new THREE.SkinnedMesh(src.geometry, material);
  twin.bindMode = sm.bindMode;
  twin.bind(sm.skeleton, sm.bindMatrix);
  twin.frustumCulled = false;
  return twin;
}

/** 沿法线外扩（外扩量在世界单位下恒定，正交相机即屏幕恒定粗细）。 */
function expandAlongNormal(material: THREE.Material, u: { value: number }, outward: boolean, key: string): void {
  material.userData.outlineUniform = u; // 便于滑杆实时改粗细，不必重建
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = u;
    shader.vertexShader = 'uniform float uOutline;\n' + shader.vertexShader.replace(
      '#include <skinning_vertex>',
      `#include <skinning_vertex>\n\ttransformed ${outward ? '+' : '-'}= normalize( objectNormal ) * uOutline;`,
    );
  };
  material.customProgramCacheKey = () => key;
}

/** 实时改描边粗细 / 阴影代理内缩量（遍历子树，找带 outlineUniform 的材质）。 */
export function setOutlineThickness(root: THREE.Object3D, thickness: number): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      const u = (mat as THREE.Material).userData.outlineUniform as { value: number } | undefined;
      if (u) { u.value = thickness; n++; }
    }
  });
  return n;
}

/**
 * 经典反向 hull 描边：MeshBasicMaterial(BackSide) + 顶点沿法线外扩。
 * 用 onBeforeCompile 而不是自写 ShaderMaterial，是为了白拿 three 的蒙皮 / morph
 * 顶点着色链——注入点放在 `#include <skinning_vertex>` 之后，`objectNormal` 已被骨骼变换。
 */
export function makeOutlineMaterial(opts: OutlineOptions = {}): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(opts.color ?? 0x1a1522),
    side: THREE.BackSide,
    transparent: false,
    depthWrite: true,
    fog: false,
  });
  expandAlongNormal(mat, { value: opts.thickness ?? 0.006 }, true, 'npr-outline');
  return mat;
}

/** 给一个网格挂描边壳（共享几何，零额外内存）。返回壳对象，便于改粗细。 */
export function addOutlineHull(mesh: THREE.Mesh, opts: OutlineOptions = {}): THREE.Mesh {
  const hull = makeTwinMesh(mesh, makeOutlineMaterial(opts));
  hull.name = `${mesh.name || 'mesh'}__outline`;
  hull.castShadow = false;
  hull.receiveShadow = false;
  hull.renderOrder = -1;
  mesh.add(hull);
  return hull;
}

/** 给整棵子树挂描边（跳过自带描边壳与透明件）。 */
export function addOutlineToObject(root: THREE.Object3D, opts: OutlineOptions = {}): number {
  const targets: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.Material;
    if (mat && (mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) return;
    if (mat && roleOfMaterial(mat) === 'outline') return;
    if (mat && mat.transparent) return; // 透明件外扩会糊
    targets.push(m);
  });
  for (const m of targets) addOutlineHull(m, opts);
  return targets.length;
}

/* ------------------------------------------------------------------ *
 * 7. 阴影代理
 * ------------------------------------------------------------------ */

/**
 * [公开拆解] 「系统还使用了向内的阴影代理，虽然不完全符合物理真实，
 *  却极大地丰富了角色的结构层次。」
 * [工程推断] three.js 里我们把它落地为「沿法线内缩的隐形投影体」：
 *  原网格只收阴影不投阴影，克隆一份沿法线内缩 ε 的隐形壳专门投影——
 *  投出的阴影比物理真实更小更贴合剪影，读起来是「内阴影」而不是杂物投影。
 */
export function addShadowProxy(mesh: THREE.Mesh, inset = 0.01): THREE.Mesh | null {
  const mat = mesh.material as THREE.Material;
  if (!mat || mat.transparent) return null;
  const proxyMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const proxy = makeTwinMesh(mesh, proxyMat);
  proxy.name = `${mesh.name || 'mesh'}__shadowProxy`;
  proxy.castShadow = true;
  proxy.receiveShadow = false;
  proxy.position.copy(mesh.position);
  proxy.quaternion.copy(mesh.quaternion);
  proxy.scale.copy(mesh.scale);
  // 内缩必须打在**深度材质**上——three 投影时用 MeshDepthMaterial，改原材质无效
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  expandAlongNormal(depthMat, { value: inset }, false, 'npr-shadow-proxy');
  proxy.customDepthMaterial = depthMat;
  mesh.castShadow = false;
  (mesh.parent ?? mesh).add(proxy);
  return proxy;
}

/** 给整棵子树挂阴影代理（跳过透明件与已有替身）。 */
export function addShadowProxyToObject(root: THREE.Object3D, inset = 0.01): number {
  const targets: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if ((m.material as THREE.Material as THREE.MeshBasicMaterial).isMeshBasicMaterial) return;
    if (m.name.endsWith('__shadowProxy') || m.name.endsWith('__outline')) return;
    if ((m.material as THREE.Material).transparent) return;
    targets.push(m);
  });
  let n = 0;
  for (const m of targets) if (addShadowProxy(m, inset)) n++;
  return n;
}

/* ------------------------------------------------------------------ *
 * 8. 分离式相机锁定光照 rig
 * ------------------------------------------------------------------ */

export interface CameraLockedRigOptions {
  /** 主光相对相机的方位（相机局部系：x 右、y 上、z 朝后） */
  keyOffset?: THREE.Vector3;
  keyColor?: THREE.ColorRepresentation;
  keyIntensity?: number;
  rimColor?: THREE.ColorRepresentation;
  rimIntensity?: number;
  rimOffset?: THREE.Vector3;
  /** 灯与目标的距离（方向光只看方向，距离只影响 shadow camera 摆放） */
  distance?: number;
  castShadow?: boolean;
  shadowSpan?: number;
  shadowMapSize?: number;
}

export interface CameraLockedRig {
  key: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  group: THREE.Group;
  /** 每帧调用：把灯摆到「相机坐标系里的固定方位」 */
  update(camera: THREE.Camera): void;
}

/**
 * [公开拆解] 「将角色光照从场景光源中独立出来，将主要光照方向强制校准为相机朝向，
 *  避免因场景光源位置不佳而产生的『阴阳脸』或杂乱阴影。场景光源主要起提供
 *  整体明暗变化和色彩氛围的作用。」
 *
 * 实现：每帧读相机世界矩阵，把灯放到相机局部系的固定偏移点上——相机不动，
 * 角色就是固定的经典三点光；相机绕角色转，角色永远被同一套光打亮。
 */
export function createCameraLockedRig(opts: CameraLockedRigOptions = {}): CameraLockedRig {
  const group = new THREE.Group();
  group.name = 'npr-camera-rig';
  const distance = opts.distance ?? 4;
  const span = opts.shadowSpan ?? 4;

  const key = new THREE.DirectionalLight(opts.keyColor ?? 0xfff0dd, opts.keyIntensity ?? 1.6);
  key.name = 'npr-key';
  const rim = new THREE.DirectionalLight(opts.rimColor ?? 0xffc890, opts.rimIntensity ?? 1.1);

  if (opts.castShadow !== false) {
    key.castShadow = true;
    const s = opts.shadowMapSize ?? 2048;
    key.shadow.mapSize.set(s, s);
    key.shadow.camera.left = -span;
    key.shadow.camera.right = span;
    key.shadow.camera.top = span;
    key.shadow.camera.bottom = -span;
    key.shadow.camera.far = distance * 4;
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
  }
  group.add(key, key.target, rim, rim.target);

  const keyOffset = (opts.keyOffset ?? new THREE.Vector3(-0.55, 0.62, 0.75)).normalize().multiplyScalar(distance);
  const rimOffset = (opts.rimOffset ?? new THREE.Vector3(0.7, 0.35, -0.72)).normalize().multiplyScalar(distance);

  const m = new THREE.Matrix4();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const back = new THREE.Vector3();
  const place = (light: THREE.DirectionalLight, off: THREE.Vector3, target: THREE.Vector3) => {
    const p = new THREE.Vector3()
      .addScaledVector(right, off.x)
      .addScaledVector(up, off.y)
      .addScaledVector(back, -off.z);
    light.position.copy(target).add(p);
    light.target.position.copy(target);
    light.target.updateMatrixWorld();
  };

  function update(camera: THREE.Camera) {
    m.copy(camera.matrixWorld);
    right.setFromMatrixColumn(m, 0).normalize();
    up.setFromMatrixColumn(m, 1).normalize();
    back.setFromMatrixColumn(m, 2).normalize();
    const target = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    // 光的目标取「相机前方 distance*0.35 处」——正交/透视都够用，不必知道被摄对象
    target.addScaledVector(back, -distance * 0.35);
    place(key, keyOffset, target);
    place(rim, rimOffset, target);
  }

  return { key, rim, group, update };
}

/* ------------------------------------------------------------------ *
 * 9. 彩色 IBL
 * ------------------------------------------------------------------ */

export interface ColoredEnvOptions {
  /** 天顶色 */
  sky?: THREE.ColorRepresentation;
  /** 地平线色 */
  horizon?: THREE.ColorRepresentation;
  /** 地面色 */
  ground?: THREE.ColorRepresentation;
  /** 主光方向上的暖色光斑（模拟一盏主光被环境"看见"） */
  glow?: THREE.ColorRepresentation;
  /** 光斑中心方向（世界空间） */
  glowDir?: THREE.Vector3;
  /** 环境强度 */
  intensity?: number;
}

/**
 * [公开拆解] 「服装材质则恰到好处地混合了 PBR，并融入带颜色的 IBL
 *  （基于图像的光照），这不仅丰富了间接光信息，也让皮衣等工业风材质在
 *  二次元世界中显得毫不违和。」
 *
 * 实现：把渐变烘进一个内表面反向球体的顶点色 → PMREMGenerator.fromScene() 预卷积
 * → scene.environment。只作用于 PBR 轨道（MeshStandardMaterial 系），NPR 轨道走灯光，互不干扰。
 */
export function createColoredEnvironment(
  renderer: THREE.WebGLRenderer,
  opts: ColoredEnvOptions = {},
): { texture: THREE.Texture; dispose(): void } {
  const sky = new THREE.Color(opts.sky ?? 0x3a4270);
  const horizon = new THREE.Color(opts.horizon ?? 0x5c5570);
  const ground = new THREE.Color(opts.ground ?? 0x2a2230);
  const glow = new THREE.Color(opts.glow ?? 0xffc890);
  const glowDir = (opts.glowDir ?? new THREE.Vector3(-0.55, 0.62, 0.75)).normalize();
  const tmp = new THREE.Color();

  // PMREM：DataTexture 直喂 fromEquirectangular 实测拿到的是黑图，
  // 走文档推荐的 fromScene()——把渐变烘到一个内表面反向的球体顶点色上。
  const envScene = new THREE.Scene();
  const sphere = new THREE.SphereGeometry(10, 48, 32);
  const pos = sphere.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const h = THREE.MathUtils.clamp(v.y * 0.5 + 0.5, 0, 1);
    if (h > 0.5) tmp.copy(horizon).lerp(sky, (h - 0.5) * 2);
    else tmp.copy(ground).lerp(horizon, h * 2);
    // 主光方向上的暖斑：给金属件留下一条可读的高光带
    const g = Math.pow(THREE.MathUtils.clamp(v.dot(glowDir), 0, 1), 5);
    tmp.lerp(glow, g * 0.9);
    colors[i * 3] = THREE.MathUtils.clamp(tmp.r, 0, 1);
    colors[i * 3 + 1] = THREE.MathUtils.clamp(tmp.g, 0, 1);
    colors[i * 3 + 2] = THREE.MathUtils.clamp(tmp.b, 0, 1);
  }
  sphere.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const shell = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide,
  }));
  envScene.add(shell);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  sphere.dispose();
  (shell.material as THREE.Material).dispose();
  void opts.intensity;

  return {
    texture: rt.texture,
    dispose() {
      rt.dispose();
    },
  };
}

/** 挂环境并设强度（r163+ 的 scene.environmentIntensity） */
export function applyEnvironment(
  scene: THREE.Scene,
  env: THREE.Texture,
  intensity = 0.7,
): void {
  scene.environment = env;
  scene.environmentIntensity = intensity;
}

/* ------------------------------------------------------------------ *
 * 10. 后期：暗角 + 冷暖分离调色
 * ------------------------------------------------------------------ */

export interface GradeOptions {
  vignette?: number;
  vignettePower?: number;
  /** 阴影整体色偏向（通常冷） */
  shadowTint?: THREE.Color;
  /** 高光整体色偏向（通常暖） */
  highlightTint?: THREE.Color;
  strength?: number;
  saturation?: number;
  contrast?: number;
}

/**
 * 一个 pass 干两件事：暗角（把视线压向角色）+ 冷暖分离调色。
 * 放在 Bloom 之后、OutputPass 之前——此时是线性光，乘色即物理正确的染色。
 */
export function createGradePass(opts: GradeOptions = {}): ShaderPass {
  const shader: THREE.ShaderMaterialParameters = {
    uniforms: {
      tDiffuse: { value: null as THREE.Texture | null },
      uVignette: { value: opts.vignette ?? 0.42 },
      uVignettePower: { value: opts.vignettePower ?? 1.5 },
      uShadowTint: { value: (opts.shadowTint ?? new THREE.Color(0x8d93d8)).clone() },
      uHighlightTint: { value: (opts.highlightTint ?? new THREE.Color(0xfff0d8)).clone() },
      uSplit: { value: opts.strength ?? 0.35 },
      uSaturation: { value: opts.saturation ?? 1.06 },
      uContrast: { value: opts.contrast ?? 1.05 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float uVignette;
      uniform float uVignettePower;
      uniform vec3 uShadowTint;
      uniform vec3 uHighlightTint;
      uniform float uSplit;
      uniform float uSaturation;
      uniform float uContrast;
      varying vec2 vUv;
      const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );
      void main() {
        vec3 c = texture2D( tDiffuse, vUv ).rgb;

        float l = dot( c, LUMA );
        // 冷暖分离：暗部乘冷端、亮部乘暖端
        vec3 tint = mix( uShadowTint, uHighlightTint, smoothstep( 0.0, 0.6, l ) );
        c = mix( c, c * tint, uSplit );

        // 饱和度 / 对比（围绕中灰）
        float g = dot( c, LUMA );
        c = mix( vec3( g ), c, uSaturation );
        c = ( c - 0.18 ) * uContrast + 0.18;

        // 暗角
        vec2 d = vUv - 0.5;
        float v = 1.0 - uVignette * pow( clamp( dot( d, d ) * 2.0, 0.0, 1.0 ), uVignettePower );
        c *= clamp( v, 0.0, 1.0 );

        gl_FragColor = vec4( max( c, vec3( 0.0 ) ), 1.0 );
      }
    `,
  };
  return new ShaderPass(shader);
}

/* ------------------------------------------------------------------ *
 * 11. 每帧驱动
 * ------------------------------------------------------------------ */

/**
 * 每帧调用：同步相机位置 uniform（视角高光与边缘光依赖它）。
 * 传 keyLight 时同时把主光方向写进 uNprKeyDir —— 注入项与真实灯光的接线
 * （此前 uNprKeyDir 只有硬编码默认值，与场景主光同向纯属巧合）。
 */
export function updateNprUniforms(
  u: NprUniforms,
  camera: THREE.Camera,
  keyLight?: THREE.DirectionalLight,
): void {
  camera.getWorldPosition(u.uNprCamPos.value);
  if (keyLight) {
    u.uNprKeyDir.value.copy(keyLight.position).sub(keyLight.target.position).normalize();
  }
}

/* ------------------------------------------------------------------ *
 * 12. 预设
 * ------------------------------------------------------------------ */

/** 一键预设：把 uniforms / rig / grade 调到「终末地复刻」或「原管线」 */
export interface NprPresetContext {
  uniforms: NprUniforms;
  rig?: CameraLockedRig;
  grade?: ShaderPass;
}

export function applyPreset(ctx: NprPresetContext, name: 'endfield' | 'baseline'): void {
  const u = ctx.uniforms;
  const g = ctx.grade;
  if (name === 'baseline') {
    u.uNprEnable.value = 0;
    u.uNprRimStrength.value = 0;
    u.uNprTintStrength.value = 0;
    u.uNprRampLow.value = 1;
    if (ctx.rig) {
      ctx.rig.key.intensity = 1.35;
      ctx.rig.rim.intensity = 0.35;
    }
    if (g) {
      g.uniforms.uVignette.value = 0;
      g.uniforms.uSplit.value = 0;
      g.uniforms.uSaturation.value = 1;
      g.uniforms.uContrast.value = 1;
    }
    return;
  }
  u.uNprEnable.value = 1;
  u.uNprRampLow.value = 0.55;
  u.uNprRampSoft.value = 0.34;
  u.uNprTintStrength.value = 0.5;
  u.uNprRimStrength.value = 0.3;
  u.uNprSpecStrength.value = 0.22;
  if (ctx.rig) {
    ctx.rig.key.intensity = 1.9;
    ctx.rig.rim.intensity = 0.55;
  }
  if (g) {
    g.uniforms.uVignette.value = 0.42;
    g.uniforms.uSplit.value = 0.35;
    g.uniforms.uSaturation.value = 1.06;
    g.uniforms.uContrast.value = 1.05;
  }
}
