import fs from 'node:fs';
import { PNG } from 'pngjs';
const sp = PNG.sync.read(fs.readFileSync('/tmp/yelan-extract/tex/sp.png'));
let black = 0, white = 0, other = 0;
for (let i = 0; i < sp.width * sp.height; i++) {
  if (sp.data[i*4+3] !== 0) continue;
  const r = sp.data[i*4], g = sp.data[i*4+1], b = sp.data[i*4+2];
  if (r < 10 && g < 10 && b < 10) black++;
  else if (r > 245 && g > 245 && b > 245) white++;
  else other++;
}
const total = sp.width * sp.height;
console.log(`透明区 RGB: 黑=${(black/total*100).toFixed(1)}% 白=${(white/total*100).toFixed(1)}% 其他=${(other/total*100).toFixed(1)}%`);
