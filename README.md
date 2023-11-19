# rethink

The goal of this project is to de-cloud LG ThinQ-branded appliances, meaning to communicate with then without using the official LG app and cloud service. 
The project is developed by reverse engineering various components of the ThinQ ecosystem.

Currently all of this is aimed at supporting the "LG Standard" wall-mounted AC unit. Contributions are welcome :)

## Status

The project is at early stages, but the groundwork has already been done:

- [x] Determine the general communications scheme
- [x] Reverse engineer app-device and cloud-device communications
- [x] Implement a minimal substitute for the cloud service that will be accepted by the appliance
- [ ] Implement actual functionality in the server
- [ ] Reverse engineer appliance-specific protocol
- [ ] Home Assistant integration

Most of the findings are available on the [project wiki](https://github.com/anszom/rethink/wiki)

## Code

The following code is currently available:

- [rethink-setup](rethink/rethink-setup.js) - a simple tool to perform the "initial setup" from a Wi-Fi connected PC, without using the official LG app
- [rethink-cloud](rethink/rethink-cloud.js) - a server that replaces LG's cloud service. It's meant to be installed on your local network
- [appliance simulator](appliance-simulator) - a program which allows the Wi-Fi module to be operated without connection to an appliance. It simulates a minimum set of UART responses to activate the Wi-Fi module.

## Notice

LG ThinQ is likely a registered trademark, or whatever, I don't care. The name is used here for identification purposes only. I'm not in any way affiliated with LG.

## Warning

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

This means that if your device breaks, you get to fix it yourself or keep both pieces.
