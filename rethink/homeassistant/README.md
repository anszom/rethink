# Rethink

Local protocol translator for LG ThinQ appliances — no cloud required.

![Supports aarch64 Architecture][aarch64-shield]
![Supports amd64 Architecture][amd64-shield]

## About

Rethink intercepts the LG ThinQ cloud protocol at the network level and translates it to MQTT. Your appliances think they are talking to LG — but they are talking to you. All device state and control messages are published to your local MQTT broker, compatible with Home Assistant MQTT Discovery out of the box.

No account, no cloud, no phone home. Once paired, your appliances work entirely on your local network.

Supports both **ThinQ1** and **ThinQ2** devices, including air conditioners, washing machines, dryers, and refrigerators.

## Install & configure the addon

1. Go to the Add-on Store → Click the **More** button (⋮) in the upper-right corner → Select **Repositories**
2. Paste the following URL:  
   [https://github.com/anszom/rethink](https://github.com/anszom/rethink)
3. Or, simply click the button below to add it automatically:

[![Add Repository](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fanszom%2Frethink)

## How to use

See the **Documentation** tab for full setup instructions, including DNS configuration, MQTT setup, and device pairing.

[aarch64-shield]: https://img.shields.io/badge/aarch64-yes-green.svg
[amd64-shield]: https://img.shields.io/badge/amd64-yes-green.svg
