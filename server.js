// Yosh Xorazmiylar — server. Faqat Node.js 22+ (qo'shimcha paket kerak emas).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'yx.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

// ---------------------------------------------------------------- schema
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, role TEXT NOT NULL, name TEXT DEFAULT '', phone TEXT DEFAULT '',
  pin TEXT UNIQUE, pin_at TEXT, school_id INTEGER, class_id INTEGER, perms TEXT DEFAULT '{}',
  active INTEGER DEFAULT 1, created_at TEXT, last_login TEXT, consent_at TEXT);
CREATE TABLE IF NOT EXISTS schools(
  id INTEGER PRIMARY KEY, num INTEGER UNIQUE, name TEXT DEFAULT '', director_name TEXT DEFAULT '',
  director_phone TEXT DEFAULT '', created_at TEXT);
CREATE TABLE IF NOT EXISTS classes(
  id INTEGER PRIMARY KEY, school_id INTEGER NOT NULL REFERENCES schools(id), name TEXT NOT NULL,
  grade INTEGER NOT NULL, teacher_name TEXT DEFAULT '', teacher_phone TEXT DEFAULT '', UNIQUE(school_id,name));
CREATE TABLE IF NOT EXISTS students(
  id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id), name TEXT NOT NULL,
  phone TEXT DEFAULT '', birth_year INTEGER, address TEXT DEFAULT '', active INTEGER DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS tests(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, date TEXT DEFAULT '', status TEXT DEFAULT 'tayyor',
  gifted_top INTEGER DEFAULT 10, gifted_min INTEGER DEFAULT 70, created_at TEXT);
CREATE TABLE IF NOT EXISTS keys(
  test_id INTEGER NOT NULL REFERENCES tests(id), grade INTEGER NOT NULL, key TEXT NOT NULL, PRIMARY KEY(test_id,grade));
CREATE TABLE IF NOT EXISTS results(
  id INTEGER PRIMARY KEY, test_id INTEGER NOT NULL REFERENCES tests(id), student_id INTEGER NOT NULL REFERENCES students(id),
  absent INTEGER DEFAULT 0, mode TEXT DEFAULT 'belgi', answers TEXT DEFAULT '', bits TEXT DEFAULT '', score INTEGER,
  qn INTEGER DEFAULT 20, entered_by INTEGER, at TEXT, UNIQUE(test_id,student_id));
CREATE TABLE IF NOT EXISTS approvals(
  test_id INTEGER NOT NULL, school_id INTEGER NOT NULL, user_id INTEGER NOT NULL, at TEXT,
  PRIMARY KEY(test_id,school_id,user_id));
CREATE TABLE IF NOT EXISTS announcements(test_id INTEGER NOT NULL, school_id INTEGER NOT NULL, at TEXT, PRIMARY KEY(test_id,school_id));
CREATE TABLE IF NOT EXISTS notes(
  id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL, user_id INTEGER NOT NULL, text TEXT NOT NULL,
  summary INTEGER DEFAULT 0, at TEXT);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, at TEXT, user_id INTEGER, action TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS student_phones(student_id INTEGER NOT NULL, phone TEXT NOT NULL, PRIMARY KEY(student_id,phone));
