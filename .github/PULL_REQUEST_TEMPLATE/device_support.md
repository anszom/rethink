<!--
New device support PR. See the contributor guide before opening this:
https://github.com/anszom/rethink/wiki/Adding-support-for-a-new-device

Delete this comment block before submitting.
-->

## Device

- Brand / model name:
- ThinQ Model ID:
- Platform: ThinQ1 / TLV / AABB
- Related issue (if one exists):

## What's supported

<!-- What Home Assistant entities does this expose? What's read-only vs. controllable?
     Call out anything you deliberately left out and why (e.g. a feature you couldn't
     confirm safely, or one that would require behaviour rethink shouldn't implement). -->

## How this was verified

- [ ] Checked against `modelJson` (ThinQ1) or decoded packet captures (TLV/AABB) - not just guessed from the app's UI
- [ ] Tested against a real physical device, not just synthetic data
- [ ] Added a unit test under `tests/cloud/devices/` built from real captured data where possible
- [ ] `npm test` and `npx tsc --noEmit` pass locally

## Guidelines checklist

- [ ] Maps the device protocol to Home Assistant with little or no extra logic - no timers, schedules, or safety locks implemented here (those belong in Home Assistant)
- [ ] Doesn't circumvent any device-side safety feature
- [ ] If any code here was LLM-generated, I understand it and can explain the reasoning behind it
