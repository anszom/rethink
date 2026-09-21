# rethink

The goal of this project is to de-cloud LG ThinQ-branded appliances, meaning to communicate with them without using the official LG app and cloud service.
The project is developed by reverse engineering various components of the ThinQ ecosystem.

## Status

A working version of `rethink-cloud` is now available. This is a service which emulates the cloud part of ThinQ and translates the protocol to
HomeAssistant-compatible MQTT.

An optional "bridge" mode is also supported, in which the messages are forwarded to the actual LG ThinQ cloud. This can be used as a reverse-engineering
aid, or simply to allow the user to still use the original LG app alongside HomeAssistant.

## Supported appliances

The following appliances are currently supported in rethink. The first column is the model name as reported by the appliance over ThinQ,
the second one is the model it is sold as.

#### Air conditioners

| ThinQ model                  | Appliance                                | Support                                                                                                             |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| RAC_056905_WW, RAC_0B0001_WW | LG DualCool family wall-mounted IDUs     | 💎 high level of support. What's missing are mostly some features of higher-end models and more diagnostic coverage |
| WIN_056905_WW                | LW1822HRSM, Smart Window Air Conditioner | 👍 mostly working                                                                                                   |
| POT_056905_WW                | LP1022FVSM, Portable Air Conditioner     | 👍 mostly working                                                                                                   |

#### Fridges

| ThinQ model     | Appliance                                                  | Support                                                                                     |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 2REF11EIDA\_\_4 | LF28H8330S, Standard-Depth 4-Door French Door Refrigerator | 🫤 preliminary support                                                                      |
| 2RES1VE61NFA2   | GSJV70PZTE, Side by Side Refrigerator                      | 🫤 preliminary support                                                                      |
| 2REB1GLVB1\_\_2 | GSB470BASZ, American Style Side by Side Refrigerator       | 🫤 preliminary support                                                                      |
| 2RES1VE600FWC   | GA-B509CMUM                                                | 🫤 preliminary support                                                                      |
| 2REF11EBIVPC4   | (model name unknown)                                       | 🫤 preliminary support: fridge/freezer temperature, door open, express freeze, Shabbat mode |

#### Washing machines

| ThinQ model                                      | Appliance                                        | Support                      |
| ------------------------------------------------ | ------------------------------------------------ | ---------------------------- |
| WTDN3 (ThinQ1)                                   | F2J7HG1W, Washing Machine                        | 👍 mostly working            |
| Y_V8_Y\_\_\_W.B32QEUK                            | (model name unknown)                             | 🫤 preliminary support       |
| F_V7_Y\_\_\_W.B_2QEUK                            | F4WV508S2E, Front-Loading Washing Machine        | 🫤 preliminary support       |
| F_V8_Y\_\_\_W.B_2QEUK                            | F4WV709P1E, Front-Loading Washing Machine        | 🫤 preliminary support       |
| F_V\_\_Y\_\_\_W.B_2QEUK                          | TW4V9RW9W                                        | 🫤 preliminary support       |
| F_C\_\_Y\_\_\_W.A\_\_QEUK                        | F4WV709P1, Front-Loading Washing Machine         | 👍 mostly working            |
| F_V7_Y\_\_\_W.B\_\_QEUK                          | F2V5PS0W, Front-Load Washing Machine             | 👍 mostly working            |
| VCDWL2QEUK                                       | F4X7511TWS, Front-Load Washing Machine           | 👍 mostly working            |
| T1789EFH_F                                       | WT7300CW, Top-Load Washing Machine               | 🫤 preliminary support       |
| F3L2CYU\_\_                                      | WM3900HBA, Front-Load Washing Machine            | 👍 mostly working            |
| F3L7CYK5W_US_WIFI                                | (model name unknown), Front-Load Washing Machine | 👍 mostly working            |
| F3P3CYK2\_                                       | WM4200HBA, Front-Load Washing Machine            | 👍 mostly working |
| F_V\_\_F\_\_\_W.B_1QEUK, F_VA_F\_\_\_W.B\_\_QEUK | FV1413H2B / FV1413H2BA, Washing Machine          | 👍 mostly working            |
| FAFXU25006                                       | WM5800HVA, Front-Load Washing Machine            | 👍 mostly working, read-only |
| F_VB_F\_\_\_W.B_2QEUK                            | CV74J7S2QA, Washer/Dryer Combo                   | 👍 mostly working            |
| Y_V8_F\_\_\_W.B_2QEUK                            | W4WR70E61, Washer/Dryer Combo                    | 👍 mostly working            |

#### Dryers

| ThinQ model          | Appliance                            | Support                      |
| -------------------- | ------------------------------------ | ---------------------------- |
| RV13U6AM8W_D_US_WIFI | DLE7300WE, Electric Dryer            | 🫤 preliminary support       |
| RV13B6BSD_D_US_WIFI  | DLEX3900B, Electric Dryer            | 👍 mostly working            |
| RV13B6ES_D_US_WIFI   | (model name unknown), Electric Dryer | 👍 mostly working            |
| BDH_D30007_US        | DLHC5502V, Heat-Pump Dryer           | 👍 mostly working, read-only |

#### WashTowers (combined washer+dryer)

| ThinQ model       | Appliance             | Support           |
| ----------------- | --------------------- | ----------------- |
| WTL_FXU_BDV_NA_01 | WKEX200HBA, WashTower | 👍 mostly working |

#### Dehumidifiers

| ThinQ model    | Appliance                     | Support           |
| -------------- | ----------------------------- | ----------------- |
| DHUM_056905_WW | MD19GQGE0, Smart Dehumidifier | 👍 mostly working |

#### Range hoods

| ThinQ model | Appliance                                      | Support    |
| ----------- | ---------------------------------------------- | ---------- |
| STUDIO_HOOD | HCED3015D, probably works with multiple models | 👍 working |

#### Ovens and ranges

| ThinQ model | Appliance                               | Support                                                                    |
| ----------- | --------------------------------------- | -------------------------------------------------------------------------- |
| WLREL6323S  | LREL6323S, Electric Range               | 🫤 preliminary read-only oven and cooktop support                          |
| WLSI_633\_  | LSIS6338FE, Slide-In Induction Range    | 👍 mostly working, read-only                                               |
| WFV474PGV   | (model name unknown), Double Oven/Range | 🫤 preliminary status, timer, cancel, and constrained remote-start support |

#### Microwave ovens

| ThinQ model | Appliance                                   | Support                                           |
| ----------- | ------------------------------------------- | ------------------------------------------------- |
| WMVEM1825   | MVEM1825D/F, Smart Over-the-Range Microwave | 👍 mostly working                                 |
| WMVEL2137   | MVEL2033F, Over-the-Range Microwave         | 👍 mostly working, with vent fan and lamp control |

#### Stylers

| ThinQ model     | Appliance | Support           |
| --------------- | --------- | ----------------- |
| ST_B_E4H01Y_APL | S5BBP     | 👍 mostly working |

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
