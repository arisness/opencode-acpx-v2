# Changelog

All notable changes to this project are documented here. The format is based on
Keep a Changelog and the package uses Semantic Versioning.

## [Unreleased]

## [0.1.0] - 2026-09-25

### Added

- OpenCode 2 entrypoint using `setup()`, `ctx.provider.transform` and AI SDK
  hooks.
- In-memory ACP provider and model registration for Cursor Agent.
- Isolated OpenCode 2 configuration with deny-by-default permissions and an
  explicit trusted-agent opt-in.
- OpenCode 2 unit coverage and real end-to-end Cursor ACP smoke tests.

### Fixed

- Preserve factory routing metadata in OpenCode 2 model settings.
- Accept host-normalised empty model configuration during request routing.

## [0.0.1] - 2026-08-15

### Added

- One-package OpenCode server, TUI, internal `LanguageModelV3` provider and
  isolated Node worker.
- Cursor, Claude, Codex, Grok Build, Hermes and custom ACP v1 presets.
- Dynamic model, configuration and command discovery with explicit fallbacks
  and OpenCode provider filtering.
- Stable OpenCode variants for ACP thought level, reasoning effort,
  model-scoped configuration and Cursor parameter controls.
- Persistent ACP session identity, per-session ordering, cancellation,
  idempotency and process cleanup.
- Streaming text, reasoning, usage, plans, native tool presentation, todos and
  subagent activity.
- Fail-closed OpenCode permission, question, elicitation and vendor-interaction
  bridges.
- ACP stdio operation through explicitly configured SSH commands.
- Deterministic unit, worker, real-process ACP integration and packaging tests.
- Architecture, configuration, compatibility, security and testing guides.

### Fixed

- Retain whitelisted ACP providers and last-known-good catalogues when a live
  startup probe is temporarily unavailable.
- Preserve every effort and fast-mode combination across ACP sticky session
  selection and OpenCode processes.
- Avoid duplicate remote ACP sessions for OpenCode title, summary and
  compaction agents.
- Keep model IDs opaque, including Cursor parameterised and Hermes
  provider-qualified identifiers.
- Correlate session-less task notifications and suppress redundant
  informational tool cards after native projection.

[Unreleased]: https://github.com/adolfo199/opencode-acpx-v2/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/adolfo199/opencode-acpx-v2/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/intellectronica/opencode-acpx/releases/tag/v0.0.1
