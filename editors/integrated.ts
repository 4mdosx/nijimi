/**
 * 集成编辑器：完整场景（房间+陈设+粒子+工业簇）+ 夜兰，调「人物 × 环境」的融合观感。
 * 与主工程 index 的唯一差别 = 多了这块调试面板；标定完的参数回写
 * src/stage.ts / src/character.ts 的默认值。
 */

import * as THREE from 'three';
import { createStage } from '../src/stage';
import { applyBackdrop } from './studio';

const container = document.getElementById('viewport')!;
const s = createStage(container); // withCharacter 默认 true
// EffectComposer 会丢 alpha（透明处渲黑），浅色棚壁直接垫进 3D 场景
applyBackdrop(s.scene);
const D = s.debug;

// 人物基准值（loadYelan 固化）：站位 (2.35, 1.15)、朝向 -2.36、局部微调用滑杆叠加
const BASE = { x: 2.35, z: 1.15, rotY: -2.36 };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $inp = (id: string) => document.getElementById(id) as HTMLInputElement;

function bindSlider(id: string, valId: string, fmt: (v: number) => string, apply: (v: number) => void) {
  const inp = $inp(id);
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    apply(v);
    $(valId).textContent = fmt(v);
  });
}
const f2 = (v: number) => v.toFixed(2);

// ---- 人物（加载完成后生效）----
let dx = 0, dz = 0;
function applyChar() {
  const w = s.character();
  if (!w) return;
  w.group.position.set(BASE.x + dx, 0, BASE.z + dz);
  w.group.rotation.y = (parseFloat($inp('rotY').value) * Math.PI) / 180; // 滑杆值即绝对朝向
}
bindSlider('rotY', 'rotYVal', (v) => `${v.toFixed(0)}°`, () => applyChar());
bindSlider('posX', 'posXVal', (v) => (v >= 0 ? '+' : '') + v.toFixed(2), (v) => { dx = v; applyChar(); });
bindSlider('posZ', 'posZVal', (v) => (v >= 0 ? '+' : '') + v.toFixed(2), (v) => { dz = v; applyChar(); });
// 人物异步加载，轮询对齐一次初始滑杆值
const alignTimer = setInterval(() => {
  if (s.character()) { applyChar(); clearInterval(alignTimer); }
}, 300);
setTimeout(() => clearInterval(alignTimer), 15000);

// ---- 灯光 ----
bindSlider('key', 'keyVal', f2, (v) => { D.lights.key.intensity = v; });
bindSlider('hemi', 'hemiVal', f2, (v) => {
  D.lights.hemi.intensity = v * 0.5;
  s.scene.traverse((o) => {
    if ((o as THREE.AmbientLight).isAmbientLight) (o as THREE.AmbientLight).intensity = v * 0.55;
  });
});
bindSlider('moon', 'moonVal', f2, (v) => { D.lights.moon.intensity = v; });
bindSlider('fill', 'fillVal', (v) => v.toFixed(1), (v) => { D.lights.fill.intensity = v; });

// ---- 后期 ----
bindSlider('bloom', 'bloomVal', f2, (v) => { D.bloomPass.strength = v; });
bindSlider('exposure', 'exposureVal', f2, (v) => { s.renderer.toneMappingExposure = v; });

const nprBtn = $('toggleNpr');
let nprOn = true;
nprBtn.addEventListener('click', () => {
  nprOn = !nprOn;
  s.setNpr(nprOn);
  nprBtn.classList.toggle('on', nprOn);
  nprBtn.textContent = `NPR 手法：${nprOn ? '开' : '关'}`;
});

const bloomBtn = $('toggleBloom');
let bloomOn = true;
bloomBtn.addEventListener('click', () => {
  bloomOn = !bloomOn;
  s.setBloom(bloomOn);
  bloomBtn.classList.toggle('on', bloomOn);
  bloomBtn.textContent = `Bloom 通路：${bloomOn ? '开' : '关'}`;
});

$('resetView').addEventListener('click', () => s.view.reset());

// ---- 视窗交互（拖拽平移 / 滚轮缩放，与主工程同 rig）----
const canvas = s.renderer.domElement;
let dragging = false;
let px = 0, py = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; px = e.clientX; py = e.clientY; });
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  s.view.panByPx(e.clientX - px, e.clientY - py);
  px = e.clientX; py = e.clientY;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  s.view.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, {
    x: ((e.clientX - r.left) / r.width) * 2 - 1,
    y: -(((e.clientY - r.top) / r.height) * 2 - 1),
  });
}, { passive: false });

// ---- 渲染循环 ----
let last = performance.now();
const t0 = last;
function loop(now: number) {
  requestAnimationFrame(loop);
  s.render((now - last) / 1000, (now - t0) / 1000);
  last = now;
}
requestAnimationFrame(loop);

// 调试钩子
Object.assign(window, {
  __labIntegrated: { THREE, scene: s, lights: D.lights, bloomPass: D.bloomPass, character: () => s.character() },
});
