#!/bin/bash

CLOUD_LOG="/var/log/rethink/cloud.log"

echo "[INFO] Bridge watcher started"
echo "[INFO] Monitoring: $CLOUD_LOG"

# Ensure log file exists before tailing
if [ ! -f "$CLOUD_LOG" ]; then
    echo "[WARN] Cloud log does not exist yet. Waiting..."
    touch "$CLOUD_LOG"
fi

# Tail the log and process each line once
tail -Fn0 "$CLOUD_LOG" | while read -r line; do
    # Skip empty or invalid lines
    if [ -z "$line" ]; then
        continue
    fi

    #echo "[INFO] Processing line: $line"

    # Only process lines containing `"type":0`
    # this is to process only lines that contain all the keys for Bridge mode
    if ! echo "$line" | grep -q "\"type\":0"; then
        #echo "[DEBUG] Line does not contain type 0. Skipping."
        continue
    fi

    echo "[INFO] device connected to CLOUD Server."

    # ------------------------------
    # Extract values using sed
    # ------------------------------

    did=$(echo "$line" | sed -n 's/.*"did":"\([^"]*\)".*/\1/p')
    country=$(echo "$line" | sed -n 's/.*"subCountryCode":"\([^"]*\)".*/\1/p')
    model=$(echo "$line" | sed -n 's/.*"modelName":"\([^"]*\)".*/\1/p')
    dtype=$(echo "$line" | sed -n 's/.*"DeviceType":"\([^"]*\)".*/\1/p')

    # Check if values extracted
    if [ -z "$did" ] || [ -z "$country" ] || [ -z "$model" ] || [ -z "$dtype" ]; then
        echo "[ERROR] Failed to extract one or more required Key Values: did=$did country=$country model=$model dtype=$dtype"
        continue
    fi

    echo "[INFO] Extracted Key DID: $did"
    echo "[INFO] Extracted Key Country: $country"
    echo "[INFO] Extracted Key Model: $model"
    echo "[INFO] Extracted Key DeviceType: $dtype"

    # ------------------------------
    # Check if this bridge is already running
    # ------------------------------

    if ps aux | grep -v grep | grep -q "$did"; then
        echo "[INFO] BRIDGE Service for Device ID $did already running. Skipping."
        continue
    fi

    echo "[INFO] No running BRIDGE Services for Device ID $did. Starting new bridge instance..."

    # ------------------------------
    # Start the bridge service
    # ------------------------------

    LOGFILE="/var/log/rethink/bridge.${did}.log"
    #echo "[INFO] Starting BRIDGE Server → logging to: $LOGFILE"

    (
        echo "[INFO] BRIDGE Service start for Device ID $did"
        node dist/experimental/bridge/bridge.js \
            "mqtt://${RETHINK_HOSTNAME}:${RETHINK_MQTT_PORT}/" \
            "$country" \
            "$dtype" \
            "$model" \
            "$did"
        echo "[ERROR] BRIDGE Service for Device ID $did exited unexpectedly!"
    ) >"$LOGFILE" 2>&1 &

    echo "[INFO] BRIDGE Service instance for Device ID $did started successfully."
done
