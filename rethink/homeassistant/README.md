# Rethink

Local protocol translator for LG ThinQ appliances — no cloud required.

![Supports aarch64 Architecture][aarch64-shield]
![Supports amd64 Architecture][amd64-shield]

## About

Rethink intercepts the LG ThinQ cloud protocol at the network level and translates it to MQTT. Your appliances think they are talking to LG — but they are talking to you. All device state and control messages are published to your local MQTT broker, compatible with Home Assistant MQTT Discovery out of the box.

No account, no cloud, no phone home. Once paired, your appliances work entirely on your local network.

Supports both **ThinQ1** and **ThinQ2** devices, including air conditioners, washing machines, dryers, and refrigerators.

## Installation

1. Go to the Add-on Store → Click the **More** button (⋮) in the upper-right corner → **Repositories**
2. Paste the repository URL and click **Add**
3. Find **Rethink** in the list and click **Install**
4. Configure the add-on (see the **Configuration** tab) and start it

## How to use

See the **Documentation** tab for full setup instructions, including DNS configuration, MQTT setup, and device pairing.

[aarch64-shield]: https://img.shields.io/badge/aarch64-yes-green.svg
[amd64-shield]: https://img.shields.io/badge/amd64-yes-green.svg
