#!/bin/bash
# Yosh Xorazmiylar — serverga o'rnatish va yangilash.
# Birinchi marta ham, o'rnatuvchining o'zini yangilash uchun ham shu bitta buyruq (serverda, root):
# curl -fsSL https://raw.githubusercontent.com/sirojapps/yoshxorazmiylar/chiqarish/install.sh | sudo bash
#
# 24.11.2026 dan tartib (kod auditi):
#  - ASOSIY sayt fayllari `chiqarish` branchidan olinadi. U yerga GitHub'dagi avtomatik tekshiruvdan o'tgan main yoziladi.
#  - SINOV sayti fayllari `main` branchidan olinadi (har yuklashdan keyin 5 daqiqa ichida).
#  - Har 5 daqiqalik yangilovchi GitHub'dan yuklangan hech bir buyruqni root sifatida BAJARMAYDI: u serverdagi shu faylning
#    o'z nusxasini (/usr/local/lib/yx/install.sh) ishlatadi. install.sh o'zgarsa, u faqat yuqoridagi buyruq bilan qo'lda yangilanadi.
#  - Sinov sayti alohida `yx-test` foydalanuvchisida ishlaydi va asosiy sayt papkasini o'qiy olmaydi.
set -euo pipefail

REPO_BASE="https://raw.githubusercontent.com/sirojapps/yoshxorazmiylar"
REPO="$REPO_BASE/chiqarish" # asosiy sayt
REPO_T="$REPO_BASE/main"    # sinov sayti
DOMAIN="yoshxorazmiylar.uz"
APP="/opt/yx"
APPT="/opt/yx-test"
ORN="/usr/local/lib/yx/install.sh" # yangilovchi ishlatadigan o'rnatuvchi nusxasi (faqat root o'zgartira oladi)
export DEBIAN_FRONTEND=noninteractive

# Rejim: "full" (birinchi o'rnatish yoki qo'lda) — hammasi; "update" (avtomatik yangilanish) — faqat o'zgargan fayllar.
# Qoida: ASOSIY sayt faqat o'zining server.js fayli (yoki xizmat sozlamasi) o'zgarganda qayta ishga tushadi. Sinov fayllari unga tegmaydi.
MODE="${1:-full}"
case "$MODE" in full|update) ;; *) echo "Noma'lum rejim: $MODE (full yoki update)"; exit 1;; esac
say(){ echo; echo "==> $*"; }
[ "$(id -u)" = "0" ] || { echo "Bu buyruqni root sifatida ishga tushiring (yoki boshiga sudo qo'shing)."; exit 1; }
TS=$(date +%s)
# vaqtinchalik fayllar faqat shu ish uchun ochilgan papkada (boshqa foydalanuvchi oldindan joy tayyorlab qo'ya olmaydi)
W=$(mktemp -d /tmp/yx-ish.XXXXXXXX); trap 'rm -rf "$W"' EXIT; mkdir -p "$W/p/q" "$W/t/q"
# faylni olish. $1 = p (asosiy sayt, `chiqarish`) yoki t (sinov sayti, `main`), $2 = fayl nomi, $3 = qayerga.
# Yangilovchi allaqachon yuklab qo'ygan bo'lsa (YX_P / YX_T) — o'sha yerdan, bo'lmasa GitHub'dan.
olish(){
  local src url
  if [ "$1" = p ]; then src="${YX_P:-}"; url="$REPO"; else src="${YX_T:-}"; url="$REPO_T"; fi
  if [ -n "$src" ] && [ -s "$src/$2" ]; then cp "$src/$2" "$3"; else curl -fsSL "$url/$2?$TS" -o "$3"; fi; }

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
# Arxiv ichidagi k/ papka — kabinet sahifalari.
# darslar.tar.gz → public/darslar. Har sayt (asosiy va sinov) O'Z manbasidan O'Z nusxasini oladi.
# Darslar ko'payib, bitta arxiv GitHub chegarasiga (100 MB) yaqinlashgani uchun dars fayllari BO'LAKLARDA (darslar-<sinf>-<chorak>.tar.gz) turadi.
# Asosiy arxiv ichidagi qismlar.txt har bo'lakning nomi va sha256 yig'indisini aytadi: bo'lak o'zgarsa asosiy arxiv ham o'zgaradi.
# Biror bo'lak hali yetib kelmagan yoki yig'indisi mos kelmasa — darslar papkasiga tegilmaydi, keyingi yangilanishda qayta uriniladi.
# Arxivlar root huquqida ochiladi: ichida faqat oddiy fayl va papka bo'lishi shart. Havola (symlink/hardlink), qurilma fayli,
# "/" bilan boshlanadigan yoki ".." li yo'l bo'lsa — arxiv umuman ochilmaydi (papkadan tashqariga yozib bo'lmasin).
tar_toza(){ # $1 = arxiv. Toza bo'lsa 0
  local t n; t=$(tar -tvzf "$1" 2>/dev/null) || return 1; n=$(tar -tzf "$1" 2>/dev/null) || return 1
  # grep -q emas: pipefail bilan grep erta chiqsa printf SIGPIPE oladi va natija teskari bo'lib qolishi mumkin
  if printf '%s\n' "$t" | grep -v '^[-d]' >/dev/null; then echo "DIQQAT: $(basename "$1") ichida oddiy fayl/papkadan boshqa narsa (havola va h.k.) bor — ochilmadi."; return 1; fi
  if printf '%s\n' "$n" | grep -E '^/|(^|/)\.\.(/|$)' >/dev/null; then echo "DIQQAT: $(basename "$1") ichida papkadan tashqariga chiqadigan yo'l bor — ochilmadi."; return 1; fi
  return 0; }
