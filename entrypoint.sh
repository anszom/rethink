#!/bin/bash
set -e

# Environment variables with defaults
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
cat /rethink/config.json

# Start service
exec node /rethink/rethink-cloud.js
