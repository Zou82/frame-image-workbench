import fs from 'node:fs/promises';
import { device } from './android-cdp.mjs';

export async function tree(name) {
  const text = device('exec-out', 'uiautomator', 'dump', '/dev/tty');
  const xml = text.slice(text.indexOf('<?xml'), text.indexOf('</hierarchy>') + 12);
  if (name) await fs.writeFile(new URL(`../output/android/${name}.xml`, import.meta.url), xml);
  return [...xml.matchAll(/<node\s+([^>]+)>/g)].map(match => Object.fromEntries(
    [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
  ));
}

export async function tap(attribute, value, { long = false, name } = {}) {
  const nodes = await tree(name);
  const node = nodes.find(item => item[attribute] === value);
  if (!node) throw new Error(`Missing ${attribute}=${value}; available: ${nodes.filter(item => item.text || item['content-desc']).map(item => item.text || item['content-desc']).join(' | ')}`);
  const [x1, y1, x2, y2] = node.bounds.match(/\d+/g).map(Number);
  const x = Math.round((x1 + x2) / 2), y = Math.round((y1 + y2) / 2);
  device('shell', 'input', ...(long ? ['swipe', `${x}`, `${y}`, `${x}`, `${y}`, '700'] : ['tap', `${x}`, `${y}`]));
}

if (process.argv[1]?.endsWith('android-tree.mjs')) {
  if (process.argv[2]) await tap(process.argv[2], process.argv[3], { long: process.argv.includes('--long'), name: 'tree-latest' });
  else console.log((await tree('tree-latest')).filter(n => n.text || n['content-desc']).map(n => ({ text: n.text, description: n['content-desc'], bounds: n.bounds })));
}
