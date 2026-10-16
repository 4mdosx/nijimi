/**
 * 程序化 CanvasTexture 材质库 —— 零外部资产硬约束（MVP原型设计 §5）。
 * 思路参考 threejs-sims-house-builder（MIT）：Canvas 画木纹/墙纸/瓷砖。
 */

import * as THREE from 'three';

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function toTexture(c: HTMLCanvasElement, repeatX = 1, repeatY = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 深色木地板：横条木板 + 木纹噪线 */
export function woodFloorTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(256, 256);
  g.fillStyle = '#6b4a32';
  g.fillRect(0, 0, 256, 256);
  const rows = 6;
  for (let i = 0; i < rows; i++) {
    const y = (i * 256) / rows;
    // 每块板色差
    const tone = 0.85 + Math.random() * 0.3;
    const r = Math.floor(0x7a * tone);
    const gg = Math.floor(0x55 * tone);
    const b = Math.floor(0x38 * tone);
    g.fillStyle = `rgb(${r},${gg},${b})`;
    g.fillRect(0, y + 1, 256, (256 / rows) - 2);
    // 板缝
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, y, 256, 1);
    // 木纹细线
    g.strokeStyle = 'rgba(40,25,15,0.25)';
    for (let k = 0; k < 5; k++) {
      g.beginPath();
      const yy = y + Math.random() * (256 / rows);
      g.moveTo(0, yy);
      g.bezierCurveTo(80, yy + (Math.random() - 0.5) * 4, 170, yy + (Math.random() - 0.5) * 4, 256, yy);
      g.stroke();
    }
    // 竖向接缝（错位）
    const seam = Math.random() * 256;
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(seam, y, 1, 256 / rows);
  }
  return toTexture(c, 3, 3);
}

/** 台面深色桌面：更细的木纹 */
export function tableTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(256, 256);
  g.fillStyle = '#4a3423';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(25,15,8,0.4)';
  for (let i = 0; i < 14; i++) {
    g.beginPath();
    const y = Math.random() * 256;
    g.moveTo(0, y);
    g.bezierCurveTo(64, y + (Math.random() - 0.5) * 6, 192, y + (Math.random() - 0.5) * 6, 256, y);
    g.lineWidth = 1 + Math.random();
    g.stroke();
  }
  return toTexture(c, 2, 1);
}

/** 墙纸：暖米色 + 竖条纹 + 暗纹圆点 */
export function wallpaperTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(256, 256);
  g.fillStyle = '#8a7458';
  g.fillRect(0, 0, 256, 256);
  for (let x = 0; x < 256; x += 32) {
    g.fillStyle = 'rgba(255,240,210,0.07)';
    g.fillRect(x, 0, 16, 256);
  }
  g.fillStyle = 'rgba(60,45,30,0.18)';
  for (let y = 16; y < 256; y += 48) {
    for (let x = 16; x < 256; x += 48) {
      g.beginPath();
      g.arc(x + ((y / 48) % 2) * 24, y, 3, 0, Math.PI * 2);
      g.fill();
    }
  }
  return toTexture(c, 2, 1);
}

/** 石砖（壁炉/基座） */
export function stoneTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(256, 256);
  g.fillStyle = '#5c564e';
  g.fillRect(0, 0, 256, 256);
  const bh = 32;
  for (let row = 0; row < 256 / bh; row++) {
    const off = (row % 2) * 32;
    for (let x = -64; x < 256; x += 64) {
      const tone = 0.85 + Math.random() * 0.3;
      const r = Math.floor(0x6e * tone);
      const gg = Math.floor(0x68 * tone);
      const b = Math.floor(0x5e * tone);
      g.fillStyle = `rgb(${r},${gg},${b})`;
      g.fillRect(x + off + 1, row * bh + 1, 62, bh - 2);
    }
  }
  return toTexture(c, 1, 1);
}

/** 法阵台面：石板 + 淡刻线圆环 */
export function workbenchTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(256, 256);
  g.fillStyle = '#57504a';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  for (let i = 0; i <= 4; i++) {
    g.beginPath();
    g.moveTo((i * 256) / 4, 0);
    g.lineTo((i * 256) / 4, 256);
    g.stroke();
    g.beginPath();
    g.moveTo(0, (i * 256) / 4);
    g.lineTo(256, (i * 256) / 4);
    g.stroke();
  }
  // 淡金色刻线
  g.strokeStyle = 'rgba(212,180,120,0.35)';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(128, 128, 100, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(128, 128, 80, 0, Math.PI * 2);
  g.stroke();
  return toTexture(c, 1, 1);
}

