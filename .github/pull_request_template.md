<!--
Adding support for a new device? See the contributor guide before opening this:
https://github.com/anszom/rethink/wiki/Adding-support-for-a-new-device
and fill in the "New device" sections below. Otherwise, delete them.

Delete this comment block before submitting.
-->

## Summary

<!-- What does this change, and why? -->

## Test plan

<!-- How did you verify this? `npm test` output, manual steps, a real device you tested
     against - whatever's relevant. -->

## New device

- Brand / model name:
- ThinQ Model ID:
- Platform: ThinQ1 / ThinQ2
- Related issue (if one exists):

### What's supported

<!-- What Home Assistant entities does this expose? What's read-only vs. controllable?
     Call out anything you deliberately left out and why (e.g. a feature you couldn't
     confirm safely, or one that would require behaviour rethink shouldn't implement). -->

### New device checklist

- [ ] Tested against a real physical device, not just synthetic data.
- [ ] All entities were checked against a real device, the LG cloud, or the modelJson definition.
- [ ] Added a unit test under `tests/cloud/devices/` built from real captured data where possible.

## Checklist

- [ ] `npm run check`, `npm test`, `npx prettier --check .` pass locally.
- [ ] I've made sure that the code follows the guidelines outlined in CONTRIBUTING.md;
      any deviations are explained in the PR description.

## LLM checklist. Required only if an LLM was used

- [ ] I understand it and can explain the reasoning behind the code.
- [ ] My LLM has pre-reviewed that the code follows CONTRIBUTING.md guidelines.
- [ ] The code comments and the PR description are not overly verbose (AI agents like to babble).
