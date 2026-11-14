# SideKick remote setting and arming

User-operated MI2U7B captures from 2026-11-11 verify separate fields in each
49-byte status record (zero-based offsets). No agent appliance traffic was used.
EC98 reports contain previous/current records; only the last record is current.

- **Keep Remote Start**: record40 mask04. ON sends `f024100101`, OFF sends
  `f024100100`. Both received successful class20 short replies. Fresh EC
  readback sets/clears the bit; the reply alone is not setting confirmation.
- **Remote start**: record37 mask10. Panel arming sets it and panel disarming
  clears it, independently of the persistent setting.
- **Door lock**: record38 mask01 changes in separate reports after arming and
  disarming. This follows the existing washer lock mapping and capture
  correlation. Physical latch operation was not separately confirmed. ON means
  locked, so the inverted HA binary-sensor lock device class is not used.
- The first setting ON report also clears record37 mask02 and record39 mask20.
  No meaning is assigned to those changes.

The two ending Spin Only EC reports change state21 from14 (Spinning) to42
(Remote maintain), then retain42 while remaining minutes change from1 to8.
Both keep record37 mask10, record38 mask01 and record40 mask04 ON. The user
confirmed the panel displayed “Remote still on” and could start another cycle.
No restart packets were supplied: neither the eight-minute field nor these
captures establish a restart command/transition. Completion-event handling is
unchanged; its separate notification validation remains limited to Tub Clean.

The device has no KeepFresh per the user. No KeepFresh entity or command is
inferred from other washer/dryer models. Persistence across power loss, other
courses' ending behavior and the full HA command path are not established here.

Regression fixtures contain only eight captured EC status frames, with no
appliance identifiers, credentials or unrelated traffic. Their original framing,
previous/current records and CRC16/XMODEM are retained. Sequences AE1F/AE24
cover setting ON/OFF; AE43/AE45/AE4D/AE4E cover arming/lock/disarming/unlock;
AECA/AECD cover the ending state. Successful command replies use the existing
short-frame helper with the captured class20 payload `20002400`.
