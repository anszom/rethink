#!/bin/bash
set -e

# -------------------------
# Load environment variables
# -------------------------
RETHINK_HOSTNAME="${RETHINK_HOSTNAME:-rethink.lan}"
RETHINK_MQTT_URL="${RETHINK_MQTT_URL:-mqtt://localhost:1883}"
RETHINK_DISCOVERY_PREFIX="${RETHINK_DISCOVERY_PREFIX:-homeassistant}"
RETHINK_PREFIX="${RETHINK_PREFIX:-rethink}"
RETHINK_MQTT_USER="${RETHINK_MQTT_USER:-user}"
RETHINK_MQTT_PASS="${RETHINK_MQTT_PASS:-pass}"
RETHINK_CA_KEY_FILE="${RETHINK_CA_KEY_FILE:-ca.key}"
RETHINK_CA_CERT_FILE="${RETHINK_CA_CERT_FILE:-ca.cert}"
RETHINK_HTTPS_PORT="${RETHINK_HTTPS_PORT:-4433}"
RETHINK_MQTTS_PORT="${RETHINK_MQTTS_PORT:-8884}"
RETHINK_MQTT_PORT="${RETHINK_MQTT_PORT:-1884}"
RETHINK_SERVER_MODE="${RETHINK_SERVER_MODE:-both}"
RETHINK_DEVICE_ID="${RETHINK_DEVICE_ID:-68b5784e-3ae6-40ce-86d6-111fec8838e8}"
RETHINK_COUNTRY_CODE="${RETHINK_COUNTRY_CODE:-PL}"
RETHINK_MODEL_NAME="${RETHINK_MODEL_NAME:-RAC_056905_WW}"
RETHINK_DEVICE_TYPE="${RETHINK_DEVICE_TYPE:-401}"

# Rewrite config.json
cat <<EOF >/rethink/config.json
{
    "hostname": "$RETHINK_HOSTNAME",

    "homeassistant": {
        "mqtt_url": "$RETHINK_MQTT_URL",
        "discovery_prefix": "$RETHINK_DISCOVERY_PREFIX",
        "rethink_prefix": "$RETHINK_PREFIX",
        "mqtt_user": "$RETHINK_MQTT_USER",
        "mqtt_pass": "$RETHINK_MQTT_PASS"
    },

    "ca_key_file": "$RETHINK_CA_KEY_FILE",
    "ca_cert_file": "$RETHINK_CA_CERT_FILE",
    "https_port": $RETHINK_HTTPS_PORT,
    "mqtts_port": $RETHINK_MQTTS_PORT,
    "mqtt_port": $RETHINK_MQTT_PORT
}
EOF

echo "[INFO] Generated /rethink/config.json:"
#cat /rethink/config.json

echo "[INFO] Syncing /config into /rethink as symbolic links..."
mkdir -p /config
# Iterate over all items including hidden files (but excluding . and ..)
shopt -s dotglob

for item in /config/*; do
    name=$(basename "$item")
    target="/rethink/$name"

    echo "[INFO] Processing: $name"

    # Remove existing file or directory at destination
    if [ -e "$target" ] || [ -L "$target" ]; then
        echo "[INFO] Removing existing $target"
        rm -rf "$target" || echo "[WARN] Failed to remove $target"
    fi

    # Create symbolic link
    ln -s "$item" "$target"
    if [ $? -eq 0 ]; then
        echo "[INFO] Linked $item → $target"
    else
        echo "[ERROR] Failed to link $item → $target"
    fi
done

shopt -u dotglob

echo "[INFO] Finished syncing /config → /rethink"


# -------------------------
# Start services depending on mode
# -------------------------

echo "[INFO] Running in mode: $RETHINK_SERVER_MODE"
mkdir -p /var/log/rethink

# Start CLOUD mode

if [ "$RETHINK_SERVER_MODE" = "cloud" ] || [ "$RETHINK_SERVER_MODE" = "both" ]; then
  echo "[INFO] Starting CLOUD service..."
  npm run start > /var/log/rethink/cloud.log 2>&1 &
fi
sleep 5
echo "[INFO] Ensuring /config contains CA certificate and key"

for f in ca.cert ca.key; do
    src="/rethink/$f"
    dst="/config/$f"

    if [ -f "$dst" ]; then
        echo "[INFO] $dst already exists — not overwriting"
        continue
    fi

    if [ ! -f "$src" ]; then
        echo "[WARN] $src does not exist — cannot copy"
        continue
    fi

    cp "$src" "$dst"
    if [ $? -eq 0 ]; then
        echo "[INFO] Copied $src → $dst"
    else
        echo "[ERROR] Failed to copy $src → $dst"
    fi
done

# Start BRIDGE mode

if [ "$RETHINK_SERVER_MODE" = "both" ]; then
  echo "[INFO] Starting BRIDGE services..."
  /start-bridge-services.sh > /var/log/rethink/bridge.log 2>&1 &
fi

if [ "$RETHINK_SERVER_MODE" = "bridge" ]; then
  echo "[INFO] Starting BRIDGE service for Device ID ${RETHINK_DEVICE_ID}..."
  node dist/experimental/bridge/bridge.js \
    mqtt://${RETHINK_HOSTNAME}:${RETHINK_MQTT_PORT}/ \
    "$RETHINK_COUNTRY_CODE" \
    "$RETHINK_DEVICE_TYPE" \
    "$RETHINK_MODEL_NAME" \
    "$RETHINK_DEVICE_ID" \
    > /var/log/rethink/bridge.${RETHINK_DEVICE_ID}.log 2>&1 &
fi

# -------------------------
# Keep container alive
# -------------------------
exec tail -F /var/log/rethink/*.log