/** 粒子贴图：径向渐变圆点 */
export function particleTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(64, 64);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- 现代魔法世界（终末地风格）新增程序化贴图 ---------- */

/** 径向辉光（自发光晕 / 粒子 / 坩埚火光 halo） */
export function radialGlowTexture(inner: string, outer: string): THREE.CanvasTexture {
  const [c, g] = makeCanvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.4, outer);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 警戒条纹（终末地明黄警戒色，45° 斜纹） */
export function warningStripeTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(64, 64);
  g.fillStyle = '#2a2418';
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#f5c542';
  g.lineWidth = 12;
  for (let i = -64; i < 128; i += 24) {
    g.beginPath();
    g.moveTo(i, 0); g.lineTo(i + 64, 64);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 压力表盘：深底 + 琥珀刻度 + 红区 + 数字 */
export function gaugeDialTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(256, 256);
  const cx = 128, cy = 128;
  g.fillStyle = '#1c2030';
  g.beginPath(); g.arc(cx, cy, 120, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#8a7a50'; g.lineWidth = 6;
  g.beginPath(); g.arc(cx, cy, 120, 0, Math.PI * 2); g.stroke();
  // 红区（8–10）
  g.strokeStyle = '#c0392b'; g.lineWidth = 14;
  g.beginPath(); g.arc(cx, cy, 92, Math.PI * 0.75, Math.PI * 1.25); g.stroke();
  // 刻度
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI * 0.75 + (i / 10) * Math.PI * 1.5;
    const r1 = i % 5 === 0 ? 74 : 84;
    const x1 = cx + Math.cos(a) * r1, y1 = cy + Math.sin(a) * r1;
    const x2 = cx + Math.cos(a) * 96, y2 = cy + Math.sin(a) * 96;
    g.strokeStyle = i >= 8 ? '#e06050' : '#d8c890';
    g.lineWidth = i % 5 === 0 ? 5 : 2.5;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    if (i % 2 === 0) {
      g.fillStyle = '#e8dcc0';
      g.font = 'bold 26px ui-monospace, Menlo, monospace';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(i), cx + Math.cos(a) * 56, cy + Math.sin(a) * 56);
    }
  }
  g.fillStyle = '#9a8a60';
  g.font = '16px ui-monospace, Menlo, monospace';
  g.textAlign = 'center';
  g.fillText('MPa', cx, cy + 44);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 玻璃管液流：纵向渐变 + 横带（滚动 offset 形成流动） */
export function liquidFlowTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(64, 256);
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#ffd9a0');
  grad.addColorStop(0.35, '#ff9a3c');
  grad.addColorStop(0.5, '#ffb46a');
  grad.addColorStop(0.85, '#e87a20');
  grad.addColorStop(1, '#ffd9a0');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 256);
  // 气泡横带
  g.fillStyle = 'rgba(255,240,210,0.5)';
  for (let i = 0; i < 7; i++) {
    const y = (i * 256) / 7 + Math.random() * 20;
    g.fillRect(0, y, 64, 5 + Math.random() * 6);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 1.6);
  return t;
}

/** 窗外夜色/暮色 */
export function windowTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(128, 160);
  const grad = g.createLinearGradient(0, 0, 0, 160);
  grad.addColorStop(0, '#2c3e5c');
  grad.addColorStop(0.7, '#4a5a78');
  grad.addColorStop(1, '#6a7490');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 160);
  // 月亮
  g.fillStyle = 'rgba(255,250,230,0.9)';
  g.beginPath();
  g.arc(88, 36, 14, 0, Math.PI * 2);
  g.fill();
  // 窗棂
  g.strokeStyle = '#3a2c1e';
  g.lineWidth = 6;
  g.strokeRect(0, 0, 128, 160);
  g.beginPath();
  g.moveTo(64, 0);
  g.lineTo(64, 160);
  g.moveTo(0, 80);
  g.lineTo(128, 80);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
