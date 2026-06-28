# Enrolling newer ThinQ2 firmware (RTL8720cm "CLIP", protocolVer 4.9)

Notes from bringing up a current-gen LG appliance — an **`BDH_D30007_US` dryer** (DeviceType 202,
RTK_RTL8720cm Wi-Fi/"CLIP" module, `protocolVer 4.9`, sw 2.11.263) — fully local on rethink. It now
completes SoftAP → `/route` → cert → MQTT clip, enrolls, and streams telemetry with no LG cloud
contact. A couple of things differ from older firmware; this documents them so the next person with
a newer module doesn't repeat the rabbit holes.

## 1. The setup `publicKey` must have no in-band whitespace  *(fixed in this branch)*

`rethink-setup`'s hardcoded `publicKey` was a tab-indented template literal, so every base64 line
carried a leading `\t` inside the PEM. Older firmware strips it; the RTL8720cm CLIP parser is strict.

With the indentation, `getDeviceInfo` comes back as:
```
encrypt_val: ''
extra: 'POWER_ON|...|encryptRes:ffff'   # the device's RSA-encrypt step failed
```
The device then can't build a cert request, reboots onto Wi-Fi, polls `/route` a few times, sends a
clean `close_notify`, and gives up — which looks like a `/route` problem but is really the setup key.

With a clean PEM (base64 at column 0, same key bytes):
```
extra: 'POWER_ON|...|encryptRes:0'
encrypt_val: 'frkUhxnfo4kzwExk1zF2...'   # non-empty
```
…and it proceeds straight through `/route` → `GET /route/certificate` → `POST /device/:id/certificate`
→ MQTT. See the `rethink-setup: strip whitespace from the setup publicKey` commit.

## 2. Unknown models now loosely enroll instead of being dropped  *(added in this branch)*

Previously an unknown `modelId` was dropped (`ha_bridge` logged `device type ... unknown` and
returned). A new appliance could provision perfectly and still never appear in HA, get no answer from
the cloud side, and leave you with no captured data to build a class from. A generic raw-capture
fallback now enrolls any unknown thinq2 device and republishes its raw packet hex to a diagnostic HA
sensor, so adding real support becomes a decode exercise against live data. See the
`ha_bridge: generic raw-capture fallback` commit + `cloud/devices/generic.ts`.

## 3. Legacy TLS profile (modern Node / OpenSSL 3)  *(not changed here — see issues #17/#18)*

This firmware is TLS-1.2-only and prefers legacy ECDHE-CBC-SHA suites. On Node ≥ 20 / OpenSSL 3 the
server defaults are too strict and the handshake fails. A relaxed profile is needed:
`minVersion/maxVersion: 'TLSv1.2'`, the legacy ciphers at `@SECLEVEL=0`, and
`SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION | SSL_OP_LEGACY_SERVER_CONNECT` on the HTTPS and MQTTS
servers. This is already tracked in issues #17/#18; left out of this PR to keep it focused, but
required to reproduce the flow on a current Node.

## 4. Post-provision: power-cycle the appliance once

After `releaseDev` the device reboots itself, but on this firmware it then sits in "connecting…",
streams monitoring for a few minutes, and publishes `clip/provisioning/.../undeploy` (we see
`req_timesync` with `rssi:-100` = a reboot) — a re-registration loop that never settles. A **hard
power-cycle of the appliance after provisioning** makes it come up clean and hold a stable connection
(verified across a full ~50-minute dryer cycle: one MQTT connection, 0 undeploys, ~960 telemetry
packets). The firmware's own soft-reset appears insufficient where a cold boot is not. Whether a
cloud/setup-triggerable clean reset exists (a reboot opcode after `releaseDev`, or an AABB reboot
command over MQTT) is an open question.

## Things that were NOT the problem (so nobody chases them)

- **The fake OTP / shared `publicKey`.** Fine for the local flow: rethink signs the CSR without
  verifying the `ciphertext`, and the `publicKey` is a fixed value (a real cloud-issued key is
  byte-identical to the one in the repo). A self-generated `base64(uuid)` OTP also works.
- **The minimal `/route` body.** Upstream returns `ssl://<config.hostname>:<port>`, which the rethink
  CA cert covers, so the broker TLS validates fine. (Returning a real per-region AWS mqtt host would
  break it — the device validates the broker cert against that SNI and rejects it `bad_certificate`.)
- **`svcphase`.** Our working setup ran `svcphase: 'OP'` rather than the repo's debug-UART `'QA'`; we
  could not isolate whether OP is *required* for this firmware, so we left the default alone here.
  Flagging in case it matters for other newer modules.

## Device under test
`BDH_D30007_US`, did `fe8b2ea0-…-3034dbd055fe`. Full packet captures + decrypted MQTT clip transcripts
available (SoftAP setup, `/route`, cert, `deploy`/`completeProvisioning`/`_ack`, telemetry).
