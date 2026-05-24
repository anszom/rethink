#!/usr/bin/env sh
set -e

cd /app

if [ -f /data/options.json ] && [ -n "$SUPERVISOR_TOKEN" ]; then
    echo "[rethink] Running as Home Assistant addon"

    OPTIONS=/data/options.json

    HOSTNAME=$(jq -r '.hostname' "$OPTIONS")
    MQTT_URL=$(jq -r '.mqtt_url' "$OPTIONS")
    DISCOVERY_PREFIX=$(jq -r '.discovery_prefix' "$OPTIONS")
    RETHINK_PREFIX=$(jq -r '.rethink_prefix' "$OPTIONS")
    HTTPS_PORT=$(jq -r '.https_port' "$OPTIONS")
    MANAGEMENT_PORT=$(jq -r '.management_port' "$OPTIONS")
    MQTT_USER=$(jq -r '.mqtt_user' "$OPTIONS")
    MQTT_PASS=$(jq -r '.mqtt_pass' "$OPTIONS")
    SETUP_IP=$(jq -r '.setup_ip // ""' "$OPTIONS")
    WIFI_SSID=$(jq -r '.wifi_ssid // ""' "$OPTIONS")
    WIFI_PASSWORD=$(jq -r '.wifi_password // ""' "$OPTIONS")

    cat > /data/config.json <<EOF
{
  "hostname": "${HOSTNAME}",
  "homeassistant": {
    "mqtt_url": "${MQTT_URL}",
    "mqtt_user": "${MQTT_USER}",
    "mqtt_pass": "${MQTT_PASS}",
    "discovery_prefix": "${DISCOVERY_PREFIX}",
    "rethink_prefix": "${RETHINK_PREFIX}"
  },
  "ca_key_file": "ca.key",
  "ca_cert_file": "ca.cert",
  "https_port": ${HTTPS_PORT},
  "mqtts_port": 8885,
  "mqtt_port": 1885,
  "thinq1_https_port": 46030,
  "thinq1_port": 47878,
  "management_port": ${MANAGEMENT_PORT},
  "bridge": {
    "storage_path": "./state"
  },
  "log": ["status", "incoming", "HTTPS", "publish", "MGMT"]
}
EOF

    echo "[rethink] Starting with hostname=${HOSTNAME}, mqtt=${MQTT_URL}"

    if [ -n "$SETUP_IP" ] && [ -n "$WIFI_SSID" ] && [ -n "$WIFI_PASSWORD" ]; then
        echo "[rethink] ThinQ1 pairing mode: setup_ip=${SETUP_IP} ssid=${WIFI_SSID}"
        (sleep 3 && npx tsx rethink-setup.ts "$SETUP_IP" "$WIFI_SSID" "$WIFI_PASSWORD") &
    fi

    exec node dist/rethink-cloud.js /data/config.json

else
    echo "[rethink] Running in standalone Docker mode"

    [ -f /app/data/config.json ] || cp /app/config.json /app/data/config.json

    exec node dist/rethink-cloud.js /app/data/config.json

fi