CREATE TABLE IF NOT EXISTS phone_hints(student_id INTEGER PRIMARY KEY, phone TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS threads(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, user_id INTEGER, class_id INTEGER, student_id INTEGER,
  topic TEXT DEFAULT '', status TEXT DEFAULT 'ochiq', created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, user_id INTEGER NOT NULL, text TEXT DEFAULT '', image TEXT DEFAULT '', at TEXT);
CREATE TABLE IF NOT EXISTS reads(thread_id INTEGER NOT NULL, user_id INTEGER NOT NULL, at TEXT, PRIMARY KEY(thread_id,user_id));
CREATE TABLE IF NOT EXISTS exercises(id INTEGER PRIMARY KEY, grade INTEGER NOT NULL, day TEXT NOT NULL, text TEXT NOT NULL, image TEXT DEFAULT '',
  options TEXT NOT NULL, answer TEXT NOT NULL, explain TEXT DEFAULT '', user_id INTEGER, at TEXT);
CREATE TABLE IF NOT EXISTS ex_answers(exercise_id INTEGER NOT NULL, student_id INTEGER NOT NULL, choice TEXT, correct INTEGER, at TEXT, PRIMARY KEY(exercise_id,student_id));
CREATE TABLE IF NOT EXISTS certificates(id INTEGER PRIMARY KEY, code TEXT UNIQUE, test_id INTEGER NOT NULL, student_id INTEGER NOT NULL, at TEXT, UNIQUE(test_id,student_id));
CREATE TABLE IF NOT EXISTS tg_users(chat_id TEXT PRIMARY KEY, phone TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS tg_requests(id INTEGER PRIMARY KEY, chat_id TEXT, phone TEXT, class_id INTEGER, child TEXT, status TEXT DEFAULT 'kutilmoqda',
  student_id INTEGER, by INTEGER, at TEXT);
CREATE TABLE IF NOT EXISTS itests(id INTEGER PRIMARY KEY, school_id INTEGER NOT NULL, name TEXT NOT NULL, day TEXT, qn INTEGER DEFAULT 20, grade INTEGER DEFAULT 0,
  subject TEXT DEFAULT '', by INTEGER, at TEXT);
CREATE TABLE IF NOT EXISTS iresults(itest_id INTEGER NOT NULL, student_id INTEGER NOT NULL, score INTEGER, absent INTEGER DEFAULT 0, by INTEGER, at TEXT,
  PRIMARY KEY(itest_id,student_id));
`);

// yangi ustunlar (eski bazaga ham qo'shiladi)
try { db.exec("ALTER TABLE messages ADD COLUMN edited TEXT DEFAULT ''"); } catch (e) { }
try { db.exec("ALTER TABLE threads ADD COLUMN school_id INTEGER"); } catch (e) { }
try { db.exec("ALTER TABLE itests ADD COLUMN class_id INTEGER"); } catch (e) { }
db.exec("CREATE TABLE IF NOT EXISTS trash(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref_id INTEGER, label TEXT DEFAULT '', info TEXT DEFAULT '', school_id INTEGER, by INTEGER, at TEXT, data TEXT DEFAULT '{}')");
try { db.exec("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''"); } catch (e) { }
try { db.exec("ALTER TABLE students ADD COLUMN avatar TEXT DEFAULT ''"); } catch (e) { }
try { db.exec("ALTER TABLE messages ADD COLUMN audio TEXT DEFAULT ''"); } catch (e) { }
// tug'ilgan yil va manzil endi yig'ilmaydi — avval kiritilganlari ham o'chiriladi
db.exec("UPDATE students SET birth_year=NULL, address='' WHERE birth_year IS NOT NULL OR address<>''");
db.exec("DELETE FROM audit WHERE action='oquvchi.malumot'");
// test olish: variantlar (B, C, D kalitlari; A kaliti keys jadvalida), yuklangan test savollari, natijadagi variant
db.exec(`CREATE TABLE IF NOT EXISTS vkeys(test_id INTEGER NOT NULL, grade INTEGER NOT NULL, variant TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(test_id,grade,variant));
CREATE TABLE IF NOT EXISTS tbank(id INTEGER PRIMARY KEY, name TEXT NOT NULL, grade INTEGER NOT NULL, qn INTEGER NOT NULL, nopt INTEGER DEFAULT 4, data TEXT NOT NULL, keys TEXT NOT NULL, by INTEGER, at TEXT);
CREATE TABLE IF NOT EXISTS tlinks(test_id INTEGER NOT NULL, grade INTEGER NOT NULL, bank_id INTEGER NOT NULL, by INTEGER, at TEXT, PRIMARY KEY(test_id,grade));`);
try { db.exec("ALTER TABLE tests ADD COLUMN scope TEXT DEFAULT ''"); } catch (e) { }
try { db.exec("ALTER TABLE results ADD COLUMN variant TEXT DEFAULT ''"); } catch (e) { }

const now = () => new Date().toISOString();
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const log = (uid, action, detail) => run('INSERT INTO audit(at,user_id,action,detail) VALUES(?,?,?,?)', now(), uid, action, JSON.stringify(detail ?? {}));

// ---------------------------------------------------------------- helpers
const PERMS = ['kiritish', 'maktab', 'tuzatish', 'kalit', 'reyting', 'pinlar', 'pin_korish', 'tarix', 'xabar', 'mashq'];
function phone9(p) { const d = String(p || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; }
function newPin() {
  for (;;) { const p = String(crypto.randomInt(100000, 1000000)); if (!one('SELECT 1 FROM users WHERE pin=?', p)) return p; }
}
function perms(u) {
  if (u.role === 'ceo') return Object.fromEntries(PERMS.map(k => [k, true]).concat([['sardor', true], ['ceo', true]]));
  if (u.role !== 'jamoa') return {};
  try { return JSON.parse(u.perms || '{}'); } catch { return {}; }
}
const isTeam = u => u.role === 'ceo' || u.role === 'jamoa';
function can(u, k) { return !!perms(u)[k]; }
// direktor o'z maktabini boshqaradi (sinf rahbarlari, o'quvchilar, telefonlar, maktab ma'lumotlari)
const schoolOfClass = cid => one('SELECT school_id FROM classes WHERE id=?', +cid)?.school_id || 0;
const schoolOfStudent = sid => one('SELECT c.school_id FROM students s JOIN classes c ON c.id=s.class_id WHERE s.id=?', +sid)?.school_id || 0;
const ownsSchool = (u, schoolId) => can(u, 'maktab') || (u.role === 'direktor' && !!schoolId && u.school_id === schoolId);
class HttpErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const need = (cond, msg = 'Bu amal uchun huquqingiz yo‘q') => { if (!cond) throw new HttpErr(403, msg); };
const bad = msg => { throw new HttpErr(400, msg); };
const str = (v, max = 200) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
// ism-familiyalarda bir xil yozuv: o‘ g‘ (‘ belgisi), qolgan joyda tutuq belgisi ’ (A’zamjon, Ma’ruf)
const fixName = (v, max = 200) => str(String(v ?? '').replace(/\u00a0/g, ' '), max).replace(/([oOgG])?[`'‘’ʻʼ´]/g, (m, l) => l ? l + '‘' : '’');
function gradeOf(name) { const g = parseInt(name, 10); return g >= 1 && g <= 11 ? g : 0; }
function clsName(n) { const m = String(n).toUpperCase().replace(/\s| /g, '').match(/^(\d{1,2})-?([A-ZА-Я]+)?$/); return m ? m[1] + (m[2] ? '-' + m[2] : '') : ''; }

// first run: create CEO
if (!one("SELECT 1 FROM users WHERE role='ceo'")) {
  const pin = newPin();
  run("INSERT INTO users(role,name,pin,pin_at,created_at) VALUES('ceo','CEO',?,?,?)", pin, now(), now());
  fs.writeFileSync(path.join(DATA, 'ceo-pin.txt'), pin + '\n', { mode: 0o600 });
  console.log('CEO PIN:', pin);
}

// ---------------------------------------------------------------- scoring
const VARS = ['A', 'B', 'C', 'D'];
const varOf = v => VARS.includes(String(v || '').toUpperCase()) ? String(v).toUpperCase() : '';
function keyFor(testId, grade, variant) {
  if (variant && variant !== 'A') return one('SELECT key FROM vkeys WHERE test_id=? AND grade=? AND variant=?', testId, grade, variant)?.key || '';
  return one('SELECT key FROM keys WHERE test_id=? AND grade=?', testId, grade)?.key || '';
}
// sinf bosqichi bo'yicha variantlar va savollar soni (titul va skaner uchun; kalitlarning o'zi emas)
function varInfo(testId) {
  const o = {};
  for (const k of all('SELECT grade,key FROM keys WHERE test_id=?', testId)) o[k.grade] = { v: ['A'], qn: k.key.length, nopt: k.key.includes('E') ? 5 : 4 };
  for (const k of all('SELECT grade,variant,key FROM vkeys WHERE test_id=? ORDER BY variant', testId)) { const g = (o[k.grade] ||= { v: [], qn: k.key.length, nopt: 4 }); g.v.push(k.variant); if (k.key.includes('E')) g.nopt = 5; }
  for (const l of all('SELECT l.grade,l.bank_id,b.name,b.nopt FROM tlinks l JOIN tbank b ON b.id=l.bank_id WHERE l.test_id=?', testId)) {
    const g = (o[l.grade] ||= { v: [], qn: 0, nopt: 4 }); g.bank = { id: l.bank_id, name: l.name }; g.nopt = Math.max(g.nopt, l.nopt || 4);
  }
  for (const g of Object.keys(o)) o[g].locked = gradeLocked(testId, +g);
  return o;
}
// imtihonda shu sinf bosqichiga birorta natija (kelmadi ham) kiritilgan bo'lsa, testi va kalitlari qulflanadi
const gradeLocked = (testId, g) => !!one('SELECT 1 FROM results r JOIN students s ON s.id=r.student_id JOIN classes c ON c.id=s.class_id WHERE r.test_id=? AND c.grade=? LIMIT 1', testId, g);
function score(testId, grade, mode, answers, bits, variant) {
  const key = keyFor(testId, grade, variant);
  if (mode === 'harf') {
    const a = String(answers || '').toUpperCase().replace(/[^A-E-]/g, '-');
    if (!key) return { answers: a, bits: '', score: null, qn: a.length || 20 };
    const b = [...key].map((k, i) => (a[i] && a[i] === k ? '1' : '0')).join('');
    return { answers: a.padEnd(key.length, '-').slice(0, key.length), bits: b, score: [...b].filter(x => x === '1').length, qn: key.length };
  }
  const qn = key ? key.length : 20;
  const b = String(bits || '').replace(/[^01]/g, '0').padEnd(qn, '0').slice(0, qn);
  return { answers: '', bits: b, score: [...b].filter(x => x === '1').length, qn };
}
function rescoreTest(testId) {
  const rows = all(`SELECT r.id,r.mode,r.answers,r.bits,r.variant,c.grade FROM results r JOIN students s ON s.id=r.student_id
    JOIN classes c ON c.id=s.class_id WHERE r.test_id=? AND r.absent=0 AND r.mode!='ball'`, testId);
  for (const r of rows) { const s = score(testId, r.grade, r.mode, r.answers, r.bits, r.variant); run('UPDATE results SET bits=?,score=?,qn=? WHERE id=?', s.bits, s.score, s.qn, r.id); }
  return rows.length;
}

// announcement = CEO + jamoa sardori (if a sardor exists) both approved
function sardorIds() { return all("SELECT id,role,perms FROM users WHERE role='jamoa' AND active=1").filter(u => perms(u).sardor).map(u => u.id); }
function approvedState(testId, schoolId) {
  const ap = all('SELECT user_id FROM approvals WHERE test_id=? AND school_id=?', testId, schoolId).map(r => r.user_id);
  const ceo = one("SELECT id FROM users WHERE role='ceo'").id;
  const sard = sardorIds();
  const ceoOk = ap.includes(ceo), sardOk = !sard.length || sard.some(id => ap.includes(id));
  const ann = one('SELECT at FROM announcements WHERE test_id=? AND school_id=?', testId, schoolId);
  return { ceo: ceoOk, sardor: sardOk, hasSardor: sard.length > 0, done: !!ann, at: ann?.at || null, by: ap };
}
const announced = (testId, schoolId) => !!one('SELECT 1 FROM announcements WHERE test_id=? AND school_id=?', testId, schoolId);
const finished = testId => announced(testId, 0);

// ---------------------------------------------------------------- state (what each role may see)
function state(u) {
  const P = perms(u);
  const tests = all('SELECT * FROM tests ORDER BY id DESC');
  const out = { me: { id: u.id, role: u.role, name: u.name, perms: P, consent: !!u.consent_at, avatar: u.avatar || '' }, tests, perms: PERMS };
  if (isTeam(u)) {
    out.schools = all('SELECT * FROM schools ORDER BY num');
    out.classes = all('SELECT * FROM classes ORDER BY school_id,grade,name');
    out.students = all('SELECT id,class_id,name,phone,avatar FROM students WHERE active=1 ORDER BY name').map(s => ({ ...s, avatar: kidPh(s.avatar) }));
    out.results = all('SELECT id,test_id,student_id,absent,mode,answers,bits,score,qn,entered_by,at,variant FROM results');
    out.vinfo = Object.fromEntries(tests.map(t => [t.id, varInfo(t.id)]));
    out.bank = bankList();
    out.keys = {};
    for (const t of tests) {
      const visible = P.ceo || (P.kalit && ['tekshiruv', 'yakunlandi'].includes(t.status));
      out.keys[t.id] = visible ? Object.fromEntries(all('SELECT grade,key FROM keys WHERE test_id=?', t.id).map(k => [k.grade, k.key]))
        : Object.fromEntries(all('SELECT grade,length(key) n FROM keys WHERE test_id=?', t.id).map(k => [k.grade, '?'.repeat(k.n)]));
      if (visible) { const vk = {}; for (const k of all('SELECT grade,variant,key FROM vkeys WHERE test_id=?', t.id)) (vk[k.grade] ||= {})[k.variant] = k.key; (out.vkeys ||= {})[t.id] = vk; }
    }
    out.approvals = {};
    for (const t of tests) { out.approvals[t.id] = {}; for (const s of [{ id: 0 }, ...out.schools]) out.approvals[t.id][s.id] = approvedState(t.id, s.id); }
    out.team = all("SELECT id,role,name,phone,perms,active,last_login,avatar FROM users WHERE role IN ('ceo','jamoa')").map(x => ({ ...x, perms: perms(x) }));
    out.notes = all('SELECT * FROM notes ORDER BY at DESC');
    out.hints = hintsMap();
    Object.assign(out, extras(u, out));
    return out;
  }
  // school-side roles: results only after announcement
  let classIds = [];
  if (u.role === 'direktor') classIds = all('SELECT id FROM classes WHERE school_id=?', u.school_id).map(r => r.id);
  if (u.role === 'rahbar') classIds = [u.class_id];
  if (u.role === 'ota') {
    const p = phone9(u.phone);
    const kids = kidsOfPhone(p);
    classIds = [...new Set(kids.map(id => one('SELECT class_id FROM students WHERE id=?', id).class_id))];
  }
  const ph = classIds.map(() => '?').join(',') || 'NULL';
  out.classes = all(`SELECT id,school_id,name,grade,teacher_name${u.role === 'direktor' ? ',teacher_phone' : ''} FROM classes WHERE id IN (${ph})`, ...classIds);
  const schoolIds = [...new Set(out.classes.map(c => c.school_id))];
  out.schools = all(`SELECT id,num,name${u.role === 'direktor' ? ',director_name,director_phone' : ''} FROM schools WHERE id IN (${schoolIds.map(() => '?').join(',') || 'NULL'})`, ...schoolIds);
  let studs = all(`SELECT id,class_id,name,phone,avatar FROM students WHERE active=1 AND class_id IN (${ph}) ORDER BY name`, ...classIds);
  if (u.role === 'rahbar') { const my = one('SELECT school_id,grade FROM classes WHERE id=?', u.class_id);
    out.moveTo = my ? all('SELECT id,name FROM classes WHERE school_id=? AND grade=? AND id<>? ORDER BY name', my.school_id, my.grade, u.class_id) : []; }
  if (u.role === 'ota') { const k = new Set(kidsOfPhone(phone9(u.phone))); out.children = studs.filter(s => k.has(s.id)).map(s => s.id); }
  const hm = ['rahbar', 'direktor'].includes(u.role) ? hintsMap() : {};
  out.students = studs.map(s => ({ id: s.id, class_id: s.class_id, name: s.name, avatar: kidPh(s.avatar),
    ...(['rahbar', 'direktor'].includes(u.role) ? { phone: s.phone || '', extra: extraPhones(s.id), hint: hm[s.id] || '' } : {}) }));
  const visibleTests = tests.filter(t => schoolIds.some(sid => announced(t.id, sid)));
  out.tests = visibleTests.map(t => ({ ...t, finished: finished(t.id) }));
  const sIds = studs.map(s => s.id);
  out.results = [];
  for (const t of visibleTests) {
    for (const sid of schoolIds) {
      if (!announced(t.id, sid)) continue;
      const rows = all(`SELECT r.test_id,r.student_id,r.absent,r.bits,r.score,r.qn FROM results r JOIN students s ON s.id=r.student_id
        JOIN classes c ON c.id=s.class_id WHERE r.test_id=? AND c.school_id=?`, t.id, sid).filter(r => sIds.includes(r.student_id));
      out.results.push(...rows);
    }
  }
  if (u.role === 'ota') { // parents: other children only as class averages, never names
    const kids = new Set(out.children);
    const avg = {};
    for (const r of out.results) { const s = studs.find(x => x.id === r.student_id); const k = r.test_id + ':' + s.class_id; if (!r.absent) { (avg[k] ||= []).push(r.score / r.qn); } }
    out.classAvg = Object.fromEntries(Object.entries(avg).map(([k, v]) => [k, Math.round(v.reduce((a, b) => a + b, 0) / v.length * 100)]));
    out.results = out.results.filter(r => kids.has(r.student_id));
    out.students = out.students.filter(s => kids.has(s.id));
    out.classes = out.classes.filter(c => out.students.some(s => s.class_id === c.id));
  }
  // district figures only after the whole test is finished
  out.district = {};
  out.gifted = [];
  for (const t of out.tests) {
    if (!t.finished) continue;
    const rows = all(`SELECT r.student_id,r.score,r.qn,c.grade,c.school_id FROM results r JOIN students s ON s.id=r.student_id JOIN classes c ON c.id=s.class_id
      WHERE r.test_id=? AND r.absent=0 AND r.score IS NOT NULL`, t.id);
    for (const g of [...new Set(rows.map(r => r.grade))]) {
      const gr = rows.filter(r => r.grade === g).sort((a, b) => b.score - a.score);
      out.district[t.id + ':' + g] = Math.round(gr.reduce((a, r) => a + r.score / r.qn, 0) / gr.length * 100);
      // sinf rahbari: o'z maktabining shu sinf bosqichi o'rtachasi (solishtirish uchun)
      if (u.role === 'rahbar') { const my = gr.filter(r => r.school_id === schoolIds[0]); if (my.length) out.district[t.id + ':school:' + g] = Math.round(my.reduce((a, r) => a + r.score / r.qn, 0) / my.length * 100); }
      // direktor: o'z maktabining tumandagi o'rni (boshqa maktablar nomi va bolalari ko'rsatilmaydi)
      if (u.role === 'direktor') {
        const by = {}; for (const r of gr) (by[r.school_id] ||= []).push(r.score / r.qn);
        const avgs = Object.entries(by).map(([k, v]) => [+k, v.reduce((a, b) => a + b, 0) / v.length]).sort((a, b) => b[1] - a[1]);
        const i = avgs.findIndex(x => x[0] === u.school_id); if (i >= 0) out.district[t.id + ':srank:' + g] = [avgs.filter(x => x[1] > avgs[i][1]).length + 1, avgs.length];
      }
      if (u.role === 'ota') for (const kid of out.children) { const i = gr.findIndex(r => r.student_id === kid); if (i >= 0) out.district[t.id + ':rank:' + kid] = [gr.filter(r => r.score > gr[i].score).length + 1, gr.length]; }
    }
  }
  for (const t of out.tests) for (const sid of schoolIds) if (announced(t.id, sid)) out.gifted.push(...giftedIds(t, sid).filter(id => out.students.some(s => s.id === id)).map(id => t.id + ':' + id));
  Object.assign(out, extras(u, out));
  return out;
}
// iqtidorli: har bir maktab ichida, o'z sinf bosqichida eng yaxshi gifted_top% va kamida gifted_min%
function giftedIds(t, schoolId) {
  const rows = all(`SELECT r.student_id,r.score,r.qn,c.grade,c.school_id FROM results r JOIN students s ON s.id=r.student_id JOIN classes c ON c.id=s.class_id
    WHERE r.test_id=? AND r.absent=0 AND r.score IS NOT NULL AND s.active=1`, t.id).filter(r => !schoolId || r.school_id === schoolId);
  const ids = [];
  for (const g of [...new Set(rows.map(r => r.school_id + ':' + r.grade))]) {
    const gr = rows.filter(r => r.school_id + ':' + r.grade === g).sort((a, b) => b.score - a.score);
    const cut = gr[Math.max(0, Math.ceil(gr.length * t.gifted_top / 100) - 1)].score;
    gr.forEach(r => { if (r.score >= cut && r.score / r.qn * 100 >= t.gifted_min) ids.push(r.student_id); });
  }
  return ids;
}

// ---------------------------------------------------------------- actions
const A = {};
// ---------------------------------------------------------------- avatarlar: tayyor rasm ('p:kalit') yoki o'z rasmi (kichik JPEG/PNG)
const kidPh = v => v && v.startsWith('data:') ? 'ph:' + v.length : ''; // bola surati alohida yuklanadi
function cleanAvatar(v, allowPhoto) {
  const s = String(v || ''); if (!s) return '';
  if (/^p:[a-z0-9_]{2,12}$/.test(s)) return s;
  if (allowPhoto && /^data:image\/(png|jpeg|webp);base64,/.test(s) && s.length <= 160000) return s;
  bad('Rasm juda katta yoki noto‘g‘ri');
}
// profil suratlari maxfiylik uchun o'chirilgan (28.10.2026 qarori): faqat ism bosh harflari ko'rinadi
db.exec("UPDATE users SET avatar='' WHERE avatar<>''"); db.exec("UPDATE students SET avatar='' WHERE avatar<>''");
A['me.avatar'] = () => bad('Profil surati qo‘yish o‘chirilgan');
A['student.avatar'] = () => bad('Profil surati qo‘yish o‘chirilgan');
A['consent'] = u => { run('UPDATE users SET consent_at=? WHERE id=?', now(), u.id); log(u.id, 'rozilik', {}); return {}; };

A['school.save'] = (u, b) => {
  if (!can(u, 'maktab')) { // direktor: faqat o'z maktabi nomi va direktor ismi
    need(u.role === 'direktor' && +b.id === u.school_id);
    const old = one('SELECT * FROM schools WHERE id=?', u.school_id);
    run('UPDATE schools SET name=?,director_name=? WHERE id=?', str(b.name), fixName(b.director_name), u.school_id);
    log(u.id, 'maktab.tahrir', { old, new: { name: str(b.name), director_name: fixName(b.director_name) } }); return { id: u.school_id };
  }
  const num = parseInt(b.num, 10); if (!num) bad('Maktab raqamini yozing');
  const f = [num, str(b.name), fixName(b.director_name), phone9(b.director_phone)];
  if (b.id) { const old = one('SELECT * FROM schools WHERE id=?', b.id); run('UPDATE schools SET num=?,name=?,director_name=?,director_phone=? WHERE id=?', ...f, b.id); log(u.id, 'maktab.tahrir', { old, new: f }); return { id: b.id }; }
  if (one('SELECT 1 FROM schools WHERE num=?', num)) bad(num + '-maktab allaqachon bor');
  const r = run('INSERT INTO schools(num,name,director_name,director_phone,created_at) VALUES(?,?,?,?,?)', ...f, now());
  log(u.id, 'maktab.qoshish', { num }); return { id: Number(r.lastInsertRowid) };
};
A['class.save'] = (u, b) => {
  if (u.role === 'direktor') b.school_id = u.school_id;
  need(ownsSchool(u, b.id ? schoolOfClass(b.id) : +b.school_id));
  const name = clsName(b.name); if (!name) bad('Sinf nomi noto‘g‘ri. Masalan: 3-A');
  const f = [name, gradeOf(name), fixName(b.teacher_name), phone9(b.teacher_phone)];
  if (b.id) { const old = one('SELECT * FROM classes WHERE id=?', b.id); run('UPDATE classes SET name=?,grade=?,teacher_name=?,teacher_phone=? WHERE id=?', ...f, b.id); log(u.id, 'sinf.tahrir', { old, new: f }); return { id: b.id }; }
  if (one('SELECT 1 FROM classes WHERE school_id=? AND name=?', b.school_id, name)) bad(name + ' sinfi allaqachon bor');
  const r = run('INSERT INTO classes(school_id,name,grade,teacher_name,teacher_phone) VALUES(?,?,?,?,?)', b.school_id, ...f);
  log(u.id, 'sinf.qoshish', { school_id: b.school_id, name }); return { id: Number(r.lastInsertRowid) };
};
A['student.save'] = (u, b) => {
  const dir = u.role === 'direktor';
  if (dir) need(ownsSchool(u, schoolOfClass(b.class_id)) && (!b.id || ownsSchool(u, schoolOfStudent(b.id))));
  else need(can(u, 'maktab') || can(u, 'kiritish'));
  const name = fixName(b.name, 120); if (name.split(' ').length < 2) bad('Familiya va ismni yozing');
  checkPhone(phone9(b.phone), b.id ? +b.id : 0);
  // bir sinfda bir xil familiya-ism ikki marta bo'lmasin
  const twin = all('SELECT id,name FROM students WHERE class_id=? AND active=1 AND id<>?', b.class_id, +b.id || 0).find(x => nameKey(x.name) === nameKey(name));
  if (twin) bad(`Bu sinfda «${twin.name}» allaqachon bor. Ro’yxatdan o’sha bolani toping`);
  if (phone9(b.phone) && b.id) run('DELETE FROM phone_hints WHERE student_id=?', +b.id);
  if (b.id) {
    if (!dir) need(can(u, 'maktab'));
    const old = one('SELECT * FROM students WHERE id=?', b.id);
    run('UPDATE students SET class_id=?,name=?,phone=? WHERE id=?', b.class_id, name, phone9(b.phone), b.id);
    log(u.id, 'oquvchi.tahrir', { id: b.id, old, new: { class_id: b.class_id, name, phone: phone9(b.phone) } });
    return { id: b.id };
  }
  const r = run('INSERT INTO students(class_id,name,phone,created_at) VALUES(?,?,?,?)', b.class_id, name, phone9(b.phone), now());
  log(u.id, 'oquvchi.qoshish', { id: Number(r.lastInsertRowid), name, class_id: b.class_id }); return { id: Number(r.lastInsertRowid) };
};
// boshqa sinfga ko'chirish: jamoa (maktab huquqi) istalgan sinfga; sinf rahbari o'z sinfidan shu maktabdagi parallel sinfga
A['student.move'] = (u, b) => {
  const st = one('SELECT s.id,s.name,s.class_id,c.school_id,c.grade,c.name cname FROM students s JOIN classes c ON c.id=s.class_id WHERE s.id=? AND s.active=1', +b.id); if (!st) bad('O‘quvchi topilmadi');
  const to = one('SELECT id,school_id,grade,name FROM classes WHERE id=?', +b.class_id); if (!to) bad('Sinf topilmadi');
  if (to.id === st.class_id) bad('Bola allaqachon shu sinfda');
  if (u.role === 'direktor') need(st.school_id === u.school_id && to.school_id === u.school_id, 'Faqat o‘z maktabingiz ichida ko‘chira olasiz');
  else if (!can(u, 'maktab')) need(u.role === 'rahbar' && u.class_id === st.class_id && to.school_id === st.school_id && to.grade === st.grade, 'Faqat o‘z sinfingizdagi bolani shu maktabdagi parallel sinfga ko‘chira olasiz');
  const twin = all('SELECT id,name FROM students WHERE class_id=? AND active=1', to.id).find(x => nameKey(x.name) === nameKey(st.name));
  if (twin) bad(`${to.name} sinfida «${twin.name}» allaqachon bor. Bu ortiqcha nusxa bo‘lsa, uni o‘chiring`);
  run('UPDATE students SET class_id=? WHERE id=?', to.id, st.id);
  log(u.id, 'oquvchi.kochirish', { id: st.id, name: st.name, from: st.cname, to: to.name, from_class: st.class_id, to_class: to.id });
  return {};
};
// takroriy nusxani asosiy nusxaga qo'shib, keyin o'chirish (telefon, tug'ilgan yil, manzil yo'qolmaydi)
A['students.merge'] = (u, b) => {
  need(can(u, 'maktab') || u.role === 'direktor');
  const pairs = Array.isArray(b.pairs) ? b.pairs : []; let n = 0;
  tx(() => {
    for (const [keepId, dropId] of pairs) {
      const k = one('SELECT * FROM students WHERE id=? AND active=1', +keepId), d = one('SELECT * FROM students WHERE id=? AND active=1', +dropId);
      if (!k || !d || k.id === d.id || k.class_id !== d.class_id || nameKey(k.name) !== nameKey(d.name)) continue;
      if (!ownsSchool(u, schoolOfClass(k.class_id))) continue;
      const kr = all('SELECT test_id FROM results WHERE student_id=? AND absent=0', d.id); if (kr.length) continue; // ikkinchisida ham ball bo'lsa, qo'lda hal qilinadi
      run('UPDATE students SET phone=CASE WHEN phone IS NULL OR phone=\'\' THEN ? ELSE phone END WHERE id=?', d.phone || '', k.id);
      run('INSERT OR IGNORE INTO student_phones(student_id,phone) SELECT ?,phone FROM student_phones WHERE student_id=?', k.id, d.id);
      run('INSERT OR IGNORE INTO phone_hints(student_id,phone) SELECT ?,phone FROM phone_hints WHERE student_id=?', k.id, d.id);
      run('INSERT OR IGNORE INTO results(test_id,student_id,absent,mode,answers,bits,score,qn,entered_by,at,variant) SELECT test_id,?,absent,mode,answers,bits,score,qn,entered_by,at,variant FROM results WHERE student_id=?', k.id, d.id);
      run('DELETE FROM results WHERE student_id=?', d.id); run('DELETE FROM phone_hints WHERE student_id=?', d.id); run('DELETE FROM student_phones WHERE student_id=?', d.id);
      run('UPDATE students SET active=0 WHERE id=?', d.id);
      log(u.id, 'oquvchi.birlashtirish', { keep: k.id, drop: d.id, name: k.name }); n++;
    }
  });
  return { n };
};
A['student.delete'] = (u, b) => {
  need(ownsSchool(u, schoolOfStudent(b.id)));
  const s = one('SELECT s.id,s.name,c.name cls,sc.num,sc.id sid FROM students s JOIN classes c ON c.id=s.class_id JOIN schools sc ON sc.id=c.school_id WHERE s.id=? AND s.active=1', +b.id); if (!s) return {};
  tx(() => { run('UPDATE students SET active=0 WHERE id=?', s.id); run('INSERT INTO trash(kind,ref_id,label,info,school_id,by,at) VALUES(?,?,?,?,?,?,?)', 'student', s.id, s.name, `${s.num}-maktab · ${s.cls}`, s.sid, u.id, now()); });
  log(u.id, 'oquvchi.ochirish', { id: s.id, name: s.name }); return {};
};
A['student.restore'] = (u, b) => { need(ownsSchool(u, schoolOfStudent(b.id))); run('UPDATE students SET active=1 WHERE id=?', b.id); run("DELETE FROM trash WHERE kind='student' AND ref_id=?", +b.id); log(u.id, 'oquvchi.qaytarish', { id: b.id }); return {}; };

// ---------------------------------------------------------------- savat: o'chirilganlar 30 kun saqlanadi
// Maktab, sinf, sinov, ichki sinov o'chirilganda bog'liq hamma qatorlar nusxasi saqlanadi va qaytarish mumkin
const inList = a => a.length ? a.map(() => '?').join(',') : 'NULL';
function snapStudents(ids, d) {
  const L = inList(ids);
  d.students = all(`SELECT * FROM students WHERE id IN (${L})`, ...ids);
  for (const t of ['results', 'student_phones', 'phone_hints', 'certificates', 'ex_answers', 'notes', 'iresults']) d[t] = (d[t] || []).concat(all(`SELECT * FROM ${t} WHERE student_id IN (${L})`, ...ids));
}
function dropStudents(ids) {
  const L = inList(ids);
  for (const t of ['results', 'student_phones', 'phone_hints', 'certificates', 'ex_answers', 'notes', 'iresults']) run(`DELETE FROM ${t} WHERE student_id IN (${L})`, ...ids);
  run(`DELETE FROM students WHERE id IN (${L})`, ...ids);
}
const ORDER = ['schools', 'tbank', 'tests', 'tlinks', 'classes', 'students', 'keys', 'vkeys', 'results', 'approvals', 'announcements', 'student_phones', 'phone_hints', 'certificates', 'ex_answers', 'notes', 'itests', 'iresults'];
function putBack(d) {
  for (const t of ORDER) for (const r of d[t] || []) { const k = Object.keys(r); run(`INSERT INTO ${t}(${k.join(',')}) VALUES(${k.map(() => '?').join(',')})`, ...k.map(x => r[x])); }
  if ((d.users || []).length) run(`UPDATE users SET active=1 WHERE id IN (${inList(d.users)})`, ...d.users);
}
function toTrash(u, kind, ref, label, info, schoolId, d) { run('INSERT INTO trash(kind,ref_id,label,info,school_id,by,at,data) VALUES(?,?,?,?,?,?,?,?)', kind, ref, label, info, schoolId || null, u.id, now(), JSON.stringify(d)); }
function offUsers(where, ...a) { const ids = all(`SELECT id FROM users WHERE active=1 AND ${where}`, ...a).map(r => r.id); if (ids.length) { run(`UPDATE users SET active=0 WHERE id IN (${inList(ids)})`, ...ids); run(`DELETE FROM sessions WHERE user_id IN (${inList(ids)})`, ...ids); } return ids; }
A['school.delete'] = (u, b) => {
  need(u.role === 'ceo', 'Maktabni faqat CEO o‘chiradi');
  const sc = one('SELECT * FROM schools WHERE id=?', +b.id); if (!sc) bad('Maktab topilmadi');
  if (String(b.confirm || '').trim() !== String(sc.num)) bad(`Tasdiqlash uchun maktab raqamini (${sc.num}) yozing`);
  return tx(() => {
    const cls = all('SELECT * FROM classes WHERE school_id=?', sc.id); const cids = cls.map(c => c.id);
    const sids = all(`SELECT id FROM students WHERE class_id IN (${inList(cids)})`, ...cids).map(r => r.id);
    const d = { schools: [sc], classes: cls }; snapStudents(sids, d);
    d.itests = all('SELECT * FROM itests WHERE school_id=?', sc.id); const its = d.itests.map(t => t.id);
    d.iresults = (d.iresults || []).filter(r => !its.includes(r.itest_id)).concat(all(`SELECT * FROM iresults WHERE itest_id IN (${inList(its)})`, ...its));
    d.approvals = all('SELECT * FROM approvals WHERE school_id=?', sc.id); d.announcements = all('SELECT * FROM announcements WHERE school_id=?', sc.id);
    d.users = offUsers(`(role='direktor' AND school_id=?) OR (role='rahbar' AND class_id IN (${inList(cids)}))`, sc.id, ...cids);
    run(`DELETE FROM iresults WHERE itest_id IN (${inList(its)})`, ...its); run('DELETE FROM itests WHERE school_id=?', sc.id);
    dropStudents(sids); run('DELETE FROM approvals WHERE school_id=?', sc.id); run('DELETE FROM announcements WHERE school_id=?', sc.id);
    run('DELETE FROM classes WHERE school_id=?', sc.id); run('DELETE FROM schools WHERE id=?', sc.id);
    toTrash(u, 'school', sc.id, `${sc.num}-maktab`, `${cls.length} sinf · ${sids.length} o‘quvchi`, sc.id, d);
    log(u.id, 'maktab.ochirish', { num: sc.num, sinf: cls.length, oquvchi: sids.length }); return {};
  });
};
A['class.delete'] = (u, b) => {
  need(u.role === 'ceo', 'Sinfni faqat CEO o‘chiradi');
  const c = one('SELECT c.*,s.num FROM classes c JOIN schools s ON s.id=c.school_id WHERE c.id=?', +b.id); if (!c) bad('Sinf topilmadi');
  if (String(b.confirm || '').trim().toUpperCase() !== c.name.toUpperCase()) bad(`Tasdiqlash uchun sinf nomini (${c.name}) yozing`);
  return tx(() => {
    const sids = all('SELECT id FROM students WHERE class_id=?', c.id).map(r => r.id);
    const { num, ...row } = c; const d = { classes: [row] }; snapStudents(sids, d);
    d.itests = all('SELECT * FROM itests WHERE class_id=?', c.id); const its = d.itests.map(t => t.id);
    d.iresults = (d.iresults || []).filter(r => !its.includes(r.itest_id)).concat(all(`SELECT * FROM iresults WHERE itest_id IN (${inList(its)})`, ...its));
    d.users = offUsers("role='rahbar' AND class_id=?", c.id);
    run(`DELETE FROM iresults WHERE itest_id IN (${inList(its)})`, ...its); run('DELETE FROM itests WHERE class_id=?', c.id);
    dropStudents(sids); run('DELETE FROM classes WHERE id=?', c.id);
    toTrash(u, 'class', c.id, `${c.num}-maktab · ${c.name} sinf`, `${sids.length} o‘quvchi`, c.school_id, d);
    log(u.id, 'sinf.ochirish', { name: `${c.num}-maktab ${c.name}`, oquvchi: sids.length }); return {};
  });
};
A['test.delete'] = (u, b) => {
  need(u.role === 'ceo', 'Sinovni faqat CEO o‘chiradi');
  const t = one('SELECT * FROM tests WHERE id=?', +b.id); if (!t) bad('Sinov topilmadi');
  if (String(b.confirm || '').trim().toLowerCase() !== 'o‘chirish' && String(b.confirm || '').trim().toLowerCase().replace(/['`’ʻ]/g, '‘') !== 'o‘chirish') bad('Tasdiqlash uchun “o‘chirish” deb yozing');
  return tx(() => {
    const d = { tests: [t] };
    for (const x of ['results', 'keys', 'vkeys', 'tlinks', 'approvals', 'announcements', 'certificates']) d[x] = all(`SELECT * FROM ${x} WHERE test_id=?`, t.id);
    for (const x of ['results', 'keys', 'vkeys', 'tlinks', 'approvals', 'announcements', 'certificates']) run(`DELETE FROM ${x} WHERE test_id=?`, t.id);
    run('DELETE FROM tests WHERE id=?', t.id);
    toTrash(u, 'test', t.id, t.name, `${d.results.length} ta natija`, null, d);
    log(u.id, 'sinov.ochirish', { name: t.name, natija: d.results.length }); return {};
  });
};
A['trash.list'] = u => {
  const rows = all('SELECT id,kind,ref_id,label,info,school_id,by,at FROM trash ORDER BY id DESC').filter(r => u.role === 'ceo' || r.by === u.id);
  const names = {}; for (const r of rows) if (!(r.by in names)) { const x = one('SELECT name,role FROM users WHERE id=?', r.by); names[r.by] = x ? (x.role === 'ceo' ? 'CEO' : x.name) : '—'; }
  return { rows: rows.map(r => ({ ...r, who: names[r.by] })) };
};
A['trash.restore'] = (u, b) => {
  const r = one('SELECT * FROM trash WHERE id=?', +b.id); if (!r) bad('Topilmadi');
  need(u.role === 'ceo' || r.by === u.id);
  return tx(() => {
    if (r.kind === 'student') { if (!one('SELECT 1 FROM students WHERE id=?', r.ref_id)) bad('Bu o‘quvchi butunlay o‘chirilgan'); run('UPDATE students SET active=1 WHERE id=?', r.ref_id); }
    else {
      const d = JSON.parse(r.data || '{}');
      if (r.kind === 'school' && one('SELECT 1 FROM schools WHERE num=?', d.schools[0].num)) bad(`${d.schools[0].num}-maktab hozir bor. Avval uni o‘chiring yoki raqamini o‘zgartiring`);
      if (r.kind === 'class') { if (!one('SELECT 1 FROM schools WHERE id=?', d.classes[0].school_id)) bad('Bu sinfning maktabi o‘chirilgan. Avval maktabni qaytaring'); if (one('SELECT 1 FROM classes WHERE school_id=? AND name=?', d.classes[0].school_id, d.classes[0].name)) bad(`${d.classes[0].name} sinfi hozir bor`); }
      if (r.kind === 'itest' && !one('SELECT 1 FROM schools WHERE id=?', d.itests[0].school_id)) bad('Bu sinovning maktabi o‘chirilgan');
      try { putBack(d); } catch (e) { bad('Qaytarib bo‘lmadi: ' + e.message); }
    }
    run('DELETE FROM trash WHERE id=?', r.id); log(u.id, 'savat.qaytarish', { name: r.label, kind: r.kind }); return {};
  });
};
function purgeTrash(id) {
  const r = one('SELECT * FROM trash WHERE id=?', id); if (!r) return;
  tx(() => { if (r.kind === 'student' && one('SELECT 1 FROM students WHERE id=? AND active=0', r.ref_id)) dropStudents([r.ref_id]); run('DELETE FROM trash WHERE id=?', r.id); });
}
A['trash.purge'] = (u, b) => { need(u.role === 'ceo', 'Butunlay o‘chirishni faqat CEO qiladi'); const r = one('SELECT label FROM trash WHERE id=?', +b.id); purgeTrash(+b.id); log(u.id, 'savat.tozalash', { name: r?.label }); return {}; };
setInterval(() => { try { const lim = new Date(Date.now() - 30 * 864e5).toISOString(); for (const r of all('SELECT id FROM trash WHERE at<?', lim)) purgeTrash(r.id); } catch (e) { } }, 6 * 36e5);
const nameKey = n => String(n || '').toLowerCase().replace(/[`‘’'ʻʼ´]/g, "'").replace(/\s+/g, ' ').trim();
A['students.import'] = (u, b) => {
  need(can(u, 'maktab'));
  const num = parseInt(b.school_num, 10); if (!num) bad('Maktab raqamini yozing');
  const rows = Array.isArray(b.rows) ? b.rows : []; if (!rows.length) bad('Faylda o‘quvchi topilmadi');
  return tx(() => {
    let sc = one('SELECT id FROM schools WHERE num=?', num);
    if (!sc) sc = { id: Number(run('INSERT INTO schools(num,created_at) VALUES(?,?)', num, now()).lastInsertRowid) };
    let added = 0, skipped = 0, newCls = 0, results = 0, absents = 0; const bad_ = [];
    const t = b.test_id ? one('SELECT id FROM tests WHERE id=?', b.test_id) : null;
    const withScore = (sid, r) => { const v = String(r.score ?? '').trim(); if (!t || v === '') return;
      if (!can(u, 'kiritish')) return;
      const abs = /^(kelmadi|yo.?q|-)$/i.test(v); try { A['result.save'](u, abs ? { test_id: t.id, student_id: sid, absent: 1 } : { test_id: t.id, student_id: sid, mode: 'ball', score: v }); if (abs) absents++; else results++; } catch (e) { bad_.push(r.name + ': ' + e.message); } };
    for (const r of rows) {
      const name = fixName(r.name, 120).split(' ').slice(0, 2).join(' '); const cn = clsName(r.cls);
      if (name.split(' ').length < 2 || !cn) { skipped++; continue; }
      let c = one('SELECT id FROM classes WHERE school_id=? AND name=?', sc.id, cn);
      if (!c) { c = { id: Number(run('INSERT INTO classes(school_id,name,grade) VALUES(?,?,?)', sc.id, cn, gradeOf(cn)).lastInsertRowid) }; newCls++; }
      const ex = all('SELECT id,phone,name FROM students WHERE class_id=? AND active=1', c.id).find(x => nameKey(x.name) === nameKey(name));
      if (ex) { if (!ex.phone && phone9(r.phone)) run('INSERT OR IGNORE INTO phone_hints(student_id,phone) VALUES(?,?)', ex.id, phone9(r.phone)); skipped++; withScore(ex.id, r); continue; }
      const sid = Number(run('INSERT INTO students(class_id,name,phone,created_at) VALUES(?,?,?,?)', c.id, name, '', now()).lastInsertRowid); added++;
      if (phone9(r.phone)) run('INSERT OR IGNORE INTO phone_hints(student_id,phone) VALUES(?,?)', sid, phone9(r.phone));
      withScore(sid, r);
    }
    log(u.id, 'royxat.import', { num, added, skipped, newCls, results, absents });
    return { added, skipped, newCls, results, absents, errors: bad_ };
  });
};

A['test.save'] = (u, b) => {
  need(can(u, 'maktab'));
  const name = str(b.name); if (!name) bad('Sinov nomini yozing');
  const st = ['tayyor', 'otkazildi', 'tekshiruv', 'yakunlandi'].includes(b.status) ? b.status : 'tayyor';
  const f = [name, str(b.date, 20), st, Math.min(100, Math.max(1, +b.gifted_top || 10)), Math.min(100, Math.max(0, +b.gifted_min || 70))];
  // qamrov: qaysi maktab/sinflarda o'tadi ({s:[maktab], c:[sinf]}; bo'sh — hamma maktablar)
  if (b.scope !== undefined) {
    const sc = b.scope || {}, ss = [...new Set((sc.s || []).map(Number).filter(x => one('SELECT 1 FROM schools WHERE id=?', x)))], cc = [...new Set((sc.c || []).map(Number).filter(x => one('SELECT 1 FROM classes WHERE id=?', x)))];
    const js = ss.length || cc.length ? JSON.stringify({ s: ss, c: cc }) : '';
    if (b.id) run('UPDATE tests SET scope=? WHERE id=?', js, b.id); else b._scope = js;
  }
  if (b.id) { const old = one('SELECT * FROM tests WHERE id=?', b.id); if (st === 'yakunlandi' && !finished(b.id)) bad('Sinovni yakunlash uchun avval “Yakunlash”ni tasdiqlang'); run('UPDATE tests SET name=?,date=?,status=?,gifted_top=?,gifted_min=? WHERE id=?', ...f, b.id); log(u.id, 'sinov.tahrir', { old, new: f }); return { id: b.id }; }
  const r = run('INSERT INTO tests(name,date,status,gifted_top,gifted_min,created_at,scope) VALUES(?,?,?,?,?,?,?)', ...f, now(), b._scope || '');
  log(u.id, 'sinov.qoshish', { name }); return { id: Number(r.lastInsertRowid) };
};
const canKey = u => u.role === 'ceo' || (can(u, 'maktab') && can(u, 'kalit'));
function putKey(testId, g, v, key) {
  if (v && v !== 'A') run('INSERT INTO vkeys(test_id,grade,variant,key) VALUES(?,?,?,?) ON CONFLICT(test_id,grade,variant) DO UPDATE SET key=excluded.key', testId, g, v, key);
  else run('INSERT INTO keys(test_id,grade,key) VALUES(?,?,?) ON CONFLICT(test_id,grade) DO UPDATE SET key=excluded.key', testId, g, key);
}
A['key.save'] = (u, b) => {
  need(canKey(u), 'Kalitni faqat CEO yoki ruxsati bor a‘zo kiritadi');
  const key = String(b.key || '').toUpperCase().replace(/[^A-E]/g, '');
  const g = parseInt(b.grade, 10); if (!g) bad('Sinfni tanlang');
  const v = varOf(b.variant) || 'A';
  if (key.length < 5) bad('Kalit to‘liq emas');
  if (v !== 'A' && !keyFor(b.test_id, g, 'A')) bad('Avval A variant kalitini kiriting');
  if (one('SELECT 1 FROM tlinks WHERE test_id=? AND grade=?', b.test_id, g)) bad('Bu sinfning kaliti bazadagi testdan olingan. Testni almashtirish uchun “Test tanlash”dan foydalaning');
  const old = keyFor(b.test_id, g, v);
  return tx(() => {
    putKey(b.test_id, g, v, key);
    const n = rescoreTest(b.test_id);
    log(u.id, old ? 'kalit.tuzatish' : 'kalit.kiritish', { test_id: b.test_id, grade: g, variant: v, old, new: key, qayta_hisoblandi: n });
    return { rescored: n };
  });
};
// ---------------- testlar bazasi: test nomi bilan saqlanadi, hech bir imtihonga o'zi tegmaydi
function cleanSections(secs) {
  const clean = [];
  for (const sec of secs) {
    const g = parseInt(sec.grade, 10), v = varOf(sec.variant);
    if (!(g >= 1 && g <= 11)) bad('Sinf noto‘g‘ri: ' + sec.grade); if (!v) bad(`${g}-sinf: variant harfi noto‘g‘ri`);
    if (clean.some(x => x.g === g && x.v === v)) bad(`${g}-sinf ${v} variant faylda ikki marta bor`);
    const qs = (Array.isArray(sec.qs) ? sec.qs : []).map((q, i) => {
      const o = (Array.isArray(q.o) ? q.o : []).map(x => str(x, 300));
      const a = String(q.a || '').toUpperCase();
      if (!str(q.q, 2000)) bad(`${g}-sinf ${v}: ${i + 1}-savol matni yo‘q`);
      if (o.length < 2 || o.length > 5 || o.some(x => !x)) bad(`${g}-sinf ${v}: ${i + 1}-savolda javob variantlari to‘liq emas`);
      const ai = 'ABCDE'.indexOf(a); if (ai < 0 || ai >= o.length) bad(`${g}-sinf ${v}: ${i + 1}-savolning to‘g‘ri javobi ko‘rsatilmagan`);
      return { q: String(q.q).trim().slice(0, 2000), o, a };
    });
    if (qs.length < 5 || qs.length > 50) bad(`${g}-sinf ${v}: savollar soni 5 tadan 50 tagacha bo‘lishi kerak (${qs.length} ta)`);
    clean.push({ g, v, qs });
  }
  for (const g of new Set(clean.map(x => x.g))) {
    const vs = clean.filter(x => x.g === g); if (!vs.some(x => x.v === 'A')) bad(`${g}-sinf: A variant bo‘lishi shart`);
    if (new Set(vs.map(x => x.qs.length)).size > 1) bad(`${g}-sinf: hamma variantlarda savollar soni bir xil bo‘lishi kerak`);
  }
  return clean;
}
A['bank.upload'] = (u, b) => {
  need(canKey(u), 'Testni faqat CEO yoki kalit huquqi bor a‘zo yuklaydi');
  const name = str(b.name, 120); if (!name) bad('Test nomini yozing');
  const clean = cleanSections(Array.isArray(b.sections) ? b.sections : []); if (!clean.length) bad('Faylda test topilmadi');
  return tx(() => {
    const ids = [];
    for (const g of [...new Set(clean.map(x => x.g))].sort((a, c) => a - c)) {
      const vs = clean.filter(x => x.g === g).sort((a, c) => a.v.localeCompare(c.v));
      const data = Object.fromEntries(vs.map(x => [x.v, { qs: x.qs }])), keys = Object.fromEntries(vs.map(x => [x.v, x.qs.map(q => q.a).join('')]));
      const nopt = Math.max(4, ...vs.flatMap(x => x.qs.map(q => q.o.length)));
      const r = run('INSERT INTO tbank(name,grade,qn,nopt,data,keys,by,at) VALUES(?,?,?,?,?,?,?,?)', name, g, vs[0].qs.length, nopt, JSON.stringify(data), JSON.stringify(keys), u.id, now());
      ids.push({ id: Number(r.lastInsertRowid), grade: g, variants: vs.map(x => x.v), qn: vs[0].qs.length });
      log(u.id, 'test.bazaga', { name, grade: g, variantlar: vs.map(x => x.v).join(','), savol: vs[0].qs.length });
    }
    return { ok: ids };
  });
};
function bankList() {
  const used = {}; for (const l of all('SELECT l.bank_id,l.test_id,t.name FROM tlinks l JOIN tests t ON t.id=l.test_id')) (used[l.bank_id] ||= []).push({ id: l.test_id, name: l.name });
  return all('SELECT id,name,grade,qn,nopt,keys,at FROM tbank ORDER BY grade,id DESC').map(r => ({ id: r.id, name: r.name, grade: r.grade, qn: r.qn, nopt: r.nopt, variants: Object.keys(JSON.parse(r.keys)), at: r.at, used: used[r.id] || [] }));
}
// test savollari (kitobcha uchun) — kalit kabi maxfiy
A['bank.get'] = (u, b) => {
  need(canKey(u), 'Test savollarini faqat CEO yoki kalit huquqi bor a‘zo ko‘radi');
  const r = one('SELECT * FROM tbank WHERE id=?', +b.id); if (!r) bad('Test topilmadi');
  return { id: r.id, name: r.name, grade: r.grade, qn: r.qn, data: JSON.parse(r.data) };
};
A['bank.delete'] = (u, b) => {
  need(canKey(u));
  const r = one('SELECT * FROM tbank WHERE id=?', +b.id); if (!r) bad('Test topilmadi');
  if (one('SELECT 1 FROM tlinks WHERE bank_id=?', r.id)) bad('Bu test imtihonga berilgan. Avval imtihondan olib tashlang');
  return tx(() => { run('DELETE FROM tbank WHERE id=?', r.id); toTrash(u, 'bank', r.id, r.name, `${r.grade}-sinf · ${r.qn} savol`, null, { tbank: [r] }); log(u.id, 'test.bazadan_ochirish', { name: r.name, grade: r.grade }); return {}; });
};
// imtihonga bazadan test berish: kalitlar shu imtihonga yoziladi. Natija kiritilgan bo'lsa — qulf, hech narsa o'zgarmaydi
A['test.useBank'] = (u, b) => {
  need(canKey(u), 'Testni faqat CEO yoki kalit huquqi bor a‘zo tanlaydi');
  const t = one('SELECT * FROM tests WHERE id=?', +b.test_id); if (!t) bad('Imtihon topilmadi');
  const g = parseInt(b.grade, 10); if (!(g >= 1 && g <= 11)) bad('Sinfni tanlang');
  if (gradeLocked(t.id, g)) bad(`Bu imtihonda ${g}-sinf natijalari kiritilgan — testi qulflangan, almashtirib bo‘lmaydi`);
  const bk = b.bank_id ? one('SELECT * FROM tbank WHERE id=?', +b.bank_id) : null;
  if (b.bank_id && !bk) bad('Test topilmadi'); if (bk && bk.grade !== g) bad(`Bu test ${bk.grade}-sinf uchun`);
  const old = one('SELECT bank_id FROM tlinks WHERE test_id=? AND grade=?', t.id, g);
  return tx(() => {
    run('DELETE FROM vkeys WHERE test_id=? AND grade=?', t.id, g); run('DELETE FROM keys WHERE test_id=? AND grade=?', t.id, g); run('DELETE FROM tlinks WHERE test_id=? AND grade=?', t.id, g);
    if (bk) {
      for (const [v, key] of Object.entries(JSON.parse(bk.keys))) putKey(t.id, g, v, key);
      run('INSERT INTO tlinks(test_id,grade,bank_id,by,at) VALUES(?,?,?,?,?)', t.id, g, bk.id, u.id, now());
    }
    log(u.id, 'imtihon.test', { test_id: t.id, imtihon: t.name, grade: g, eski: old?.bank_id || null, yangi: bk ? bk.name : null });
    return {};
  });
};
A['result.save'] = (u, b) => {
  need(can(u, 'kiritish'));
  const t = one('SELECT * FROM tests WHERE id=?', b.test_id); if (!t) bad('Sinov topilmadi');
  const s = one('SELECT s.id,c.grade,c.school_id FROM students s JOIN classes c ON c.id=s.class_id WHERE s.id=?', b.student_id); if (!s) bad('O‘quvchi topilmadi');
  const old = one('SELECT * FROM results WHERE test_id=? AND student_id=?', t.id, s.id);
  if (old && old.entered_by !== u.id) need(can(u, 'tuzatish'), 'Bu natijani boshqa a‘zo kiritgan. Tuzatish huquqi kerak');
  if (announced(t.id, s.school_id)) need(can(u, 'tuzatish'), 'Maktab natijalari e‘lon qilingan. Tuzatish huquqi kerak');
  const absent = b.absent ? 1 : 0;
  const mode = ['harf', 'ball'].includes(b.mode) ? b.mode : 'belgi';
  const variant = varOf(b.variant);
  if (variant && variant !== 'A' && !keyFor(t.id, s.grade, variant)) bad(`${s.grade}-sinf uchun ${variant} variant kaliti yo‘q`);
  let sc;
  if (absent) sc = { answers: '', bits: '', score: 0, qn: 20 };
  else if (mode === 'ball') { // faqat umumiy ball (qo'lda hisoblangan varaqlar)
    const qn = keyFor(t.id, s.grade, variant)?.length || 20; const v = parseInt(b.score, 10);
    if (!(v >= 0 && v <= qn)) bad(`Ball 0 dan ${qn} gacha bo‘lishi kerak`);
    sc = { answers: '', bits: '', score: v, qn };
  } else sc = score(t.id, s.grade, mode, b.answers, b.bits, variant);
  run(`INSERT INTO results(test_id,student_id,absent,mode,answers,bits,score,qn,entered_by,at,variant) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(test_id,student_id) DO UPDATE SET absent=excluded.absent,mode=excluded.mode,answers=excluded.answers,bits=excluded.bits,
    score=excluded.score,qn=excluded.qn,entered_by=excluded.entered_by,at=excluded.at,variant=excluded.variant`,
    t.id, s.id, absent, mode, sc.answers, sc.bits, sc.score, sc.qn, u.id, now(), absent ? '' : variant);
  if (old) log(u.id, 'natija.tuzatish', { student_id: s.id, test_id: t.id, old: { absent: old.absent, score: old.score, bits: old.bits, answers: old.answers }, new: { absent, ...sc } });
  else log(u.id, 'natija.kiritish', { student_id: s.id, test_id: t.id, absent, score: sc.score, ...(b.src === 'skaner' ? { skaner: 1 } : {}) });
  return { score: sc.score, qn: sc.qn };
};
// Maktab yoki sinfda natijasi hali kiritilmagan hamma bolani bir bosishda "kelmadi" qilish
A['results.absentRest'] = (u, b) => {
  need(can(u, 'kiritish'));
  const t = one('SELECT * FROM tests WHERE id=?', b.test_id); if (!t) bad('Sinov topilmadi');
  const cid = +b.class_id || 0, sid = +b.school_id || 0; if (!cid && !sid) bad('Maktab yoki sinf tanlanmagan');
  let sc = null; try { sc = t.scope ? JSON.parse(t.scope) : null; } catch (e) { }
  const list = all(`SELECT s.id,c.school_id,c.id cid FROM students s JOIN classes c ON c.id=s.class_id
    WHERE s.active=1 AND ${cid ? 'c.id=?' : 'c.school_id=?'}
    AND NOT EXISTS (SELECT 1 FROM results r WHERE r.test_id=? AND r.student_id=s.id)`, cid || sid, t.id)
    .filter(x => !sc || sc.s.includes(x.school_id) || sc.c.includes(x.cid)); // imtihon qamrovidan tashqaridagilar "kelmadi" bo'lmaydi
  if (!list.length) return { n: 0 };
  if (announced(t.id, list[0].school_id)) need(can(u, 'tuzatish'), 'Maktab natijalari e‘lon qilingan. Tuzatish huquqi kerak');
  tx(() => {
    for (const s of list) run(`INSERT INTO results(test_id,student_id,absent,mode,answers,bits,score,qn,entered_by,at) VALUES(?,?,1,'belgi','','',0,20,?,?)
      ON CONFLICT(test_id,student_id) DO NOTHING`, t.id, s.id, u.id, now());
  });
  log(u.id, 'natija.kelmadi_hammasi', { test_id: t.id, school_id: sid || list[0].school_id, class_id: cid || null, soni: list.length });
  return { n: list.length };
};
A['result.delete'] = (u, b) => {
  const old = one('SELECT * FROM results WHERE test_id=? AND student_id=?', b.test_id, b.student_id); if (!old) return {};
  need(can(u, 'tuzatish') || (old.entered_by === u.id && can(u, 'kiritish')));
  run('DELETE FROM results WHERE id=?', old.id); log(u.id, 'natija.ochirish', { old }); return {};
};
A['results.import'] = (u, b) => { // bulk import (e.g. from the temporary entry page)
  need(u.role === 'ceo');
  const rows = Array.isArray(b.rows) ? b.rows : [];
  let ok = 0; const miss = [];
  tx(() => {
    for (const r of rows) {
      const st = all(`SELECT s.id,s.name FROM students s JOIN classes c ON c.id=s.class_id JOIN schools sc ON sc.id=c.school_id
        WHERE sc.num=? AND c.name=? AND s.active=1`, r.school, clsName(r.cls)).find(x => nameKey(x.name) === nameKey(str(r.name, 120).split(' ').slice(0, 2).join(' ')));
      if (!st) { miss.push(r.name + ' (' + r.school + '-maktab, ' + r.cls + ')'); continue; }
      A['result.save'](u, { test_id: b.test_id, student_id: st.id, absent: r.absent, mode: r.mode, bits: r.bits, answers: r.answers, score: r.score }); ok++;
    }
  });
  return { ok, miss };
};

A['approve'] = (u, b) => {
  need(u.role === 'ceo' || perms(u).sardor, 'Faqat CEO va jamoa sardori tasdiqlaydi');
  if (b.school_id === 0) { // finishing the whole test needs every school with results announced
    const pend = all(`SELECT DISTINCT c.school_id id FROM results r JOIN students s ON s.id=r.student_id JOIN classes c ON c.id=s.class_id WHERE r.test_id=?`, b.test_id).filter(x => !announced(b.test_id, x.id));
    if (pend.length) bad('Avval hamma maktab natijalari e‘lon qilinishi kerak');
  }
  run('INSERT OR IGNORE INTO approvals(test_id,school_id,user_id,at) VALUES(?,?,?,?)', b.test_id, b.school_id, u.id, now());
  let st = approvedState(b.test_id, b.school_id);
  if (st.ceo && st.sardor && !st.done) { run('INSERT OR IGNORE INTO announcements(test_id,school_id,at) VALUES(?,?,?)', b.test_id, b.school_id, now()); st = approvedState(b.test_id, b.school_id); }
  if (b.school_id === 0 && st.done) { run("UPDATE tests SET status='yakunlandi' WHERE id=?", b.test_id); assignCerts(b.test_id); }
  if (b.school_id && st.done) { assignCerts(b.test_id, b.school_id); notifyAnnounce(b.test_id, b.school_id); }
  log(u.id, b.school_id ? 'elon.tasdiq' : 'yakunlash.tasdiq', { test_id: b.test_id, school_id: b.school_id, done: st.done });
  return st;
};
A['unapprove'] = (u, b) => {
  need(u.role === 'ceo' || perms(u).sardor);
  run('DELETE FROM approvals WHERE test_id=? AND school_id=? AND user_id=?', b.test_id, b.school_id, u.id);
  if (u.role === 'ceo' && b.school_id) run('DELETE FROM certificates WHERE test_id=? AND student_id IN (SELECT s.id FROM students s JOIN classes c ON c.id=s.class_id WHERE c.school_id=?)', b.test_id, b.school_id);
  if (u.role === 'ceo') { run('DELETE FROM announcements WHERE test_id=? AND school_id=?', b.test_id, b.school_id); if (b.school_id === 0) run("UPDATE tests SET status='tekshiruv' WHERE id=?", b.test_id); }
  log(u.id, 'tasdiq.bekor', { test_id: b.test_id, school_id: b.school_id }); return approvedState(b.test_id, b.school_id);
};

// PINs: only the CEO issues; list is visible with the 'pinlar' right, PIN digits with 'pin_korish'
function pinTargets() {
  const users = all('SELECT id,role,name,phone,pin,pin_at,school_id,class_id,active,last_login FROM users WHERE role!=\'ceo\'');
  const list = [];
  for (const s of all('SELECT * FROM schools ORDER BY num')) {
    const us = users.find(x => x.role === 'direktor' && x.school_id === s.id && x.active);
    list.push({ kind: 'direktor', ref: s.id, school_id: s.id, name: s.director_name || (s.num + '-maktab direktori'), phone: s.director_phone, user: us || null });
  }
  for (const c of all('SELECT c.*,s.num FROM classes c JOIN schools s ON s.id=c.school_id ORDER BY s.num,c.grade,c.name')) {
    const us = users.find(x => x.role === 'rahbar' && x.class_id === c.id && x.active);
    list.push({ kind: 'rahbar', ref: c.id, school_id: c.school_id, class_id: c.id, name: c.teacher_name || (c.num + '-maktab ' + c.name + ' sinf rahbari'), phone: c.teacher_phone, user: us || null });
  }
  const byPhone = {};
  for (const s of all('SELECT s.id,s.name,s.phone,s.class_id,c.school_id,c.name cls FROM students s JOIN classes c ON c.id=s.class_id WHERE s.active=1')) {
    const p = phone9(s.phone);
    if (!p) { list.push({ kind: 'ota', ref: 'no' + s.id, school_id: s.school_id, class_id: s.class_id, name: s.name + ' ota-onasi', phone: '', kids: [s.name], user: null }); continue; }
    (byPhone[p] ||= { kind: 'ota', ref: p, school_id: s.school_id, class_id: s.class_id, name: '', phone: p, kids: [] }).kids.push(s.name);
  }
  for (const s of all('SELECT sp.phone,s.name,s.class_id,c.school_id FROM student_phones sp JOIN students s ON s.id=sp.student_id JOIN classes c ON c.id=s.class_id WHERE s.active=1')) {
    const o = (byPhone[s.phone] ||= { kind: 'ota', ref: s.phone, school_id: s.school_id, class_id: s.class_id, name: '', phone: s.phone, kids: [] });
    if (!o.kids.includes(s.name)) o.kids.push(s.name);
  }
  for (const [p, o] of Object.entries(byPhone)) { o.name = o.kids.join(', ') + ' ota-onasi'; o.user = users.find(x => x.role === 'ota' && phone9(x.phone) === p && x.active) || null; list.push(o); }
  for (const t of users.filter(x => x.role === 'jamoa' && x.active)) list.push({ kind: 'jamoa', ref: t.id, name: t.name, phone: t.phone, user: t });
  return list;
}
A['pins'] = u => {
  need(can(u, 'pinlar'));
  const show = can(u, 'pin_korish');
  return { list: pinTargets().map(x => ({ ...x, user: x.user ? { id: x.user.id, pin: show ? x.user.pin : (x.user.pin ? '••••••' : ''), pin_at: x.user.pin_at, last_login: x.user.last_login } : null })) };
};
A['pin.issue'] = (u, b) => {
  need(u.role === 'ceo', 'PIN‘ni faqat CEO beradi');
  const t = pinTargets().find(x => x.kind === b.kind && String(x.ref) === String(b.ref)); if (!t) bad('Topilmadi');
  if (t.kind === 'ota' && !t.phone) bad('Ota-onaning telefon raqami kerak');
  return ensurePin(t, u.id, true);
};
function ensurePin(t, by, renew) {
  if (t.user && t.user.pin && !renew) return { pin: t.user.pin, name: t.name, phone: t.phone, kind: t.kind };
  const pin = newPin();
  if (t.user) run('UPDATE users SET pin=?,pin_at=?,phone=?,name=? WHERE id=?', pin, now(), t.phone || t.user.phone, t.name, t.user.id);
  else run('INSERT INTO users(role,name,phone,pin,pin_at,school_id,class_id,created_at) VALUES(?,?,?,?,?,?,?,?)', t.kind, t.name, t.phone || '', pin, now(), t.school_id || null, t.class_id || null, now());
  log(by, t.user ? 'pin.yangilash' : 'pin.berish', { kind: t.kind, name: t.name, bot: by == null });
  return { pin, name: t.name, phone: t.phone, kind: t.kind };
}
A['pin.revoke'] = (u, b) => {
  need(u.role === 'ceo'); const t = one('SELECT * FROM users WHERE id=? AND role!=\'ceo\'', b.user_id); if (!t) bad('Topilmadi');
  run('UPDATE users SET pin=NULL WHERE id=?', t.id); run('DELETE FROM sessions WHERE user_id=?', t.id);
  log(u.id, 'pin.ochirish', { name: t.name, role: t.role }); return {};
};
A['team.save'] = (u, b) => {
  need(u.role === 'ceo', 'Jamoani faqat CEO boshqaradi');
  const name = fixName(b.name, 80); if (!name) bad('Ismni yozing');
  const p = {}; for (const k of PERMS) p[k] = !!b.perms?.[k]; p.sardor = !!b.perms?.sardor;
  if (b.id) { const old = one('SELECT * FROM users WHERE id=? AND role=\'jamoa\'', b.id); run('UPDATE users SET name=?,phone=?,perms=? WHERE id=?', name, phone9(b.phone), JSON.stringify(p), b.id); log(u.id, 'jamoa.huquq', { name, old: old && JSON.parse(old.perms), new: p }); return { id: b.id }; }
  const pin = newPin();
  const r = run("INSERT INTO users(role,name,phone,perms,pin,pin_at,created_at) VALUES('jamoa',?,?,?,?,?,?)", name, phone9(b.phone), JSON.stringify(p), pin, now(), now());
  log(u.id, 'jamoa.qoshish', { name, perms: p }); return { id: Number(r.lastInsertRowid), pin };
};
A['team.remove'] = (u, b) => {
  need(u.role === 'ceo'); const t = one("SELECT * FROM users WHERE id=? AND role='jamoa'", b.id); if (!t) bad('Topilmadi');
  run('UPDATE users SET active=0,pin=NULL WHERE id=?', t.id); run('DELETE FROM sessions WHERE user_id=?', t.id);
  log(u.id, 'jamoa.chiqarish', { name: t.name }); return {};
};
A['note.save'] = (u, b) => {
  need(isTeam(u)); const text = str(b.text, 2000); if (!text) bad('Izoh bo‘sh');
  if (b.id) { const n = one('SELECT * FROM notes WHERE id=?', b.id); need(n && n.user_id === u.id, 'Faqat o‘z izohingizni o‘zgartirasiz'); run('UPDATE notes SET text=?,at=? WHERE id=?', text, now(), b.id); return {}; }
  run('INSERT INTO notes(student_id,user_id,text,at) VALUES(?,?,?,?)', b.student_id, u.id, text, now()); return {};
};
A['note.summary'] = (u, b) => { need(u.role === 'ceo' || perms(u).sardor); const n = one('SELECT student_id FROM notes WHERE id=?', b.id); run('UPDATE notes SET summary=0 WHERE student_id=?', n.student_id); run('UPDATE notes SET summary=1 WHERE id=?', b.id); return {}; };
A['audit'] = (u, b) => {
  need(can(u, 'tarix'));
  const rows = b.student_id ? all("SELECT * FROM audit WHERE detail LIKE ? ORDER BY id DESC LIMIT 200", '%"student_id":' + (+b.student_id) + '%')
    : all('SELECT * FROM audit ORDER BY id DESC LIMIT ? OFFSET ?', Math.min(100, Math.max(1, +b.limit || 100)), (+b.offset || 0));
  const who = {}; for (const r of rows) if (!(r.user_id in who)) { const x = one('SELECT name,role FROM users WHERE id=?', r.user_id); who[r.user_id] = x ? (x.role === 'ceo' ? 'CEO' : x.role === 'direktor' ? 'Direktor ' + (x.name || '').split(' ')[0] : x.role === 'rahbar' ? 'Ustoz ' + (x.name || '').split(' ')[0] : (x.name || '').split(' ')[0]) : '—'; }
  return { rows: rows.map(r => ({ ...r, who: who[r.user_id], detail: JSON.parse(r.detail || '{}') })) };
};

// ================================================================ v2: parents' phones, settings, messages, bot, certificates, exercises
const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10); // Toshkent vaqti
const getSet = k => one('SELECT value FROM settings WHERE key=?', k)?.value ?? '';
const setSet = (k, v) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v ?? ''));
const siteUrl = () => getSet('site_url') || 'https://yoshxorazmiylar.uz';
const DEFAULT_TEXTS = {
  tabrik_ota: 'Hurmatli ota-ona! Farzandingiz {ism} "Yosh Xorazmiylar" sinovida {ball} ball ({foiz}%) to‘plab, iqtidorli o‘quvchilar qatoridan joy oldi. Tabriklaymiz! Hurmat bilan, KARAKUL INTERNATIONAL SCHOOL jamoasi',
  tabrik_rahbar: 'Hurmatli ustoz! Sinfingizdan {soni} nafar o‘quvchi "Yosh Xorazmiylar" sinovida iqtidorli deb topildi. Mehnatingiz uchun rahmat! Hurmat bilan, KARAKUL INTERNATIONAL SCHOOL jamoasi',
  tabrik_direktor: 'Hurmatli direktor! Maktabingizdan {soni} nafar o‘quvchi "Yosh Xorazmiylar" sinovida iqtidorli deb topildi. Hamkorligingiz uchun rahmat! Hurmat bilan, KARAKUL INTERNATIONAL SCHOOL jamoasi',
};
const text = k => getSet(k) || DEFAULT_TEXTS[k] || '';

function kidsOfPhone(p) {
  if (!p) return [];
  const a = all('SELECT id,phone FROM students WHERE active=1').filter(s => phone9(s.phone) === p).map(s => s.id);
  const b = all('SELECT sp.student_id id FROM student_phones sp JOIN students s ON s.id=sp.student_id WHERE s.active=1 AND sp.phone=?', p).map(r => r.id);
  return [...new Set([...a, ...b])];
}
const studentInfo = id => one(`SELECT s.id,s.name,s.class_id,c.name cls,c.grade,c.school_id,sc.num FROM students s JOIN classes c ON c.id=s.class_id JOIN schools sc ON sc.id=c.school_id WHERE s.id=?`, id);
const parentsOf = sid => all("SELECT * FROM users WHERE role='ota' AND active=1").filter(x => kidsOfPhone(phone9(x.phone)).includes(sid));
const rahbarsOf = classId => all("SELECT * FROM users WHERE role='rahbar' AND active=1 AND class_id=?", classId);
const ceoId = () => one("SELECT id FROM users WHERE role='ceo'").id;
const directorsOf = schoolId => all("SELECT * FROM users WHERE role='direktor' AND active=1 AND school_id=?", schoolId);
const rahbarsOfSchool = schoolId => all("SELECT u.* FROM users u JOIN classes c ON c.id=u.class_id WHERE u.role='rahbar' AND u.active=1 AND c.school_id=?", schoolId);
const kidInSchool = (u, schoolId, classId) => kidsOfPhone(phone9(u.phone)).some(id => { const x = one('SELECT s.class_id,c.school_id FROM students s JOIN classes c ON c.id=s.class_id WHERE s.id=?', id); return x && x.school_id === schoolId && (!classId || x.class_id === classId); });
// Ro'yxatdan (Excel) kelgan ota-ona raqamlariga ishonilmaydi: ular faqat "tekshirilmagan taklif" bo'lib turadi.
// Haqiqiy raqamni sinf rahbari yoki jamoa qo'lda kiritadi (yoki sinf rahbari bot so'rovini tasdiqlaydi).
const MAX_KIDS = 4;
function checkPhone(p, sid) {
  if (!p) return;
  const k = kidsOfPhone(p).filter(id => id !== sid);
  if (k.length >= MAX_KIDS) bad(`Bu raqam allaqachon ${k.length} ta bolaga yozilgan. Bitta ota-onada bunchalik farzand kam bo‘ladi, raqamni tekshiring.`);
}
if (!getSet('phones_reset_v1')) tx(() => {
  for (const r of all("SELECT student_id,phone FROM tg_requests WHERE status='tasdiqlandi' AND student_id IS NOT NULL"))
    if (phone9(r.phone)) run('INSERT OR IGNORE INTO student_phones(student_id,phone) VALUES(?,?)', r.student_id, phone9(r.phone));
  let moved = 0;
  for (const st of all("SELECT id,phone FROM students WHERE phone IS NOT NULL AND phone!=''")) {
    const p = phone9(st.phone); if (!p) continue;
    run('INSERT OR REPLACE INTO phone_hints(student_id,phone) VALUES(?,?)', st.id, p); moved++;
  }
  run("UPDATE students SET phone=''");
  // tasdiqlanmagan raqam bilan PIN olgan ota-onalar o'chiriladi (PIN'i ishlamay qoladi)
  let off = 0;
  for (const x of all("SELECT id,phone FROM users WHERE role='ota' AND active=1"))
    if (!kidsOfPhone(phone9(x.phone)).length) { run('UPDATE users SET active=0 WHERE id=?', x.id); run('DELETE FROM sessions WHERE user_id=?', x.id); off++; }
  setSet('phones_reset_v1', now());
  log(one("SELECT id FROM users WHERE role='ceo'")?.id || 0, 'telefon.tozalash', { moved, off });
});
const hintsMap = () => Object.fromEntries(all('SELECT student_id,phone FROM phone_hints').map(r => [r.student_id, r.phone]));
const extraPhones = sid => all('SELECT phone FROM student_phones WHERE student_id=?', sid).map(r => r.phone);
// sinf rahbari (o'z sinfi) yoki jamoa ota-ona telefonini kiritadi
A['student.phone'] = (u, b) => {
  const s = one('SELECT * FROM students WHERE id=? AND active=1', +b.id); if (!s) bad('O‘quvchi topilmadi');
  need(ownsSchool(u, schoolOfStudent(s.id)) || (u.role === 'rahbar' && u.class_id === s.class_id));
  const raw = String(b.phone || '').trim(); const p = phone9(raw);
  if (raw && !p) bad('Telefon raqamini to‘liq yozing (masalan, 90 123 45 67)');
  checkPhone(p, s.id);
  run('UPDATE students SET phone=? WHERE id=?', p, s.id);
  if (b.remove_extra) run('DELETE FROM student_phones WHERE student_id=? AND phone=?', s.id, phone9(b.remove_extra));
  run('DELETE FROM phone_hints WHERE student_id=?', s.id);
  log(u.id, 'oquvchi.telefon', { id: s.id, old: s.phone, new: p });
  return {};
};

// ---------------------------------------------------------------- extras for state
// ---------------------------------------------------------------- maktab ichki sinovlari (reytingga qo'shilmaydi)
function itestsFor(u, out) {
  if (isTeam(u)) return { itests: all('SELECT * FROM itests ORDER BY day DESC,id DESC'), iresults: all('SELECT itest_id,student_id,score,absent FROM iresults') };
  const sIds = new Set((out.students || []).map(s => s.id));
  const schools = [...new Set((out.classes || []).map(c => c.school_id))];
  if (!schools.length) return { itests: [], iresults: [] };
  const its = all(`SELECT * FROM itests WHERE school_id IN (${schools.map(() => '?').join(',')}) ORDER BY day DESC,id DESC`, ...schools);
  const ids = its.map(t => t.id);
  const res = ids.length ? all(`SELECT itest_id,student_id,score,absent FROM iresults WHERE itest_id IN (${ids.map(() => '?').join(',')})`, ...ids).filter(r => sIds.has(r.student_id)) : [];
  return { itests: u.role === 'ota' ? its.filter(t => res.some(r => r.itest_id === t.id)) : its, iresults: res };
}
const canItest = (u, schoolId) => ownsSchool(u, schoolId);
A['itest.save'] = (u, b) => {
  const sid = u.role === 'direktor' ? u.school_id : +b.school_id;
  need(canItest(u, sid));
  const name = str(b.name, 120); if (!name) bad('Sinov nomini yozing');
  const qn = parseInt(b.qn, 10); if (!(qn >= 1 && qn <= 100)) bad('Savollar (yoki eng yuqori ball) soni 1 dan 100 gacha');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day)) ? b.day : now().slice(0, 10);
  let grade = parseInt(b.grade, 10) || 0; const subject = str(b.subject, 60);
  const classId = +b.class_id || null; // bitta sinf uchun sinov
  if (classId) { const c = one('SELECT school_id,grade FROM classes WHERE id=?', classId); need(c && c.school_id === sid, 'Sinf shu maktabniki emas'); grade = c.grade; }
  if (b.id) {
    const t = one('SELECT * FROM itests WHERE id=?', +b.id); if (!t) bad('Sinov topilmadi'); need(canItest(u, t.school_id));
    run('UPDATE itests SET name=?,day=?,qn=?,grade=?,subject=?,class_id=? WHERE id=?', name, day, qn, grade, subject, classId, t.id);
    log(u.id, 'ichki.tahrir', { id: t.id, name }); return { id: t.id };
  }
  const r = run('INSERT INTO itests(school_id,name,day,qn,grade,subject,class_id,by,at) VALUES(?,?,?,?,?,?,?,?,?)', sid, name, day, qn, grade, subject, classId, u.id, now());
  log(u.id, 'ichki.yaratish', { school_id: sid, name }); return { id: Number(r.lastInsertRowid) };
};
A['itest.delete'] = (u, b) => {
  const t = one('SELECT * FROM itests WHERE id=?', +b.id); if (!t) return {}; need(canItest(u, t.school_id));
  tx(() => { const d = { itests: [t], iresults: all('SELECT * FROM iresults WHERE itest_id=?', t.id) }; run('DELETE FROM iresults WHERE itest_id=?', t.id); run('DELETE FROM itests WHERE id=?', t.id);
    toTrash(u, 'itest', t.id, t.name, `${(one('SELECT num FROM schools WHERE id=?', t.school_id) || {}).num}-maktab · ichki sinov · ${d.iresults.length} ta ball`, t.school_id, d); });
  log(u.id, 'ichki.ochirish', { id: t.id, name: t.name }); return {};
};
// ball kiritish: direktor (o'z maktabi), sinf rahbari (o'z sinfi), jamoa (maktab huquqi)
A['iresult.save'] = (u, b) => {
  const t = one('SELECT * FROM itests WHERE id=?', +b.itest_id); if (!t) bad('Sinov topilmadi');
  const st = one('SELECT s.id,s.class_id,c.school_id FROM students s JOIN classes c ON c.id=s.class_id WHERE s.id=? AND s.active=1', +b.student_id); if (!st) bad('O‘quvchi topilmadi');
  need(st.school_id === t.school_id && (canItest(u, t.school_id) || (u.role === 'rahbar' && u.class_id === st.class_id)));
  if (b.clear) { run('DELETE FROM iresults WHERE itest_id=? AND student_id=?', t.id, st.id); return {}; }
  const absent = b.absent ? 1 : 0; let score = null;
  if (!absent) { score = parseInt(b.score, 10); if (!(score >= 0 && score <= t.qn)) bad(`Ball 0 dan ${t.qn} gacha bo‘lishi kerak`); }
  run(`INSERT INTO iresults(itest_id,student_id,score,absent,by,at) VALUES(?,?,?,?,?,?) ON CONFLICT(itest_id,student_id) DO UPDATE SET score=excluded.score,absent=excluded.absent,by=excluded.by,at=excluded.at`, t.id, st.id, score, absent, u.id, now());
  return {};
};
function extras(u, out) {
  const ex = { ...itestsFor(u, out), texts: { tabrik_ota: text('tabrik_ota'), tabrik_rahbar: text('tabrik_rahbar'), tabrik_direktor: text('tabrik_direktor') } };
  ex.bot = getSet('bot_username');
  ex.school = { name: getSet('sch_name') || 'KARAKUL INTERNATIONAL SCHOOL', about: getSet('sch_about'), address: getSet('sch_address') || 'Qorako‘l tumani, Buxoro viloyati',
    phone: getSet('sch_phone'), telegram: getSet('sch_telegram'), instagram: getSet('sch_instagram'), facebook: getSet('sch_facebook'), youtube: getSet('sch_youtube'), site: getSet('sch_site') };
  ex.assetsReady = !!(getSet('logo') && getSet('imzo') && getSet('muhr'));
  const vis = visibleThreads(u);
  ex.unread = vis.filter(t => !(isTeam(u) && (t.kind === 'ota' || t.kind === 'sinf'))).reduce((n, t) => n + t.unread, 0);
  const sIds = new Set((out.students || []).map(s => s.id));
  ex.certs = all('SELECT code,test_id,student_id FROM certificates').filter(c => isTeam(u) || sIds.has(c.student_id));
  if (isTeam(u) && can(u, 'pinlar')) ex.tgPending = one("SELECT count(*) n FROM tg_requests WHERE status='kutilmoqda'").n;
  if (u.role === 'rahbar') ex.tgPending = one("SELECT count(*) n FROM tg_requests WHERE status='kutilmoqda' AND class_id=?", u.class_id).n;
  if (u.role === 'ota') {
    const grades = [...new Set((out.classes || []).map(c => c.grade))];
    ex.exNew = grades.length ? all(`SELECT id,grade FROM exercises WHERE day<=? AND grade IN (${grades.map(() => '?').join(',')})`, today(), ...grades)
      .filter(e => (out.students || []).some(s => out.classes.find(c => c.id === s.class_id)?.grade === e.grade && !one('SELECT 1 FROM ex_answers WHERE exercise_id=? AND student_id=?', e.id, s.id))).length : 0;
  }
  return ex;
}

// ---------------------------------------------------------------- telegram
const TG_API = process.env.TG_API || 'https://api.telegram.org';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function tg(method, body) {
  const token = getSet('bot_token'); if (!token) return null;
  try {
    const r = await fetch(`${TG_API}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    return await r.json();
  } catch (e) { return null; }
}
const tgSend = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, disable_web_page_preview: true, ...extra });
const chatsOfPhone = p => p ? all('SELECT chat_id FROM tg_users WHERE phone=?', p).map(r => r.chat_id) : [];
function notifyUsers(userIds, msg) {
  const seen = new Set();
  for (const id of userIds) {
    const x = one('SELECT role,phone FROM users WHERE id=? AND active=1', id); if (!x) continue;
    const p = x.role === 'ceo' ? phone9(getSet('ceo_phone')) : phone9(x.phone);
    for (const c of chatsOfPhone(p)) if (!seen.has(c)) { seen.add(c); tgSend(c, msg); }
  }
}
function notifyAnnounce(testId, schoolId) {
  const t = one('SELECT name FROM tests WHERE id=?', testId);
  const kids = all('SELECT s.id,s.name,s.phone FROM students s JOIN classes c ON c.id=s.class_id WHERE c.school_id=? AND s.active=1', schoolId);
  const byChat = {};
  for (const k of kids) {
    const phones = new Set([phone9(k.phone), ...all('SELECT phone FROM student_phones WHERE student_id=?', k.id).map(r => r.phone)].filter(Boolean));
    for (const p of phones) for (const c of chatsOfPhone(p)) (byChat[c] ||= []).push(k.name);
  }
  for (const [c, names] of Object.entries(byChat))
    tgSend(c, `Assalomu alaykum! "${t.name}" sinovi natijalari e‘lon qilindi.\n${names.join(', ')} natijasini ko‘rish: ${siteUrl()}`);
  const staff = all("SELECT id FROM users WHERE active=1 AND ((role='direktor' AND school_id=?) OR (role='rahbar' AND class_id IN (SELECT id FROM classes WHERE school_id=?)))", schoolId, schoolId).map(r => r.id);
  notifyUsers(staff, `"${t.name}" sinovi natijalari e‘lon qilindi. Ko‘rish: ${siteUrl()}`);
}
function grantByPhone(p) {
  if (!p) return [];
  const got = [];
  for (const t of pinTargets()) {
    if (phone9(t.phone) !== p) continue;
    if (t.kind === 'jamoa') { if (t.user?.pin) got.push({ pin: t.user.pin, name: t.name, kind: 'jamoa' }); continue; }
    got.push(ensurePin(t, null, false));
  }
  return got;
}
const ROLE_UZ = { ota: 'Ota-ona', rahbar: 'Sinf rahbari', direktor: 'Direktor', jamoa: 'Jamoa a‘zosi' };
function pinMessage(got) {
  return 'Sizning PIN kodingiz:\n\n' + got.map(g => `${ROLE_UZ[g.kind] || ''} — ${g.name}\nPIN: ${g.pin}`).join('\n\n') +
    `\n\nSaytga kirish: ${siteUrl()}\nPIN kodni hech kimga bermang.`;
}
const CONTACT_KB = { reply_markup: { keyboard: [[{ text: '📱 Telefon raqamni yuborish', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } };
const NO_KB = { reply_markup: { remove_keyboard: true } };
const tgState = new Map();
async function onUpdate(up) {
  const cb = up.callback_query;
  if (cb) {
    const chat = String(cb.message.chat.id); tg('answerCallbackQuery', { callback_query_id: cb.id });
    const st = tgState.get(chat); if (!st) return;
    const [k, v] = String(cb.data).split(':');
    if (k === 'sc') {
      const cls = all('SELECT id,name FROM classes WHERE school_id=? ORDER BY grade,name', +v);
      const rows = []; for (let i = 0; i < cls.length; i += 4) rows.push(cls.slice(i, i + 4).map(c => ({ text: c.name, callback_data: 'cl:' + c.id })));
      return tgSend(chat, 'Sinfni tanlang:', { reply_markup: { inline_keyboard: rows } });
    }
    if (k === 'cl') { st.class_id = +v; st.step = 'child'; return tgSend(chat, 'Farzandingizning familiyasi va ismini yozing (masalan: Karimov Jasur):'); }
    return;
  }
  const m = up.message; if (!m || m.chat.type !== 'private') return;
  const chat = String(m.chat.id);
  if (m.contact) {
    if (m.contact.user_id !== m.from.id) return tgSend(chat, 'Iltimos, o‘zingizning raqamingizni pastdagi tugma orqali yuboring.', CONTACT_KB);
    const p = phone9(m.contact.phone_number);
    run('INSERT INTO tg_users(chat_id,phone,at) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET phone=excluded.phone,at=excluded.at', chat, p, now());
    const got = grantByPhone(p);
    if (got.length) return tgSend(chat, pinMessage(got), NO_KB);
    const schools = all('SELECT id,num FROM schools ORDER BY num');
    tgState.set(chat, { step: 'school', phone: p });
    const rows = []; for (let i = 0; i < schools.length; i += 4) rows.push(schools.slice(i, i + 4).map(s => ({ text: s.num + '-maktab', callback_data: 'sc:' + s.id })));
    await tgSend(chat, 'Raqamingiz ro‘yxatda topilmadi. Bu holda sinf rahbari tasdiqlaydi.', NO_KB);
    return tgSend(chat, 'Farzandingiz o‘qiydigan maktabni tanlang:', { reply_markup: { inline_keyboard: rows } });
  }
  const txt = String(m.text || '').trim();
  const st = tgState.get(chat);
  if (st?.step === 'child' && txt && !txt.startsWith('/')) {
    tgState.delete(chat);
    run('INSERT INTO tg_requests(chat_id,phone,class_id,child,at) VALUES(?,?,?,?,?)', chat, st.phone, st.class_id, str(txt, 100), now());
    const c = one('SELECT c.name,s.num FROM classes c JOIN schools s ON s.id=c.school_id WHERE c.id=?', st.class_id);
    notifyUsers(rahbarsOf(st.class_id).map(r => r.id), `Yangi so‘rov: ${str(txt, 100)} (${c.num}-maktab, ${c.name}) ota-onasi PIN so‘ramoqda. Tasdiqlash: ${siteUrl()}`);
    return tgSend(chat, `So‘rovingiz ${c.num}-maktab ${c.name} sinf rahbariga yuborildi. Tasdiqlangach, PIN kodingiz shu yerga keladi.`);
  }
  const linked = one('SELECT phone FROM tg_users WHERE chat_id=?', chat);
  if (linked && (txt === '/pin' || txt.startsWith('/start'))) {
    const got = grantByPhone(linked.phone);
    if (got.length) return tgSend(chat, pinMessage(got), NO_KB);
  }
  return tgSend(chat, 'Assalomu alaykum! "Yosh Xorazmiylar" saytiga kirish uchun PIN kodingizni olish uchun pastdagi tugmani bosib, telefon raqamingizni yuboring.', CONTACT_KB);
}
let tgGen = 0;
async function tgLoop() {
  const gen = ++tgGen; let offset = 0;
  while (gen === tgGen) {
    const token = getSet('bot_token');
    if (!token) { await sleep(5000); continue; }
    try {
      const r = await fetch(`${TG_API}/bot${token}/getUpdates?timeout=50&offset=${offset}`, { signal: AbortSignal.timeout(65000) });
      const d = await r.json();
      if (!d.ok) { setSet('bot_error', d.description || 'xato'); await sleep(15000); continue; }
      if (getSet('bot_error')) setSet('bot_error', '');
      for (const up of d.result) { offset = up.update_id + 1; try { await onUpdate(up); } catch (e) { console.error('bot', e); } }
    } catch (e) { await sleep(5000); }
  }
}
if (process.env.NO_BOT !== '1') tgLoop();

A['tg.requests'] = u => {
  need(u.role === 'rahbar' || can(u, 'pinlar'));
  const rows = u.role === 'rahbar' ? all("SELECT * FROM tg_requests WHERE class_id=? ORDER BY id DESC LIMIT 100", u.class_id) : all('SELECT * FROM tg_requests ORDER BY id DESC LIMIT 200');
  return { rows: rows.map(r => ({ ...r, cls: one('SELECT c.name,s.num FROM classes c JOIN schools s ON s.id=c.school_id WHERE c.id=?', r.class_id), phone: r.phone, student: r.student_id ? one('SELECT name FROM students WHERE id=?', r.student_id)?.name : '' })) };
};
A['tg.approve'] = async (u, b) => {
  const r = one('SELECT * FROM tg_requests WHERE id=?', b.id); if (!r) bad('Topilmadi');
  need(can(u, 'pinlar') || (u.role === 'rahbar' && u.class_id === r.class_id));
  if (b.reject) {
    run("UPDATE tg_requests SET status='rad',by=? WHERE id=?", u.id, r.id);
    tgSend(r.chat_id, 'So‘rovingiz tasdiqlanmadi. Iltimos, farzandingizning sinf rahbariga murojaat qiling.');
    log(u.id, 'bot.rad', { child: r.child }); return {};
  }
  const s = one('SELECT * FROM students WHERE id=? AND active=1', b.student_id); if (!s) bad('O‘quvchini tanlang');
  if (u.role === 'rahbar') need(s.class_id === u.class_id, 'Faqat o‘z sinfingiz o‘quvchisi');
  checkPhone(r.phone, s.id);
  if (!phone9(s.phone)) run('UPDATE students SET phone=? WHERE id=?', r.phone, s.id);
  else if (phone9(s.phone) !== r.phone) run('INSERT OR IGNORE INTO student_phones(student_id,phone) VALUES(?,?)', s.id, r.phone);
  run("UPDATE tg_requests SET status='tasdiqlandi',student_id=?,by=? WHERE id=?", s.id, u.id, r.id);
  const got = grantByPhone(r.phone);
  if (got.length) await tgSend(r.chat_id, pinMessage(got), NO_KB);
  log(u.id, 'bot.tasdiq', { student_id: s.id, child: r.child }); return { sent: got.length };
};

// ---------------------------------------------------------------- settings (CEO)
const SET_KEYS = ['bot_token', 'logo', 'imzo', 'muhr', 'signer', 'signer_role', 'tabrik_ota', 'tabrik_rahbar', 'tabrik_direktor', 'ceo_phone', 'site_url',
  'sch_name', 'sch_about', 'sch_address', 'sch_phone', 'sch_telegram', 'sch_instagram', 'sch_facebook', 'sch_youtube', 'sch_site'];
A['settings.get'] = u => {
  need(u.role === 'ceo');
  const o = {}; for (const k of SET_KEYS) o[k] = k === 'bot_token' ? (getSet(k) ? '••••••' + getSet(k).slice(-4) : '') : getSet(k);
  o.sch_name ||= 'KARAKUL INTERNATIONAL SCHOOL'; o.sch_address ||= 'Qorako‘l tumani, Buxoro viloyati';
  o.signer ||= 'Abdurashidov G‘ulom O‘ktamovich'; o.signer_role ||= 'Loyiha rahbari';
  for (const k in DEFAULT_TEXTS) o[k] ||= DEFAULT_TEXTS[k];
  o.bot_username = getSet('bot_username'); o.bot_error = getSet('bot_error');
  o.tg_users = one('SELECT count(*) n FROM tg_users').n;
  return o;
};
A['settings.save'] = async (u, b) => {
  need(u.role === 'ceo');
  if (!SET_KEYS.includes(b.key)) bad('Noma‘lum sozlama');
  let v = String(b.value ?? '');
  if (['logo', 'imzo', 'muhr'].includes(b.key) && v && !/^data:image\/(png|jpeg|webp);base64,/.test(v)) bad('Rasm PNG yoki JPG bo‘lishi kerak');
  if (b.key === 'bot_token' && v) {
    v = v.trim();
    let me = null; try { me = await (await fetch(`${TG_API}/bot${v}/getMe`, { signal: AbortSignal.timeout(15000) })).json(); } catch (e) {}
    if (!me) bad('Telegram‘ga ulanib bo‘lmadi. Server internetini tekshiring.');
    if (!me.ok) bad('Kalit noto‘g‘ri. BotFather bergan kalitni to‘liq nusxalang.');
    setSet('bot_username', me.result.username); setSet('bot_error', '');
  }
  if (b.key === 'ceo_phone') v = phone9(v);
  setSet(b.key, v);
  if (b.key === 'bot_token') tgLoop();
  log(u.id, 'sozlama', { key: b.key });
  return { ok: true, bot_username: getSet('bot_username') };
};
A['cert.assets'] = () => ({ logo: getSet('logo'), imzo: getSet('imzo'), muhr: getSet('muhr'), signer: getSet('signer') || 'Abdurashidov G‘ulom O‘ktamovich', signer_role: getSet('signer_role') || 'Loyiha rahbari', site: siteUrl() });

// ---------------------------------------------------------------- certificates
function assignCerts(testId, schoolId) {
  const t = one('SELECT * FROM tests WHERE id=?', testId); if (!t) return 0;
  const year = (t.date || now()).slice(0, 4); let n = 0;
  for (const sid of giftedIds(t, schoolId)) {
    if (one('SELECT 1 FROM certificates WHERE test_id=? AND student_id=?', testId, sid)) continue;
    const seq = (one('SELECT count(*) n FROM certificates').n || 0) + 1;
    run('INSERT INTO certificates(code,test_id,student_id,at) VALUES(?,?,?,?)', `YX-${year}-${String(seq).padStart(4, '0')}`, testId, sid, now()); n++;
  }
  return n;
}
A['certs.assign'] = (u, b) => { need(u.role === 'ceo'); const t = one("SELECT id FROM tests WHERE id=?", +b?.test_id); return { n: t ? assignCerts(t.id) : 0 }; };
function verifyCert(code) {
  const c = one('SELECT * FROM certificates WHERE code=?', String(code || '').toUpperCase()); if (!c) return { ok: false };
  const s = studentInfo(c.student_id); const t = one('SELECT name,date FROM tests WHERE id=?', c.test_id);
  return { ok: true, code: c.code, name: s?.name, school: s?.num, cls: s?.cls, test: t?.name, date: t?.date || c.at.slice(0, 10) };
}

// ---------------------------------------------------------------- messages
// maktab ichidagi yozishmalar (sinf rahbari ↔ ota-ona, direktor ↔ sinf rahbari/ota-ona) shaxsiy:
// ularni faqat qatnashchilar ko'radi — CEO va jamoa ham o'qiy olmaydi
const PRIVATE_KINDS = ['ota', 'sinf', 'drh', 'drhs', 'dota', 'dotalar'];
function threadAccess(u, t) {
  const P = perms(u);
  if ((u.role === 'ceo' || P.sardor) && !PRIVATE_KINDS.includes(t.kind)) return { see: true, reply: true };
  if (t.kind === 'chat') return { see: isTeam(u), reply: isTeam(u) };
  if (t.kind === 'jamoa') { const mine = t.user_id === u.id; return { see: mine || (u.role === 'jamoa' && P.xabar), reply: mine || (u.role === 'jamoa' && P.xabar) }; }
  if (t.kind === 'ota') { const ok = t.user_id === u.id || (u.role === 'rahbar' && u.class_id === t.class_id); return { see: ok, reply: ok }; }
  // direktor yozishmalari: drh — direktor ↔ bitta sinf rahbari, drhs — direktor va maktabdagi hamma sinf rahbarlari guruhi,
  // dota — direktor ↔ bitta ota-ona, dotalar — direktordan ota-onalarga e'lon (ota-onalar faqat o'qiydi)
  if (t.kind === 'drh') { const ok = (u.role === 'direktor' && u.id === t.user_id) || (u.role === 'rahbar' && u.class_id === t.class_id); return { see: ok, reply: ok }; }
  if (t.kind === 'drhs') { const ok = (u.role === 'direktor' && u.school_id === t.school_id) || (u.role === 'rahbar' && one('SELECT school_id FROM classes WHERE id=?', u.class_id)?.school_id === t.school_id); return { see: ok, reply: ok }; }
  if (t.kind === 'dota') { const ok = u.id === t.user_id || (u.role === 'direktor' && u.school_id === t.school_id); return { see: ok, reply: ok }; }
  if (t.kind === 'dotalar') { if (u.role === 'direktor' && u.school_id === t.school_id) return { see: true, reply: true }; if (u.role === 'ota') return { see: kidInSchool(u, t.school_id, t.class_id), reply: false }; if (u.role === 'rahbar' && (!t.class_id || u.class_id === t.class_id) && one('SELECT school_id FROM classes WHERE id=?', u.class_id)?.school_id === t.school_id) return { see: true, reply: false }; return { see: false, reply: false }; }
  if (t.kind === 'sinf') {
    if (u.role === 'rahbar' && u.class_id === t.class_id) return { see: true, reply: true };
    if (u.role === 'ota') { const k = kidsOfPhone(phone9(u.phone)); const ok = k.some(id => one('SELECT class_id FROM students WHERE id=?', id)?.class_id === t.class_id); return { see: ok, reply: false }; }
  }
  return { see: false, reply: false };
}
function visibleThreads(u) {
  const rows = all('SELECT * FROM threads ORDER BY updated_at DESC LIMIT 1000').filter(t => threadAccess(u, t).see);
  return rows.map(t => {
    const r = one('SELECT at FROM reads WHERE thread_id=? AND user_id=?', t.id, u.id)?.at || '';
    const last = one("SELECT user_id,text,image,audio<>'' AS audio,at FROM messages WHERE thread_id=? ORDER BY id DESC LIMIT 1", t.id);
    const unread = one('SELECT count(*) n FROM messages WHERE thread_id=? AND user_id!=? AND at>?', t.id, u.id, r).n;
    return { ...t, last, unread };
  });
}
function threadTitle(t, u) {
  const s = t.student_id ? studentInfo(t.student_id) : null;
  const who = one('SELECT name,role FROM users WHERE id=?', t.user_id);
  if (t.kind === 'chat') return 'Jamoa chati';
  if (t.kind === 'drh') { const c = one('SELECT name,teacher_name FROM classes WHERE id=?', t.class_id); return u?.role === 'rahbar' ? `Direktor · ${who?.name || ''}` : `${c?.teacher_name || 'Sinf rahbari'} · ${c?.name || ''} sinf`; }
  if (t.kind === 'drhs') return 'Sinf rahbarlari guruhi (direktor bilan)';
  if (t.kind === 'dota') { if (u?.role === 'ota') return `Maktab direktori${s ? ' · ' + (s.name.split(' ')[1] || s.name) : ''}`; return s ? `${s.name.split(' ')[1] || s.name}ning ota-onasi · ${s.cls}` : 'Ota-ona'; }
  if (t.kind === 'dotalar') { const c = t.class_id ? one('SELECT name FROM classes WHERE id=?', t.class_id) : null; return `Direktordan e’lon · ${c ? c.name + ' sinf ota-onalari' : 'butun maktab ota-onalari'}`; }
  if (t.kind === 'sinf') { const c = one('SELECT c.name,s.num FROM classes c JOIN schools s ON s.id=c.school_id WHERE c.id=?', t.class_id); return `${c?.num}-maktab ${c?.name} — butun sinfga`; }
  if (t.kind === 'ota' && u?.role === 'ota') { const c = one('SELECT teacher_name FROM classes WHERE id=?', t.class_id); return `${c?.teacher_name || 'Sinf rahbari'} · ${s ? s.name.split(' ')[1] || s.name : ''}`; }
  if (t.kind === 'ota') return s ? `${s.name.split(' ')[1] || s.name}ning ota-onasi · ${s.num}-maktab ${s.cls}` : 'Ota-ona';
  return (who?.name || '') + (s ? ' · ' + s.name : '');
}
function recipients(t, fromId) {
  let ids = [];
  const leaders = [ceoId(), ...sardorIds()];
  if (t.kind === 'jamoa') ids = [...leaders, t.user_id, ...all("SELECT id,role,perms FROM users WHERE role='jamoa' AND active=1").filter(x => perms(x).xabar).map(x => x.id)];
  if (t.kind === 'ota') ids = [t.user_id, ...rahbarsOf(t.class_id).map(r => r.id)];
  if (t.kind === 'sinf') ids = all("SELECT id,phone FROM users WHERE role='ota' AND active=1").filter(x => kidsOfPhone(phone9(x.phone)).some(k => one('SELECT class_id FROM students WHERE id=?', k)?.class_id === t.class_id)).map(x => x.id);
  if (t.kind === 'chat') ids = all("SELECT id FROM users WHERE role IN ('ceo','jamoa') AND active=1").map(x => x.id);
  if (t.kind === 'drh') ids = [t.user_id, ...rahbarsOf(t.class_id).map(r => r.id)];
  if (t.kind === 'drhs') ids = [...directorsOf(t.school_id).map(r => r.id), ...rahbarsOfSchool(t.school_id).map(r => r.id)];
  if (t.kind === 'dota') ids = [t.user_id, ...directorsOf(t.school_id).map(r => r.id)];
  if (t.kind === 'dotalar') ids = all("SELECT * FROM users WHERE role='ota' AND active=1").filter(x => kidInSchool(x, t.school_id, t.class_id)).map(x => x.id);
  return [...new Set(ids)].filter(id => id !== fromId);
}
function cleanImage(v) { const s = String(v || ''); if (!s) return ''; if (!/^data:image\/(png|jpeg|webp);base64,/.test(s) || s.length > 1.5e6) bad('Rasm juda katta yoki noto‘g‘ri'); return s; }
function cleanAudio(v) { const s = String(v || ''); if (!s) return ''; if (!/^data:audio\/[a-z0-9.+-]+(;[a-z0-9=.,+ -]+)*;base64,/i.test(s) || s.length > 4.5e6) bad('Ovozli xabar juda uzun yoki noto‘g‘ri (eng ko‘pi 3 daqiqa)'); return s; }
function addMessage(u, t, txt, image, audio = '') {
  const at = now();
  run('INSERT INTO messages(thread_id,user_id,text,image,audio,at) VALUES(?,?,?,?,?,?)', t.id, u.id, txt, image, audio, at);
  run('UPDATE threads SET updated_at=? WHERE id=?', at, t.id);
  run('INSERT INTO reads(thread_id,user_id,at) VALUES(?,?,?) ON CONFLICT(thread_id,user_id) DO UPDATE SET at=excluded.at', t.id, u.id, at);
  if (t.status === 'hal' && t.user_id === u.id) run("UPDATE threads SET status='ochiq' WHERE id=?", t.id);
  const who = u.role === 'ceo' ? 'CEO' : u.name;
  notifyUsers(recipients(t, u.id), `Yangi xabar (${who}):\n${txt.slice(0, 300)}${image ? '\n[rasm]' : ''}${audio ? '\n[ovozli xabar]' : ''}\n\nJavob berish: ${siteUrl()}`);
}
const TOPICS = ['xato', 'pin', 'savol', 'taklif'];
A['threads'] = u => ({ rows: visibleThreads(u).map(t => ({ ...t, title: threadTitle(t, u), last: t.last ? { ...t.last, image: !!t.last.image } : null })) });
A['thread.get'] = (u, b) => { const t = one('SELECT * FROM threads WHERE id=?', b.id); if (!t) bad('Topilmadi');
  const acc = threadAccess(u, t); need(acc.see);
  run('INSERT INTO reads(thread_id,user_id,at) VALUES(?,?,?) ON CONFLICT(thread_id,user_id) DO UPDATE SET at=excluded.at', t.id, u.id, now());
  const msgs = all('SELECT * FROM messages WHERE thread_id=? ORDER BY id', t.id).map(m => ({ ...m, audio: m.audio ? 1 : 0 }));
  const names = {}, avs = {}; for (const m of msgs) if (!(m.user_id in names)) { const x = one('SELECT name,role,avatar FROM users WHERE id=?', m.user_id); names[m.user_id] = x ? (x.role === 'ceo' ? 'CEO' : x.role === 'ota' ? 'Ota-ona' : x.name) : '—'; avs[m.user_id] = x?.avatar || ''; }
  const reads = all('SELECT user_id,at FROM reads WHERE thread_id=?', t.id).filter(r => r.user_id !== u.id);
  const s = t.student_id ? studentInfo(t.student_id) : null;
  let result = null;
  if (s && (isTeam(u) || u.role === 'rahbar')) { const r = one('SELECT r.score,r.qn,r.absent,t.name FROM results r JOIN tests t ON t.id=r.test_id WHERE r.student_id=? ORDER BY r.test_id DESC LIMIT 1', s.id); if (r) result = r; }
  return { thread: { ...t, title: threadTitle(t, u) }, reply: acc.reply, msgs, names, avs, readBy: reads, student: s, result };
};
A['thread.new'] = (u, b) => {
  const txt = str(b.text, 3000); const image = cleanImage(b.image); const audio = cleanAudio(b.audio);
  if (!txt && !image && !audio) bad('Xabar bo‘sh');
  let t;
  if (b.kind === 'jamoa') {
    need(['direktor', 'rahbar', 'jamoa'].includes(u.role), 'Bu xabar turi sizga mo‘ljallanmagan');
    const topic = TOPICS.includes(b.topic) ? b.topic : 'savol';
    const r = run('INSERT INTO threads(kind,user_id,student_id,topic,created_at,updated_at) VALUES(?,?,?,?,?,?)', 'jamoa', u.id, +b.student_id || null, topic, now(), now());
    t = one('SELECT * FROM threads WHERE id=?', Number(r.lastInsertRowid));
  } else if (b.kind === 'ota') {
    const s = studentInfo(+b.student_id); if (!s) bad('O‘quvchini tanlang');
    let parentId;
    if (u.role === 'ota') { need(kidsOfPhone(phone9(u.phone)).includes(s.id)); parentId = u.id; }
    else if (u.role === 'rahbar') { need(u.class_id === s.class_id); const ps = parentsOf(s.id); if (!ps.length) bad('Bu bolaning ota-onasi hali saytga kirmagan (PIN yo‘q)'); parentId = ps[0].id; }
    else need(false);
    t = one("SELECT * FROM threads WHERE kind='ota' AND user_id=? AND student_id=?", parentId, s.id);
    if (!t) { const r = run('INSERT INTO threads(kind,user_id,class_id,student_id,created_at,updated_at) VALUES(?,?,?,?,?,?)', 'ota', parentId, s.class_id, s.id, now(), now()); t = one('SELECT * FROM threads WHERE id=?', Number(r.lastInsertRowid)); }
  } else if (b.kind === 'sinf') {
    need(u.role === 'rahbar');
    const r = run('INSERT INTO threads(kind,user_id,class_id,created_at,updated_at) VALUES(?,?,?,?,?)', 'sinf', u.id, u.class_id, now(), now());
    t = one('SELECT * FROM threads WHERE id=?', Number(r.lastInsertRowid));
  } else if (b.kind === 'drh') { // direktor ↔ sinf rahbari
    let dirId, cid;
    if (u.role === 'direktor') { cid = +b.class_id; need(one('SELECT school_id FROM classes WHERE id=?', cid)?.school_id === u.school_id, 'Faqat o‘z maktabingiz sinflari'); if (!rahbarsOf(cid).length) bad('Bu sinf rahbari hali saytga kirmagan (PIN yo‘q)'); dirId = u.id; }
    else if (u.role === 'rahbar') { cid = u.class_id; const sc = one('SELECT school_id FROM classes WHERE id=?', cid)?.school_id; const d = directorsOf(sc)[0]; if (!d) bad('Maktab direktori hali saytga kirmagan (PIN yo‘q)'); dirId = d.id; }
    else need(false);
    t = one("SELECT * FROM threads WHERE kind='drh' AND user_id=? AND class_id=?", dirId, cid);
    if (!t) { const r = run('INSERT INTO threads(kind,user_id,class_id,school_id,created_at,updated_at) VALUES(?,?,?,?,?,?)', 'drh', dirId, cid, one('SELECT school_id FROM classes WHERE id=?', cid).school_id, now(), now()); t = one('SELECT * FROM threads WHERE id=?', Number(r.lastInsertRowid)); }
  } else if (b.kind === 'drhs') { // direktor + hamma sinf rahbarlari guruhi
    need(u.role === 'direktor');
    t = one("SELECT * FROM threads WHERE kind='drhs' AND school_id=?", u.school_id);
    if (!t) { const r = run('INSERT INTO threads(kind,user_id,school_id,created_at,updated_at) VALUES(?,?,?,?,?)', 'drhs', u.id, u.school_id, now(), now()); t = one('SELECT * FROM threads WHERE id=?', Number(r.lastInsertRowid)); }
  } else if (b.kind === 'dota') { // direktor ↔ bitta ota-ona
    need(u.role === 'direktor');
    const s = studentInfo(+b.student_id); if (!s) bad('O‘quvchini tanlang');
    const sc = one('SELECT school_id FROM classes WHERE id=?', s.class_id)?.school_id; need(sc === u.school_id, 'Faqat o‘z maktabingiz o‘quvchilari');
    const ps = parentsOf(s.id); if (!ps.length) bad('Bu bolaning ota-onasi hali saytga kirmagan (PIN yo‘q)');
    t = one("SELECT * FROM threads WHERE kind='dota' AND user_id=? AND student_id=?", ps[0].id, s.id);
    if (!t) { const r = run('INSERT INTO threads(kind,user_id,class_id,student_id,school_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', 'dota', ps[0].id, s.class_id, s.id, sc, now(), now()); t = one('SELECT * FROM threads WHERE id=?', Number(r.lastInsertRowid)); }
  } else if (b.kind === 'dotalar') { // direktordan ota-onalarga e'lon
    need(u.role === 'direktor');
    const cid = +b.class_id || null; if (cid) need(one('SELECT school_id FROM classes WHERE id=?', cid)?.school_id === u.school_id);
    const r = run('INSERT INTO threads(kind,user_id,class_id,school_id,created_at,updated_at) VALUES(?,?,?,?,?,?)', 'dotalar', u.id, cid, u.school_id, now(), now());
    t = one('SELECT * FROM threads WHERE id=?', Number(r.lastInsertRowid));
  } else if (b.kind === 'chat') {
    need(isTeam(u));
    t = one("SELECT * FROM threads WHERE kind='chat'");
    if (!t) { const r = run("INSERT INTO threads(kind,user_id,created_at,updated_at) VALUES('chat',?,?,?)", u.id, now(), now()); t = one('SELECT * FROM threads WHERE id=?', Number(r.lastInsertRowid)); }
  } else bad('Noma‘lum xabar turi');
  addMessage(u, t, txt, image, audio);
  return { id: t.id };
};
A['thread.reply'] = (u, b) => {
  const t = one('SELECT * FROM threads WHERE id=?', b.id); if (!t) bad('Topilmadi');
  need(threadAccess(u, t).reply, 'Bu yozishmaga javob yoza olmaysiz');
  const txt = str(b.text, 3000); const image = cleanImage(b.image); const audio = cleanAudio(b.audio); if (!txt && !image && !audio) bad('Xabar bo‘sh');
  addMessage(u, t, txt, image, audio); return {};
};
// ovozli xabar alohida yuklanadi (yozishma tez ochilishi uchun)
A['msg.audio'] = (u, b) => {
  const m = one('SELECT id,thread_id,audio FROM messages WHERE id=?', +b.id); if (!m || !m.audio) bad('Topilmadi');
  need(threadAccess(u, one('SELECT * FROM threads WHERE id=?', m.thread_id)).see); return { audio: m.audio };
};
A['msg.edit'] = (u, b) => { // faqat o'z xabarini tahrirlaydi
  const m = one('SELECT * FROM messages WHERE id=?', b.id); if (!m) bad('Xabar topilmadi');
  need(m.user_id === u.id, 'Faqat o‘z xabaringizni tahrirlay olasiz');
  const txt = str(b.text, 3000); if (!txt && !m.image) bad('Xabar bo‘sh');
  if (txt === m.text) return {};
  run('UPDATE messages SET text=?,edited=? WHERE id=?', txt, now(), m.id);
  log(u.id, 'xabar.tahrir', { id: m.id, old: m.text, new: txt }); return {};
};
A['msg.delete'] = (u, b) => { // o'z xabarini o'chiradi; CEO istalgan xabarni o'chira oladi
  const m = one('SELECT * FROM messages WHERE id=?', b.id); if (!m) return {};
  need(m.user_id === u.id || (u.role === 'ceo' && threadAccess(u, one('SELECT * FROM threads WHERE id=?', m.thread_id) || {}).see), 'Faqat o‘z xabaringizni o‘chira olasiz');
  run('DELETE FROM messages WHERE id=?', m.id);
  log(u.id, 'xabar.ochirish', { id: m.id, thread_id: m.thread_id, by: m.user_id, text: m.text, image: !!m.image }); return {};
};
A['thread.status'] = (u, b) => {
  const t = one('SELECT * FROM threads WHERE id=?', b.id); if (!t) bad('Topilmadi');
  need(u.role === 'ceo' || perms(u).sardor || (u.role === 'jamoa' && perms(u).xabar));
  run('UPDATE threads SET status=? WHERE id=?', b.status === 'hal' ? 'hal' : 'ochiq', t.id); return {};
};
A['thread.forward'] = (u, b) => {
  const t = one('SELECT * FROM threads WHERE id=?', b.id); if (!t) bad('Topilmadi');
  need(u.role === 'rahbar' && threadAccess(u, t).see);
  const last = one('SELECT text FROM messages WHERE thread_id=? AND user_id=? ORDER BY id DESC LIMIT 1', t.id, t.user_id);
  const r = run('INSERT INTO threads(kind,user_id,student_id,topic,created_at,updated_at) VALUES(?,?,?,?,?,?)', 'jamoa', u.id, t.student_id, 'savol', now(), now());
  const nt = one('SELECT * FROM threads WHERE id=?', Number(r.lastInsertRowid));
  addMessage(u, nt, `Ota-ona xabarini jamoaga yuboraman:\n“${last?.text || ''}”${b.note ? '\n\n' + str(b.note, 1000) : ''}`, '');
  return { id: nt.id };
};

// ---------------------------------------------------------------- exercises (mashg'ulotlar)
A['ex.save'] = (u, b) => {
  need(can(u, 'mashq'), 'Mashq qo‘shish huquqi kerak');
  const grade = parseInt(b.grade, 10); if (!grade) bad('Sinfni tanlang');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(b.day) ? b.day : today();
  const q = str(b.text, 2000); if (!q && !b.image) bad('Savolni yozing');
  const opts = (Array.isArray(b.options) ? b.options : []).map(o => str(o, 200)).filter(Boolean).slice(0, 5); if (opts.length < 2) bad('Kamida 2 ta javob varianti kerak');
  const ans = String(b.answer || '').toUpperCase(); if (!'ABCDE'.slice(0, opts.length).includes(ans) || !ans) bad('To‘g‘ri javobni belgilang');
  const f = [grade, day, q, cleanImage(b.image), JSON.stringify(opts), ans, str(b.explain, 1000)];
  if (b.id) { run('UPDATE exercises SET grade=?,day=?,text=?,image=?,options=?,answer=?,explain=? WHERE id=?', ...f, b.id); log(u.id, 'mashq.tahrir', { id: b.id }); return { id: b.id }; }
  const r = run('INSERT INTO exercises(grade,day,text,image,options,answer,explain,user_id,at) VALUES(?,?,?,?,?,?,?,?,?)', ...f, u.id, now());
  log(u.id, 'mashq.qoshish', { grade, day }); return { id: Number(r.lastInsertRowid) };
};
A['ex.delete'] = (u, b) => { need(can(u, 'mashq')); run('DELETE FROM exercises WHERE id=?', b.id); run('DELETE FROM ex_answers WHERE exercise_id=?', b.id); log(u.id, 'mashq.ochirish', { id: b.id }); return {}; };
A['ex.list'] = u => {
  if (isTeam(u)) return { today: today(), rows: all('SELECT * FROM exercises ORDER BY day DESC,id DESC LIMIT 300').map(e => ({ ...e, options: JSON.parse(e.options), done: one('SELECT count(*) n, sum(correct) c FROM ex_answers WHERE exercise_id=?', e.id) })) };
  need(u.role === 'ota');
  const kids = kidsOfPhone(phone9(u.phone)).map(studentInfo).filter(Boolean);
  const grades = [...new Set(kids.map(k => k.grade))];
  if (!grades.length) return { today: today(), rows: [] };
  const rows = all(`SELECT * FROM exercises WHERE day<=? AND grade IN (${grades.map(() => '?').join(',')}) ORDER BY day DESC,id DESC LIMIT 60`, today(), ...grades);
  return { today: today(), rows: rows.map(e => {
    const ans = Object.fromEntries(kids.filter(k => k.grade === e.grade).map(k => [k.id, one('SELECT choice,correct FROM ex_answers WHERE exercise_id=? AND student_id=?', e.id, k.id) || null]));
    const anyDone = Object.values(ans).some(Boolean);
    return { id: e.id, grade: e.grade, day: e.day, text: e.text, image: e.image, options: JSON.parse(e.options), answers: ans, answer: anyDone ? e.answer : null, explain: anyDone ? e.explain : null };
  }) };
};
A['ex.answer'] = (u, b) => {
  need(u.role === 'ota');
  const e = one('SELECT * FROM exercises WHERE id=?', b.exercise_id); if (!e) bad('Mashq topilmadi');
  const sid = +b.student_id; need(kidsOfPhone(phone9(u.phone)).includes(sid));
  need(studentInfo(sid)?.grade === e.grade, 'Bu mashq boshqa sinf uchun');
  const ch = String(b.choice || '').toUpperCase().slice(0, 1); if (!ch) bad('Javobni tanlang');
  const prev = one('SELECT * FROM ex_answers WHERE exercise_id=? AND student_id=?', e.id, sid);
  if (!prev) run('INSERT INTO ex_answers(exercise_id,student_id,choice,correct,at) VALUES(?,?,?,?,?)', e.id, sid, ch, ch === e.answer ? 1 : 0, now());
  const p = prev || { choice: ch, correct: ch === e.answer ? 1 : 0 };
  return { choice: p.choice, correct: !!p.correct, answer: e.answer, explain: e.explain };
};

// ---------------------------------------------------------------- http
const fails = new Map(); // ip -> {n, until}
function readBody(req, limit = 8e6) {
  return new Promise((res, rej) => { let s = ''; req.on('data', c => { s += c; if (s.length > limit) { rej(new HttpErr(413, 'Juda katta')); req.destroy(); } }); req.on('end', () => res(s)); req.on('error', rej); });
}
function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(body);
}
function cookie(req, n) { const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + n + '=([^;]+)')); return m ? m[1] : ''; }
function userOf(req) {
  const t = cookie(req, 'yx'); if (!t) return null;
  const s = one('SELECT * FROM sessions WHERE token=?', t); if (!s || s.expires < now()) return null;
  return one('SELECT * FROM users WHERE id=? AND active=1 AND pin IS NOT NULL', s.user_id) || null;
}
// sayt versiyasi: index.html o'zgarsa, ochiq sahifalarga "Sayt yangilandi" chiqadi
let VER = { m: 0, v: '' };
function siteVersion() { try { const f = path.join(PUBLIC, 'index.html'); const m = fs.statSync(f).mtimeMs; if (m !== VER.m) VER = { m, v: crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 12) }; } catch (e) { } return VER.v; }
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };

// ---- Telefonga ilova sifatida o'rnatish (PWA) ----
const ICONS = {
  '/icon-512.png': Buffer.from('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', 'base64'),
  '/icon-192.png': Buffer.from('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', 'base64'),
  '/icon-mask.png': Buffer.from('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', 'base64'),
  '/apple-touch-icon.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAMAAAAKE/YAAAADAFBMVEX5/f0dN2QiOmQNLWsAWofs6O76uAHoZo3fgZsQK1mniSVSVk0uRW2KeDPGmxbnXIXpdpkIYo01RVrvx9XqlrDoh6TUpBHeepVqZULtt8iIlq1oeZfX5ey3xdKvuMdVaIn+wQgXMV7Q2+Tw2uPw46+bprp1bD3qpbp7iqRCTVW6lBzEytY8Unf2xjSbgytEWHzv0tzw2YuykCC42OLtrcHs68+Mtc3jqgPlUn3y023M0txIXIHzyUx8cDopPl5HiasqdZsyeLJZlbF4qceWw9L18NlMqrWhrL6w0t1uo7wFhpVlnLdxgZ2AjqcAS3w8g6SjrsBOi8Hig57p3qMNdY+Brc8tmqhecJCvzOP0viQBHU8AHmHe8fNak8ZgX0djmsndZYoUY60hb5YkbrM4oK1asbvwz2EYkJ9gsrx6v8h6wMmd0di74OTek6rwfaD40F0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADVb5rzAAABAHRSTlP/////////////////////////////////////////////////////////////////////////////////////////////////////////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', 'base64'),
  '/favicon.png': Buffer.from('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', 'base64'),
};
const MANIFEST = JSON.stringify({
  name: 'Yosh Xorazmiylar', short_name: 'Yosh Xorazmiylar', id: '/', start_url: '/', scope: '/',
  display: 'standalone', orientation: 'portrait', lang: 'uz', background_color: '#ffffff', theme_color: '#ffffff',
  description: 'Yosh Xorazmiylar — matematika sinovlari natijalari',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-mask.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});
