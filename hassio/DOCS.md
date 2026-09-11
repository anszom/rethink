# Rethink

De-cloud LG ThinQ appliances and expose them to Home Assistant over MQTT,
without the official LG app or cloud. The add-on runs `rethink-cloud`, which
emulates the ThinQ cloud on your local network and translates the device
protocol into Home Assistant MQTT discovery.

## How it works

Appliances are hard-coded to talk to LG's cloud by DNS name. To use this
add-on you redirect those names to your Home Assistant host, where the add-on
answers on the device-facing ports. It then publishes each device to your MQTT
broker, and Home Assistant discovers it automatically.

## Requirements

- An MQTT broker reachable by Home Assistant. The
  [Mosquitto broker add-on](https://github.com/home-assistant/addons/tree/master/mosquitto)
  is the easiest option and is detected automatically (the add-on declares
  `mqtt:need`).
- A way to redirect the ThinQ DNS names to the Home Assistant host IP
  (e.g. your router's DNS, Pi-hole/AdGuard, or a local DNS override). See the
  [project wiki](https://github.com/anszom/rethink/wiki/Installing-rethink%E2%80%90cloud).

## Installation

1. Install and start an MQTT broker (e.g. Mosquitto).
2. Install this add-on and set the options below.
3. Start the add-on and open the **Web UI** (Ingress) to watch devices connect.
4. Redirect the ThinQ DNS names to Home Assistant and (re)connect your device.

The management web interface is served through **Ingress**, so it opens
directly from the add-on page — no extra port or login is required for it.

## Options

These are the options exposed under the add-on's **Configuration** tab. The
defaults come straight from `config.yaml`.

| Option             | Default                                  | Description                                                                                                                                    |
| ------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `hostname`         | `rethink.lan`                            | The DNS name your appliances are redirected to. Must be a hostname, not an IP — it becomes the CN of the generated CA/server certificate.      |
| `discovery_prefix` | `homeassistant`                          | MQTT discovery prefix. Must match Home Assistant's MQTT discovery prefix.                                                                      |
| `rethink_prefix`   | `rethink`                                | Prefix for the add-on's own MQTT topics.                                                                                                       |
| `bridge`           | `false`                                  | Enable ThinQ cloud bridge mode, forwarding messages to the real LG cloud so the official app keeps working. Configure the login in the Web UI. |
| `mqtt_url`         | _(empty)_                                | Leave empty to use the Home Assistant MQTT service automatically. Set it (e.g. `mqtt://192.168.1.10:1883`) to use an external broker.          |
| `mqtt_user`        | _(empty)_                                | Username for `mqtt_url` (ignored when the MQTT service is auto-detected).                                                                      |
| `mqtt_pass`        | _(empty)_                                | Password for `mqtt_url` (ignored when the MQTT service is auto-detected).                                                                      |
| `log`              | `status, incoming, HTTPS, publish, MGMT` | Log categories to enable. Allowed values: `status`, `incoming`, `HTTPS`, `publish`, `MGMT`, or `all` for everything.                           |

The device-facing ports are not options — they are configured under the
add-on's **Network** panel (see **Ports** below).

## Ports

The add-on exposes the device-facing ports below (from the `ports` mapping in
`config.yaml`). Appliances connect to the Home Assistant host on these.

| Port        | Purpose                            |
| ----------- | ---------------------------------- |
| `4443/tcp`  | Thinq2 HTTPS (device provisioning) |
| `8885/tcp`  | Thinq2 MQTTS (device connection)   |
| `46030/tcp` | Thinq1 HTTPS (device provisioning) |
| `47878/tcp` | Thinq1 device connection           |

To change a host port, edit the mapping in the add-on's **Network** panel.
Changing a port from its default may reduce compatibility with some devices.

The management interface is served through **Ingress** (internal port
`44401`); no host port is needed for it.

## Data & persistence

The add-on maps its `addon_config` directory to `/app/data` (read-write), so
everything below survives restarts and updates:

- `ca.key` / `ca.cert` — the generated CA/server certificate (created on first
  run for your `hostname`).
- `config.json` — the effective configuration rendered from your options.
- `state/` — bridge mode state (when `bridge` is enabled).

Changing `hostname` regenerates the certificate on the next start.

## Notes

LG ThinQ is a trademark of LG and is used here for identification only. This
project is not affiliated with LG. It is provided WITHOUT ANY WARRANTY.
