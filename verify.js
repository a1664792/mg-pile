#!/usr/bin/env node
/* 离线自检：校验 web/index.html 里的内联脚本语法，并跑协议黄金向量。
   用法: node verify.js        （在 MG-Pile/web 目录下，或 node web/verify.js）
   不需要充电桩，也不联网。 */
const fs = require('fs'), path = require('path'), vm = require('vm'), { execFileSync } = require('child_process');
const here = __dirname;
const file = path.join(here, 'index.html');
const html = fs.readFileSync(file, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
console.log('index.html:', html.length, 'chars, 内联脚本', scripts.length, '段');
let syntaxBad = 0;
scripts.forEach((body, i) => {
  const tmp = path.join(require('os').tmpdir(), 'mgpile_script' + i + '.js');
  fs.writeFileSync(tmp, body, 'utf8');
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); console.log('  script' + i + ': 语法 OK (' + body.length + ' chars)'); }
  catch (e) { syntaxBad++; console.log('  script' + i + ': 语法 FAIL\n' + String(e.stderr || e.message).slice(0, 600)); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
});
let proto = null, idx = -1;
scripts.forEach((src, i) => {
  const ctx = { console, module: {}, window: {}, navigator: {}, alert(){}, setTimeout, clearTimeout, setInterval, clearInterval,
    Uint8Array, DataView, TextEncoder, TextDecoder, btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'), Promise, Object, Math, Date, JSON, String, Number, Array, Error, RangeError };
  ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  try { vm.runInContext(src, ctx, { timeout: 5000 }); } catch (e) { /* UI 脚本需要 DOM，忽略 */ }
  if (ctx.PileProtocol) { proto = ctx.PileProtocol; idx = i; }
});
console.log('PileProtocol 位于 script' + idx, proto ? '(exports: ' + Object.keys(proto).join(', ') + ')' : '未找到');
if (!proto) { console.log('FAIL: 找不到 PileProtocol'); process.exit(1); }
const hex = a => Array.from(a, b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
const cases = [
  ['info', proto.commands.info(), '68 B1 00 00 00 00 00 D9'],
  ['sync(1700000000)', proto.commands.sync(1700000000), '68 B0 00 00 04 00 00 1B 00 F1 53 65'],
  ['start', proto.commands.start(), '68 B4 00 00 02 00 00 DF 01 00'],
  ['stop', proto.commands.stop(), '68 B6 00 00 01 00 00 DF 00'],
  ['volume(30)', proto.commands.volume(30), '68 B2 00 00 01 00 00 C5 1E'],
  ['light(true)', proto.commands.light(true), '68 A0 00 00 07 00 00 CF 01 01 00 00 00 00 00'],
  ['reserve(true,23:00,07:00)', proto.commands.reserve(true, '23:00', '07:00'), '68 B3 00 00 05 00 00 CF 01 17 00 07 00'],
  ['reserve(false)', proto.commands.reserve(false), '68 B3 00 00 05 00 00 DE 00 00 00 00 00']
];
let bad = 0;
for (const [n, f, e] of cases) { const g = hex(f); const ok = g === e; bad += ok ? 0 : 1; console.log((ok ? 'OK  ' : 'BAD ') + n.padEnd(26) + g + (ok ? '' : '   expected ' + e)); }
const mk = (h, cmd, pl) => { const a = new Uint8Array(8 + pl.length); a[0] = h; a[1] = cmd; a[4] = pl.length & 255; a[5] = pl.length >> 8; a.set(pl, 8); a[7] = a.reduce((x, y) => x ^ y, 0); return a; };
const pAA = new proto.Parser().push(mk(0xAA, 0xB1, [1, 2, 3]));
const p68 = new proto.Parser().push(mk(0x68, 0xB1, [1, 2, 3]));
console.log('解析 0xAA 帧 ->', pAA.frames.length, '（期望 1）'); bad += pAA.frames.length === 1 ? 0 : 1;
console.log('解析 0x68 帧 ->', p68.frames.length, '（默认兼容模式期望 1）'); bad += p68.frames.length === 1 ? 0 : 1;
proto.setHeaders([0xAA]);
const strict = new proto.Parser().push(mk(0x68, 0xB1, [1]));
console.log('仅 0xAA 模式下解析 0x68 ->', strict.frames.length, '（期望 0）', JSON.stringify(strict.errors)); bad += strict.frames.length === 0 ? 0 : 1;
proto.setHeaders([0xAA, 0x68]);
const badframe = mk(0xAA, 0xB1, [1]); badframe[7] ^= 0xFF;
const bx = new proto.Parser().push(badframe);
console.log('坏 XOR 帧 ->', bx.frames.length, '（期望 0）', JSON.stringify(bx.errors)); bad += bx.frames.length === 0 ? 0 : 1;
const pay = new Uint8Array(59); const nm = 'AY12ARM269A1B2C'; for (let i = 0; i < nm.length; i++) pay[i] = nm.charCodeAt(i);
pay[41] = 1; pay[46] = 1; pay[47] = 23; pay[48] = 0; pay[49] = 7; pay[50] = 0; pay[51] = 30; pay[58] = 6;
console.log('sysInfo ->', JSON.stringify(proto.sysInfo(pay)));
const external = (html.match(/<script[^>]*\bsrc=/gi) || []).length + (html.match(/<link\b/gi) || []).length + (html.match(/<img\b/gi) || []).length;
console.log('外部资源引用 ->', external, '（期望 0）'); bad += external === 0 ? 0 : 1;
bad += syntaxBad;
console.log(bad === 0 ? '\nRESULT: ALL PASS' : '\nRESULT: ' + bad + ' 项失败');
process.exit(bad === 0 ? 0 : 1);
