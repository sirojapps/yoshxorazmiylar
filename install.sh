#!/bin/bash
# Yosh Xorazmiylar — serverga o'rnatish va yangilash.
# Birinchi marta ham, yangilash uchun ham shu bitta buyruq:
#   curl -fsSL https://raw.githubusercontent.com/sirojapps/yoshxorazmiylar/main/install.sh | bash
set -euo pipefail

REPO="https://raw.githubusercontent.com/sirojapps/yoshxorazmiylar/main"
DOMAIN="yoshxorazmiylar.uz"
APP="/opt/yx"
export DEBIAN_FRONTEND=noninteractive

say(){ echo; echo "==> $*"; }
[ "$(id -u)" = "0" ] || { echo "Bu buyruqni root sifatida ishga tushiring (yoki boshiga sudo qo'shing)."; exit 1; }

say "1/7 Kerakli dasturlar o'rnatilmoqda (bir necha daqiqa)"
apt-get update -qq
apt-get install -y -qq curl ca-certificates nginx certbot python3-certbot-nginx sqlite3 >/dev/null
NODE_MAJOR=$(command -v node >/dev/null && node -v | sed 's/v\([0-9]*\).*/\1/' || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node.js $(node -v)"

say "2/7 Sayt fayllari yuklanmoqda"
id yx >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$APP" yx
mkdir -p "$APP/public" "$APP/data" "$APP/backups"
TS=$(date +%s)
curl -fsSL "$REPO/server.js?$TS"  -o "$APP/server.js.new"
curl -fsSL "$REPO/index.html?$TS" -o "$APP/public/index.html.new"
grep -q "Yosh Xorazmiylar" "$APP/server.js.new" || { echo "server.js yuklanmadi. GitHub'dagi fayl nomini tekshiring."; exit 1; }
grep -q "YOSH XORAZMIYLAR" "$APP/public/index.html.new" || { echo "index.html yuklanmadi. GitHub'dagi fayl nomini tekshiring."; exit 1; }
cp "$APP/server.js.new" /tmp/yx-check.js && node --check /tmp/yx-check.js && rm -f /tmp/yx-check.js
mv "$APP/server.js.new" "$APP/server.js"
mv "$APP/public/index.html.new" "$APP/public/index.html"
chown -R yx:yx "$APP"
chmod 700 "$APP/data" "$APP/backups"

say "3/7 Sayt xizmati sozlanmoqda"
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

say "4/7 Veb-server (nginx) sozlanmoqda"
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
nginx -t -q
systemctl reload nginx

say "5/7 Xavfsiz ulanish (https) sozlanmoqda"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; fi
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect -q \
  || certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect -q \
  || echo "DIQQAT: https sozlanmadi. Domen serverga ulanganini tekshiring, keyin buyruqni qayta ishga tushiring."
else
  echo "https allaqachon sozlangan."
fi

say "6/7 Kunlik zaxira nusxa sozlanmoqda"
cat > /etc/cron.d/yx-backup <<EOF
30 2 * * * root sqlite3 $APP/data/yx.db ".backup '$APP/backups/yx-\$(date +\%F).db'" && find $APP/backups -name 'yx-*.db' -mtime +30 -delete
EOF
chmod 644 /etc/cron.d/yx-backup

# Avtomatik yangilanish: GitHub'ga yangi fayl yuklansa, server 5 daqiqa ichida o'zi o'rnatadi.
cat > /usr/local/bin/yx-update <<'UPD'
#!/bin/bash
# GitHub'dagi server.js va index.html o'zgargan bo'lsa, saytni o'zi yangilaydi.
R="https://raw.githubusercontent.com/sirojapps/yoshxorazmiylar/main"
exec 9>/run/yx-update.lock; flock -n 9 || exit 0
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
TS=$(date +%s)
curl -fsSL "$R/server.js?$TS" -o "$T/s" || exit 0
curl -fsSL "$R/index.html?$TS" -o "$T/i" || exit 0
cmp -s "$T/s" /opt/yx/server.js && cmp -s "$T/i" /opt/yx/public/index.html && exit 0
H=$(cat "$T/s" "$T/i" | sha256sum | cut -c1-16)
[ "$(cat /opt/yx/.last-try 2>/dev/null)" = "$H" ] && exit 0
echo "=== $(date '+%F %T') yangilanish boshlandi" >> /var/log/yx-update.log
curl -fsSL "$R/install.sh?$TS" | bash >> /var/log/yx-update.log 2>&1 \
  && echo "=== $(date '+%F %T') muvaffaqiyatli" >> /var/log/yx-update.log \
  || { echo "$H" > /opt/yx/.last-try; echo "=== $(date '+%F %T') XATO, eski versiya ishlab turibdi" >> /var/log/yx-update.log; }
UPD
chmod 755 /usr/local/bin/yx-update
echo "*/5 * * * * root /usr/local/bin/yx-update" > /etc/cron.d/yx-update
chmod 644 /etc/cron.d/yx-update
echo "Avtomatik yangilanish yoqildi: GitHub'ga yuklangan fayllar 5 daqiqa ichida saytga o'zi o'rnatiladi."

say "7/7 Tayyor!"
echo "Sayt: https://$DOMAIN"
if [ -f "$APP/data/ceo-pin.txt" ]; then
  echo
  echo "  Sizning CEO PIN kodingiz:  $(cat "$APP/data/ceo-pin.txt")"
  echo "  Uni yozib oling. Keyin ko'rish uchun:  cat $APP/data/ceo-pin.txt"
fi
