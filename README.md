# rethink

The goal of this project is to de-cloud LG ThinQ-branded appliances, meaning to communicate with them without using the official LG app and cloud service. 
The project is developed by reverse engineering various components of the ThinQ ecosystem.

## Status

A working version of `rethink-cloud` is now available. This is a service which emulates the cloud part of ThinQ and translates the protocol to
HomeAssistant-compatible MQTT. 

The following appliances are currently supported in rethink:

- 👍 LG DualCool Standard Wall-mounted Air Conditioner - mostly working,
- 👍 LW1822HRSM, Smart Window Air Conditioner - mostly working,
- 🫤 LF28H8330S, Standard-Depth 4-Door French Door Refrigerator - preliminary support,
- 🫤 GSJV70PZTE, LG Side by Side Refrigerator - preliminary support,
- 🫤 Washing Machine (name unknown) - preliminary support

The supported appliances can be used "out of the box" with HomeAssistant or another compatible MQTT consumer.  
Other appliances can still possibly be connected and used with the bridge utility (see below), but they will not be translated to MQTT. Contributions are welcome!

Most of the findings from the reverse engineering process are available on the [project wiki](https://github.com/anszom/rethink/wiki) as well.

## Installation

See the [instructions](https://github.com/anszom/rethink/wiki/Installing-rethink‐cloud).

## Code

The following code is currently available:

- [rethink-setup](rethink/rethink-setup.ts) - a simple tool to perform the "initial setup" from a Wi-Fi connected PC, without using the official LG app
- [rethink-cloud](rethink/rethink-cloud.ts) - a server that replaces LG's cloud service. It's meant to be installed on your local network and hosts its own simplistic MQTT broker.
- [bridge](rethink/experimental/bridge/bridge.ts) - an utility which registers a rethink-provisioned device on the official ThinQ cloud, and forwards data between the device and LG's servers. This allows the device to be available both to rethink and the official LG app, and the communications can be observed!

Miscelanneous utilities:

- [packet-parser](rethink/packet-parser.ts) - an utility to interpret TLV-formatted packets received from the appliance via MQTT. It connects to rethink-cloud
- [packet-sender](rethink/packet-sender.ts) - an utility to create TLV-formatted packets & send them via MQTT to the appliance. It connects to rethink-cloud
- [packet-parser](rethink/packet-parser.js) - an utility to interpret TLV-formatted packets received from the appliance via MQTT. It connects to rethink-cloud
- [packet-sender](rethink/packet-sender.js) - an utility to create TLV-formatted packets & send them via MQTT to the appliance. It connects to rethink-cloud
- [appliance simulator](appliance-simulator) - a program which allows the Wi-Fi module to be operated without connection to an appliance. It simulates a minimum set of UART responses to activate the Wi-Fi module.

## Notice

LG ThinQ is likely a registered trademark, or whatever, I don't care. The name is used here for identification purposes only. I'm not in any way affiliated with LG.

## Warning

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

This means that if your device breaks, you get to fix it yourself or keep both pieces.
