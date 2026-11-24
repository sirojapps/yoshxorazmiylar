// YUKLAMA SINOVI (24.11.2026, kod auditi 4-bosqich).
// Katta soxta baza (minglab maktab/sinf, yuz minglab o'quvchi va ota-ona) bilan serverni vaqtinchalik papkada ishga tushiradi
// va ko'p odam bir vaqtda kirganda javob vaqtini o'lchaydi. Haqiqiy bazaga va saytga tegmaydi.
//   node tekshiruv/yuk.js [maktablar=400] [sinf/maktab=12] [bola/sinf=25] [bir vaqtda=50] [soniya=12]
//   NATIJA=fayl.json — natijani faylga yozish; FAQAT=matn — faqat nomida shu matn bor holatlar; PROF=fayl.js — server profili (vaqtinchalik papkada qoladi)
// Natija: har holat uchun soniyada nechta so'rov, o'rtacha (p50), 95% (p95) va eng sekin javob; server bandligi
// (shu vaqtda eng yengil so'rov /api/ver qancha kutdi) va server xotirasi.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const [MAK = 400, SNF = 12, BOLA = 25, PAR = 50, SEK = 12] = process.argv.slice(2).map(Number);
const SRV = path.join(__dirname, '..', 'server.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yx-yuk-'));
const DATA = path.join(DIR, 'data');
const PORT = 4800 + Math.floor(Math.random() * 400), B = 'http://127.0.0.1:' + PORT;
const KOR = new Set();
const wait = ms => new Promise(r => setTimeout(r, ms));
const KEY = crypto.randomBytes(32);
const pinH = p => 'h1$' + crypto.createHmac('sha256', KEY).update('pin:' + String(p)).digest('hex');