arxiv_tayyorla(){ # $1 = p | t. Natija: $W/$1/darslar.tgz + q/ (bo'laklar) va dars.ok; $W/$1/rasm.tgz va rasm.ok
  local d="$W/$1" ok=0 QH QF
  : > "$d/q/qismlar.txt"
  if olish "$1" darslar.tar.gz "$d/darslar.tgz" 2>/dev/null && tar -tzf "$d/darslar.tgz" > "$d/darslar.txt" 2>/dev/null && grep -qx 'index.html' "$d/darslar.txt" && tar_toza "$d/darslar.tgz"; then ok=1
    if grep -qx 'qismlar.txt' "$d/darslar.txt"; then
      tar -xzf "$d/darslar.tgz" -O qismlar.txt > "$d/q/qismlar.txt" 2>/dev/null || ok=0
      while read -r QH QF; do
        [ -n "${QF:-}" ] || continue
        case "$QF" in darslar-*.tar.gz) ;; *) ok=0; echo "Dars bo'lagi nomi noto'g'ri: $QF"; break;; esac
        case "$QF" in */*|*..*) ok=0; echo "Dars bo'lagi nomi noto'g'ri: $QF"; break;; esac
        if olish "$1" "$QF" "$d/q/$QF" 2>/dev/null && [ "$(sha256sum "$d/q/$QF" | cut -d' ' -f1)" = "$QH" ] && tar -tzf "$d/q/$QF" >/dev/null 2>&1 && tar_toza "$d/q/$QF"; then :
        else ok=0; echo "Dars bo'lagi hali tayyor emas: $QF (keyingi yangilanishda qayta uriniladi)"; break; fi
      done < "$d/q/qismlar.txt"
    fi
  fi
  if [ "$ok" = 1 ]; then touch "$d/dars.ok"; fi
  if olish "$1" rasmlar.tar.gz "$d/rasm.tgz" 2>/dev/null && tar -tzf "$d/rasm.tgz" >/dev/null 2>&1 && tar_toza "$d/rasm.tgz"; then touch "$d/rasm.ok"; fi
  return 0; }
put_darslar(){ # $1 = public papka, $2 = asosiy | sinov, $3 = saqlangan arxiv nusxasi, $4 = p | t
  local d="$W/$4" QH QF
  [ -f "$d/dars.ok" ] || return 0
  if [ -d "$1/darslar" ] && [ ! -L "$1/darslar" ] && cmp -s "$d/darslar.tgz" "$3" && cmp -s "$d/q/qismlar.txt" "$1/darslar/.bolak-ok" 2>/dev/null; then return 0; fi # o'zgarmagan (.bolak-ok: bo'laklar ham shu papkaga yoyilganining belgisi)
  rm -rf "$1/darslar.new"; mkdir -p "$1/darslar.new"
  tar -xzf "$d/darslar.tgz" -C "$1/darslar.new" --no-same-owner
  while read -r QH QF; do [ -n "${QF:-}" ] || continue; tar -xzf "$d/q/$QF" -C "$1/darslar.new" --no-same-owner; done < "$d/q/qismlar.txt"
  cp "$d/q/qismlar.txt" "$1/darslar.new/.bolak-ok"
  rm -rf "$1/darslar.old"
  # eski tartibda sinov saytida bu papka asosiy saytga havola (symlink) edi: faqat havolaning o'zi olib tashlanadi, asosiy papkaga tegilmaydi
  if [ -L "$1/darslar" ]; then rm -f "$1/darslar"; elif [ -d "$1/darslar" ]; then mv "$1/darslar" "$1/darslar.old"; fi
  mv "$1/darslar.new" "$1/darslar"; rm -rf "$1/darslar.old"
  cp "$d/darslar.tgz" "$3"
  echo "Mavzu darslari o'rnatildi ($2): $(ls "$1/darslar/m" 2>/dev/null | wc -l) ta mavzu"; }
put_rasmlar(){ # $1 = public papka, $2 = asosiy | sinov, $3 = saqlangan arxiv nusxasi, $4 = p | t
  local d="$W/$4"
  [ -f "$d/rasm.ok" ] || return 0
  if [ -d "$1/a" ] && [ -e "$1/a/k" ] && cmp -s "$d/rasm.tgz" "$3"; then return 0; fi # o'zgarmagan
  rm -rf "$1/a.new"; mkdir -p "$1/a.new"
  tar -xzf "$d/rasm.tgz" -C "$1/a.new" --no-same-owner
  rm -rf "$1/a.old"; [ -d "$1/a" ] && mv "$1/a" "$1/a.old"; mv "$1/a.new" "$1/a"; rm -rf "$1/a.old"
  cp "$d/rasm.tgz" "$3"; echo "Rasmlar yangilandi ($2)"; }

# Xizmat (systemd) sozlamasi: matni o'zgargan bo'lsagina yoziladi (avvalgisi .prev bo'lib qoladi). O'zgargan bo'lsa 0 qaytaradi.
unit_yoz(){ # $1 = xizmat nomi, $2 = sozlama matni
  local f="/etc/systemd/system/$1.service"
  if [ -f "$f" ] && [ "$(cat "$f")" = "$2" ]; then return 1; fi
  # shu serverda avval ishlamagan sozlama qayta sinalmaydi (sayt har yangilanishda to'xtab-yonmasin). Qo'lda to'liq o'rnatish yana sinaydi.
  if [ "$MODE" != full ] && [ -f "$f.rad" ] && [ "$(printf '%s\n' "$2" | sha256sum)" = "$(cat "$f.rad")" ]; then return 1; fi
  [ -f "$f" ] && cp -p "$f" "$f.prev"
  rm -f "$f.rad" # qayta sinaladi; yana ishlamasa unit_qaytar belgini qayta qo'yadi
  printf '%s\n' "$2" > "$f.new"; mv -f "$f.new" "$f"
  systemctl daemon-reload; systemctl enable "$1" >/dev/null 2>&1 || true
  return 0; }
# Yangi sozlama bilan xizmat ishga tushmasa — avvalgi sozlamaga qaytiladi (sayt to'xtab qolmasin)
ishlayapti(){ # $1 = xizmat nomi: qayta ishga tushirib, 4 soniya ichida ikki marta tekshiradi (darrov yiqiladigan dastur "ishlayapti" deb o'tib ketmasin)
  systemctl restart "$1"; sleep 2; systemctl is-active --quiet "$1" || return 1; sleep 2; systemctl is-active --quiet "$1"; }
# Yangi sozlama bilan ishga tushmadi: avvalgi sozlama bilan sinab ko'riladi. Avvalgisi bilan ISHLASA — aybdor yangi sozlama:
# u shu serverda boshqa sinalmaydi (.rad, qo'lda to'liq o'rnatishgacha). Avvalgisi bilan ham ishlamasa — sozlama aybdor emas:
# yangi sozlama joyiga qaytariladi, .rad yozilmaydi.
unit_qaytar(){ # $1 = xizmat nomi
  local f="/etc/systemd/system/$1.service"
  [ -f "$f.prev" ] || return 1
  cp -p "$f" "$f.yomon"; cp -p "$f.prev" "$f"; systemctl daemon-reload
  if ishlayapti "$1"; then sha256sum < "$f.yomon" > "$f.rad"; echo "Yangi xizmat sozlamasi bilan ishga tushmadi — avvalgisi qaytarildi ($1)."; return 0; fi
  cp -p "$f.yomon" "$f"; systemctl daemon-reload; return 1; }
# Xizmat himoyasi: sayt dasturi faqat o'z data va backups papkasiga yoza oladi, tizimning qolgan qismi unga faqat o'qish uchun;
# yangi huquq ololmaydi (sudo/setuid ishlamaydi), /tmp o'ziniki, uy papkalari ko'rinmaydi.
himoya(){ # $1 = sayt papkasi
  printf '%s\n' "NoNewPrivileges=true" "PrivateTmp=true" "ProtectSystem=strict" "ProtectHome=true" "ReadWritePaths=$1/data $1/backups" \
    "ProtectKernelTunables=true" "ProtectKernelModules=true" "ProtectControlGroups=true" "RestrictSUIDSGID=true" "LockPersonality=true" "UMask=0077"; }

# O'rnatuvchining server nusxasi: yangilovchi faqat shuni ishlatadi. Qo'lda to'liq o'rnatishda (yoki nusxa hali yo'q bo'lsa) yoziladi.
if [ "$MODE" = full ] || [ ! -s "$ORN" ]; then
  mkdir -p "$(dirname "$ORN")"
  MEN="${BASH_SOURCE[0]:-}"
  if [ -n "$MEN" ] && [ -f "$MEN" ] && [ "$(readlink -f "$MEN")" = "$(readlink -f "$ORN" 2>/dev/null || true)" ]; then :
  else
    if [ -n "$MEN" ] && [ -f "$MEN" ]; then cp "$MEN" "$ORN.new"; else curl -fsSL "$REPO/install.sh?$TS" -o "$ORN.new"; fi
    if bash -n "$ORN.new" && grep -q "Yosh Xorazmiylar" "$ORN.new"; then chown root:root "$ORN.new"; chmod 755 "$ORN.new"; mv -f "$ORN.new" "$ORN"; echo "O'rnatuvchi nusxasi yangilandi: $ORN"
    else rm -f "$ORN.new"; echo "DIQQAT: o'rnatuvchi nusxasi yozilmadi"; fi
  fi
fi

say "2/8 Sayt fayllari yuklanmoqda"
id yx >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APP" yx
mkdir -p "$APP/public" "$APP/data" "$APP/backups"
olish p server.js "$W/p/server.js"
olish p index.html "$W/p/index.html"
grep -q "Yosh Xorazmiylar" "$W/p/server.js" || { echo "server.js yuklanmadi. GitHub'dagi fayl nomini tekshiring."; exit 1; }
grep -q "YOSH XORAZMIYLAR" "$W/p/index.html" || { echo "index.html yuklanmadi. GitHub'dagi fayl nomini tekshiring."; exit 1; }
# yozuvida xato bor server.js hech qachon o'rnatilmaydi: ishlab turgan fayl joyida qoladi
node --check "$W/p/server.js" || { echo "Yangi server.js da yozuv xatosi bor — o'rnatilmadi, sayt eski fayl bilan ishlayapti."; exit 1; }
# server.js faqat haqiqatan o'zgargan bo'lsa almashtiriladi (shundagina xizmat qayta ishga tushadi); eski nusxa saqlab qo'yiladi
SRV_CH=0
if ! cmp -s "$W/p/server.js" "$APP/server.js" 2>/dev/null; then
  # server.js almashishidan oldin bazaning nusxasi olinadi (kuniga bir marta; hech narsa o'chirilmaydi)
  ZB="$APP/backups/oldin-$(date +%F).db"
  if [ -f "$APP/data/yx.db" ] && [ ! -f "$ZB" ] && command -v sqlite3 >/dev/null 2>&1; then sqlite3 "$APP/data/yx.db" ".backup '$ZB'" && chmod 600 "$ZB" && echo "Zaxira nusxa olindi: $ZB" || echo "Zaxira nusxa olinmadi (davom etiladi)"; fi
  [ -f "$APP/server.js" ] && cp -p "$APP/server.js" "$APP/server.js.prev"
  cp "$W/p/server.js" "$APP/server.js.new"; mv -f "$APP/server.js.new" "$APP/server.js"; SRV_CH=1; fi
# sahifa: server uni har so'rovda diskdan o'qiydi — qayta ishga tushirish kerak emas
if ! cmp -s "$W/p/index.html" "$APP/public/index.html" 2>/dev/null; then
  cp "$W/p/index.html" "$APP/public/index.html.new"; mv -f "$APP/public/index.html.new" "$APP/public/index.html"; echo "Sahifa yangilandi (asosiy)"; fi
arxiv_tayyorla p
put_darslar "$APP/public" asosiy "$APP/.darslar.tgz" p
put_rasmlar "$APP/public" asosiy "$APP/.rasmlar.tgz" p
# yangi o'quvchi kabineti hozircha saytda yo'q (kelishilgandan keyin qo'yiladi): eski sinov fayllari o'chiriladi
rm -rf "$APP/public/oq" "$APP/public/oq.new" "$APP/public/oq.old" "$APP/.oq.tgz"
chown -R yx:yx "$APP"
chmod 750 "$APP"; chmod 700 "$APP/data" "$APP/backups"

say "3/8 Sayt xizmati sozlanmoqda"
UNIT_CH=0
if unit_yoz yx "[Unit]
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
$(himoya "$APP")
[Install]
WantedBy=multi-user.target"; then UNIT_CH=1; echo "Asosiy sayt xizmati sozlamasi yangilandi."; fi
if [ "$SRV_CH" = 1 ] || [ "$UNIT_CH" = 1 ] || ! systemctl is-active --quiet yx; then
  if ! ishlayapti yx; then
    echo "Sayt yangi fayl/sozlama bilan ishga tushmadi:"; journalctl -u yx -n 30 --no-pager || true
    # Qaysi o'zgarish aybdorligini aniqlash: avval yangi server.js + avvalgi sozlama (ishlasa — aybdor sozlama, o'rnatish davom etadi),
    # bo'lmasa avvalgi server.js (yangi sozlama bilan, kerak bo'lsa avvalgisi bilan ham) — aybdor server.js, yangilanish XATO deb belgilanadi.
    if [ "$UNIT_CH" = 1 ] && unit_qaytar yx; then
      echo "DIQQAT: himoyali xizmat sozlamasi bu serverda ishlamadi — sayt avvalgi sozlama bilan ishlayapti (qo'lda to'liq o'rnatishda qayta sinaladi)."
    else
      if [ "$SRV_CH" = 1 ] && [ -f "$APP/server.js.prev" ]; then # avvalgi ishlab turgan nusxaga qaytish
        cp -p "$APP/server.js" "$APP/server.js.yomon"; cp -p "$APP/server.js.prev" "$APP/server.js"; chown yx:yx "$APP/server.js"
        if ishlayapti yx; then echo "Avvalgi server.js qaytarildi — sayt ishlayapti."
        elif [ "$UNIT_CH" = 1 ] && unit_qaytar yx; then echo "Avvalgi server.js va avvalgi sozlama qaytarildi — sayt ishlayapti."
        else echo "DIQQAT: avvalgi nusxa bilan ham ishga tushmadi!"; fi
      fi
      exit 1
    fi
  else echo "Asosiy sayt qayta ishga tushirildi."; fi
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
# «Sinov uchun maktab» deb belgilangan maktablar ham o'zgarmaydi: CEO o'sha kabinetlarga o'z raqami bilan kirib tekshiradi.
# Sinflar, natijalar, testlar va raqamlar joyida qoladi — sayt xuddi haqiqiydek sinaladi.
# 24.11.2026 (2-versiya): sinov saytining PIN kaliti ALOHIDA (asosiy saytnikidan ko'chirilmaydi) va jamoa / sinov maktablari
# odamlariga sinov sayti uchun YANGI PIN beriladi — ular faqat serverdagi $SINOV_PINLAR faylida (root o'qiydi).
# Sinov sayti buzib kirilsa ham undan asosiy saytning birorta PIN'ini topib bo'lmaydi. Obuna jadvallari ham niqoblanadi.
# 3-versiya: CEO paroli ham sinov bazasiga o'tmaydi (asosiy saytdagi parol sinov saytida ishlamaydi) — CEO sinov saytiga sinov PIN'i bilan kiradi.
# Tartib o'zgarsa NIQOB_V oshiriladi: mavjud sinov bazasi keyingi yangilanishda qayta niqoblanadi.
NIQOB_V=3
SINOV_PINLAR="/root/yx-sinov-pinlar.txt"
niqobla(){ # $1 = sinov bazasi fayli (faqat $APPT ichida)
  case "$1" in "$APPT"/*) ;; *) echo "niqobla: faqat sinov bazasi uchun"; return 1;; esac
  cat > "$W/niqob.js" <<'JS'
// Sinov bazasidagi haqiqiy odamlar ma'lumotini soxta ma'lumot bilan almashtiradi. FAQAT sinov bazasida ishlaydi.
// node niqob.js <baza fayli> <sinov papkasi> <versiya> <sinov PIN'lari fayli>
const { DatabaseSync } = require('node:sqlite'); const path = require('node:path'); const crypto = require('node:crypto'); const fs = require('node:fs');
const [file, root, V, pinFile] = process.argv.slice(2);
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
  // sinov saytining o'z PIN kaliti (server.js dagi pinH bilan bir xil shifr). Asosiy saytning kaliti bu yerga kelmaydi.
  const KEY = crypto.randomBytes(32);
  const EK = crypto.createHmac('sha256', KEY).update('pin-shifr').digest(), IK = crypto.createHmac('sha256', KEY).update('pin-iv').digest();
  const pinH = p => { const t = String(p), iv = crypto.createHmac('sha256', IK).update(t).digest().subarray(0, 12); const c = crypto.createCipheriv('aes-256-gcm', EK, iv), x = Buffer.concat([c.update(t, 'utf8'), c.final()]); return 'h2$' + iv.toString('hex') + x.toString('hex') + c.getAuthTag().toString('hex'); };
  const usedPin = new Set(), sinovPin = [];
  const newPin = () => { let p; do { p = String(crypto.randomInt(100000, 1000000)); } while (usedPin.has(p)); usedPin.add(p); return p; };
  for (const u of all('SELECT * FROM users')) {
    if (ozi(u)) { // jamoa va sinov maktablari: ism va raqam o'sha, PIN — faqat sinov sayti uchun yangisi (namuna hisoblarining ichki belgisiga tegilmaydi)
      if (uc.has('pass')) run("UPDATE users SET pass='' WHERE id=?", u.id); // asosiy saytdagi parol sinov saytida ishlamaydi
      if (u.pin != null && String(u.pin) !== '' && !String(u.pin).startsWith('demo-')) { const p = newPin(); run('UPDATE users SET pin=? WHERE id=?', pinH(p), u.id); sinovPin.push([u.role, u.name || '', u.phone || '', p]); }
      else if (u.role === 'ceo') { const p = newPin(); run('UPDATE users SET pin=? WHERE id=?', pinH(p), u.id); sinovPin.push([u.role, u.name || '', u.phone || '', p]); } // parol bilan kirgan CEO'ning PIN'i bo'lmasligi mumkin
      continue;
    }
    // PIN: haqiqiy odamniki sinov saytida ishlamasin — eski (ochiq) yozuv ham, maxfiy kalitli yozuv ham tasodifiy qiymatga almashtiriladi
    let pin = u.pin; if (pin != null && String(pin) !== '') pin = 'h1$' + crypto.randomBytes(32).toString('hex');
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
  // obunalar: yozuvdagi ism va raqam (to'lov paytidagi nusxa) — bolaning yangi (soxta) ismi va soxta raqam; izoh olib tashlanadi
  if (has('obunalar')) { const sn = new Map(all('SELECT id,name FROM students').map(r => [r.id, r.name]));
    for (const r of all('SELECT id,student_id,phone FROM obunalar')) run("UPDATE obunalar SET phone=?,ism=?,izoh='' WHERE id=?", ph(r.phone), sn.get(r.student_id) || ism(), r.id); }
  if (has('obuna_sorov')) for (const r of all('SELECT id,phone FROM obuna_sorov')) run('UPDATE obuna_sorov SET phone=? WHERE id=?', ph(r.phone), r.id);
  // haqiqiy odamlarga xabar yuborish vositalari, kirish tokenlari, tarix va savat — butunlay olib tashlanadi
  for (const t of ['sessions', 'tg_users', 'push_subs', 'tg_requests', 'audit', 'trash']) if (has(t)) run(`DELETE FROM ${t}`);
  run("DELETE FROM settings WHERE key IN ('bot_token','bot_username','bot_error')");
  run("INSERT INTO settings(key,value) VALUES('niqob',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(V));
  // kalit va PIN'lar ro'yxati bazaga yozilishidan OLDIN saqlanadi (bittasi yozilmasa — hech narsa o'zgarmaydi)
  fs.writeFileSync(path.join(root, 'data', 'pin-kalit'), KEY.toString('hex') + '\n', { mode: 0o600 });
  if (pinFile) fs.writeFileSync(pinFile, `Sinov sayti (test.yoshxorazmiylar.uz) uchun PIN'lar — ${new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')} (Toshkent vaqti).\nFaqat sinov saytida ishlaydi (parol yo'q, PIN bilan kiriladi), asosiy saytdagi PIN va parolingiz o'zgarmagan.\n\n` + sinovPin.map(r => r.join(' | ')).join('\n') + '\n', { mode: 0o600 });
  db.exec('COMMIT');
  console.log(`Sinov bazasi niqoblandi: ${st.bola} o'quvchi, ${st.odam} kattalar, ${tel.size} telefon raqami almashtirildi; ${sinovPin.length} kishiga sinov PIN'i berildi (${pinFile || '-'}).`);
} catch (e) { db.exec('ROLLBACK'); console.error('niqob xatosi:', e.message); process.exit(1); }
// o'chirilgan ma'lumot fayl ichida ham qolmasin
try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.exec('VACUUM'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('niqob: VACUUM bajarilmadi:', e.message); process.exit(1); }
db.close();
JS
  local r=0; node --no-warnings "$W/niqob.js" "$1" "$APPT" "$NIQOB_V" "$SINOV_PINLAR" || r=$?
  rm -f "$W/niqob.js"; return $r; }


say "6/8 Sinov sayti (test.$DOMAIN)"
sinov_sayti(){
# `main` branchida test-server.js va test-index.html bo'lsa — alohida sinov sayti ishga tushadi.
# U haqiqiy bazaning NIQOBLANGAN nusxasi bilan ishlaydi (shaxsiy ma'lumotlar soxtasiga almashtirilgan — yuqoridagi niqobla):
# u yerdagi o'zgarishlar asosiy saytga hech qachon tegmaydi, asosiy baza faqat o'qiladi.
# Sinov sayti alohida `yx-test` foydalanuvchisida ishlaydi: asosiy sayt papkasini (/opt/yx) o'qiy olmaydi.
# Bu qism FAQAT sinov saytiga tegadi: asosiy xizmat (yx) bu yerda hech qachon qayta ishga tushirilmaydi.
if olish t test-server.js "$W/t/server.js" 2>/dev/null && olish t test-index.html "$W/t/index.html" 2>/dev/null \
   && grep -q "Yosh Xorazmiylar" "$W/t/server.js" && node --check "$W/t/server.js"; then
  id yx-test >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APPT" yx-test
  mkdir -p "$APPT/public" "$APPT/data" "$APPT/backups"
  TST_CH=0
  if ! cmp -s "$W/t/server.js" "$APPT/server.js" 2>/dev/null; then cp "$W/t/server.js" "$APPT/server.js.new"; mv -f "$APPT/server.js.new" "$APPT/server.js"; TST_CH=1; fi
  if ! cmp -s "$W/t/index.html" "$APPT/public/index.html" 2>/dev/null; then cp "$W/t/index.html" "$APPT/public/index.html.new"; mv -f "$APPT/public/index.html.new" "$APPT/public/index.html"; echo "Sahifa yangilandi (sinov)"; fi
  arxiv_tayyorla t
  put_darslar "$APPT/public" sinov "$APPT/.darslar.tgz" t
  put_rasmlar "$APPT/public" sinov "$APPT/.rasmlar.tgz" t
  if [ ! -f "$APPT/data/yx.db" ] || [ -f "$APPT/.yangila" ]; then
    systemctl stop yx-test 2>/dev/null || true
    rm -f "$APPT/data/yx.db" "$APPT/data/yx.db-wal" "$APPT/data/yx.db-shm" "$APPT/.yangila"
    sqlite3 "$APP/data/yx.db" ".backup '$APPT/data/yx.db'" && echo "Sinov sayti uchun bazaning nusxasi olindi."
    # PIN kaliti asosiy saytdan KO'CHIRILMAYDI: niqoblashda sinov saytining o'z kaliti yoziladi (yuqoridagi niqobla)
    rm -f "$APPT/data/pin-kalit"
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
  chown -R yx-test:yx-test "$APPT"; chmod 750 "$APPT"; chmod 700 "$APPT/data" "$APPT/backups"
  if unit_yoz yx-test "[Unit]
Description=Yosh Xorazmiylar (sinov)
After=network.target
[Service]
User=yx-test
WorkingDirectory=$APPT
Environment=DATA_DIR=$APPT/data
Environment=BACKUP_DIR=$APPT/backups
Environment=PORT=3001
Environment=YX_TEST=1
Environment=NO_BOT=1
ExecStart=/usr/bin/node --no-warnings $APPT/server.js
Restart=always
RestartSec=3
$(himoya "$APPT")
[Install]
WantedBy=multi-user.target"; then TST_CH=1; echo "Sinov sayti xizmati sozlamasi yangilandi."; fi
  if [ "$TST_CH" = 1 ] || ! systemctl is-active --quiet yx-test; then
    if ishlayapti yx-test; then echo "Sinov sayti qayta ishga tushirildi."
    else unit_qaytar yx-test && echo "Sinov sayti avvalgi xizmat sozlamasi bilan ishlayapti." || echo "DIQQAT: sinov sayti ishga tushmadi (xizmat sozlamasi aybdor emas — sinov server.js ni tekshiring)."; fi
  fi
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
  echo "GitHub'da (main) test-server.js / test-index.html yo'q — sinov sayti o'tkazib yuborildi."
fi

}
sinov_sayti || echo "DIQQAT: sinov sayti sozlanmadi — asosiy sayt ishlayveradi."

say "7/8 Kunlik zaxira nusxa sozlanmoqda"
cat > /etc/cron.d/yx-backup <<EOF
30 21 * * * root sqlite3 $APP/data/yx.db ".backup '$APP/backups/yx-\$(date +\%F).db'" && chown yx:yx $APP/backups/*.db && chmod 600 $APP/backups/*.db && find $APP/backups -name 'yx-*.db' -mtime +30 -delete && find $APP/backups -name 'oldin-*.db' -mtime +60 -delete
EOF
chmod 644 /etc/cron.d/yx-backup

# Avtomatik yangilanish: GitHub'ga yangi fayl yuklansa, server 5 daqiqa ichida o'zi o'rnatadi.
# Asosiy sayt — `chiqarish` branchidan, sinov sayti — `main`dan. Yuklangan fayllar faqat ma'lumot: hech biri root sifatida bajarilmaydi.
# avval yoniga yoziladi, keyin bir zumda almashtiriladi: ishlab turgan yangilovchi yarim yozilgan faylni o'qib qolmasin
cat > /usr/local/bin/yx-update.new <<'UPD'
#!/bin/bash
# Har 5 daqiqada: GitHub'dagi fayllar o'zgargan bo'lsa, serverdagi o'rnatuvchi nusxasi (/usr/local/lib/yx/install.sh) "update" rejimida ishlaydi.
# U har faylni alohida solishtiradi: sinov fayli o'zgarsa — faqat sinov sayti; asosiy sayt faqat o'z server.js o'zgarsa qayta ishga tushadi.
# GitHub'dagi install.sh bu yerda BAJARILMAYDI. U o'zgargan bo'lsa jurnalga eslatma yoziladi: qo'lda yangilanadi.
B="https://raw.githubusercontent.com/sirojapps/yoshxorazmiylar"
ORN=/usr/local/lib/yx/install.sh
LOG=/var/log/yx-update.log
exec 9>/run/yx-update.lock; flock -n 9 || exit 0
[ -s "$ORN" ] || { echo "=== $(date '+%F %T') DIQQAT: $ORN yo'q. Serverda qo'lda: curl -fsSL $B/chiqarish/install.sh | sudo bash" >> "$LOG"; exit 0; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; mkdir "$T/p" "$T/t" "$T/i"
TS=$(date +%s)
g(){ curl -fsSL "$B/$1/$2?$TS" -o "$T/$3/$2" 2>/dev/null || rm -f "$T/$3/$2"; } # $1 branch, $2 fayl, $3 p|t|i
g chiqarish server.js p; g chiqarish index.html p
[ -s "$T/p/server.js" ] && [ -s "$T/p/index.html" ] || exit 0
g chiqarish darslar.tar.gz p; g chiqarish rasmlar.tar.gz p; g chiqarish install.sh i
g main test-server.js t; g main test-index.html t; g main darslar.tar.gz t; g main rasmlar.tar.gz t
if [ -s "$T/i/install.sh" ] && ! cmp -s "$T/i/install.sh" "$ORN"; then
  H=$(sha256sum < "$T/i/install.sh" | cut -c1-16)
  [ "$(cat /var/lib/yx-install-eslatma 2>/dev/null)" = "$H" ] || { echo "=== $(date '+%F %T') ESLATMA: GitHub'dagi install.sh o'zgargan. Yangilash uchun serverda qo'lda: curl -fsSL $B/chiqarish/install.sh | sudo bash" >> "$LOG"; echo "$H" > /var/lib/yx-install-eslatma; }
fi
ch=0
cmp -s "$T/p/server.js" /opt/yx/server.js || ch=1
cmp -s "$T/p/index.html" /opt/yx/public/index.html || ch=1
[ -s "$T/p/darslar.tar.gz" ] && ! cmp -s "$T/p/darslar.tar.gz" /opt/yx/.darslar.tgz && ch=1
[ -s "$T/p/rasmlar.tar.gz" ] && ! cmp -s "$T/p/rasmlar.tar.gz" /opt/yx/.rasmlar.tgz && ch=1
[ -s "$T/t/test-server.js" ] && ! cmp -s "$T/t/test-server.js" /opt/yx-test/server.js && ch=1
[ -s "$T/t/test-index.html" ] && ! cmp -s "$T/t/test-index.html" /opt/yx-test/public/index.html && ch=1
[ -s "$T/t/darslar.tar.gz" ] && [ -f /opt/yx-test/server.js ] && ! cmp -s "$T/t/darslar.tar.gz" /opt/yx-test/.darslar.tgz && ch=1
[ -s "$T/t/rasmlar.tar.gz" ] && [ -f /opt/yx-test/server.js ] && ! cmp -s "$T/t/rasmlar.tar.gz" /opt/yx-test/.rasmlar.tgz && ch=1
[ -f /opt/yx-test/.yangila ] && ch=1
[ $ch = 0 ] && exit 0
H=$(cat "$T"/p/* "$T"/t/* | sha256sum | cut -c1-16)
[ "$(cat /opt/yx/.last-try 2>/dev/null)" = "$H" ] && [ ! -f /opt/yx-test/.yangila ] && exit 0
echo "=== $(date '+%F %T') yangilanish boshlandi" >> "$LOG"
YX_P="$T/p" YX_T="$T/t" bash "$ORN" update >> "$LOG" 2>&1 \
&& { rm -f /opt/yx/.last-try; echo "=== $(date '+%F %T') muvaffaqiyatli" >> "$LOG"; } \
|| { echo "$H" > /opt/yx/.last-try; echo "=== $(date '+%F %T') XATO, eski versiya ishlab turibdi" >> "$LOG"; }
UPD
chmod 755 /usr/local/bin/yx-update.new
mv -f /usr/local/bin/yx-update.new /usr/local/bin/yx-update
echo "*/5 * * * * root /usr/local/bin/yx-update" > /etc/cron.d/yx-update
chmod 644 /etc/cron.d/yx-update
rm -f "$APP/.install.sh" # eski tartibda yuklangan install.sh nusxasi endi kerak emas
rm -f /tmp/yx-rasm.tgz /tmp/yx-check.js /tmp/yx-ts.js /tmp/yx-ti.html /tmp/yx-darslar.tgz /tmp/yx-darslar.txt; rm -rf /tmp/yx-dq # eski tartibning vaqtinchalik fayllari
echo "Avtomatik yangilanish yoqildi (asosiy sayt: chiqarish, sinov sayti: main)."

say "8/8 Tayyor!"
echo "Sayt: https://$DOMAIN"
# CEO PIN kodi hech qachon jurnalga yozilmaydi: faqat qo'lda (terminalda) to'liq o'rnatishda bir marta ko'rsatiladi
if [ "$MODE" = full ] && [ -t 1 ] && [ -f "$APP/data/ceo-pin.txt" ]; then
echo
echo " Sizning CEO PIN kodingiz: $(cat "$APP/data/ceo-pin.txt")"
echo " Uni yozib oling. Keyin ko'rish uchun: cat $APP/data/ceo-pin.txt"
fi
