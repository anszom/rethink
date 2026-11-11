# SideKick write multiplexing

The SideKick driver uses the maintainer's `WriteQueueDevice` from
`73872810566d090cc8288635cc75aa4939f2af79` without modifying shared transport code.
Driver and bridge streams share one FIFO. Replies go only to the stream that
sent the write. Exact E6 target, record size/marker and unique property-ID set,
or the exact F024 reply layout, determine a match. Driver callbacks interpret
captured result codes and publish command diagnostics, never requested state.

All settings are standalone writes (or the two complete captured downloaded-course
bundles), not bundles assembled from cached settings. No accepted-value overlay,
bridge-write observer, generation tracking or queue implementation is needed in
the driver. A current powered-on report remains required for non-power commands;
there is no extra Remote Start or drawer gate. Report latency under competing
live bridge/HA commands has not been newly tested.

## Differences from the old PR branch

- FIFO retains all requested settings; unsent settings are not coalesced.
- The unchanged 3000 ms shared timeout reports a driver command failure, then
  continues the queue. No fail-closed latch or automatic retry is added. Late
  identical replies are indistinguishable and can answer a newer matching write.
- ACK handling belongs to the shared multiplexer and precedes driver processing.
  Its permissive framing checks are unchanged: invalid CRC/length frames may be
  ACKed, and structurally matching replies may settle writes before driver frame
  validation. This is not strict transport validation.
- Driver `onData` still checks frame class, lengths and checksum/CRC before parsing
  reports. Only strict EB49/EC98 current records and supported notifications publish
  appliance state. Embedded reply records never publish state.
- Matched bridge replies are private to the bridge stream. The driver relies on
  subsequent reports, not bridge replies, for course/power/setting readback.

No dependencies, protocol encodings or timing constants changed. Offline tests
are not new physical validation. No deployment or appliance commands are part of
this port.
