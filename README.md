# zenKev (Zen Voice Navigator)

> **Accessible, Local, Deterministic Voice Navigation Engine for Zen Browser (Gecko)**

`zenKev` provides native, zero-latency, CPU-first voice control for **Zen Browser** through deep integration with Gecko's **Accessibility Object Model (AOM)**, bypassing the visual DOM and communicating with an ultra-fast Rust inference daemon.

---

## Architecture Overview

```text
       [ User Voice Command ]
                  │
                  ▼
   [ Audio Pipeline: Silero VAD + Whisper STT ]
                  │ (Transcript text)
                  ▼
   [ Gecko Content: ZenVoiceNavChild ]  ◄── Extracts actionable AOM nodes via nsIAccessibilityService
                  │
                  ▼ (IPC sendQuery)
   [ Gecko Chrome: ZenVoiceNavParent ]
                  │
                  ▼ (Stdio NDJSON)
   [ Rust Daemon: zen-voice-engine ]    ◄── Lexical pruning & Intent Decision (<0.1 ms latency)
                  │
                  ▼ (Target Action)
   [ Gecko Actuator ]                   ──► Direct accNode.doAction(0) / takeFocus()
```

---

## Core Components

1. **`modules/voice-nav/` (Gecko JSWindowActors):**
   - **`ZenVoiceNavChild.sys.mjs`:** Runs in content processes. Iteratively traverses `nsIAccessible` trees, prunes non-interactive elements and elements outside the current viewport.
   - **`ZenVoiceNavParent.sys.mjs`:** Runs in the parent/chrome process. Acts as the orchestrator and IPC bridge.
   - **`ZenVoiceEngineClient.sys.mjs`:** Manages the lifecycle and Stdio NDJSON pipe to the Rust daemon.

2. **`modules/voice-engine/` (Rust Inference Daemon):**
   - **`lexical_ranker.rs`:** Sub-millisecond pre-ranking and pruning using token n-grams and normalized similarity.
   - **`nli_engine.rs`:** ModernBERT Natural Language Inference intent decision classifier.
   - **`mimalloc` allocator:** Zero-fragmentation memory allocation under high throughput.

---

## Screen Reader Coexistence (JAWS / NVDA / VoiceOver)

`zenKev` does not intercept OS-level accessibility APIs (IAccessible2, UIAutomation, NSAccessibility). It queries Gecko's internal `nsIAccessibilityService` concurrently as a passive observer, preserving virtual cursors and focus states for external screen readers.

---

## Building and Testing

### 1. Rust Daemon Tests
```bash
cd modules/voice-engine
cargo test --release
```

### 2. Live Stdio Benchmark
```bash
cargo build --release --manifest-path modules/voice-engine/Cargo.toml
node modules/voice-engine/tests/benchmark_throughput.mjs
```

### 3. Serving the zenKev Bridge (Kev-4B NLI Model)
The fine-tuned Kev-4B checkpoint is hosted on Hugging Face: [Ttotopo27/zenkev-v4](https://huggingface.co/Ttotopo27/zenkev-v4).

To start the local HTTP bridge server:
```bash
python scripts/serve_zenkev_bridge.py
```
*Note: If no local checkpoint path is defined via `ZENKEV_MODEL_PATH`, the bridge will automatically download and resolve the checkpoint from `Ttotopo27/zenkev-v4`.*

---

## License

Mozilla Public License 2.0 (`MPL-2.0`). See [LICENSE](LICENSE) for details.