let srv = null;
async function boot() {
  fs.mkdirSync(path.join(DIR, 'public', 'darslar'), { recursive: true });
  fs.copyFileSync(SRV, path.join(DIR, 'server.js'));
  fs.writeFileSync(path.join(DIR, 'public', 'index.html'), '<!doctype html><title>YOSH XORAZMIYLAR</title>');
  fs.writeFileSync(path.join(DIR, 'public', 'darslar', '2A1.html'), '<!doctype html><title>dars</title>' + 'x'.repeat(200000));
  let log = '';
  srv = spawn(process.execPath, ['--no-warnings', ...(process.env.PROF ? ['--cpu-prof', '--cpu-prof-dir=' + path.join(DIR, 'prof'), '--require', process.env.PROF] : []), path.join(DIR, 'server.js')], { env: { ...process.env, DATA_DIR: DATA, BACKUP_DIR: path.join(DIR, 'backups'), PORT: String(PORT), NO_BOT: '1', YX_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 400 && !/http:\/\/127/.test(log) && srv.exitCode == null; i++) await wait(250);
  if (!/http:\/\/127/.test(log)) { console.log(log); throw new Error('server ishga tushmadi'); }
}
async function stop() { if (!srv) return; if (srv.exitCode != null || srv.signalCode != null) { srv = null; return; } srv.kill('SIGTERM'); await new Promise(r => srv.once('exit', r)); srv = null; }
const rss = () => { try { return Math.round(+fs.readFileSync(`/proc/${srv.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1] / 1024); } catch { return 0; } };

function seed() {
  const db = new DatabaseSync(path.join(DATA, 'yx.db')); db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF');
  const now = new Date().toISOString();
  db.exec('BEGIN');
  const iS = db.prepare('INSERT INTO schools(num,name,director_name,director_phone,created_at) VALUES(?,?,?,?,?)');
  const iC = db.prepare('INSERT INTO classes(school_id,name,grade,teacher_name,teacher_phone) VALUES(?,?,?,?,?)');
  const iK = db.prepare('INSERT INTO students(class_id,name,phone,created_at) VALUES(?,?,?,?)');
  const iU = db.prepare('INSERT INTO users(role,name,phone,pin,pin_at,school_id,class_id,created_at,consent_at) VALUES(?,?,?,?,?,?,?,?,?)');
  const iR = db.prepare('INSERT INTO results(test_id,student_id,score,qn,at) VALUES(?,?,?,20,?)');
  const t1 = db.prepare("INSERT INTO tests(name,date,status,created_at) VALUES('Kuz sinovi','2026-10-20','otkazildi',?)").run(now).lastInsertRowid;
  const t2 = db.prepare("INSERT INTO tests(name,date,status,created_at) VALUES('Qish sinovi','2026-11-20','otkazildi',?)").run(now).lastInsertRowid;
  const L = { ota: [], rahbar: [], direktor: [] };
  let tel = 0; const ph = () => String(930000000 + (++tel));
  for (let s = 1; s <= MAK; s++) {
    const dp = ph(), sid = iS.run(1000 + s, 'Maktab ' + s, 'Direktor ' + s, dp, now).lastInsertRowid;
    iU.run('direktor', 'Direktor ' + s, dp, pinH(100000 + s), now, sid, null, now, now); L.direktor.push([dp, String(100000 + s)]);
    for (let c = 0; c < SNF; c++) {
      const tp = ph(), grade = 2 + (c % 3), cid = iC.run(sid, grade + '-' + 'ABCDEFGHIJKLMNOP'[Math.floor(c / 3)], grade, 'Ustoz ' + s + '-' + c, tp).lastInsertRowid;
      iU.run('rahbar', 'Ustoz ' + s + '-' + c, tp, pinH(200000 + Number(cid)), now, sid, cid, now, now); L.rahbar.push([tp, String(200000 + Number(cid))]);
      for (let k = 0; k < BOLA; k++) {
        const op = ph(), kid = iK.run(cid, 'Bola ' + s + '-' + c + '-' + k, op, now).lastInsertRowid;
        iU.run('ota', 'Ota-ona ' + kid, op, pinH(300000 + Number(kid)), now, sid, cid, now, now); L.ota.push([op, String(300000 + Number(kid))]);
        iR.run(t1, kid, kid % 21, now); iR.run(t2, kid, (kid * 7) % 21, now);
      }
    }
  }
  db.exec('COMMIT'); db.close();
  return L;
}

class Kim {
  constructor() { this.ck = ''; }
  async f(a, b) {
    const r = await fetch(B + '/api/' + a, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: this.ck, 'Accept-Encoding': 'gzip' }, body: JSON.stringify(b || {}) });
    const sc = r.headers.get('set-cookie'); if (sc && /^yx=/.test(sc)) this.ck = sc.split(';')[0];
    const t = await r.text(); if (r.status !== 200) throw new Error(a + ' ' + r.status + ' ' + t.slice(0, 120)); if (process.env.KORISH) KOR.add(a + ' ' + t.length + ' ' + t.slice(0, 70)); return t.length;
  }
  async get(u) { const r = await fetch(B + u, { headers: { Cookie: this.ck } }); const t = await r.arrayBuffer(); if (r.status !== 200) throw new Error(u + ' ' + r.status); return t.byteLength; }
}
const kir = async ([p, pin]) => { const k = new Kim(); await k.f('login', { phone: p, pin }); return k; };
const pick = a => a[Math.floor(Math.random() * a.length)];
const q = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };

async function holat(nom, par, ish) {
  if (process.env.FAQAT && !nom.includes(process.env.FAQAT)) return null;
  const t = [], xato = []; let bayt = 0; const end = Date.now() + SEK * 1000; const ping = [];
  const pinger = (async () => { while (Date.now() < end) { const a = performance.now(); await fetch(B + '/api/ver').then(r => r.text()).catch(() => { }); ping.push(performance.now() - a); await wait(100); } })();
  await Promise.all(Array.from({ length: par }, async () => {
    while (Date.now() < end) { const a = performance.now(); try { const n = await ish(); bayt += n; t.push(performance.now() - a); } catch (e) { xato.push(e.message); } }
  }));
  await pinger;
  const r = { holat: nom, bir_vaqtda: par, soniyada: Math.round(t.length / SEK), p50_ms: q(t, .5), p95_ms: q(t, .95), eng_sekin_ms: q(t, 1), javob_kb: t.length ? +(bayt / t.length / 1024).toFixed(1) : 0, xato: xato.length, server_bandligi_p95_ms: q(ping, .95), xotira_mb: rss() };
  console.log(`  ${nom.padEnd(34)} ${String(r.soniyada).padStart(5)}/s  p50 ${String(r.p50_ms).padStart(5)} ms  p95 ${String(r.p95_ms).padStart(5)} ms  max ${String(r.eng_sekin_ms).padStart(5)} ms  ${String(r.javob_kb).padStart(5)} KB  bandlik p95 ${String(r.server_bandligi_p95_ms).padStart(4)} ms  xotira ${r.xotira_mb} MB${xato.length ? '  XATO: ' + xato.length + ' (' + xato[0] + ')' : ''}`);
  return r;
}

(async () => {
  try {
    fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(path.join(DATA, 'pin-kalit'), KEY.toString('hex') + '\n', { mode: 0o600 });
    console.log(`Baza tayyorlanmoqda: ${MAK} maktab, ${MAK * SNF} sinf, ${MAK * SNF * BOLA} o'quvchi va ota-ona, ${MAK * SNF * BOLA * 2} natija…`);
    await boot(); await stop(); // jadvallar va migratsiyalar
    let a = Date.now(); const L = seed(); console.log(`  baza ${((Date.now() - a) / 1000).toFixed(1)} s da to'ldirildi`);
    a = Date.now(); await boot(); console.log(`  server ${((Date.now() - a) / 1000).toFixed(1)} s da ishga tushdi, xotira ${rss()} MB`);
    const ceoPin = fs.readFileSync(path.join(DATA, 'ceo-pin.txt'), 'utf8').trim();
    const ceo = await kir(['909999999', ceoPin]);
    const otalar = await Promise.all(Array.from({ length: 300 }, () => kir(pick(L.ota))));
    const rahbarlar = await Promise.all(Array.from({ length: 60 }, () => kir(pick(L.rahbar))));
    const direktorlar = await Promise.all(Array.from({ length: 20 }, () => kir(pick(L.direktor))));
    console.log(`\nHar holat ${SEK} soniya:`);
    const R = [];
    R.push(await holat('kirish (login)', PAR, () => kir(pick(L.ota)).then(() => 1)));
    R.push(await holat('ota-ona: bosh ma’lumot (state)', PAR, () => pick(otalar).f('state')));
    R.push(await holat('ota-ona: ota.get', PAR, () => pick(otalar).f('ota.get')));
    R.push(await holat('ota-ona: obuna.holat', PAR, () => pick(otalar).f('obuna.holat')));
    R.push(await holat('ota-ona: dars sahifasi (200 KB)', PAR, () => pick(otalar).get('/darslar/2A1.html').catch(e => { if (/403|401/.test(e.message)) return 0; throw e; })));
    R.push(await holat('sinf rahbari: state', PAR, () => pick(rahbarlar).f('state')));
    R.push(await holat('direktor: state', 20, () => pick(direktorlar).f('state')));
    R.push(await holat('sinf rahbari: kabinet (ustoz.get)', PAR, () => pick(rahbarlar).f('ustoz.get')));
    R.push(await holat('direktor: kabinet (dir.get)', 20, () => pick(direktorlar).f('dir.get')));
    R.push(await holat('CEO: state', 3, () => ceo.f('state')));
    R.push(await holat('CEO: ceo.dash', 3, () => ceo.f('ceo.dash')));
    R.push(await holat('CEO: obuna.list', 3, () => ceo.f('obuna.list')));
    R.push(await holat('aralash (80% ota, 15% ustoz, 5% kirish)', PAR, () => { const x = Math.random(); return x < .8 ? pick(otalar).f('state') : x < .95 ? pick(rahbarlar).f('state') : kir(pick(L.ota)).then(() => 1); }));
    if (process.env.KORISH) console.log([...KOR].slice(0, 40).join('\n'));
    if (process.env.NATIJA) { fs.writeFileSync(process.env.NATIJA, JSON.stringify({ MAK, SNF, BOLA, PAR, SEK, R }, null, 1)); console.log('\nNatija fayli: ' + process.env.NATIJA); }
  } catch (e) { console.error('XATO:', e.message); process.exitCode = 1; }
  finally { await stop(); if (!process.env.PROF) fs.rmSync(DIR, { recursive: true, force: true }); }
})();
