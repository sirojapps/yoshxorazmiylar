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

say(){ echo; echo "==> $*"; }
[ "$(id -u)" = "0" ] || { echo "Bu buyruqni root sifatida ishga tushiring (yoki boshiga sudo qo'shing)."; exit 1; }

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

# rasmlar.tar.gz → public/a  (sayt rasmlari alohida fayl: telefon bir marta yuklab, keyin xotiradan oladi)
put_rasmlar(){ # $1 = public papka
  if curl -fsSL "$REPO/rasmlar.tar.gz?$TS" -o /tmp/yx-rasm.tgz 2>/dev/null && tar -tzf /tmp/yx-rasm.tgz >/dev/null 2>&1; then
    rm -rf "$1/a.new"; mkdir -p "$1/a.new"; tar -xzf /tmp/yx-rasm.tgz -C "$1/a.new" --no-same-owner
    rm -rf "$1/a.old"; [ -d "$1/a" ] && mv "$1/a" "$1/a.old"; mv "$1/a.new" "$1/a"; rm -rf "$1/a.old"
  fi; }

say "2/8 Sayt fayllari yuklanmoqda"
id yx >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APP" yx
mkdir -p "$APP/public" "$APP/data" "$APP/backups"
TS=$(date +%s)
curl -fsSL "$REPO/server.js?$TS" -o "$APP/server.js.new"
curl -fsSL "$REPO/index.html?$TS" -o "$APP/public/index.html.new"
grep -q "Yosh Xorazmiylar" "$APP/server.js.new" || { echo "server.js yuklanmadi. GitHub'dagi fayl nomini tekshiring."; exit 1; }
grep -q "YOSH XORAZMIYLAR" "$APP/public/index.html.new" || { echo "index.html yuklanmadi. GitHub'dagi fayl nomini tekshiring."; exit 1; }
cp "$APP/server.js.new" /tmp/yx-check.js && node --check /tmp/yx-check.js && rm -f /tmp/yx-check.js
mv "$APP/server.js.new" "$APP/server.js"
mv "$APP/public/index.html.new" "$APP/public/index.html"
if curl -fsSL "$REPO/darslar.tar.gz?$TS" -o /tmp/yx-darslar.tgz 2>/dev/null && tar -tzf /tmp/yx-darslar.tgz > /tmp/yx-darslar.txt && grep -qx 'index.html' /tmp/yx-darslar.txt; then
rm -rf "$APP/public/darslar.new"; mkdir -p "$APP/public/darslar.new"
tar -xzf /tmp/yx-darslar.tgz -C "$APP/public/darslar.new" --no-same-owner
rm -rf "$APP/public/darslar.old"; [ -d "$APP/public/darslar" ] && mv "$APP/public/darslar" "$APP/public/darslar.old"
mv "$APP/public/darslar.new" "$APP/public/darslar"; rm -rf "$APP/public/darslar.old"
cp /tmp/yx-darslar.tgz "$APP/.darslar.tgz"
echo "Mavzu darslari o'rnatildi: $(ls "$APP/public/darslar/m" | wc -l) ta mavzu"
fi
rm -f /tmp/yx-darslar.tgz /tmp/yx-darslar.txt
put_rasmlar "$APP/public"; [ -f /tmp/yx-rasm.tgz ] && cp /tmp/yx-rasm.tgz "$APP/.rasmlar.tgz"
chown -R yx:yx "$APP"
chmod 700 "$APP/data" "$APP/backups"

say "3/8 Sayt xizmati sozlanmoqda"
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
systemctl restart yx
sleep 2
systemctl is-active --quiet yx || { echo "Sayt ishga tushmadi:"; journalctl -u yx -n 30 --no-pager; exit 1; }

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
# siqish (gzip): sahifa telefonga 3-4 baravar kichik bo'lib boradi
cat > /etc/nginx/conf.d/yx-gzip.conf <<'EOF'
gzip on;
gzip_vary on;
gzip_proxied any;
gzip_comp_level 6;
gzip_min_length 1024;
gzip_types text/plain text/css text/javascript application/javascript application/json application/manifest+json image/svg+xml;
EOF
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

