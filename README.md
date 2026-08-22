# rethink

The goal of this project is to de-cloud LG ThinQ-branded appliances, meaning to communicate with them without using the official LG app and cloud service.
The project is developed by reverse engineering various components of the ThinQ ecosystem.

## Status

A working version of `rethink-cloud` is now available. This is a service which emulates the cloud part of ThinQ and translates the protocol to
HomeAssistant-compatible MQTT.

An optional "bridge" mode is also supported, in which the messages are forwarded to the actual LG ThinQ cloud. This can be used as a reverse-engineering
aid, or simply to allow the user to still use the original LG app alongside HomeAssistant.

The following appliances are currently supported in rethink:

| Model / Description                                                  | Status                   | Tested | Contributor              |
| -------------------------------------------------------------------- | ------------------------ | ------ | ------------------------ |
| **Air Conditioners**                                                 |                          |        |                          |
| LG DualCool family (Standard 2, Deluxe with/without air purifier)    | 👍 High level of support | Yes    | anszom, maciejsszmigiero |
| WZ12AWN SNU3 / S3NW12TZXBB (DualCool 12k Inverter AC)                | 👍 High level of support | Yes    | nacorsito                |
| WZ18AWN SNU1 / S3NW18TZXBA (DualCool 18k Inverter AC)                | 👍 High level of support | Yes    | nacorsito                |
| WZ09* / S3NW09*, WZ24* / S3NW24* (DualCool series - shared protocol) | 👍 High level of support | No     | nacorsito                |
| Modern ThinQ2 RAC (deviceType 401 / 917be+ firmware)                 | 👍 High level of support | No     | nacorsito                |
| LW1822HRSM (Smart Window Air Conditioner)                            | 👍 Mostly working        | Yes    | kheston                  |
| LP1022FVSM (Portable Air Conditioner)                                | 👍 Mostly working        | Yes    | walker0643               |
| **Refrigerators**                                                    |                          |        |                          |
| LF28H8330S (Standard-Depth 4-Door French Door Refrigerator)          | 🫤 Preliminary support   | No     | anszom                   |
| GSJV70PZTE (LG Side by Side Refrigerator)                            | 🫤 Preliminary support   | No     | anszom                   |
| GSB470BASZ (American Style Side by Side Refrigerator)                | 🫤 Preliminary support   | No     | anszom                   |
| GA-B509CMUM                                                          | 🫤 Preliminary support   | No     | anszom                   |
| 2REF11EBIVPC4                                                        | 🫤 Preliminary support   | No     | NadavK                   |
| **Washing Machines & Combos**                                        |                          |        |                          |
| (model name unknown) Washing Machine                                 | 🫤 Preliminary support   | No     | anszom                   |
| F2J7HG1W (ThinQ 1 Washing Machine)                                   | 👍 Mostly working        | Yes    | anszom                   |
| F4WV508S2E (Front-Loading Washing Machine)                           | 🫤 Preliminary support   | No     | pabbloo                  |
| F4WV709P1E (Front-Loading Washing Machine)                           | 🫤 Preliminary support   | No     | ToniH1987                |
| TW4V9RW9W                                                            | 🫤 Preliminary support   | No     | anszom                   |
| F4X7511TWS (VCDWL2QEUK), Front-Load Washing Machine                  | 👍 Mostly working        | Yes    | maslygan                 |
| WT7300CW                                                             | 🫤 Preliminary support   | No     | tberg                    |
| WM3900HBA (F3L2CYU\_\_), Front-Load Washing Machine                  | 👍 Mostly working        | Yes    | bateman.joseph           |
| FV1413H2B (F_V**F\_**W_B_1QEUK), Washing Machine                     | 👍 Mostly working        | Yes    | artemon_93, stevenbower  |
| F3L7CYK5W_US_WIFI (Front-Load Washing Machine)                       | 👍 Mostly working        | Yes    | Danimal4326              |
| W4WR70E61 (Y_V8_F\_\_\_W.B_2QEUK), Washer/Dryer Combo                | 👍 Mostly working        | Yes    | max.obenaus              |
| CV74J7S2QA (F_VB_F\_\_\_W.B_2QEUK), Washer/Dryer Combo               | 👍 Mostly working        | Yes    | joonas.palosuo           |
| **Dryers**                                                           |                          |        |                          |
| DLE7300WE (RV13U6AM8W_D_US_WIFI)                                     | 🫤 Preliminary support   | No     | tberg                    |
| DLEX3900B (RV13B6BSD_D_US_WIFI), Electric Dryer                      | 👍 Mostly working        | Yes    | bateman.joseph           |
| RV13B6ES_D_US_WIFI (Electric Dryer)                                  | 👍 Mostly working        | Yes    | Danimal4326              |
| **WashTowers**                                                       |                          |        |                          |
| WKEX200HBA (WTL_FXU_BDV_NA_01), WashTower                            | 👍 Mostly working        | Yes    | schmittjoseph            |
| **Dehumidifiers**                                                    |                          |        |                          |
| MD19GQGE0 (DHUM_056905_WW), Smart Dehumidifier                       | 👍 Mostly working        | Yes    | stevenbower              |
| **Range Hoods**                                                      |                          |        |                          |
| HCED3015D (STUDIO_HOOD), Generic identifier                          | 👍 Working               | Yes    | B1223GS87                |

