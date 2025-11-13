# rethink

The goal of this project is to de-cloud LG ThinQ-branded appliances, meaning to communicate with them without using the official LG app and cloud service. 
The project is developed by reverse engineering various components of the ThinQ ecosystem.

Currently all of this is aimed at supporting the "LG Standard" wall-mounted AC unit. Contributions are welcome :)

## Status

A minimal working version of `rethink-cloud` is now available. This is a service which emulates the cloud part of ThinQ and translates the protocol to
HomeAssistant-compatible MQTT. At the moment only the wall-mounted AC is supported, contributions are welcome :)

Most of the findings from the reverse engineering process are available on the [project wiki](https://github.com/anszom/rethink/wiki)

## Installation

See the instructions on the [project wiki](https://github.com/anszom/rethink/wiki/Installing-rethink‐cloud)

## Code

The following code is currently available:

- [rethink-setup](rethink/rethink-setup.js) - a simple tool to perform the "initial setup" from a Wi-Fi connected PC, without using the official LG app
- [rethink-cloud](rethink/rethink-cloud.js) - a server that replaces LG's cloud service. It's meant to be installed on your local network and hosts its own simplistic MQTT broker.
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
