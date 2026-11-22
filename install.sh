#!/bin/bash
# Yosh Xorazmiylar — serverga o'rnatish va yangilash.
# Birinchi marta ham, yangilash uchun ham shu bitta buyruq:
# curl -fsSL https://raw.githubusercontent.com/sirojapps/yoshxorazmiylar/main/install.sh | bash
set -euo pipefail

REPO="https://raw.githubusercontent.com/sirojapps/yoshxorazmiylar/main"
DOMAIN="yoshxorazmiylar.uz"
APP="/opt/yx"
APPT="/opt/yx-test"
export DEBIAN_FRONTEND=noninteractive

# Rejim: "full" (birinchi o'rnatish yoki qo'lda) — hammasi; "update" (avtomatik yangilanish) — faqat o'zgargan fayllar.
# Qoida: ASOSIY sayt faqat o'zining server.js fayli o'zgarganda qayta ishga tushadi. Sinov fayllari unga tegmaydi.
MODE="${1:-full}"
case "$MODE" in full|update) ;; *) echo "Noma'lum rejim: $MODE (full yoki update)"; exit 1;; esac
say(){ echo; echo "==> $*"; }
# faylni olish: yangilovchi allaqachon yuklab qo'ygan bo'lsa (YX_SRC) — o'sha yerdan, bo'lmasa GitHub'dan
TS=$(date +%s)
olish(){ # $1 = fayl nomi, $2 = qayerga
  if [ -n "${YX_SRC:-}" ] && [ -s "$YX_SRC/$1" ]; then cp "$YX_SRC/$1" "$2"; else curl -fsSL "$REPO/$1?$TS" -o "$2"; fi; }
[ "$(id -u)" = "0" ] || { echo "Bu buyruqni root sifatida ishga tushiring (yoki boshiga sudo qo'shing)."; exit 1; }

