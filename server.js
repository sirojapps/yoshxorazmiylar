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
`);

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
class HttpErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const need = (cond, msg = 'Bu amal uchun huquqingiz yo‘q') => { if (!cond) throw new HttpErr(403, msg); };
const bad = msg => { throw new HttpErr(400, msg); };
const str = (v, max = 200) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
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
function keyFor(testId, grade) { return one('SELECT key FROM keys WHERE test_id=? AND grade=?', testId, grade)?.key || ''; }
function score(testId, grade, mode, answers, bits) {
  const key = keyFor(testId, grade);
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
  const rows = all(`SELECT r.id,r.mode,r.answers,r.bits,c.grade FROM results r JOIN students s ON s.id=r.student_id
    JOIN classes c ON c.id=s.class_id WHERE r.test_id=? AND r.absent=0`, testId);
  for (const r of rows) { const s = score(testId, r.grade, r.mode, r.answers, r.bits); run('UPDATE results SET bits=?,score=?,qn=? WHERE id=?', s.bits, s.score, s.qn, r.id); }
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
  const out = { me: { id: u.id, role: u.role, name: u.name, perms: P, consent: !!u.consent_at }, tests, perms: PERMS };
  if (isTeam(u)) {
    out.schools = all('SELECT * FROM schools ORDER BY num');
    out.classes = all('SELECT * FROM classes ORDER BY school_id,grade,name');
    out.students = all('SELECT id,class_id,name,phone,birth_year,address FROM students WHERE active=1 ORDER BY name');
    out.results = all('SELECT id,test_id,student_id,absent,mode,answers,bits,score,qn,entered_by,at FROM results');
    out.keys = {};
    for (const t of tests) {
      const visible = P.ceo || (P.kalit && ['tekshiruv', 'yakunlandi'].includes(t.status));
      out.keys[t.id] = visible ? Object.fromEntries(all('SELECT grade,key FROM keys WHERE test_id=?', t.id).map(k => [k.grade, k.key]))
        : Object.fromEntries(all('SELECT grade,length(key) n FROM keys WHERE test_id=?', t.id).map(k => [k.grade, '?'.repeat(k.n)]));
    }
    out.approvals = {};
    for (const t of tests) { out.approvals[t.id] = {}; for (const s of [{ id: 0 }, ...out.schools]) out.approvals[t.id][s.id] = approvedState(t.id, s.id); }
    out.team = all("SELECT id,role,name,phone,perms,active,last_login FROM users WHERE role IN ('ceo','jamoa')").map(x => ({ ...x, perms: perms(x) }));
    out.notes = all('SELECT * FROM notes ORDER BY at DESC');
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
  out.classes = all(`SELECT id,school_id,name,grade,teacher_name FROM classes WHERE id IN (${ph})`, ...classIds);
  const schoolIds = [...new Set(out.classes.map(c => c.school_id))];
  out.schools = all(`SELECT id,num,name FROM schools WHERE id IN (${schoolIds.map(() => '?').join(',') || 'NULL'})`, ...schoolIds);
  let studs = all(`SELECT id,class_id,name,phone FROM students WHERE active=1 AND class_id IN (${ph}) ORDER BY name`, ...classIds);
  if (u.role === 'ota') { const k = new Set(kidsOfPhone(phone9(u.phone))); out.children = studs.filter(s => k.has(s.id)).map(s => s.id); }
  out.students = studs.map(s => ({ id: s.id, class_id: s.class_id, name: s.name }));
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
    const rows = all(`SELECT r.student_id,r.score,r.qn,c.grade FROM results r JOIN students s ON s.id=r.student_id JOIN classes c ON c.id=s.class_id
      WHERE r.test_id=? AND r.absent=0 AND r.score IS NOT NULL`, t.id);
    for (const g of [...new Set(rows.map(r => r.grade))]) {
      const gr = rows.filter(r => r.grade === g).sort((a, b) => b.score - a.score);
      out.district[t.id + ':' + g] = Math.round(gr.reduce((a, r) => a + r.score / r.qn, 0) / gr.length * 100);
      if (u.role === 'ota') for (const kid of out.children) { const i = gr.findIndex(r => r.student_id === kid); if (i >= 0) out.district[t.id + ':rank:' + kid] = [gr.filter(r => r.score > gr[i].score).length + 1, gr.length]; }
    }
  }
  for (const t of out.tests) if (t.finished) out.gifted.push(...giftedIds(t).filter(id => out.students.some(s => s.id === id)).map(id => t.id + ':' + id));
  Object.assign(out, extras(u, out));
  return out;
}
function giftedIds(t) {
  const rows = all(`SELECT r.student_id,r.score,r.qn,c.grade FROM results r JOIN students s ON s.id=r.student_id JOIN classes c ON c.id=s.class_id
    WHERE r.test_id=? AND r.absent=0 AND r.score IS NOT NULL`, t.id);
  const ids = [];
  for (const g of [...new Set(rows.map(r => r.grade))]) {
    const gr = rows.filter(r => r.grade === g).sort((a, b) => b.score - a.score);
    const cut = gr[Math.max(0, Math.ceil(gr.length * t.gifted_top / 100) - 1)].score;
    gr.forEach(r => { if (r.score >= cut && r.score / r.qn * 100 >= t.gifted_min) ids.push(r.student_id); });
  }
  return ids;
}

// ---------------------------------------------------------------- actions
const A = {};
A['consent'] = u => { run('UPDATE users SET consent_at=? WHERE id=?', now(), u.id); log(u.id, 'rozilik', {}); return {}; };

A['school.save'] = (u, b) => {
  need(can(u, 'maktab'));
  const num = parseInt(b.num, 10); if (!num) bad('Maktab raqamini yozing');
  const f = [num, str(b.name), str(b.director_name), phone9(b.director_phone)];
  if (b.id) { const old = one('SELECT * FROM schools WHERE id=?', b.id); run('UPDATE schools SET num=?,name=?,director_name=?,director_phone=? WHERE id=?', ...f, b.id); log(u.id, 'maktab.tahrir', { old, new: f }); return { id: b.id }; }
  if (one('SELECT 1 FROM schools WHERE num=?', num)) bad(num + '-maktab allaqachon bor');
  const r = run('INSERT INTO schools(num,name,director_name,director_phone,created_at) VALUES(?,?,?,?,?)', ...f, now());
  log(u.id, 'maktab.qoshish', { num }); return { id: Number(r.lastInsertRowid) };
};
A['class.save'] = (u, b) => {
  need(can(u, 'maktab'));
  const name = clsName(b.name); if (!name) bad('Sinf nomi noto‘g‘ri. Masalan: 3-A');
  const f = [name, gradeOf(name), str(b.teacher_name), phone9(b.teacher_phone)];
  if (b.id) { const old = one('SELECT * FROM classes WHERE id=?', b.id); run('UPDATE classes SET name=?,grade=?,teacher_name=?,teacher_phone=? WHERE id=?', ...f, b.id); log(u.id, 'sinf.tahrir', { old, new: f }); return { id: b.id }; }
  if (one('SELECT 1 FROM classes WHERE school_id=? AND name=?', b.school_id, name)) bad(name + ' sinfi allaqachon bor');
  const r = run('INSERT INTO classes(school_id,name,grade,teacher_name,teacher_phone) VALUES(?,?,?,?,?)', b.school_id, ...f);
  log(u.id, 'sinf.qoshish', { school_id: b.school_id, name }); return { id: Number(r.lastInsertRowid) };
};
A['student.save'] = (u, b) => {
  need(can(u, 'maktab') || can(u, 'kiritish'));
  const name = str(b.name, 120); if (name.split(' ').length < 2) bad('Familiya va ismni yozing');
  const by = b.birth_year ? parseInt(b.birth_year, 10) || null : null;
  if (b.id) {
    need(can(u, 'maktab'));
    const old = one('SELECT * FROM students WHERE id=?', b.id);
    run('UPDATE students SET class_id=?,name=?,phone=?,birth_year=?,address=? WHERE id=?', b.class_id, name, phone9(b.phone), by, str(b.address), b.id);
    log(u.id, 'oquvchi.tahrir', { id: b.id, old, new: { class_id: b.class_id, name, phone: phone9(b.phone), birth_year: by, address: str(b.address) } });
    return { id: b.id };
  }
  const r = run('INSERT INTO students(class_id,name,phone,birth_year,address,created_at) VALUES(?,?,?,?,?,?)', b.class_id, name, phone9(b.phone), by, str(b.address), now());
  log(u.id, 'oquvchi.qoshish', { id: Number(r.lastInsertRowid), name, class_id: b.class_id }); return { id: Number(r.lastInsertRowid) };
};
A['student.delete'] = (u, b) => { need(can(u, 'maktab')); run('UPDATE students SET active=0 WHERE id=?', b.id); log(u.id, 'oquvchi.ochirish', { id: b.id, name: one('SELECT name FROM students WHERE id=?', b.id)?.name }); return {}; };
A['student.restore'] = (u, b) => { need(can(u, 'maktab')); run('UPDATE students SET active=1 WHERE id=?', b.id); log(u.id, 'oquvchi.qaytarish', { id: b.id }); return {}; };
A['students.import'] = (u, b) => {
  need(can(u, 'maktab'));
  const num = parseInt(b.school_num, 10); if (!num) bad('Maktab raqamini yozing');
  const rows = Array.isArray(b.rows) ? b.rows : []; if (!rows.length) bad('Faylda o‘quvchi topilmadi');
  return tx(() => {
    let sc = one('SELECT id FROM schools WHERE num=?', num);
    if (!sc) sc = { id: Number(run('INSERT INTO schools(num,created_at) VALUES(?,?)', num, now()).lastInsertRowid) };
    let added = 0, skipped = 0, newCls = 0;
    for (const r of rows) {
      const name = str(r.name, 120).split(' ').slice(0, 2).join(' '); const cn = clsName(r.cls);
      if (name.split(' ').length < 2 || !cn) { skipped++; continue; }
      let c = one('SELECT id FROM classes WHERE school_id=? AND name=?', sc.id, cn);
      if (!c) { c = { id: Number(run('INSERT INTO classes(school_id,name,grade) VALUES(?,?,?)', sc.id, cn, gradeOf(cn)).lastInsertRowid) }; newCls++; }
      const ex = one('SELECT id,phone FROM students WHERE class_id=? AND lower(name)=lower(?)', c.id, name);
      if (ex) { if (!ex.phone && phone9(r.phone)) run('UPDATE students SET phone=? WHERE id=?', phone9(r.phone), ex.id); skipped++; continue; }
      run('INSERT INTO students(class_id,name,phone,created_at) VALUES(?,?,?,?)', c.id, name, phone9(r.phone), now()); added++;
    }
    log(u.id, 'royxat.import', { num, added, skipped, newCls });
    return { added, skipped, newCls };
  });
};

A['test.save'] = (u, b) => {
  need(can(u, 'maktab'));
  const name = str(b.name); if (!name) bad('Sinov nomini yozing');
  const st = ['tayyor', 'otkazildi', 'tekshiruv', 'yakunlandi'].includes(b.status) ? b.status : 'tayyor';
  const f = [name, str(b.date, 20), st, Math.min(100, Math.max(1, +b.gifted_top || 10)), Math.min(100, Math.max(0, +b.gifted_min || 70))];
  if (b.id) { const old = one('SELECT * FROM tests WHERE id=?', b.id); if (st === 'yakunlandi' && !finished(b.id)) bad('Sinovni yakunlash uchun avval “Yakunlash”ni tasdiqlang'); run('UPDATE tests SET name=?,date=?,status=?,gifted_top=?,gifted_min=? WHERE id=?', ...f, b.id); log(u.id, 'sinov.tahrir', { old, new: f }); return { id: b.id }; }
  const r = run('INSERT INTO tests(name,date,status,gifted_top,gifted_min,created_at) VALUES(?,?,?,?,?,?)', ...f, now());
  log(u.id, 'sinov.qoshish', { name }); return { id: Number(r.lastInsertRowid) };
};
A['key.save'] = (u, b) => {
  need(u.role === 'ceo' || (can(u, 'maktab') && can(u, 'kalit')), 'Kalitni faqat CEO yoki ruxsati bor a‘zo kiritadi');
  const key = String(b.key || '').toUpperCase().replace(/[^A-E]/g, '');
  const g = parseInt(b.grade, 10); if (!g) bad('Sinfni tanlang');
  if (key.length < 5) bad('Kalit to‘liq emas');
  const old = keyFor(b.test_id, g);
  return tx(() => {
    run('INSERT INTO keys(test_id,grade,key) VALUES(?,?,?) ON CONFLICT(test_id,grade) DO UPDATE SET key=excluded.key', b.test_id, g, key);
    const n = rescoreTest(b.test_id);
    log(u.id, old ? 'kalit.tuzatish' : 'kalit.kiritish', { test_id: b.test_id, grade: g, old, new: key, qayta_hisoblandi: n });
    return { rescored: n };
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
  const sc = absent ? { answers: '', bits: '', score: 0, qn: 20 } : score(t.id, s.grade, b.mode === 'harf' ? 'harf' : 'belgi', b.answers, b.bits);
  run(`INSERT INTO results(test_id,student_id,absent,mode,answers,bits,score,qn,entered_by,at) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(test_id,student_id) DO UPDATE SET absent=excluded.absent,mode=excluded.mode,answers=excluded.answers,bits=excluded.bits,
    score=excluded.score,qn=excluded.qn,entered_by=excluded.entered_by,at=excluded.at`,
    t.id, s.id, absent, b.mode === 'harf' ? 'harf' : 'belgi', sc.answers, sc.bits, sc.score, sc.qn, u.id, now());
  if (old) log(u.id, 'natija.tuzatish', { student_id: s.id, test_id: t.id, old: { absent: old.absent, score: old.score, bits: old.bits, answers: old.answers }, new: { absent, ...sc } });
  else log(u.id, 'natija.kiritish', { student_id: s.id, test_id: t.id, absent, score: sc.score });
  return { score: sc.score, qn: sc.qn };
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
      const st = one(`SELECT s.id FROM students s JOIN classes c ON c.id=s.class_id JOIN schools sc ON sc.id=c.school_id
        WHERE sc.num=? AND c.name=? AND lower(s.name)=lower(?) AND s.active=1`, r.school, clsName(r.cls), str(r.name, 120));
      if (!st) { miss.push(r.name + ' (' + r.school + '-maktab, ' + r.cls + ')'); continue; }
      A['result.save'](u, { test_id: b.test_id, student_id: st.id, absent: r.absent, mode: r.mode, bits: r.bits, answers: r.answers }); ok++;
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
  if (b.school_id && st.done) notifyAnnounce(b.test_id, b.school_id);
  log(u.id, b.school_id ? 'elon.tasdiq' : 'yakunlash.tasdiq', { test_id: b.test_id, school_id: b.school_id, done: st.done });
  return st;
};
A['unapprove'] = (u, b) => {
  need(u.role === 'ceo' || perms(u).sardor);
  run('DELETE FROM approvals WHERE test_id=? AND school_id=? AND user_id=?', b.test_id, b.school_id, u.id);
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
  const name = str(b.name, 80); if (!name) bad('Ismni yozing');
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
    : all('SELECT * FROM audit ORDER BY id DESC LIMIT ? OFFSET ?', 100, (+b.offset || 0));
  return { rows: rows.map(r => ({ ...r, detail: JSON.parse(r.detail || '{}') })) };
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

// ---------------------------------------------------------------- extras for state
function extras(u, out) {
  const ex = { texts: { tabrik_ota: text('tabrik_ota'), tabrik_rahbar: text('tabrik_rahbar'), tabrik_direktor: text('tabrik_direktor') } };
  ex.bot = getSet('bot_username');
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
  if (!phone9(s.phone)) run('UPDATE students SET phone=? WHERE id=?', r.phone, s.id);
  else if (phone9(s.phone) !== r.phone) run('INSERT OR IGNORE INTO student_phones(student_id,phone) VALUES(?,?)', s.id, r.phone);
  run("UPDATE tg_requests SET status='tasdiqlandi',student_id=?,by=? WHERE id=?", s.id, u.id, r.id);
  const got = grantByPhone(r.phone);
  if (got.length) await tgSend(r.chat_id, pinMessage(got), NO_KB);
  log(u.id, 'bot.tasdiq', { student_id: s.id, child: r.child }); return { sent: got.length };
};

// ---------------------------------------------------------------- settings (CEO)
const SET_KEYS = ['bot_token', 'logo', 'imzo', 'muhr', 'signer', 'signer_role', 'tabrik_ota', 'tabrik_rahbar', 'tabrik_direktor', 'ceo_phone', 'site_url'];
A['settings.get'] = u => {
  need(u.role === 'ceo');
  const o = {}; for (const k of SET_KEYS) o[k] = k === 'bot_token' ? (getSet(k) ? '••••••' + getSet(k).slice(-4) : '') : getSet(k);
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
function assignCerts(testId) {
  const t = one('SELECT * FROM tests WHERE id=?', testId); if (!t) return 0;
  const year = (t.date || now()).slice(0, 4); let n = 0;
  for (const sid of giftedIds(t)) {
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
function threadAccess(u, t) {
  const P = perms(u);
  if (u.role === 'ceo' || P.sardor) return { see: true, reply: true };
  if (t.kind === 'chat') return { see: isTeam(u), reply: isTeam(u) };
  if (t.kind === 'jamoa') { const mine = t.user_id === u.id; return { see: mine || (u.role === 'jamoa' && P.xabar), reply: mine || (u.role === 'jamoa' && P.xabar) }; }
  if (t.kind === 'ota') { const ok = t.user_id === u.id || (u.role === 'rahbar' && u.class_id === t.class_id); return { see: ok, reply: ok }; }
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
    const last = one('SELECT user_id,text,image,at FROM messages WHERE thread_id=? ORDER BY id DESC LIMIT 1', t.id);
    const unread = one('SELECT count(*) n FROM messages WHERE thread_id=? AND user_id!=? AND at>?', t.id, u.id, r).n;
    return { ...t, last, unread };
  });
}
function threadTitle(t, u) {
  const s = t.student_id ? studentInfo(t.student_id) : null;
  const who = one('SELECT name,role FROM users WHERE id=?', t.user_id);
  if (t.kind === 'chat') return 'Jamoa chati';
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
  return [...new Set(ids)].filter(id => id !== fromId);
}
function cleanImage(v) { const s = String(v || ''); if (!s) return ''; if (!/^data:image\/(png|jpeg|webp);base64,/.test(s) || s.length > 1.5e6) bad('Rasm juda katta yoki noto‘g‘ri'); return s; }
function addMessage(u, t, txt, image) {
  const at = now();
  run('INSERT INTO messages(thread_id,user_id,text,image,at) VALUES(?,?,?,?,?)', t.id, u.id, txt, image, at);
  run('UPDATE threads SET updated_at=? WHERE id=?', at, t.id);
  run('INSERT INTO reads(thread_id,user_id,at) VALUES(?,?,?) ON CONFLICT(thread_id,user_id) DO UPDATE SET at=excluded.at', t.id, u.id, at);
  if (t.status === 'hal' && t.user_id === u.id) run("UPDATE threads SET status='ochiq' WHERE id=?", t.id);
  const who = u.role === 'ceo' ? 'CEO' : u.name;
  notifyUsers(recipients(t, u.id), `Yangi xabar (${who}):\n${txt.slice(0, 300)}${image ? '\n[rasm]' : ''}\n\nJavob berish: ${siteUrl()}`);
}
const TOPICS = ['xato', 'pin', 'savol', 'taklif'];
A['threads'] = u => ({ rows: visibleThreads(u).map(t => ({ ...t, title: threadTitle(t, u), last: t.last ? { ...t.last, image: !!t.last.image } : null })) });
A['thread.get'] = (u, b) => { const t = one('SELECT * FROM threads WHERE id=?', b.id); if (!t) bad('Topilmadi');
  const acc = threadAccess(u, t); need(acc.see);
  run('INSERT INTO reads(thread_id,user_id,at) VALUES(?,?,?) ON CONFLICT(thread_id,user_id) DO UPDATE SET at=excluded.at', t.id, u.id, now());
  const msgs = all('SELECT * FROM messages WHERE thread_id=? ORDER BY id', t.id);
  const names = {}; for (const m of msgs) if (!(m.user_id in names)) { const x = one('SELECT name,role FROM users WHERE id=?', m.user_id); names[m.user_id] = x ? (x.role === 'ceo' ? 'CEO' : x.role === 'ota' ? 'Ota-ona' : x.name) : '—'; }
  const reads = all('SELECT user_id,at FROM reads WHERE thread_id=?', t.id).filter(r => r.user_id !== u.id);
  const s = t.student_id ? studentInfo(t.student_id) : null;
  let result = null;
  if (s && (isTeam(u) || u.role === 'rahbar')) { const r = one('SELECT r.score,r.qn,r.absent,t.name FROM results r JOIN tests t ON t.id=r.test_id WHERE r.student_id=? ORDER BY r.test_id DESC LIMIT 1', s.id); if (r) result = r; }
  return { thread: { ...t, title: threadTitle(t, u) }, reply: acc.reply, msgs, names, readBy: reads, student: s, result };
};
A['thread.new'] = (u, b) => {
  const txt = str(b.text, 3000); const image = cleanImage(b.image);
  if (!txt && !image) bad('Xabar bo‘sh');
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
  } else if (b.kind === 'chat') {
    need(isTeam(u));
    t = one("SELECT * FROM threads WHERE kind='chat'");
    if (!t) { const r = run("INSERT INTO threads(kind,user_id,created_at,updated_at) VALUES('chat',?,?,?)", u.id, now(), now()); t = one('SELECT * FROM threads WHERE id=?', Number(r.lastInsertRowid)); }
  } else bad('Noma‘lum xabar turi');
  addMessage(u, t, txt, image);
  return { id: t.id };
};
A['thread.reply'] = (u, b) => {
  const t = one('SELECT * FROM threads WHERE id=?', b.id); if (!t) bad('Topilmadi');
  need(threadAccess(u, t).reply, 'Bu yozishmaga javob yoza olmaysiz');
  const txt = str(b.text, 3000); const image = cleanImage(b.image); if (!txt && !image) bad('Xabar bo‘sh');
  addMessage(u, t, txt, image); return {};
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
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress);
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const f = fails.get(ip); if (f && f.until > Date.now()) return send(res, 429, { error: 'Ko‘p marta xato kiritildi. 15 daqiqadan keyin urinib ko‘ring.' });
      const { pin } = JSON.parse(await readBody(req) || '{}');
      const u = /^\d{6}$/.test(String(pin)) ? one('SELECT * FROM users WHERE pin=? AND active=1', String(pin)) : null;
      if (!u) { const n = (f && f.until < Date.now() ? 0 : f?.n || 0) + 1; fails.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60e3 : 0 }); return send(res, 401, { error: n >= 5 ? 'Ko‘p marta xato kiritildi. 15 daqiqadan keyin urinib ko‘ring.' : 'PIN noto‘g‘ri. Qaytadan kiriting.' }); }
      fails.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      run('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)', token, u.id, new Date(Date.now() + 90 * 864e5).toISOString());
      run('UPDATE users SET last_login=? WHERE id=?', now(), u.id);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `yx=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${90 * 86400}${secure}` });
    }
    if (url.pathname === '/api/logout') { run('DELETE FROM sessions WHERE token=?', cookie(req, 'yx')); return send(res, 200, { ok: true }, { 'Set-Cookie': 'yx=; Path=/; Max-Age=0' }); }
    if (url.pathname === '/api/verify') return send(res, 200, verifyCert(url.searchParams.get('c')));
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
server.listen(PORT, '127.0.0.1', () => console.log('Yosh Xorazmiylar: http://127.0.0.1:' + PORT));