const SW = `const C='yx-v3';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.add('/')).catch(()=>{}));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);if(u.origin!==location.origin||u.pathname.startsWith('/api/'))return;
 if(r.mode==='navigate'){e.respondWith(fetch(r).then(res=>{if(res.ok&&u.pathname==='/'){const cp=res.clone();caches.open(C).then(c=>c.put('/',cp))}return res}).catch(()=>caches.match('/')));return}
 if(/\\.png$/.test(u.pathname))e.respondWith(caches.match(r).then(m=>m||fetch(r).then(res=>{const cp=res.clone();caches.open(C).then(c=>c.put(r,cp));return res})));
});`;
function pwa(url, res) {
  if (ICONS[url.pathname]) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=604800', ...SEC }); res.end(ICONS[url.pathname]); return true; }
  if (url.pathname === '/manifest.webmanifest') { res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'max-age=3600', ...SEC }); res.end(MANIFEST); return true; }
  if (url.pathname === '/sw.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/', ...SEC }); res.end(SW); return true; }
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress);
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const f = fails.get(ip); if (f && f.until > Date.now()) return send(res, 429, { error: 'Ko‘p marta xato kiritildi. 15 daqiqadan keyin urinib ko‘ring.' });
      const { pin, phone } = JSON.parse(await readBody(req) || '{}');
      const p9 = phone9(phone);
      if (!p9) return send(res, 400, { error: 'Telefon raqamingizni kiriting.' });
      // bitta raqamga ham ko'p qurilmadan urinishni to'xtatish
      const pk = 'tel:' + p9, fp = fails.get(pk); if (fp && fp.until > Date.now()) return send(res, 429, { error: 'Bu raqam bilan ko‘p marta xato kiritildi. 15 daqiqadan keyin urinib ko‘ring.' });
      let u = /^\d{6}$/.test(String(pin)) ? one('SELECT * FROM users WHERE pin=? AND active=1', String(pin)) : null;
      if (u) { // PIN faqat o'z egasining telefon raqami bilan ochiladi
        const own = u.role === 'ceo' ? (phone9(getSet('ceo_phone')) || phone9(u.phone)) : phone9(u.phone);
        if (own && own !== p9) u = null; // raqami yozilmagan eski foydalanuvchilar vaqtincha faqat PIN bilan kiradi
      }
      if (!u) {
        const bump = (k, o) => { const n = (o && o.until < Date.now() ? 0 : o?.n || 0) + 1; fails.set(k, { n, until: n >= 5 ? Date.now() + 15 * 60e3 : 0 }); return n; };
        const n = Math.max(bump(ip, f), bump(pk, fp));
        return send(res, 401, { error: n >= 5 ? 'Ko‘p marta xato kiritildi. 15 daqiqadan keyin urinib ko‘ring.' : 'Telefon raqami yoki PIN noto‘g‘ri. Qaytadan kiriting.' });
      }
      fails.delete(ip); fails.delete(pk);
      const token = crypto.randomBytes(32).toString('hex');
      run('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)', token, u.id, new Date(Date.now() + 90 * 864e5).toISOString());
      run('UPDATE users SET last_login=? WHERE id=?', now(), u.id);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `yx=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${90 * 86400}${secure}` });
    }
    if (url.pathname === '/api/logout') { run('DELETE FROM sessions WHERE token=?', cookie(req, 'yx')); return send(res, 200, { ok: true }, { 'Set-Cookie': 'yx=; Path=/; Max-Age=0' }); }
    if (url.pathname === '/api/verify') return send(res, 200, verifyCert(url.searchParams.get('c')));
    if (url.pathname === '/api/ver') return send(res, 200, { v: siteVersion() }); // sahifa yangilanganini bilish uchun
    const phm = url.pathname.match(/^\/ph\/s\/(\d+)$/);
    if (phm) { // o'quvchi surati: faqat uni ko'rishga haqli bo'lganlarga
      const u = userOf(req); const s = u && one('SELECT s.id,s.class_id,s.avatar,c.school_id FROM students s JOIN classes c ON c.id=s.class_id WHERE s.id=?', +phm[1]);
      const ok = s && s.avatar && s.avatar.startsWith('data:') && (isTeam(u) || (u.role === 'direktor' && u.school_id === s.school_id) || (u.role === 'rahbar' && u.class_id === s.class_id) || (u.role === 'ota' && kidsOfPhone(phone9(u.phone)).includes(s.id)));
      if (!ok) { res.writeHead(404, SEC); return res.end(); }
      const m = s.avatar.match(/^data:([^;]+);base64,(.*)$/); res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'private, max-age=86400', ...SEC }); return res.end(Buffer.from(m[2], 'base64'));
    }
    if (url.pathname.startsWith('/api/')) {
      const u = userOf(req); if (!u) return send(res, 401, { error: 'Qaytadan kiring' });
      if (url.pathname === '/api/state') return send(res, 200, state(u));
      if (url.pathname === '/api/backup') {
        need(u.role === 'ceo'); const f = path.join(DATA, 'backup-download.db'); try { fs.unlinkSync(f); } catch {}
        db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`); log(u.id, 'zaxira.yuklab_olish', {});
        const buf = fs.readFileSync(f); fs.unlinkSync(f);
        return send(res, 200, buf, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="yoshxorazmiylar-${now().slice(0, 10)}.db"` });
      }
      const act = url.pathname.slice(5); const fn = A[act];
      if (!fn || req.method !== 'POST') return send(res, 404, { error: 'Topilmadi' });
      const b = JSON.parse(await readBody(req) || '{}');
      return send(res, 200, (await fn(u, b)) || {});
    }
    if (pwa(url, res)) return;
    // static
    let p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file); const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=86400', ...SEC }); return fs.createReadStream(file).pipe(res);
    }
    if (url.pathname.startsWith('/t/')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SEC }); return fs.createReadStream(path.join(PUBLIC, 'index.html')).pipe(res); }
    res.writeHead(302, { Location: '/' }); res.end();
  } catch (e) {
    if (e instanceof HttpErr) return send(res, e.code, { error: e.message });
    if (e instanceof SyntaxError) return send(res, 400, { error: 'Noto‘g‘ri so‘rov' });
    console.error(e); send(res, 500, { error: 'Serverda xatolik. Qaytadan urinib ko‘ring.' });
  }
});
setInterval(() => { try { run('DELETE FROM sessions WHERE expires<?', now()); } catch {} }, 36e5);
// e'lon qilingan maktablar uchun sertifikatlar (eski holatda faqat yakunlanganda berilardi)
try { for (const a of all('SELECT test_id,school_id FROM announcements WHERE school_id>0')) assignCerts(a.test_id, a.school_id); } catch (e) { console.error('Sertifikat berishda xato:', e.message); }
// bir martalik: bazadagi eski ismlarni ham bir xil yozuvga keltirish
try {
  let fixed = 0;
  tx(() => {
    for (const r of all('SELECT id,name FROM students')) { const n = fixName(r.name, 120); if (n !== r.name) { run('UPDATE students SET name=? WHERE id=?', n, r.id); fixed++; } }
    for (const r of all("SELECT id,teacher_name FROM classes WHERE teacher_name<>''")) { const n = fixName(r.teacher_name); if (n !== r.teacher_name) { run('UPDATE classes SET teacher_name=? WHERE id=?', n, r.id); fixed++; } }
    for (const r of all("SELECT id,director_name FROM schools WHERE director_name<>''")) { const n = fixName(r.director_name); if (n !== r.director_name) { run('UPDATE schools SET director_name=? WHERE id=?', n, r.id); fixed++; } }
    for (const r of all("SELECT id,name FROM users WHERE name<>''")) { const n = fixName(r.name, 120); if (n !== r.name) { run('UPDATE users SET name=? WHERE id=?', n, r.id); fixed++; } }
  });
  if (fixed) console.log('Ismlar yozuvi bir xillashtirildi:', fixed);
} catch (e) { console.error('Ismlarni bir xillashtirib bo‘lmadi:', e.message); }
server.listen(PORT, '127.0.0.1', () => console.log('Yosh Xorazmiylar: http://127.0.0.1:' + PORT));
