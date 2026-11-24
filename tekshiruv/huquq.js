// HUQUQ TESTI (24.11.2026, kod auditi 10-band).
// Har rol (direktor, sinf rahbari, ota-ona, huquqsiz jamoa a'zosi, kuzatuvchi) BOSHQA maktab / sinf / o'quvchi ma'lumotini
// ko'ra olmasligi va o'zgartira olmasligini avtomatik tekshiradi. Server bo'sh baza bilan vaqtinchalik papkada ishga tushadi.
//   node tekshiruv/huquq.js [server.js]
// 1) server.js dagi HAMMA A['...'] amallari avtomatik olinadi — yangi amal qo'shilsa ham testdan chetda qolmaydi.
// 2) Har amal har rol bilan B maktabning id'lari bilan chaqiriladi (bir necha variantda).
// 3) Javobda B maktabning maxfiy belgisi ("Bsir", B telefonlari) bo'lsa — XATO (ma'lumot sizib chiqdi).
// 4) Chaqiriqdan keyin B maktabga tegishli yozuvlar o'zgargan bo'lsa — XATO (begona ma'lumot o'zgartirildi).
// 5) Kirmagan odam hech bir amalni bajara olmasligi (401) tekshiriladi.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SRV = path.resolve(process.argv[2] || path.join(__dirname, '..', 'server.js'));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yx-huquq-'));
const PORT = 4300 + Math.floor(Math.random() * 500), B = 'http://127.0.0.1:' + PORT;
const ACTS = [...new Set([...fs.readFileSync(SRV, 'utf8').matchAll(/^A\['([^']+)'\]\s*=/gm)].map(m => m[1]))];
let fail = 0; const xato = m => { fail++; console.log('  XATO: ' + m); };

function boot() {
  fs.mkdirSync(path.join(DIR, 'public'), { recursive: true });
  fs.copyFileSync(SRV, path.join(DIR, 'server.js'));
  fs.writeFileSync(path.join(DIR, 'public', 'index.html'), '<!doctype html><title>YOSH XORAZMIYLAR</title>');
  fs.mkdirSync(path.join(DIR, 'public', 'darslar'), { recursive: true });
  for (const k of ['2A1', '2A2', '3A1']) fs.writeFileSync(path.join(DIR, 'public', 'darslar', k + '.html'), '<!doctype html><title>dars</title>DARS-MAZMUNI');
  fs.writeFileSync(path.join(DIR, 'public', 'darslar', 'index.html'), '<!doctype html><title>darslar</title>');
  const p = spawn(process.execPath, ['--no-warnings', path.join(DIR, 'server.js')], { env: { ...process.env, DATA_DIR: path.join(DIR, 'data'), BACKUP_DIR: path.join(DIR, 'backups'), PORT: String(PORT), NO_BOT: '1', YX_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  return { p, log: () => log };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
class Kim {
  constructor(n) { this.n = n; this.ck = ''; }
  async f(a, b, raw) {
    const r = await fetch(B + '/api/' + a, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: this.ck }, body: JSON.stringify(b || {}) });
    const sc = r.headers.get('set-cookie'); if (sc && /^yx=/.test(sc)) this.ck = sc.split(';')[0];
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { }
    if (raw) return { status: r.status, text: t, j };
    if (r.status !== 200) throw new Error(this.n + ' ' + a + ': ' + r.status + ' ' + t.slice(0, 160));
    return j;
  }
  async kir(phone, pin) { const r = await this.f('login', { phone, pin }, true); if (r.status !== 200) throw new Error(this.n + ' kira olmadi: ' + r.text); return this; }
}

(async () => {
  const S = boot();
  for (let i = 0; i < 60 && !/http:\/\/127/.test(S.log()); i++) await wait(250);
  if (!/http:\/\/127/.test(S.log())) { console.log(S.log()); throw new Error('server ishga tushmadi'); }
  try {
    // ---------------- ma'lumot: A va B maktab
    const ceo = new Kim('ceo'); await ceo.kir('909999999', fs.readFileSync(path.join(DIR, 'data', 'ceo-pin.txt'), 'utf8').trim());
    // B maktab AVVAL yaratiladi va to'ldiruvchi yozuvlar qo'shiladi: A maktabning id'lari B id'lari bilan hech bir jadvalda ustma-ust tushmasin
    // (aks holda "B id" bilan chaqiriq tasodifan A ning o'z yozuviga tegib, test noto'g'ri natija beradi)
    const sB = (await ceo.f('school.save', { num: 202, name: 'Bsir maktab', director_name: 'Bsirov Direktor', director_phone: '937000001' })).id;
    const cB = (await ceo.f('class.save', { school_id: sB, name: '2-A', teacher_name: 'Bsirova Ustoz', teacher_phone: '937000002' })).id;
    const kB = (await ceo.f('student.save', { class_id: cB, name: 'Bsirov Bola', phone: '937000003' })).id;
    const kB2 = (await ceo.f('student.save', { class_id: cB, name: 'Bsirova Qiz', phone: '937000004' })).id;
    for (let i = 0; i < 12; i++) { await ceo.f('school.save', { num: 300 + i, name: 'Bsir to‘ldiruvchi ' + i }); await ceo.f('class.save', { school_id: sB, name: (2 + (i % 3)) + '-' + 'CDEFGHIJKLMN'[i], teacher_name: '' }); await ceo.f('student.save', { class_id: cB, name: 'Bsirov To‘ldiruvchi' + 'abcdefghijkl'[i], phone: '' }); }
    const pin = async (kind, ref) => (await ceo.f('pin.issue', { kind, ref })).pin;
    const dirB = await new Kim('direktorB').kir('937000001', await pin('direktor', sB));
    const rahB = await new Kim('rahbarB').kir('937000002', await pin('rahbar', cB));
    const otaB = await new Kim('otaB').kir('937000003', await pin('ota', '937000003'));
    const sA = (await ceo.f('school.save', { num: 101, name: 'Alfa maktab', director_name: 'Aliyev Direktor', director_phone: '901000001' })).id;
    const cA = (await ceo.f('class.save', { school_id: sA, name: '2-A', teacher_name: 'Aliyeva Ustoz', teacher_phone: '901000002' })).id;
    const cA2 = (await ceo.f('class.save', { school_id: sA, name: '3-A', teacher_name: 'Aliyeva Ikkinchi', teacher_phone: '901000005' })).id;
    const kA = (await ceo.f('student.save', { class_id: cA, name: 'Aliyev Bola', phone: '901000003' })).id;
    const kA2 = (await ceo.f('student.save', { class_id: cA2, name: 'Aliyev Boshqa', phone: '901000006' })).id;
    const tst = (await ceo.f('test.save', { name: 'Kuz sinovi', date: '2026-10-20', status: 'otkazildi' })).id;
    for (const s of [kA, kA2, kB, kB2]) await ceo.f('result.save', { test_id: tst, student_id: s, score: 15 }).catch(() => { });
    const dirA = await new Kim('direktorA').kir('901000001', await pin('direktor', sA));
    const rahA = await new Kim('rahbarA').kir('901000002', await pin('rahbar', cA));
    const otaA = await new Kim('otaA').kir('901000003', await pin('ota', '901000003'));
    const jam = await ceo.f('team.save', { name: 'Jamoa Huquqsiz', phone: '905000001', perms: {} });
    const kuz = await ceo.f('team.save', { name: 'Kuzatuvchi Odam', phone: '905000002', perms: { kuzatuvchi: true } });
    const jamoa = await new Kim('jamoa(huquqsiz)').kir('905000001', jam.pin);
    const kuzat = await new Kim('kuzatuvchi').kir('905000002', kuz.pin);
    for (const k of [dirA, rahA, otaA, dirB, rahB, otaB, jamoa, kuzat]) await k.f('consent', { consent: true }).catch(() => { });
    // B maktabda yozishmalar
    await otaB.f('thread.new', { kind: 'ota', student_id: kB, text: 'Bsir ota-ona xabari' });
    await rahB.f('thread.new', { kind: 'jamoa', topic: 'savol', text: 'Bsir ustoz xabari' });
    await rahB.f('thread.new', { kind: 'sinf', text: 'Bsir sinf xabari' }).catch(() => { });
    await rahB.f('rnote.save', { student_id: kB, text: 'Bsir eslatma' }).catch(() => { });
    await ceo.f('note.save', { student_id: kB, text: 'Bsir izoh' }).catch(() => { });

    const db = new DatabaseSync(path.join(DIR, 'data', 'yx.db'), { readOnly: true });
    const q = (s, ...a) => { try { return db.prepare(s).all(...a); } catch { return []; } };
    const uB = q('SELECT id FROM users WHERE school_id=? OR class_id=? OR phone IN (?,?)', sB, cB, '937000003', '937000004').map(r => r.id);
    const thB = q(`SELECT id FROM threads WHERE user_id IN (${uB.join(',')}) OR class_id=? OR student_id IN (?,?)`, cB, kB, kB2).map(r => r.id);
    const msgB = q(`SELECT id FROM messages WHERE thread_id IN (${thB.join(',') || 0})`).map(r => r.id);
    const ids = { maktab: sB, sinf: cB, bola: kB, odam: uB[0], rahbar: uB.find(i => q('SELECT role FROM users WHERE id=?', i)[0]?.role === 'rahbar'), yozishma: thB[0], xabar: msgB[0] };
    if (!thB.length || !msgB.length) xato('B maktabda yozishma yaratilmadi — test to‘liq emas');
    // B maktabga tegishli hamma yozuvlarning "barmoq izi"
    const iz = () => {
      const bs = q('SELECT id FROM students WHERE class_id IN (SELECT id FROM classes WHERE school_id=?)', sB).map(r => r.id).join(',') || 0;
      const bc = q('SELECT id FROM classes WHERE school_id=?', sB).map(r => r.id).join(',') || 0;
      const bu = q(`SELECT id FROM users WHERE school_id=? OR class_id IN (${bc}) OR phone IN ('937000001','937000002','937000003','937000004')`, sB).map(r => r.id).join(',') || 0;
      const bt = q(`SELECT id FROM threads WHERE user_id IN (${bu}) OR class_id IN (${bc}) OR student_id IN (${bs})`).map(r => r.id).join(',') || 0;
      const parts = [
        q('SELECT * FROM schools WHERE id=?', sB), q(`SELECT * FROM classes WHERE id IN (${bc})`), q(`SELECT * FROM students WHERE id IN (${bs})`),
        q(`SELECT id,role,name,phone,pin,school_id,class_id,active,perms FROM users WHERE id IN (${bu})`), q(`SELECT * FROM student_phones WHERE student_id IN (${bs})`),
        q(`SELECT * FROM results WHERE student_id IN (${bs})`), q(`SELECT * FROM notes WHERE student_id IN (${bs})`), q(`SELECT * FROM rnotes WHERE student_id IN (${bs})`),
        q(`SELECT * FROM certificates WHERE student_id IN (${bs})`), q(`SELECT * FROM ex_answers WHERE student_id IN (${bs})`), q(`SELECT * FROM iresults WHERE student_id IN (${bs})`),
        q('SELECT * FROM itests WHERE school_id=?', sB), q(`SELECT * FROM yol_prog WHERE student_id IN (${bs})`), q(`SELECT * FROM kj_prog WHERE student_id IN (${bs})`),
        q(`SELECT * FROM utests WHERE class_id IN (${bc})`), q(`SELECT * FROM uholat WHERE class_id IN (${bc})`), q(`SELECT * FROM threads WHERE id IN (${bt})`),
        q(`SELECT id,thread_id,user_id,text,image FROM messages WHERE thread_id IN (${bt})`), q('SELECT * FROM announcements WHERE school_id=?', sB), q('SELECT * FROM trash WHERE school_id=?', sB),
        q(`SELECT * FROM tg_requests WHERE class_id IN (${bc})`), q(`SELECT count(*) n FROM sessions WHERE user_id IN (${bu})`), q(`SELECT * FROM obunalar WHERE student_id IN (${bs})`)];
      return crypto.createHash('sha256').update(JSON.stringify(parts, (k, v) => typeof v === 'bigint' ? Number(v) : v)).digest('hex');
    };
    const SIR = /Bsir|93700000\d/;
    // ---------------- 1) kirmagan odam
    console.log(`Amallar: ${ACTS.length} ta`);
    const anon = new Kim('kirmagan');
    for (const a of ACTS) { const r = await anon.f(a, { id: kB }, true); if (r.status !== 401) xato(`kirmagan odam "${a}" amalini chaqirdi (${r.status})`); }
    // ---------------- 2) har rol × har amal × har variant
    // Jamoa a'zolari (loyiha jamoasi) hamma maktabni KO'RADI — bu loyihaning qoidasi. Ular uchun faqat O'ZGARTIRISH tekshiriladi:
    // huquqi yo'q jamoa a'zosi faqat o'z izohini yoza oladi (note.save), kuzatuvchi hech narsani o'zgartira olmaydi.
    jamoa.global = true; jamoa.ruxsat = new Set(['note.save']); kuzat.global = true; kuzat.ruxsat = new Set();
    const ROLLAR = [dirA, rahA, otaA, jamoa, kuzat];
    const asos = { school_id: sB, class_id: cB, student_id: kB, user_id: ids.odam, sid: kB, cid: cB, ids: [kB, kB2], student_ids: [kB], ref: cB, kind: 'rahbar', phone: '937000003', test_id: tst, thread_id: ids.yozishma, msg_id: ids.xabar, name: 'Zzz Yyy', text: 'x', confirm: true, on: true, och: true, topic: '2A1', grade: 2, num: 202 };
    const VAR = Object.entries(ids).filter(([, v]) => v).map(([k, v]) => [k, { ...asos, id: v }]).concat([['id-siz', asos], ['ota-raqami', { ...asos, kind: 'ota', ref: '937000003' }], ['direktor', { ...asos, kind: 'direktor', ref: sB }]]);
    let n = 0, n500 = 0; const sizish = new Set(), ozgarish = new Set(), x500 = new Set();
    for (const k of ROLLAR) for (const a of ACTS) {
      if (a === 'demo.enter' || a === 'demo.reset') continue; // namuna kabinetlar faqat CEO uchun (alohida tekshiriladi)
      for (const [vn, body] of VAR) {
        const iz0 = iz(); const r = await k.f(a, body, true); n++;
        if (r.status === 500) { n500++; x500.add(`${k.n} → ${a}`); }
        if (!k.global && r.status === 200 && SIR.test(r.text)) sizish.add(`${k.n} → ${a} [${vn}]: ${(r.text.match(/.{0,40}(Bsir|937000)[^"]{0,30}/) || [''])[0]}`);
        if (iz() !== iz0 && !(k.ruxsat && k.ruxsat.has(a))) ozgarish.add(`${k.n} → ${a} [${vn}] (javob ${r.status})`);
      }
    }
    for (const s of sizish) xato('BOSHQA MAKTAB MA’LUMOTI KO‘RINDI: ' + s);
    for (const s of ozgarish) xato('BOSHQA MAKTAB MA’LUMOTI O‘ZGARDI: ' + s);
    console.log(`Chaqiriqlar: ${n} ta; server xatosi (500): ${n500} ta`); for (const s of x500) console.log('  500: ' + s);
    // ---------------- 3) B maktab egalari o'z ma'lumotini ko'radi (test o'zi to'g'ri ishlayaptimi)
    const stB = await rahB.f('state'); if (!SIR.test(JSON.stringify(stB))) xato('rahbarB o‘z sinfini ko‘rmayapti — test noto‘g‘ri');
    // ---------------- 3b) fon yangilanishi: ma'lumot o'zgarmagan bo'lsa qisqa javob, o'zgarsa — to'liq (eskirgan ma'lumot qolmasin)
    { const s1 = await rahA.f('state'); const s2 = await rahA.f('state', { v: s1._v });
      if (!s2.same) xato('o‘zgarmagan holatda ham to‘liq ma’lumot qayta yuborildi');
      await ceo.f('student.save', { class_id: cA, name: 'Yangi Bolajon', phone: '901000099' });
      const s3 = await rahA.f('state', { v: s1._v });
      if (s3.same || !JSON.stringify(s3).includes('Yangi Bolajon')) xato('o‘zgarishdan keyin fon yangilanishi eski ma’lumot qaytardi'); }
    // ---------------- 4) dars fayllari (7-band): kirmagan — yo'q; ota-ona — faqat CEO ochgan dars; o'qituvchi — hammasi
    const dars = async (k, kod) => { const r = await fetch(B + '/darslar/' + kod + '.html', { headers: k ? { Cookie: k.ck } : {} }); return r.status === 200 && (await r.text()).includes('DARS-MAZMUNI'); };
    await ceo.f('dm.set', { id: '2A1', och: true });
    if (await dars(null, '2A1')) xato('dars fayli kirmagan odamga ochildi');
    if (!(await dars(otaA, '2A1'))) xato('ota-ona CEO ochgan darsni ocha olmadi');
    if (await dars(otaA, '2A2')) xato('ota-ona CEO ochmagan darsni ochdi');
    if (!(await dars(rahA, '2A2'))) xato('sinf rahbari darsni ocha olmadi');
    if (!(await dars(ceo, '2A2'))) xato('CEO darsni ocha olmadi');
    await ceo.f('obuna.sozlama', { majburiy: true });
    if (await dars(otaA, '2A1')) xato('obuna majburiy: obunasiz bola darsni ochdi');
    await ceo.f('obuna.yoq', { student_id: kA, turi: 'oy' });
    if (!(await dars(otaA, '2A1'))) xato('obuna majburiy: obunali bola darsni ocha olmadi ');
    // boshqa sinf darsi: "obuna kerak" emas, "boshqa sinf uchun" deyiladi
    await ceo.f('dm.set', { id: '3A1', och: true });
    { const r = await fetch(B + '/darslar/3A1.html', { headers: { Cookie: otaA.ck } }); const t = await r.text();
      if (r.status !== 403 || !t.includes('boshqa sinf')) xato('boshqa sinf darsi: noto‘g‘ri javob (' + r.status + ')'); }
    await ceo.f('obuna.sozlama', { majburiy: false });
    // ---------------- 5) PIN (2- va 3-band): bazada ochiq PIN yo'q; telefonsiz PIN berilmaydi; PIN faqat o'z raqami bilan ochiladi
    const ochiq = q('SELECT id FROM users WHERE pin GLOB ?', '[0-9][0-9][0-9][0-9][0-9][0-9]');
    if (ochiq.length) xato(`bazada ${ochiq.length} ta ochiq PIN bor`);
    if (!q("SELECT 1 FROM users WHERE pin LIKE 'h2$%'").length) xato('shifrlangan PIN topilmadi');
    // PIN raqamlari: CEO ko'radi (berilgan PIN bilan bir xil); 'pin_korish' huquqisiz jamoa a'zosi va direktor — ko'rmaydi
    { const pX = await pin('ota', '901000003'), r = (await ceo.f('pins', {})).list.find(x => x.kind === 'ota' && x.phone === '901000003');
      if (!r || r.user.pin !== pX) xato('CEO PIN ro‘yxatida PIN raqamini ko‘rmayapti (' + (r && r.user.pin) + ')');
      await otaA.kir('901000003', pX); // ota-ona kabineti keyingi sinovlarda yangi PIN bilan davom etadi
      const jp = await ceo.f('team.save', { name: 'Pinlar Ko‘ruvchi', phone: '905000009', perms: { pinlar: true } });
      const jk = await new Kim('jamoa(pinlar)').kir('905000009', jp.pin); await jk.f('consent', { consent: true }).catch(() => { });
      if (/"pin":"\d{6}"/.test(JSON.stringify(await jk.f('pins', {})))) xato('pin_korish huquqisiz jamoa a’zosi PIN raqamini ko‘rdi');
      if (/"pin":"\d{6}"/.test(JSON.stringify(await dirA.f('pins', {})))) xato('direktor PIN raqamini ko‘rdi'); }
    const cN = (await ceo.f('class.save', { school_id: sA, name: '4-A', teacher_name: 'Raqamsiz Ustoz', teacher_phone: '' })).id;
    const rN = await ceo.f('pin.issue', { kind: 'rahbar', ref: cN }, true); if (rN.status === 200) xato('telefonsiz sinf rahbariga PIN berildi');
    const rT = await ceo.f('team.save', { name: 'Raqamsiz Jamoa', phone: '', perms: {} }, true); if (rT.status === 200) xato('telefonsiz jamoa a’zosiga PIN berildi');
    const pA = await pin('ota', '901000006');
    if ((await new Kim('begona').f('login', { phone: '939999999', pin: pA }, true)).status === 200) xato('PIN begona raqam bilan ochildi');
    if ((await new Kim('ota2').f('login', { phone: '901000006', pin: pA }, true)).status !== 200) xato('PIN o‘z raqami bilan ochilmadi');
    // zaxiradan tiklangan eski (ochiq) PIN: begona raqam bilan urinish uni o'zgartirmaydi; egasi kirganda maxfiy ko'rinishga o'tadi
    { const w = new DatabaseSync(path.join(DIR, 'data', 'yx.db')); w.exec('PRAGMA busy_timeout=5000');
      const id = w.prepare("SELECT id FROM users WHERE role='ota' AND phone='901000006'").get().id; w.prepare('UPDATE users SET pin=? WHERE id=?').run('123457', id);
      if ((await new Kim('begona2').f('login', { phone: '939999998', pin: '123457' }, true)).status === 200) xato('eski PIN begona raqam bilan ochildi');
      if (w.prepare('SELECT pin FROM users WHERE id=?').get(id).pin !== '123457') xato('eski PIN begona raqam bilan urinishda o‘zgartirildi');
      if ((await new Kim('ota3').f('login', { phone: '901000006', pin: '123457' }, true)).status !== 200) xato('eski PIN egasi bilan ochilmadi');
      if (!/^h2\$/.test(w.prepare('SELECT pin FROM users WHERE id=?').get(id).pin)) xato('eski PIN egasi kirgach maxfiy ko‘rinishga o‘tmadi');
      // 24.11 gacha berilgan 'h1$' (qaytarib o'qib bo'lmaydigan) PIN: ishlayveradi, egasi kirgach shifrlanganiga o'tadi va CEO ko'radi
      const K = Buffer.from(fs.readFileSync(path.join(DIR, 'data', 'pin-kalit'), 'utf8').trim(), 'hex');
      w.prepare('UPDATE users SET pin=? WHERE id=?').run('h1$' + crypto.createHmac('sha256', K).update('pin:123458').digest('hex'), id);
      if ((await new Kim('ota4').f('login', { phone: '901000006', pin: '123458' }, true)).status !== 200) xato('h1 ko‘rinishdagi PIN bilan kirib bo‘lmadi');
      if ((await ceo.f('pins', {})).list.find(x => x.kind === 'ota' && x.phone === '901000006')?.user?.pin !== '123458') xato('h1 PIN egasi kirgach CEO ko‘rmayapti');
      w.close(); }
    db.close();
    if (process.env.LOG) console.log(S.log().split('\n').filter(l => /Error|^\s+at /.test(l)).slice(0, 60).join('\n'));
    // 7) CEO yuklab oladigan parolli zaxira ZIP: baza bilan birga PIN kaliti ham ichida (server yo'qolsa PIN'lar tiklanadi)
    { const { spawnSync } = require('node:child_process');
      if (spawnSync('7z', ['i']).error) console.log('  (7z yo‘q — zaxira ZIP tekshiruvi o‘tkazib yuborildi)');
      else {
        const r = await fetch(B + '/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ceo.ck }, body: JSON.stringify({ pw: 'Sinov-parol-123' }) });
        if (r.status !== 200) xato('zaxira ZIP yuklanmadi (' + r.status + ')');
        else {
          const zd = fs.mkdtempSync(path.join(DIR, 'zip-')), zf = path.join(zd, 'z.zip'); fs.writeFileSync(zf, Buffer.from(await r.arrayBuffer()));
          if (spawnSync('7z', ['x', '-pnotogri', '-o' + path.join(zd, 'x0'), zf]).status === 0) xato('zaxira ZIP noto‘g‘ri parol bilan ochildi');
          const x = spawnSync('7z', ['x', '-pSinov-parol-123', '-o' + path.join(zd, 'x'), zf]);
          const ich = x.status === 0 ? fs.readdirSync(path.join(zd, 'x')) : [];
          if (!ich.some(f => f.endsWith('.db'))) xato('zaxira ZIP ichida baza yo‘q');
          if (!ich.includes('pin-kalit') || fs.readFileSync(path.join(zd, 'x', 'pin-kalit'), 'utf8').trim() !== fs.readFileSync(path.join(DIR, 'data', 'pin-kalit'), 'utf8').trim()) xato('zaxira ZIP ichida PIN kaliti yo‘q yoki boshqa');
        }
      } }
    S.p.kill(); await new Promise(r => S.p.exitCode != null ? r() : S.p.once('exit', r));
    fs.writeFileSync(path.join(DIR, 'data', 'pin-kalit'), 'buzuq\n');
    const S2 = boot(); for (let i = 0; i < 60 && !/http:\/\/127/.test(S2.log()) && S2.p.exitCode == null; i++) await wait(250);
    if (!fs.readdirSync(path.join(DIR, 'data')).some(f => f.startsWith('pin-kalit.buzuq-'))) xato('buzuq PIN kaliti saqlanmadi');
    if (!/DIQQAT: .*pin-kalit buzuq/.test(S2.log())) xato('buzuq PIN kaliti haqida jurnalda ogohlantirish yo‘q');
    S2.p.kill();
  } finally { S.p.kill(); fs.rmSync(DIR, { recursive: true, force: true }); }
  console.log(fail ? `\nNATIJA: ${fail} ta XATO` : '\nNATIJA: hammasi to‘g‘ri');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST BUZILDI:', e.message); process.exit(2); });
