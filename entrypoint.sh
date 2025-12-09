#!/bin/bash
set -e

# -------------------------
# Configurable parameters
# -------------------------
MAX_RETRIES=60
SLEEP_SECONDS=5  # seconds between log checks

# Default fallback values
DEFAULT_DEVICE_ID="${RETHINK_DEVICE_ID:-68b5784e-3ae6-40ce-86d6-111fec8838e8}"
DEFAULT_COUNTRY_CODE="${RETHINK_COUNTRY_CODE:-PL}"
DEFAULT_MODEL_NAME="${RETHINK_MODEL_NAME:-RAC_056905_WW}"
DEFAULT_DEVICE_TYPE="${RETHINK_DEVICE_TYPE:-401}"

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
RETHINK_SERVER_MODE="${RETHINK_SERVER_MODE:-cloud}"

# Function to extract a value from log for a given key
extract_value() {
  local key="$1"
  grep -a -m1 "\"$key\":" "/var/log/rethink/cloud.log" | sed -n "s/.*\"$key\":\"\([^\"]*\)\".*/\1/p"
}

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

echo "Generated /rethink/config.json:"
#cat /rethink/config.json

# -------------------------
# Start services depending on mode
# -------------------------

echo "Running in mode: $RETHINK_SERVER_MODE"

mkdir -p /var/log/rethink


# Start CLOUD mode

if [ "$RETHINK_SERVER_MODE" = "cloud" ] || [ "$RETHINK_SERVER_MODE" = "both" ]; then
  echo "Starting CLOUD service..."
  npm run start > /var/log/rethink/cloud.log 2>&1 &
fi


# Retry to extract values from cloud log

if [ "$RETHINK_SERVER_MODE" = "bridge" ] || [ "$RETHINK_SERVER_MODE" = "both" ]; then
  RETRY_COUNT=0
  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    DEVICE_ID=$(extract_value "did")
    COUNTRY_CODE=$(extract_value "subCountryCode")
    MODEL_NAME=$(extract_value "modelName")
    DEVICE_TYPE=$(extract_value "DeviceType")

    if [ -n "$DEVICE_ID" ] && [ -n "$COUNTRY_CODE" ] && \
       [ -n "$MODEL_NAME" ] && [ -n "$DEVICE_TYPE" ]; then
      echo "Successfully captured values on attempt $((RETRY_COUNT+1))"
      break
    fi

    RETRY_COUNT=$((RETRY_COUNT+1))
    sleep $SLEEP_SECONDS
  done

  # Fallback to defaults if extraction failed
  : "${DEVICE_ID:=$DEFAULT_DEVICE_ID}"
  : "${COUNTRY_CODE:=$DEFAULT_COUNTRY_CODE}"
  : "${MODEL_NAME:=$DEFAULT_MODEL_NAME}"
  : "${DEVICE_TYPE:=$DEFAULT_DEVICE_TYPE}"

  # Log the final values
  echo "Final values for BRIDGE service:"
  echo "DEVICE_ID=$DEVICE_ID"
  echo "COUNTRY_CODE=$COUNTRY_CODE"
  echo "MODEL_NAME=$MODEL_NAME"
  echo "DEVICE_TYPE=$DEVICE_TYPE"

fi

# Start BRIDGE mode

if [ "$RETHINK_SERVER_MODE" = "bridge" ] || [ "$RETHINK_SERVER_MODE" = "both" ]; then
  echo "Starting BRIDGE service..."
  node dist/experimental/bridge/bridge.js \
    mqtt://${RETHINK_HOSTNAME}:${RETHINK_MQTT_PORT}/ \
    "$COUNTRY_CODE" \
    "$DEVICE_TYPE" \
    "$MODEL_NAME" \
    "$DEVICE_ID" \
    > /var/log/rethink/bridge.log 2>&1 &
fi

# -------------------------
# Keep container alive
# -------------------------
exec tail -F /var/log/rethink/*.log
