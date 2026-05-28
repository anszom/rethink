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

## Installation

### 1. Install & configure the addon

1. Go to the Add-on Store → Click the **More** button (⋮) in the upper-right corner → Select **Repositories**
2. Paste the following URL:  
   [https://github.com/anszom/rethink](https://github.com/anszom/rethink)
3. Or, simply click the button below to add it automatically:
   [![Add Repository](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fanszom%2Frethink)
4. Start the addon and configure it via the Configuration tab:

| Option             | Description                                    | Default                           |
| ------------------ | ---------------------------------------------- | --------------------------------- |
| `hostname`         | Hostname Rethink advertises                    | `rethink.lgthinq.com`             |
| `mqtt_url`         | Your MQTT broker URL                           | `mqtt://rethink.lgthinq.com:1883` |
| `discovery_prefix` | HA MQTT discovery prefix                       | `homeassistant`                   |
| `rethink_prefix`   | MQTT topic prefix for device state             | `rethink`                         |
| `https_port`       | Port for ThinQ HTTPS interception              | `4433`                            |
| `listen_443`       | Also listen on port 443 (LG provisioning port) | `true`                            |
| `management_port`  | Port for the Rethink management UI             | `44401`                           |
| `mqtt_user`        | MQTT username (if required)                    |                                   |
| `mqtt_pass`        | MQTT password (if required)                    |                                   |

### 2. Configure MQTT

Ensure you have an MQTT broker running — the Mosquitto addon is recommended.
Configure the `mqtt_url`, `mqtt_user`, and `mqtt_pass` options to match.

### 3. Port 443 (LG Provisioning Port)

By default, Rethink listens on both port **443** and port **4433**. LG appliances during provisioning
connect on port 443, however as Rethink listens on this port no port forwarding or router configuration should be needed.

> **If you are running Nginx Proxy Manager, Let's Encrypt, or another addon that
> needs port 443**, you will need to temporarily stop that addon while provisioning
> your LG device so Rethink can claim port 443. Once provisioning is complete you
> can stop Rethink's port 443 binding and restart the other addon. To do so go to the addon
> **Configuration** tab → **Network** section and set the host port for
> _LG Provisioning Port_ to a different value (e.g. `4434`), or toggle
> `listen_443` to `false` and restart the addon. Port 4433 will continue to work.

If for any reason port 443 is not available, you can redirect traffic to port 4433 manually:

Run this on your HAOS host (via SSH) using the [HassOS SSH port 22222 Configurator](https://community.home-assistant.io/t/add-on-hassos-ssh-port-22222-configurator/264109), replacing `LG_DEVICE_IP` with your LG device's IP:

```bash
iptables -t nat -I PREROUTING -s LG_DEVICE_IP -p tcp --dport 443 -j REDIRECT --to-port 4433
```

### 4. DNS records

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

## Provisioning devices

### ThinQ1 devices

1. Put your appliance into wifi mode by following the instructions in the LG app (for adding a new device)
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

No special options needed — leave `setup_ip`, `wifi_ssid`, and
`wifi_password` blank for ThinQ2 devices.

---

## After provisioning

Once provisioned, you can enable **Bridge Mode** in the Rethink Web UI for each device.
Your appliances will now publish state to MQTT and be discovered automatically
by Home Assistant.

---

## Support

- [GitHub](https://github.com/anszom/rethink)
- [Wiki & full installation guide](https://github.com/anszom/rethink/wiki/Installing-rethink%E2%80%90cloud)
- [Issues](https://github.com/anszom/rethink/issues)