if [ "$MODE" = full ]; then
say "1/8 Kerakli dasturlar o'rnatilmoqda (bir necha daqiqa)"
apt-get update -qq
apt-get install -y -qq curl ca-certificates nginx certbot python3-certbot-nginx sqlite3 >/dev/null
command -v 7z >/dev/null || command -v 7zz >/dev/null || apt-get install -y -qq p7zip-full >/dev/null 2>&1 || apt-get install -y -qq 7zip >/dev/null 2>&1 || echo "DIQQAT: 7-Zip o'rnatilmadi — zaxirani yuklab olish ishlamaydi"
NODE_MAJOR=$(command -v node >/dev/null && node -v | sed 's/v\([0-9]*\).*/\1/' || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
apt-get install -y -qq nodejs >/dev/null
fi
echo "Node.js $(node -v)"
fi

# rasmlar.tar.gz → public/a  (sayt rasmlari alohida fayl: telefon bir marta yuklab, keyin xotiradan oladi)
# Arxiv ichidagi k/ papka — kabinet sahifalari. 12.11.2026 dan (Siroj qarori) ular asosiy saytga ham ochiladi.
RASM_OK=0
rasm_olish(){ RASM_OK=0; if olish rasmlar.tar.gz /tmp/yx-rasm.tgz 2>/dev/null && tar -tzf /tmp/yx-rasm.tgz >/dev/null 2>&1; then RASM_OK=1; fi; }
put_rasmlar(){ # $1 = public papka, $2 = asosiy | sinov, $3 = saqlangan arxiv nusxasi
  [ "$RASM_OK" = 1 ] || return 0
  if [ -d "$1/a" ] && [ -e "$1/a/k" ] && cmp -s /tmp/yx-rasm.tgz "$3"; then return 0; fi # o'zgarmagan
  rm -rf "$1/a.new"; mkdir -p "$1/a.new"
  tar -xzf /tmp/yx-rasm.tgz -C "$1/a.new" --no-same-owner
  rm -rf "$1/a.old"; [ -d "$1/a" ] && mv "$1/a" "$1/a.old"; mv "$1/a.new" "$1/a"; rm -rf "$1/a.old"
  cp /tmp/yx-rasm.tgz "$3"; echo "Rasmlar yangilandi ($2)"; }

say "2/8 Sayt fayllari yuklanmoqda"
id yx >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APP" yx
mkdir -p "$APP/public" "$APP/data" "$APP/backups"
olish server.js "$APP/server.js.new"
olish index.html "$APP/public/index.html.new"
grep -q "Yosh Xorazmiylar" "$APP/server.js.new" || { echo "server.js yuklanmadi. GitHub'dagi fayl nomini tekshiring."; exit 1; }
grep -q "YOSH XORAZMIYLAR" "$APP/public/index.html.new" || { echo "index.html yuklanmadi. GitHub'dagi fayl nomini tekshiring."; exit 1; }
# yozuvida xato bor server.js hech qachon o'rnatilmaydi: ishlab turgan fayl joyida qoladi
cp "$APP/server.js.new" /tmp/yx-check.js
node --check /tmp/yx-check.js || { echo "Yangi server.js da yozuv xatosi bor — o'rnatilmadi, sayt eski fayl bilan ishlayapti."; rm -f /tmp/yx-check.js "$APP/server.js.new" "$APP/public/index.html.new"; exit 1; }
rm -f /tmp/yx-check.js
# server.js faqat haqiqatan o'zgargan bo'lsa almashtiriladi (shundagina xizmat qayta ishga tushadi); eski nusxa saqlab qo'yiladi
SRV_CH=0
if cmp -s "$APP/server.js.new" "$APP/server.js" 2>/dev/null; then rm -f "$APP/server.js.new"
else
  # server.js almashishidan oldin bazaning nusxasi olinadi (kuniga bir marta; hech narsa o'chirilmaydi)
  ZB="$APP/backups/oldin-$(date +%F).db"
  if [ -f "$APP/data/yx.db" ] && [ ! -f "$ZB" ] && command -v sqlite3 >/dev/null 2>&1; then sqlite3 "$APP/data/yx.db" ".backup '$ZB'" && chmod 600 "$ZB" && echo "Zaxira nusxa olindi: $ZB" || echo "Zaxira nusxa olinmadi (davom etiladi)"; fi
  [ -f "$APP/server.js" ] && cp -p "$APP/server.js" "$APP/server.js.prev"; mv "$APP/server.js.new" "$APP/server.js"; SRV_CH=1; fi
# sahifa: server uni har so'rovda diskdan o'qiydi — qayta ishga tushirish kerak emas
if cmp -s "$APP/public/index.html.new" "$APP/public/index.html" 2>/dev/null; then rm -f "$APP/public/index.html.new"
else mv "$APP/public/index.html.new" "$APP/public/index.html"; echo "Sahifa yangilandi (asosiy)"; fi
# darslar.tar.gz → public/darslar. Har sayt (asosiy va sinov) O'Z nusxasini oladi: sinov sayti asosiy sayt papkasiga bog'lanmaydi.
# Darslar ko'payib, bitta arxiv GitHub chegarasiga (100 MB) yaqinlashgani uchun dars fayllari BO'LAKLARDA (darslar-<sinf>-<chorak>.tar.gz) turadi.
# Asosiy arxiv ichidagi qismlar.txt har bo'lakning nomi va sha256 yig'indisini aytadi: bo'lak o'zgarsa asosiy arxiv ham o'zgaradi.
# Biror bo'lak hali yetib kelmagan yoki yig'indisi mos kelmasa — darslar papkasiga tegilmaydi, keyingi yangilanishda qayta uriniladi.
DARS_OK=0; DQ=/tmp/yx-dq; rm -rf "$DQ"; mkdir -p "$DQ"; : > "$DQ/qismlar.txt"
if olish darslar.tar.gz /tmp/yx-darslar.tgz 2>/dev/null && tar -tzf /tmp/yx-darslar.tgz > /tmp/yx-darslar.txt 2>/dev/null && grep -qx 'index.html' /tmp/yx-darslar.txt; then DARS_OK=1
  if grep -qx 'qismlar.txt' /tmp/yx-darslar.txt; then
    tar -xzf /tmp/yx-darslar.tgz -O qismlar.txt > "$DQ/qismlar.txt" 2>/dev/null || DARS_OK=0
    while read -r QH QF; do
      [ -n "${QF:-}" ] || continue
      case "$QF" in darslar-*.tar.gz) ;; *) DARS_OK=0; echo "Dars bo'lagi nomi noto'g'ri: $QF"; break;; esac
      case "$QF" in */*|*..*) DARS_OK=0; echo "Dars bo'lagi nomi noto'g'ri: $QF"; break;; esac
      if olish "$QF" "$DQ/$QF" 2>/dev/null && [ "$(sha256sum "$DQ/$QF" | cut -d' ' -f1)" = "$QH" ] && tar -tzf "$DQ/$QF" >/dev/null 2>&1; then :
      else DARS_OK=0; echo "Dars bo'lagi hali tayyor emas: $QF (keyingi yangilanishda qayta uriniladi)"; break; fi
    done < "$DQ/qismlar.txt"
  fi
fi
put_darslar(){ # $1 = public papka, $2 = asosiy | sinov, $3 = saqlangan arxiv nusxasi
  [ "$DARS_OK" = 1 ] || return 0
  if [ -d "$1/darslar" ] && [ ! -L "$1/darslar" ] && cmp -s /tmp/yx-darslar.tgz "$3" && cmp -s "$DQ/qismlar.txt" "$1/darslar/.bolak-ok" 2>/dev/null; then return 0; fi # o'zgarmagan (.bolak-ok: bo'laklar ham shu papkaga yoyilganining belgisi)
  rm -rf "$1/darslar.new"; mkdir -p "$1/darslar.new"
  tar -xzf /tmp/yx-darslar.tgz -C "$1/darslar.new" --no-same-owner
  while read -r QH QF; do [ -n "${QF:-}" ] || continue; tar -xzf "$DQ/$QF" -C "$1/darslar.new" --no-same-owner; done < "$DQ/qismlar.txt"
  cp "$DQ/qismlar.txt" "$1/darslar.new/.bolak-ok"
  rm -rf "$1/darslar.old"
  # eski tartibda sinov saytida bu papka asosiy saytga havola (symlink) edi: faqat havolaning o'zi olib tashlanadi, asosiy papkaga tegilmaydi
  if [ -L "$1/darslar" ]; then rm -f "$1/darslar"; elif [ -d "$1/darslar" ]; then mv "$1/darslar" "$1/darslar.old"; fi
  mv "$1/darslar.new" "$1/darslar"; rm -rf "$1/darslar.old"
  cp /tmp/yx-darslar.tgz "$3"
  echo "Mavzu darslari o'rnatildi ($2): $(ls "$1/darslar/m" 2>/dev/null | wc -l) ta mavzu"; }
put_darslar "$APP/public" asosiy "$APP/.darslar.tgz"
rasm_olish; put_rasmlar "$APP/public" asosiy "$APP/.rasmlar.tgz"
# yangi o'quvchi kabineti hozircha saytda yo'q (kelishilgandan keyin qo'yiladi): eski sinov fayllari o'chiriladi
rm -rf "$APP/public/oq" "$APP/public/oq.new" "$APP/public/oq.old" "$APP/.oq.tgz"
chown -R yx:yx "$APP"
chmod 700 "$APP/data" "$APP/backups"

say "3/8 Sayt xizmati sozlanmoqda"
if [ "$MODE" = full ] || [ ! -f /etc/systemd/system/yx.service ]; then
cat > /etc/systemd/system/yx.service <<EOF
[Unit]
Description=Yosh Xorazmiylar
After=network.target
[Service]
User=yx
WorkingDirectory=$APP
Environment=DATA_DIR=$APP/data
Environment=PORT=3000
ExecStart=/usr/bin/node --no-warnings $APP/server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable yx >/dev/null 2>&1
fi
if [ "$SRV_CH" = 1 ] || ! systemctl is-active --quiet yx; then
  systemctl restart yx
  sleep 2
  if ! systemctl is-active --quiet yx; then
    echo "Sayt yangi server.js bilan ishga tushmadi:"; journalctl -u yx -n 30 --no-pager || true
    if [ "$SRV_CH" = 1 ] && [ -f "$APP/server.js.prev" ]; then # avvalgi ishlab turgan nusxaga qaytish
      cp -p "$APP/server.js" "$APP/server.js.yomon"; cp -p "$APP/server.js.prev" "$APP/server.js"; chown yx:yx "$APP/server.js"
      systemctl restart yx; sleep 2
      systemctl is-active --quiet yx && echo "Avvalgi server.js qaytarildi — sayt ishlayapti." || echo "DIQQAT: avvalgi nusxa bilan ham ishga tushmadi!"
    fi
    exit 1
  fi
  echo "Asosiy sayt qayta ishga tushirildi (server.js o'zgardi)."
else
  echo "Asosiy sayt qayta ishga tushirilmadi (server.js o'zgarmagan)."
fi

if [ "$MODE" = full ]; then
say "4/8 Veb-server (nginx) sozlanmoqda"
if [ ! -f /etc/nginx/sites-available/yx ]; then
cat > /etc/nginx/sites-available/yx <<EOF
server {
listen 80;
server_name $DOMAIN www.$DOMAIN;
client_max_body_size 10m;
location / {
proxy_pass http://127.0.0.1:3000;
proxy_set_header Host \$host;
proxy_set_header X-Real-IP \$remote_addr;
proxy_set_header X-Forwarded-Proto \$scheme;
}
}
EOF
fi
ln -sf /etc/nginx/sites-available/yx /etc/nginx/sites-enabled/yx
rm -f /etc/nginx/sites-enabled/default
[ -f /etc/nginx/nginx.conf.yxbak ] || cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.yxbak
# siqish (gzip): Ubuntu'ning o'z nginx.conf faylida gzip bor — faqat izohdagi sozlamalarini yoqamiz
rm -f /etc/nginx/conf.d/yx-gzip.conf
sed -i -E 's/^([[:space:]]*)#[[:space:]]*(gzip_(vary|proxied|comp_level|types)[[:space:]])/\1\2/' /etc/nginx/nginx.conf
grep -qE '^[[:space:]]*gzip[[:space:]]+on' /etc/nginx/nginx.conf || sed -i -E 's/^([[:space:]]*)#[[:space:]]*gzip[[:space:]]+on;/\1gzip on;/' /etc/nginx/nginx.conf
nginx -t -q 2>/dev/null || { echo "DIQQAT: gzip sozlamasi qabul qilinmadi, qaytarildi"; cp /etc/nginx/nginx.conf.yxbak /etc/nginx/nginx.conf 2>/dev/null || true; }
nginx -t -q
systemctl reload nginx

say "5/8 Xavfsiz ulanish (https) sozlanmoqda"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; fi
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect -q \
|| certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect -q \
|| echo "DIQQAT: https sozlanmadi. Domen serverga ulanganini tekshiring, keyin buyruqni qayta ishga tushiring."
else
echo "https allaqachon sozlangan."
fi
fi

# Sinov bazasidagi shaxsiy ma'lumotlarni niqoblash (17.11.2026).
# Sinov sayti haqiqiy bazaning nusxasi bilan ishlaydi, lekin nusxada haqiqiy odamlar ma'lumoti QOLMAYDI:
# o'quvchi, ota-ona, o'qituvchi va direktorlarning ismi, telefon raqami va PIN kodi soxtasiga almashtiriladi; yozishmalar matni,
# rasmlar, kirish tokenlari, tarix, savat va Telegram bog'lanishlari olib tashlanadi. Jamoa (CEO va loyiha jamoasi) hisoblari o'zgarmaydi.
# «Sinov uchun maktab» deb belgilangan maktablar ham o'zgarmaydi: CEO o'sha kabinetlarga o'z raqami va PIN'i bilan kirib tekshiradi.
# Sinflar, natijalar, testlar va raqamlar joyida qoladi — sayt xuddi haqiqiydek sinaladi.
# Tartib o'zgarsa NIQOB_V oshiriladi: mavjud sinov bazasi keyingi yangilanishda qayta niqoblanadi.
NIQOB_V=1
niqobla(){ # $1 = sinov bazasi fayli (faqat $APPT ichida)
  case "$1" in "$APPT"/*) ;; *) echo "niqobla: faqat sinov bazasi uchun"; return 1;; esac
  cat > /tmp/yx-niqob.js <<'JS'
// Sinov bazasidagi haqiqiy odamlar ma'lumotini soxta ma'lumot bilan almashtiradi. FAQAT sinov bazasida ishlaydi.
// node niqob.js <baza fayli> <sinov papkasi> <versiya>
const { DatabaseSync } = require('node:sqlite'); const path = require('node:path'); const crypto = require('node:crypto');
const [file, root, V] = process.argv.slice(2);
if (!file || !root || !path.resolve(file).startsWith(path.resolve(root) + path.sep) || !/test|sinov/i.test(path.resolve(root))) { console.error('niqob: bu faqat sinov bazasi uchun'); process.exit(2); }
const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout=10000');
const has = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const cols = t => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name));
const all = (q, ...a) => db.prepare(q).all(...a), run = (q, ...a) => db.prepare(q).run(...a);
if (!has('settings') || !has('users') || !has('students')) { console.error('niqob: baza tuzilishi kutilgandek emas'); process.exit(3); }
if (String(db.prepare("SELECT value FROM settings WHERE key='niqob'").get()?.value || '') === String(V)) process.exit(0);
const p9 = p => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };
const FAM = ['Karimov', 'Rahimov', 'Tursunov', 'Salimov', 'Rustamov', 'Yusupov', 'Qodirov', 'Nazarov', 'Ergashev', 'Sobirov', 'Hamidov', 'Normatov', 'Ismoilov', 'Olimov', 'Sharipov', 'Murodov', 'Jo‘rayev', 'Hasanov', 'Aliyev', 'Boboyev', 'Xolmatov', 'Mahmudov', 'Zokirov', 'Toshev', 'Safarov', 'Ne’matov', 'Azimov', 'Latipov', 'Umarov', 'G‘aniyev'];
const BOY = ['Abdulloh', 'Asadbek', 'Bekzod', 'Bobur', 'Diyorbek', 'Elyor', 'Farrux', 'Javohir', 'Kamron', 'Mirzo', 'Nodir', 'Otabek', 'Sardor', 'Temur', 'Ulug‘bek', 'Shahzod', 'Islom', 'Jasur', 'Azizbek', 'Sanjar'];
const GIRL = ['Aziza', 'Dilnoza', 'Gulnoza', 'Madina', 'Nigora', 'Sevara', 'Zarina', 'Malika', 'Mohira', 'Shahzoda', 'Kamola', 'Feruza', 'Nilufar', 'Sabina', 'Umida', 'Laylo', 'Munisa', 'Iroda', 'Charos', 'Durdona'];
const fem = f => f.endsWith('yev') || f.endsWith('ov') || f.endsWith('ev') ? f + 'a' : f;
let nN = 0, qiz = 0; // qiz: oxirgi tuzilgan ism qiz bolanikimi (otasining ismi shunga mos bo'ladi)
const ism = jins => { const i = nN++, f = FAM[(i * 7 + 3) % FAM.length]; qiz = jins === 'a' ? 1 : jins === 'e' ? 0 : i % 2; return qiz ? fem(f) + ' ' + GIRL[(i * 11 + 5) % GIRL.length] : f + ' ' + BOY[(i * 13 + 1) % BOY.length]; };
const pat = () => BOY[(nN * 3) % BOY.length] + (qiz ? ' qizi' : ' o‘g‘li');
db.exec('BEGIN');
try {
  // jamoa (CEO va loyiha jamoasi) va namuna kabinet hisoblari o'zgarmaydi: ular sinov saytiga o'z raqami bilan kiradi
  const keep = new Set(); let demo = new Set();
  try { demo = new Set(Object.values(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='demo_users'").get()?.value || '{}')).map(Number)); } catch (e) { }
  const demoSchool = +(db.prepare("SELECT value FROM settings WHERE key='demo_school'").get()?.value || 0);
  for (const u of all("SELECT id,role,phone FROM users")) if (u.role === 'ceo' || u.role === 'jamoa' || demo.has(u.id)) { const p = p9(u.phone); if (p) keep.add(p); }
  { const p = p9(db.prepare("SELECT value FROM settings WHERE key='ceo_phone'").get()?.value); if (p) keep.add(p); }
  // «Sinov uchun maktab» deb belgilangan maktablar (CEO o'zi tekshirish uchun ochgan): ularning sinflari, o'quvchilari, sinf rahbari,
  // direktori va ota-onalari ham o'zgarmaydi — CEO sinov saytida o'sha kabinetlarga o'z raqami va PIN'i bilan kira oladi
  const sinovSch = new Set(cols('schools').has('test') ? all('SELECT id FROM schools WHERE test=1').map(r => r.id) : []); if (demoSchool) sinovSch.add(demoSchool);
  const sinovCls = new Set(all('SELECT id,school_id FROM classes').filter(c => sinovSch.has(c.school_id)).map(c => c.id));
  for (const s of all('SELECT id,director_phone FROM schools')) if (sinovSch.has(s.id)) { const p = p9(s.director_phone); if (p) keep.add(p); }
  for (const c of all('SELECT id,teacher_phone FROM classes')) if (sinovCls.has(c.id)) { const p = p9(c.teacher_phone); if (p) keep.add(p); }
  for (const s of all('SELECT id,class_id,phone FROM students')) if (sinovCls.has(s.class_id)) { const p = p9(s.phone); if (p) keep.add(p); if (has('student_phones')) for (const x of all('SELECT phone FROM student_phones WHERE student_id=?', s.id)) { const q = p9(x.phone); if (q) keep.add(q); } }
  const ozi = u => u.role === 'ceo' || u.role === 'jamoa' || demo.has(u.id) || sinovSch.has(u.school_id) || sinovCls.has(u.class_id) || (u.role === 'ota' && keep.has(p9(u.phone)));
  // telefon raqamlari: bitta haqiqiy raqam hamma joyda bitta soxta raqamga aylanadi (ota-ona va bola bog'lanishi saqlanadi)
  const tel = new Map(); let nT = 0; const names = new Map();
  const ph = p => { const k = p9(p); if (!k) return ''; if (keep.has(k) || k.startsWith('00')) return k; if (!tel.has(k)) tel.set(k, '00' + String(2000001 + nT++)); return tel.get(k); };
  const nameOf = (phone, jins) => { const k = p9(phone); if (!k) return ism(jins); if (!names.has(k)) names.set(k, ism(jins)); return names.get(k); }; // bitta odam (raqam) — bitta ism
  const st = { odam: 0, bola: 0 };
  const uc = cols('users');
  for (const u of all('SELECT * FROM users')) {
    if (ozi(u)) continue;
    let pin = u.pin; if (pin != null && /^\d{6}$/.test(String(pin))) { do { pin = String(crypto.randomInt(100000, 1000000)); } while (db.prepare('SELECT 1 FROM users WHERE pin=?').get(pin)); }
    run('UPDATE users SET name=?,phone=?,pin=? WHERE id=?', nameOf(u.phone, u.jins), ph(u.phone), pin, u.id);
    if (uc.has('avatar')) run("UPDATE users SET avatar='' WHERE id=?", u.id); if (uc.has('pass')) run("UPDATE users SET pass='' WHERE id=?", u.id); st.odam++;
  }
  const demoCls = sinovCls;
  for (const s of all('SELECT id,director_name,director_phone FROM schools')) if (!sinovSch.has(s.id)) run('UPDATE schools SET director_name=?,director_phone=? WHERE id=?', s.director_name || p9(s.director_phone) ? nameOf(s.director_phone) : '', ph(s.director_phone), s.id);
  for (const c of all('SELECT id,teacher_name,teacher_phone FROM classes')) if (!demoCls.has(c.id)) run('UPDATE classes SET teacher_name=?,teacher_phone=? WHERE id=?', c.teacher_name || p9(c.teacher_phone) ? nameOf(c.teacher_phone, 'a') : '', ph(c.teacher_phone), c.id);
  const sc = cols('students');
  for (const s of all('SELECT * FROM students')) {
    if (demoCls.has(s.class_id)) continue;
    run('UPDATE students SET name=?,phone=? WHERE id=?', ism(s.jins), ph(s.phone), s.id);
    if (sc.has('patronymic')) run('UPDATE students SET patronymic=? WHERE id=?', s.patronymic ? pat() : '', s.id);
    if (sc.has('avatar')) run("UPDATE students SET avatar='' WHERE id=?", s.id);
    run("UPDATE students SET birth_year=NULL,address='' WHERE id=?", s.id); st.bola++;
  }
  for (const t of ['student_phones', 'phone_hints']) if (has(t)) { const rows = all(`SELECT rowid r,phone FROM ${t}`); for (const r of rows) run(`UPDATE OR REPLACE ${t} SET phone=? WHERE rowid=?`, ph(r.phone) || '000000000', r.r); }
  if (has('royxat')) for (const r of all('SELECT id,phone,jins FROM royxat')) { const n = ism(r.jins).split(' '); run("UPDATE royxat SET chat_id=?,phone=?,fam=?,ism=?,pat=? WHERE id=?", 'sinov-' + r.id, ph(r.phone), n[0], n[1], pat(), r.id); }
  // yozishmalar va izohlar: matni almashtiriladi, rasm va ovoz olib tashlanadi
  if (has('messages')) { run("UPDATE messages SET text='Sinov xabari', image=''"); if (cols('messages').has('audio')) run("UPDATE messages SET audio=''"); }
  if (has('notes')) run("UPDATE notes SET text='Sinov izohi'");
  if (has('rnotes')) run("UPDATE rnotes SET text='Sinov izohi'");
  if (has('mcerts')) for (const r of all('SELECT id FROM mcerts')) run('UPDATE mcerts SET name=? WHERE id=?', ism(), r.id);
  if (has('cert_log')) run("UPDATE cert_log SET name='Sinov O‘quvchi' WHERE name<>''");
  if (has('kj_xato')) run("UPDATE kj_xato SET who=''");
  // haqiqiy odamlarga xabar yuborish vositalari, kirish tokenlari, tarix va savat — butunlay olib tashlanadi
  for (const t of ['sessions', 'tg_users', 'push_subs', 'tg_requests', 'audit', 'trash']) if (has(t)) run(`DELETE FROM ${t}`);
  run("DELETE FROM settings WHERE key IN ('bot_token','bot_username','bot_error')");
  run("INSERT INTO settings(key,value) VALUES('niqob',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(V));
  db.exec('COMMIT');
  console.log(`Sinov bazasi niqoblandi: ${st.bola} o'quvchi, ${st.odam} kattalar, ${tel.size} telefon raqami almashtirildi.`);
} catch (e) { db.exec('ROLLBACK'); console.error('niqob xatosi:', e.message); process.exit(1); }
// o'chirilgan ma'lumot fayl ichida ham qolmasin
try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.exec('VACUUM'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('niqob: VACUUM bajarilmadi:', e.message); process.exit(1); }
db.close();
JS
  local r=0; node --no-warnings /tmp/yx-niqob.js "$1" "$APPT" "$NIQOB_V" || r=$?
  rm -f /tmp/yx-niqob.js; return $r; }

say "6/8 Sinov sayti (test.$DOMAIN)"
sinov_sayti(){
# GitHub'da test-server.js va test-index.html bo'lsa — alohida sinov sayti ishga tushadi.
# U haqiqiy bazaning NIQOBLANGAN nusxasi bilan ishlaydi (shaxsiy ma'lumotlar soxtasiga almashtirilgan — yuqoridagi niqobla):
# u yerdagi o'zgarishlar asosiy saytga hech qachon tegmaydi, asosiy baza faqat o'qiladi.
# Bu qism FAQAT sinov saytiga tegadi: asosiy xizmat (yx) bu yerda hech qachon qayta ishga tushirilmaydi.
if olish test-server.js /tmp/yx-ts.js 2>/dev/null && olish test-index.html /tmp/yx-ti.html 2>/dev/null \
   && grep -q "Yosh Xorazmiylar" /tmp/yx-ts.js && node --check /tmp/yx-ts.js; then
  mkdir -p "$APPT/public" "$APPT/data" "$APPT/backups"
  TST_CH=0
  if cmp -s /tmp/yx-ts.js "$APPT/server.js" 2>/dev/null; then rm -f /tmp/yx-ts.js; else mv /tmp/yx-ts.js "$APPT/server.js"; TST_CH=1; fi
  if cmp -s /tmp/yx-ti.html "$APPT/public/index.html" 2>/dev/null; then rm -f /tmp/yx-ti.html; else mv /tmp/yx-ti.html "$APPT/public/index.html"; echo "Sahifa yangilandi (sinov)"; fi
  put_darslar "$APPT/public" sinov "$APPT/.darslar.tgz"
  put_rasmlar "$APPT/public" sinov "$APPT/.rasmlar.tgz"
  if [ ! -f "$APPT/data/yx.db" ] || [ -f "$APPT/.yangila" ]; then
    systemctl stop yx-test 2>/dev/null || true
    rm -f "$APPT/data/yx.db" "$APPT/data/yx.db-wal" "$APPT/data/yx.db-shm" "$APPT/.yangila"
    sqlite3 "$APP/data/yx.db" ".backup '$APPT/data/yx.db'" && echo "Sinov sayti uchun bazaning nusxasi olindi."
    TST_CH=1
  fi
  # Nusxa (yangisi ham, avvaldan turgani ham) niqoblanmagan bo'lsa — sinov sayti ishga tushishidan OLDIN niqoblanadi.
  # Niqoblab bo'lmasa, nusxa o'chiriladi va sinov sayti ishga tushirilmaydi: haqiqiy ma'lumot sinov saytida ochiq qolmaydi.
  if [ -f "$APPT/data/yx.db" ] && [ "$(sqlite3 "$APPT/data/yx.db" "SELECT value FROM settings WHERE key='niqob'" 2>/dev/null || true)" != "$NIQOB_V" ]; then
    systemctl stop yx-test 2>/dev/null || true
    if niqobla "$APPT/data/yx.db"; then
      # niqoblanmagan eski nusxalar (sinov saytining o'z zaxiralari) ham olib tashlanadi; asosiy sayt zaxiralariga tegilmaydi
      rm -f "$APPT/backups/"*.db "$APPT/data/restore.db" "$APPT/data/restore.tmp"
      TST_CH=1
    else
      rm -f "$APPT/data/yx.db" "$APPT/data/yx.db-wal" "$APPT/data/yx.db-shm"
      echo "DIQQAT: sinov bazasi niqoblanmadi — nusxa o'chirildi, sinov sayti to'xtatildi."
      return 1
    fi
  fi
  chown -R yx:yx "$APPT"; chmod 700 "$APPT/data"
  if [ "$MODE" = full ] || [ ! -f /etc/systemd/system/yx-test.service ]; then
  cat > /etc/systemd/system/yx-test.service <<EOF
[Unit]
Description=Yosh Xorazmiylar (sinov)
After=network.target
[Service]
User=yx
WorkingDirectory=$APPT
Environment=DATA_DIR=$APPT/data
Environment=BACKUP_DIR=$APPT/backups
Environment=PORT=3001
Environment=YX_TEST=1
Environment=NO_BOT=1
ExecStart=/usr/bin/node --no-warnings $APPT/server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload; systemctl enable yx-test >/dev/null 2>&1; TST_CH=1
  fi
  if [ "$TST_CH" = 1 ] || ! systemctl is-active --quiet yx-test; then systemctl restart yx-test; echo "Sinov sayti qayta ishga tushirildi."; fi
  if [ "$MODE" = full ]; then
  if [ ! -f /etc/nginx/sites-available/yx-test ]; then
  cat > /etc/nginx/sites-available/yx-test <<EOF
server {
listen 80;
server_name test.$DOMAIN;
client_max_body_size 10m;
location / {
proxy_pass http://127.0.0.1:3001;
proxy_set_header Host \$host;
proxy_set_header X-Real-IP \$remote_addr;
proxy_set_header X-Forwarded-Proto \$scheme;
}
}
EOF
  fi
  ln -sf /etc/nginx/sites-available/yx-test /etc/nginx/sites-enabled/yx-test
  nginx -t -q && systemctl reload nginx
  if [ ! -d "/etc/letsencrypt/live/test.$DOMAIN" ]; then
    certbot --nginx -d "test.$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect -q \
    || echo "DIQQAT: test.$DOMAIN uchun https sozlanmadi — domen panelida 'test' yozuvi qo'shilganini tekshiring."
  fi
  fi
  echo "Sinov sayti: https://test.$DOMAIN"
else
  echo "GitHub'da test-server.js / test-index.html yo'q — sinov sayti o'tkazib yuborildi."
fi

}
sinov_sayti || echo "DIQQAT: sinov sayti sozlanmadi — asosiy sayt ishlayveradi."
rm -rf /tmp/yx-darslar.tgz /tmp/yx-darslar.txt "$DQ"

say "7/8 Kunlik zaxira nusxa sozlanmoqda"
cat > /etc/cron.d/yx-backup <<EOF
30 21 * * * root sqlite3 $APP/data/yx.db ".backup '$APP/backups/yx-\$(date +\%F).db'" && chown yx:yx $APP/backups/*.db && chmod 600 $APP/backups/*.db && find $APP/backups -name 'yx-*.db' -mtime +30 -delete && find $APP/backups -name 'oldin-*.db' -mtime +60 -delete
EOF
chmod 644 /etc/cron.d/yx-backup

# Avtomatik yangilanish: GitHub'ga yangi fayl yuklansa, server 5 daqiqa ichida o'zi o'rnatadi.
# avval yoniga yoziladi, keyin bir zumda almashtiriladi: ishlab turgan yangilovchi yarim yozilgan faylni o'qib qolmasin
cat > /usr/local/bin/yx-update.new <<'UPD'
#!/bin/bash
# Har 5 daqiqada: GitHub'dagi fayllar o'zgargan bo'lsa, install.sh "update" rejimida ishlaydi.
# U har faylni alohida solishtiradi: sinov fayli o'zgarsa — faqat sinov sayti; asosiy sayt faqat o'z server.js o'zgarsa qayta ishga tushadi.
R="https://raw.githubusercontent.com/sirojapps/yoshxorazmiylar/main"
exec 9>/run/yx-update.lock; flock -n 9 || exit 0
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
TS=$(date +%s)
curl -fsSL "$R/server.js?$TS" -o "$T/server.js" || exit 0
curl -fsSL "$R/index.html?$TS" -o "$T/index.html" || exit 0
curl -fsSL "$R/install.sh?$TS" -o "$T/install.sh" || exit 0
g(){ curl -fsSL "$R/$1?$TS" -o "$T/$1" 2>/dev/null || rm -f "$T/$1"; }
g darslar.tar.gz; g rasmlar.tar.gz; g test-server.js; g test-index.html
ch=0
cmp -s "$T/server.js" /opt/yx/server.js || ch=1
cmp -s "$T/index.html" /opt/yx/public/index.html || ch=1
cmp -s "$T/install.sh" /opt/yx/.install.sh || ch=1
[ -s "$T/darslar.tar.gz" ] && ! cmp -s "$T/darslar.tar.gz" /opt/yx/.darslar.tgz && ch=1
[ -s "$T/rasmlar.tar.gz" ] && ! cmp -s "$T/rasmlar.tar.gz" /opt/yx/.rasmlar.tgz && ch=1
[ -s "$T/test-server.js" ] && ! cmp -s "$T/test-server.js" /opt/yx-test/server.js && ch=1
[ -s "$T/test-index.html" ] && ! cmp -s "$T/test-index.html" /opt/yx-test/public/index.html && ch=1
[ -s "$T/darslar.tar.gz" ] && [ -f /opt/yx-test/server.js ] && ! cmp -s "$T/darslar.tar.gz" /opt/yx-test/.darslar.tgz && ch=1
[ -f /opt/yx-test/.yangila ] && ch=1
[ $ch = 0 ] && exit 0
H=$(cat "$T"/* | sha256sum | cut -c1-16)
[ "$(cat /opt/yx/.last-try 2>/dev/null)" = "$H" ] && [ ! -f /opt/yx-test/.yangila ] && exit 0
echo "=== $(date '+%F %T') yangilanish boshlandi" >> /var/log/yx-update.log
YX_SRC="$T" bash "$T/install.sh" update >> /var/log/yx-update.log 2>&1 \
&& { cp "$T/install.sh" /opt/yx/.install.sh; echo "=== $(date '+%F %T') muvaffaqiyatli" >> /var/log/yx-update.log; } \
|| { echo "$H" > /opt/yx/.last-try; echo "=== $(date '+%F %T') XATO, eski versiya ishlab turibdi" >> /var/log/yx-update.log; }
UPD
chmod 755 /usr/local/bin/yx-update.new
mv -f /usr/local/bin/yx-update.new /usr/local/bin/yx-update
echo "*/5 * * * * root /usr/local/bin/yx-update" > /etc/cron.d/yx-update
chmod 644 /etc/cron.d/yx-update
echo "Avtomatik yangilanish yoqildi."

say "8/8 Tayyor!"
echo "Sayt: https://$DOMAIN"
# CEO PIN kodi hech qachon jurnalga yozilmaydi: faqat qo'lda (terminalda) to'liq o'rnatishda bir marta ko'rsatiladi
if [ "$MODE" = full ] && [ -t 1 ] && [ -f "$APP/data/ceo-pin.txt" ]; then
echo
echo " Sizning CEO PIN kodingiz: $(cat "$APP/data/ceo-pin.txt")"
echo " Uni yozib oling. Keyin ko'rish uchun: cat $APP/data/ceo-pin.txt"
fi