The supported appliances can be used "out of the box" with HomeAssistant or another compatible MQTT consumer.  
Appliances not listed above can still be used with the bridge mode, but they will not be translated to MQTT. Contributions are welcome!

Most of the findings from the reverse engineering process are available on the [project wiki](https://github.com/anszom/rethink/wiki) as well.

## Installation

See the [instructions](https://github.com/anszom/rethink/wiki/Installing-rethink‐cloud).

## Management

A simple web interface is available on a user-defined port (default: 44401). The interface supports:

- listing the devices connected to rethink
- monitoring their communications (with packet injection)
- configuring the bridge mode

## Code

The following code is currently available:

- [rethink-setup](rethink-setup.ts) - a simple tool to perform the "initial setup" from a Wi-Fi connected PC, without using the official LG app
- [rethink-cloud](rethink-cloud.ts) - a server that replaces LG's cloud service. It's meant to be installed on your local network and hosts its own simplistic MQTT broker.

Miscelanneous utilities:

- [packet-parser](tools/packet-parser.ts) - an utility to interpret TLV-formatted packets received from the appliance via MQTT. It connects to rethink-cloud
- [packet-sender](tools/packet-sender.ts) - an utility to create TLV-formatted packets & send them via MQTT to the appliance. It connects to rethink-cloud
- [appliance simulator](tools/appliance-simulator) - a program which allows the Wi-Fi module to be operated without connection to an appliance. It simulates a minimum set of UART responses to activate the Wi-Fi module.
- [lgcloud-monitor](tools/lgcloud-monitor.ts) - connects to the official LG cloud just like the official app would and displays real-time notifications about your devices straight from the MQTT feed. Useful for understanding how the LG cloud processes device updates.
- [rethink-capture](tools/rethink-capture.ts) - records a device's live wire traffic (and optionally the time-aligned LG cloud notifications) to a JSONL capture file, with inline annotations, for offline reverse-engineering in an LLM-friendly format.
- [mcp-server](tools/mcp-server.ts) - an [MCP](https://modelcontextprotocol.io) server that exposes the reverse-engineering toolkit (decode/encode packets, enumerate devices, capture device & cloud traffic, inject and probe packets) to an LLM agent.

## Notice

LG ThinQ is likely a registered trademark, or whatever, I don't care. The name is used here for identification purposes only. I'm not in any way affiliated with LG.

## Warning

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

This means that if your device breaks, you get to fix it yourself or keep both pieces.
