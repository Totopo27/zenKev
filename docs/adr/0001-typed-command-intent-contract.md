# ADR-0001: Typed Command Intent Contract Across Engine and Browser Actors

The Voice Engine and the Zen Browser Gecko actors communicate via a normalized, typed `Command Intent` payload over Stdio NDJSON rather than passing raw transcription strings. Natural language parsing, synonym mapping, and parameter extraction are encapsulated inside the Voice Engine, keeping browser actors strictly focused on atomic browser automation and UI rendering.

## Status

Accepted

## Context

Previously, the Voice Engine emitted raw string transcripts directly to `ZenVoiceEngineClient`, forcing `ZenVoiceNavParent.sys.mjs` (over 3,200 lines) to execute regular expression tables and string parsing in the browser chrome thread. This coupled the browser UI thread to speech/language variance and made headless testing difficult.

## Decision

We establish an explicit seam at the IPC boundary where the Voice Engine emits structured JSON payloads conforming to:

```json
{
  "type": "command_intent",
  "action": "scroll" | "navigate" | "click_badge" | "tab_action" | "voice_state",
  "params": {
    "direction": "down" | "up",
    "amount": 300,
    "target": "string"
  },
  "raw_transcript": "baja un poco",
  "confidence": 0.95
}
```

Browser actors (`ZenVoiceNavParent` and `ZenVoiceNavChild`) consume this contract directly, removing string parsing from the Gecko process.

## Consequences

- **Depth**: The Voice Engine becomes a deep module encapsulating speech recognition, VAD, and intent classification.
- **Testability**: Browser actors can be tested deterministically with static JSON mocks without spinning up audio hardware or speech models.
- **Portability**: Replacing or upgrading the voice inference engine requires no changes to browser actor code.
- **Trade-off**: The Python/Rust engine or bridge layer must perform intent classification before dispatching messages to the browser.
