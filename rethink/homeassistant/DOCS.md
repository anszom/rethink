# Rethink

Local protocol translator for LG ThinQ appliances. Replaces the LG cloud with a
direct local MQTT bridge — your appliances talk to your home, not LG's servers.

> **Supports both ThinQ1 and ThinQ2 devices.**

---

## Overview

Rethink intercepts the LG ThinQ cloud protocol at the network level and translates
it to MQTT. Your appliances think they are talking to LG — but they are talking to
you. All device state and control messages are published to your local MQTT broker,
compatible with Home Assistant MQTT Discovery out of the box.

---

## Setup

### 1. Install & configure the addon

Start the addon and configure it via the Configuration tab:

| Option             | Description                        | Default                           |
| ------------------ | ---------------------------------- | --------------------------------- |
| `hostname`         | Hostname Rethink advertises        | `rethink.lgthinq.com`             |
| `mqtt_url`         | Your MQTT broker URL               | `mqtt://rethink.lgthinq.com:1883` |
| `discovery_prefix` | HA MQTT discovery prefix           | `homeassistant`                   |
| `rethink_prefix`   | MQTT topic prefix for device state | `rethink`                         |
| `https_port`       | Port for ThinQ HTTPS interception  | `4433`                            |
| `management_port`  | Port for the Rethink management UI | `44401`                           |
| `mqtt_user`        | MQTT username (if required)        |                                   |
| `mqtt_pass`        | MQTT password (if required)        |                                   |

### 2. Set up MQTT

Ensure you have an MQTT broker running — the Mosquitto addon is recommended.
Configure the `mqtt_url`, `mqtt_user`, and `mqtt_pass` options to match.

### 3. Open the Rethink Web UI

Navigate to the Rethink management UI (port `44401` by default) and set up
**Bridge Mode** before pairing your devices.

### 4. Port forwarding for port 443

LG appliances connect on port 443, but Rethink runs on port 4433. You need to
redirect port 443 traffic to 4433. Choose one of:

**Option A — iptables (recommended for HAOS)**

Run this on your HAOS host, replacing the IP with your machine's IP:

```bash
iptables -t nat -I PREROUTING -s 192.168.8.161 -p tcp --dport 443 -j REDIRECT --to-port 4433
```

**Option B — Router port forward**

Forward port 443 on your router to port 4433 on your HAOS IP address.
Then use your WAN IP as the DNS target instead of your local IP.

### 5. DNS records

Add the following DNS records pointing to your HAOS IP address.
This is typically done in your router's local DNS or a Pi-hole/AdGuard instance:

```
rethink.lgthinq.com    → <your HAOS IP>
eic-mclip.lgthinq.com  → <your HAOS IP>
common.lgthinq.com     → <your HAOS IP>
```

Once your appliance connects you should see requests to `common.lgthinq.com`
followed by `rethink.lgthinq.com/route` and `/route/certificate` in the logs —
this confirms the intercept is working.

---

## Pairing devices

### ThinQ1 devices

1. Put your appliance into pairing mode
2. On your phone/computer, connect to the LG appliance's Wi-Fi network (it
   broadcasts its own SSID during pairing)
3. Open the Rethink Web UI and use the pairing flow
4. Enter your home Wi-Fi credentials and set `setup_ip` (usually `192.168.120.254`)
5. The appliance will join your network and appear in Rethink

Fill in the pairing options in the addon configuration:

| Option          | Description                                                      |
| --------------- | ---------------------------------------------------------------- |
| `setup_ip`      | IP used during appliance Wi-Fi setup (usually `192.168.120.254`) |
| `wifi_ssid`     | Your home Wi-Fi SSID                                             |
| `wifi_password` | Your home Wi-Fi password                                         |

### ThinQ2 devices

1. Open the LG ThinQ app
2. If the device is already listed, remove it first
3. Add the device — proceed until you reach the **Scan QR code** screen
4. Scan the QR code on the appliance and complete the pairing process
5. The device will register via Rethink instead of LG's cloud

No special pairing options needed — leave `setup_ip`, `wifi_ssid`, and
`wifi_password` blank for ThinQ2 devices.

---

## After pairing

Once paired, enable **Bridge Mode** in the Rethink Web UI for each device.
Your appliances will now publish state to MQTT and be discovered automatically
by Home Assistant.

---

## Support

- [GitHub](https://github.com/anszom/rethink)
- [Wiki & full installation guide](https://github.com/anszom/rethink/wiki/Installing-rethink%E2%80%90cloud)
- [Issues](https://github.com/anszom/rethink/issues)
