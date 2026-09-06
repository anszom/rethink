# Introduction

This project has recently attracted much more attention than I've expected. In order to
streamline the pull request review process, I've provided some guidelines for contributors.
Treat them as "strong recommendations" - if there is a good reason to bend the rules,
please state it in the code/PR comments.

---

## 1. Adding device support

- **Device name in README.md.** Any new device should be listed in README.md by its
  "marketing" model name (`WKEX200HBA` instead of `WTL_FXU_BDV_NA_01`), grouped by device
  type. The thinq model name may optionally follow.
- **Aliasing.** If a different protocol handler matches your device exactly, simply add
  an alias in `ha_bridge.ts`. Otherwise, create a new handler. Refactoring shared parts
  is a subjective decision, no hard rules here.
- **English names only.** This covers all entity names/values exposed to HomeAssistant.
- **Consistency.** When introducing an entity, check if other similar devices already provide
  it. Try to maintain consistent labels/icons/HA metadata.
- **Follow HA conventions.** As much as possible, try to use HA-native formats/units.
  Notably, values that represent a closed set of options should likely use `class: 'enum'`.
- **Follow HA class requirements.** If an entity uses `class: 'enum'`, providing values
  outside the `options` list is an error. The only exception is the `'None'` constant,
  accepted by HA unconditionally. `publishProperty` maps `undefined` values to `'None'`.
- **Follow official names.** If the LG app, device manual, front panel, or other official
  material provides a name for a feature/function - use it. This may conflict with some
  of the rules above, apply common sense :)
- **No post-processing.** Except for unit conversion, try to avoid postprocessing data
  within `rethink`. An example of an acceptable edge case is RAC_056905_WW's power
  consumption adjustment.
- **No debugging entities.** Don't expose unprocessed data to HomeAssistant. Feel free
  to keep such code on your development branch, but don't merge.
- **Only confirmed entities.** Feel free to guess what a bit does, but confirm it. Don't
  expose entities based on a guess only. Testing with real captured packets (see below)
  will expose any deviations from this rule.
- **Change debouncing.** Some devices don't react to commands instantly. Hiding this
  latency is often desirable. The preferred approach is to use HA's builtin `optimistic`
  flag. Invent your own debouncing scheme only if the builtin is not suitable.
- **Safety interlocks.** Rethink should neither fight against lockouts built into the
  device, nor implement its own on top of that.

## 2. Tests

- **Each device handler requires a test file.** Doesn't apply to a trivial alias.
- **Test against captured packets.** Testing against synthetically constructed buffers only
  validates the implementation, instead of compatibility with the actual device.
- **Complex logic needs its own test.** If any nontrivial logic is introduced/modified, it should
  be accompanied with a test as well.

## 3. Code style

- **Keep `prettier` style.** Commit hooks enforce this, don't overrule them.
- **Don't drop existing comments** without a reason. This seems pretty obvious, but LLM
  agents like to sometimes refactor code and drop the existing comments.
- **Comments are not a revision history.** Again a weak point for LLMs. If you rework
  something, it's usually unnecessary to keep a detailed history in comments. For commited
  code, `git log` will reveal everything; for uncommited changes - it's not really
  interesting how the final version was reached. On the other hand, a few words explaining
  the **rationale** for the current design may be helpful.

## 4. Commit hygiene

- **One logical change per commit.** If your work touches various areas, split it into
  separate commits. Each intermediate commit must be consistent on its own (pass build&test).
- **Amend, don't stack.** If you find something needs to be revised, please amend the
  original commit instead of maintaining all the intermediate versions in the PR. This
  doesn't apply to code already merged - there will be no "evil rebase" on the master
  branch.
- **Don't merge master into the feature branch.** This introduces unnecessary noise,
  instead, rebase your work on top of master if necessary. PRs based on an old master,
  but mergeable without conflicts are fine.
- **Long-lived PRs.** If modifications are required before a PR is merged, push (or
  force-push) to the original PR branch instead of opening a new PR.