say "6/8 Sinov sayti (test.$DOMAIN)"
# GitHub'da test-server.js va test-index.html bo'lsa — alohida sinov sayti ishga tushadi.
# U haqiqiy bazaning NUSXASI bilan ishlaydi: u yerdagi o'zgarishlar asosiy saytga hech qachon tegmaydi.
if curl -fsSL "$REPO/test-server.js?$TS" -o /tmp/yx-ts.js 2>/dev/null && curl -fsSL "$REPO/test-index.html?$TS" -o /tmp/yx-ti.html 2>/dev/null \
   && grep -q "Yosh Xorazmiylar" /tmp/yx-ts.js && node --check /tmp/yx-ts.js; then
  mkdir -p "$APPT/public" "$APPT/data" "$APPT/backups"
  mv /tmp/yx-ts.js "$APPT/server.js"; mv /tmp/yx-ti.html "$APPT/public/index.html"
  ln -sfn "$APP/public/darslar" "$APPT/public/darslar"
  put_rasmlar "$APPT/public"
  if [ ! -f "$APPT/data/yx.db" ] || [ -f "$APPT/.yangila" ]; then
    systemctl stop yx-test 2>/dev/null || true
    rm -f "$APPT/data/yx.db" "$APPT/data/yx.db-wal" "$APPT/data/yx.db-shm" "$APPT/.yangila"
    sqlite3 "$APP/data/yx.db" ".backup '$APPT/data/yx.db'" && echo "Sinov saytiga haqiqiy bazaning nusxasi qo'yildi."
  fi
  chown -R yx:yx "$APPT"; chmod 700 "$APPT/data"
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
  systemctl daemon-reload; systemctl enable yx-test >/dev/null 2>&1; systemctl restart yx-test
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
  echo "Sinov sayti: https://test.$DOMAIN"
else
  echo "GitHub'da test-server.js / test-index.html yo'q — sinov sayti o'tkazib yuborildi."
fi

say "7/8 Kunlik zaxira nusxa sozlanmoqda"
cat > /etc/cron.d/yx-backup <<EOF
30 21 * * * root sqlite3 $APP/data/yx.db ".backup '$APP/backups/yx-\$(date +\%F).db'" && chown yx:yx $APP/backups/*.db && chmod 600 $APP/backups/*.db && find $APP/backups -name 'yx-*.db' -mtime +30 -delete && find $APP/backups -name 'oldin-*.db' -mtime +60 -delete
EOF
chmod 644 /etc/cron.d/yx-backup

# Avtomatik yangilanish: GitHub'ga yangi fayl yuklansa, server 5 daqiqa ichida o'zi o'rnatadi.
cat > /usr/local/bin/yx-update <<'UPD'
#!/bin/bash
R="https://raw.githubusercontent.com/sirojapps/yoshxorazmiylar/main"
exec 9>/run/yx-update.lock; flock -n 9 || exit 0
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
TS=$(date +%s)
curl -fsSL "$R/server.js?$TS" -o "$T/s" || exit 0
curl -fsSL "$R/index.html?$TS" -o "$T/i" || exit 0
g(){ curl -fsSL "$R/$1?$TS" -o "$T/$2" 2>/dev/null || : > "$T/$2"; }
g darslar.tar.gz d; g rasmlar.tar.gz r; g test-server.js ts; g test-index.html ti
ch=0
cmp -s "$T/s" /opt/yx/server.js || ch=1
cmp -s "$T/i" /opt/yx/public/index.html || ch=1
[ -s "$T/d" ] && ! cmp -s "$T/d" /opt/yx/.darslar.tgz && ch=1
[ -s "$T/r" ] && ! cmp -s "$T/r" /opt/yx/.rasmlar.tgz && ch=1
[ -s "$T/ts" ] && ! cmp -s "$T/ts" /opt/yx-test/server.js && ch=1
[ -s "$T/ti" ] && ! cmp -s "$T/ti" /opt/yx-test/public/index.html && ch=1
[ -f /opt/yx-test/.yangila ] && ch=1
[ $ch = 0 ] && exit 0
H=$(cat "$T"/* | sha256sum | cut -c1-16)
[ "$(cat /opt/yx/.last-try 2>/dev/null)" = "$H" ] && [ ! -f /opt/yx-test/.yangila ] && exit 0
echo "=== $(date '+%F %T') yangilanish boshlandi" >> /var/log/yx-update.log
curl -fsSL "$R/install.sh?$TS" | bash >> /var/log/yx-update.log 2>&1 \
&& echo "=== $(date '+%F %T') muvaffaqiyatli" >> /var/log/yx-update.log \
|| { echo "$H" > /opt/yx/.last-try; echo "=== $(date '+%F %T') XATO, eski versiya ishlab turibdi" >> /var/log/yx-update.log; }
UPD
chmod 755 /usr/local/bin/yx-update
echo "*/5 * * * * root /usr/local/bin/yx-update" > /etc/cron.d/yx-update
chmod 644 /etc/cron.d/yx-update
echo "Avtomatik yangilanish yoqildi."

say "8/8 Tayyor!"
echo "Sayt: https://$DOMAIN"
if [ -f "$APP/data/ceo-pin.txt" ]; then
echo
echo " Sizning CEO PIN kodingiz: $(cat "$APP/data/ceo-pin.txt")"
echo " Uni yozib oling. Keyin ko'rish uchun: cat $APP/data/ceo-pin.txt"
fi
