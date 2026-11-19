#!/usr/bin/env node
// GOOGLE TEKSHIRUVI — sayt Google qidiruvi uchun to'g'ri ochiq/yopiqligini tekshiradi.
// Sabab (19.11.2026): bosh sahifa chaqiradigan manzillar robots.txt da yopiq edi, Google sahifani xato bilan ko'rardi.
//   node tekshiruv/google.js          — ombordagi kodni shu kompyuterda ishga tushirib tekshiradi (asosiy + sinov rejimi)
//   node tekshiruv/google.js --jonli  — haqiqiy saytni tekshiradi (yoshxorazmiylar.uz va test.yoshxorazmiylar.uz)
// Xato topilsa 1 bilan chiqadi. Brauzer (playwright) bo'lsa, bosh sahifa Google ko'zi bilan ham ochib ko'riladi.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawn } = require('node:child_process');
const ROOT = path.join(__dirname, '..'), JONLI = process.argv.includes('--jonli');
const BOT = 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
let xato = 0;
const ok = (shart, nima) => { if (shart) console.log('  ✓ ' + nima); else { xato++; console.log('  XATO: ' + nima); } };

// robots.txt ni Google qoidasi bilan o'qish: eng uzun mos kelgan qoida yutadi, teng bo'lsa Allow
function qoidalar(txt) {
  const guruh = []; let g = null, oldin = '';
  for (const q of String(txt).split(/\r?\n/)) {
    const m = q.replace(/#.*/, '').match(/^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2];
    if (k === 'user-agent') { if (oldin !== 'user-agent') { g = { ua: [], r: [] }; guruh.push(g); } g.ua.push(v.toLowerCase()); }
    else if ((k === 'allow' || k === 'disallow') && g && v) g.r.push({ allow: k === 'allow', p: v });
    oldin = k;
  }
  const mos = guruh.filter(x => x.ua.includes('googlebot')); return (mos.length ? mos : guruh.filter(x => x.ua.includes('*'))).flatMap(x => x.r);
}
function ochiq(txt, yol) {
  let eng = null;
  for (const r of qoidalar(txt)) {
    const re = new RegExp('^' + r.p.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\?\$$/, '$'));
    if (re.test(yol) && (!eng || r.p.length > eng.p.length || (r.p.length === eng.p.length && r.allow))) eng = r;
  }
  return !eng || eng.allow;
}
const ol = async (u, o = {}) => { const r = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': BOT }, ...o }); return { s: r.status, h: r.headers, t: await r.text() }; };
const yopiqTeg = r => /noindex/i.test(r.h.get('x-robots-tag') || '');

async function asosiy(B, nom) {
  console.log(nom + ' — Google uchun OCHIQ bo‘lishi kerak');
  const rb = await ol(B + '/robots.txt');
  ok(rb.s === 200 && /text\/plain/.test(rb.h.get('content-type') || ''), 'robots.txt bor');
  ok(ochiq(rb.t, '/'), 'bosh sahifa robots.txt da ochiq');
  ok(/^Sitemap:\s*https:\/\/yoshxorazmiylar\.uz\/sitemap\.xml\s*$/mi.test(rb.t), 'robots.txt da sayt xaritasi ko‘rsatilgan');
  for (const p of ['/api/login', '/api/logout', '/api/verify?c=1', '/api/backup', '/api/m/000000000000000000000000', '/api/oq.get']) ok(!ochiq(rb.t, p), p + ' yopiq');
  const h = await ol(B + '/');
  ok(h.s === 200, 'bosh sahifa ochiladi (200)');
  ok(!yopiqTeg(h) && !/<meta[^>]+name=["']robots["'][^>]*noindex/i.test(h.t), 'bosh sahifada "noindex" yo‘q');
  ok(/<link rel="canonical" href="https:\/\/yoshxorazmiylar\.uz\/">/.test(h.t), 'bosh sahifaning asosiy manzili to‘g‘ri');
  ok(/<title>[^<]{5,}<\/title>/.test(h.t) && /<meta name="description" content="[^"]{50,}"/.test(h.t), 'sarlavha va tavsif bor');
  const sm = await ol(B + '/sitemap.xml');
  ok(sm.s === 200 && sm.t.includes('<loc>https://yoshxorazmiylar.uz/</loc>') && !yopiqTeg(sm), 'sayt xaritasi bor, ichida bosh sahifa');
  for (const p of ['/api/ver', '/t/ABC123', '/darslar/', '/a/k/ustoz.html']) { const r = await ol(B + p); ok(yopiqTeg(r), p + ' qidiruvga chiqmaydi (noindex)'); }
  await brauzer(B, rb.t);
}
async function sinov(B, nom) {
  console.log(nom + ' — Google uchun YOPIQ bo‘lishi kerak');
  const rb = await ol(B + '/robots.txt');
  ok(rb.s === 200 && !ochiq(rb.t, '/') && !ochiq(rb.t, '/a/k/ustoz.html'), 'robots.txt hammasini yopgan');
  if (!JONLI) ok(yopiqTeg(await ol(B + '/')), 'bosh sahifada ham noindex');
}
// Bosh sahifani Google kabi ochish: robots.txt yopgan har so'rov to'siladi; shunda ham sahifa xatosiz chiqishi kerak
async function brauzer(B, robots) {
  let pw; try { pw = require('playwright'); } catch { console.log('  (brauzer yo‘q — Google ko‘zi bilan ochish o‘tkazib yuborildi)'); if (process.env.CI) ok(false, 'tekshiruvda brauzer bo‘lishi shart'); return; }
  const b = await pw.chromium.launch(), p = await b.newPage({ userAgent: BOT, viewport: { width: 412, height: 800 } });
  const tosildi = new Set(), buzuq = [];
  await p.route('**/*', r => { const u = new URL(r.request().url()); if (u.origin === new URL(B).origin && !ochiq(robots, u.pathname + u.search)) { tosildi.add(u.pathname); return r.abort(); } return r.continue(); });
  p.on('pageerror', e => buzuq.push(String(e.message).slice(0, 120)));
  await p.goto(B + '/', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500);
  const matn = await p.evaluate(() => document.body.innerText);
  ok(tosildi.size === 0, 'bosh sahifa chaqirgan hamma manzil Google uchun ochiq' + (tosildi.size ? ' — YOPIQ: ' + [...tosildi].join(', ') + ' (server.js dagi BOT_OCHIQ_API ga qo‘shing)' : ''));
  ok(!/aloqa yo.q|xatolik/i.test(matn), 'Google sahifada xato yozuvini ko‘rmaydi');
  ok(/YOSH XORAZMIYLAR/i.test(matn) && matn.replace(/\s+/g, ' ').length > 80, 'Google sahifa matnini ko‘radi');
  ok(buzuq.length === 0, 'sahifada dastur xatosi yo‘q' + (buzuq.length ? ': ' + buzuq[0] : ''));
  await b.close();
}
async function ishgaTushir(fayl, sahifa, port, test) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yx-google-'));
  fs.mkdirSync(path.join(d, 'public', 'a', 'k'), { recursive: true }); fs.mkdirSync(path.join(d, 'public', 'darslar'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, fayl), path.join(d, 'server.js')); fs.copyFileSync(path.join(ROOT, sahifa), path.join(d, 'public', 'index.html'));
  for (const f of ['a/k/ustoz.html', 'darslar/index.html']) fs.writeFileSync(path.join(d, 'public', f), '<!doctype html><title>x</title>');
  const ch = spawn(process.execPath, ['--no-warnings', path.join(d, 'server.js')], { cwd: d, env: { ...process.env, DATA_DIR: path.join(d, 'data'), BACKUP_DIR: path.join(d, 'backups'), PORT: String(port), NO_BOT: '1', YX_TEST: test ? '1' : '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; ch.stdout.on('data', x => log += x); ch.stderr.on('data', x => log += x);
  for (let i = 0; i < 100; i++) { try { await fetch('http://127.0.0.1:' + port + '/robots.txt'); return { ch, d }; } catch { await new Promise(r => setTimeout(r, 200)); } }
  ch.kill(); throw new Error(fayl + ' ishga tushmadi:\n' + log.slice(-1500));
}
(async () => {
  if (JONLI) { await asosiy('https://yoshxorazmiylar.uz', 'HAQIQIY SAYT'); await sinov('https://test.yoshxorazmiylar.uz', 'SINOV SAYTI'); }
  else {
    console.log('Fayllar');
    ok(fs.readFileSync(path.join(ROOT, 'server.js')).equals(fs.readFileSync(path.join(ROOT, 'test-server.js'))), 'server.js va test-server.js bir xil');
    const ish = [];
    try {
      for (const [fayl, sahifa] of [['server.js', 'index.html'], ['test-server.js', 'test-index.html']]) {
        let x = await ishgaTushir(fayl, sahifa, 3911, false); ish.push(x); await asosiy('http://127.0.0.1:3911', fayl + ' (asosiy rejim)'); x.ch.kill(); await new Promise(r => setTimeout(r, 400));
        x = await ishgaTushir(fayl, sahifa, 3912, true); ish.push(x); await sinov('http://127.0.0.1:3912', fayl + ' (sinov rejimi)'); x.ch.kill(); await new Promise(r => setTimeout(r, 400));
      }
    } finally { for (const x of ish) { try { x.ch.kill(); } catch { } try { fs.rmSync(x.d, { recursive: true, force: true }); } catch { } } }
  }
  console.log(xato ? '\nXATO: ' + xato + ' ta. Sayt Google qidiruvi uchun noto‘g‘ri sozlangan.' : '\nHammasi joyida.');
  process.exit(xato ? 1 : 0);
})().catch(e => { console.error('Tekshiruv ishlamadi:', e.message); process.exit(1); });
