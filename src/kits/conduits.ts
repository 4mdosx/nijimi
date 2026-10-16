/**
 * 连线：TubeGeometry + 流动 shader。
 * 「流动才亮」（工坊空间尺度 §4.3）：有流量→流光，停摆→变暗。
 * 悬停穿透（§4.2）：depthTest=false + renderOrder。
 * 布线（§3）：端口 → 上升到 h_edge → 水平 → 下降到目标端口（三段曼哈顿）。
 */

import * as THREE from 'three';

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uFlow;     // 0=停摆 1=流动
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uHighlight; // 悬停高亮 0/1
  varying vec2 vUv;
  void main() {
    // 沿线流动的亮段
    float stripes = fract(vUv.x * 6.0 - uTime * 1.6);
    float pulse = smoothstep(0.05, 0.5, stripes) * smoothstep(0.95, 0.5, stripes);
    float base = 0.28;
    vec3 col = uColor * (base + (1.0 - base) * pulse * uFlow);
    col += uColor * uHighlight * 0.5;
    gl_FragColor = vec4(col, uOpacity);
  }
`;

export interface Conduit {
  edgeKey: string;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  fromSlot: number;
  toSlot: number;
  /** 悬停穿透状态 */
  highlight: boolean;
}

export class ConduitManager {
  group = new THREE.Group();
  private conduits = new Map<string, Conduit>();

  private static edgeKey(fromSlot: number, fromPort: number, toSlot: number, toPort: number): string {
    return `${fromSlot}:${fromPort}>${toSlot}:${toPort}`;
  }

  /** 曼哈顿三段路径 */
  private static makePath(a: THREE.Vector3, b: THREE.Vector3, h: number): THREE.CatmullRomCurve3 {
    const mid1 = new THREE.Vector3(a.x, h, a.z);
    const mid2 = new THREE.Vector3(b.x, h, b.z);
    return new THREE.CatmullRomCurve3([a, mid1, mid2, b], false, 'catmullrom', 0.0);
  }

  add(
    fromSlot: number,
    fromPort: number,
    a: THREE.Vector3,
    toSlot: number,
    toPort: number,
    b: THREE.Vector3,
  ): Conduit {
    const key = ConduitManager.edgeKey(fromSlot, fromPort, toSlot, toPort);
    this.remove(key);
    const h = Math.max(a.y, b.y) + 0.22;
    const curve = ConduitManager.makePath(a, b, h);
    const geom = new THREE.TubeGeometry(curve, 32, 0.014, 8, false);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uFlow: { value: 0 },
        uColor: { value: new THREE.Color(0x8ad8ff) },
        uOpacity: { value: 0.85 },
        uHighlight: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geom, material);
    mesh.renderOrder = 10;
    const conduit: Conduit = { edgeKey: key, mesh, material, fromSlot, toSlot, highlight: false };
    this.group.add(mesh);
    this.conduits.set(key, conduit);
    return conduit;
  }

  remove(key: string) {
    const c = this.conduits.get(key);
    if (!c) return;
    this.group.remove(c.mesh);
    c.mesh.geometry.dispose();
    c.material.dispose();
    this.conduits.delete(key);
  }

  clear() {
    for (const key of [...this.conduits.keys()]) this.remove(key);
  }

  get(key: string): Conduit | undefined {
    return this.conduits.get(key);
  }

  all(): Conduit[] {
    return [...this.conduits.values()];
  }

  setTime(t: number) {
    for (const c of this.conduits.values()) c.material.uniforms.uTime.value = t;
  }

  /** 悬停某 slot：相关边穿透高亮，无关边淡出 15% */
  hoverSlot(slot: number | null) {
    for (const c of this.conduits.values()) {
      const related = slot == null || c.fromSlot === slot || c.toSlot === slot;
      c.highlight = related && slot != null;
      c.material.uniforms.uHighlight.value = related && slot != null ? 1 : 0;
      c.material.depthTest = !(related && slot != null);
      c.mesh.renderOrder = related && slot != null ? 99 : 10;
      if (slot != null && !related) c.material.uniforms.uOpacity.value = 0.15;
      else c.material.uniforms.uOpacity.value = 0.85;
    }
  }
}
