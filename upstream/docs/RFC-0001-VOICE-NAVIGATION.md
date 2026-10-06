# RFC-0001: Native Voice Navigation & Accessibility Engine (`zen-voice-nav`)

- **Status:** Proposed
- **Author:** Zen Voice Navigator Contributors (`zenKev`)
- **Target Subsystem:** `src/zen/voice-nav/`
- **Related Issues:** Accessibility, Hands-Free Navigation, Assistive Tech

---

## 1. Executive Summary & Review Empathy

This RFC proposes the integration of **`zen-voice-nav`**, a native, privacy-preserving, zero-latency voice navigation subsystem for Zen Browser.

### Key Highlights for Maintainers:
1. **Zero Impact on Default Builds:** Feature is gated behind `zen.voicenav.enabled` (defaults to `false`). When disabled, no actors are instantiated, no background subprocesses are spawned, and memory overhead is strictly 0 KB.
2. **Zero External Build Dependencies for Zen CI:** Zen does not need to compile or bundle Rust/AI audio binaries during CI. The browser includes an in-process, pure-JavaScript lexical matcher mock (`zen.voicenav.mock-engine = true`) that satisfies 100% of mochitests out of the box.
3. **Passive AOM Inspection:** Instead of injecting intrusive JavaScript content scripts into web pages (like legacy extensions do), `zen-voice-nav` queries Gecko's internal `nsIAccessibilityService` and invokes native `accNode.doAction(0)` / `takeFocus()`.
4. **Coexistence with Screen Readers:** It does not hook or monopolize OS accessibility channels (IAccessible2, UIAutomation, NSAccessibility). Existing screen reader users (NVDA, JAWS, Orca) retain full control.

---

## 2. Architecture & Process Boundaries (Fission Safe)

```text
 ┌─────────────────────────────────────────────────────────────┐
 │                    CONTENT PROCESS                          │
 │  (Sandboxed Web Page - Untrusted Code Execution)            │
 │                                                             │
 │  ZenVoiceNavChild.sys.mjs                                   │
 │    • Obtains rootAcc via nsIAccessibilityService            │
 │    • Iteratively traverses accessible tree                  │
 │    • Prunes non-actionable roles & off-screen bounds        │
 │    • Caches uniqueID -> nsIAccessible                       │
 └──────────────────────────────┬──────────────────────────────┘
                                │
                                │ JSWindowActor IPC (sendQuery)
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │                    PARENT / CHROME PROCESS                  │
 │  (Privileged Browser Engine)                                │
 │                                                             │
 │  ZenVoiceNavParent.sys.mjs                                  │
 │    • Orchestrates active tab candidates                     │
 │    • Dispatches chrome commands (scroll, tabs, history)     │
 │    • Manages Visual Badges / Highlighting overlay           │
 │                                                             │
 │  ZenVoiceEngineClient.sys.mjs                               │
 │    • Stdio NDJSON pipe manager via Subprocess.sys.mjs       │
 │    • In-Process Lexical Fallback (Zero-Dependency Mock)     │
 └──────────────────────────────┬──────────────────────────────┘
                                │
                                │ Stdio NDJSON (Local Anonymous Pipe)
                                ▼
 ┌─────────────────────────────────────────────────────────────┐
 │             OPTIONAL NATIVE DAEMON (zen-voice-engine)       │
 │  (Out-of-Process Rust Subprocess - Optional)                │
 │    • Silero VAD + Whisper STT audio pipeline                │
 │    • Token-level pruning & NLI Semantic Engine (<0.1ms)     │
 └─────────────────────────────────────────────────────────────┘
```

---

## 3. Threat Model & Security Boundaries

| Vector | Mitigated Mechanism |
| :--- | :--- |
| **Untrusted Web Execution** | Web content has **zero** access to the actor or engine. No DOM globals (`window.zenVoice`) are exposed. Web pages cannot trigger voice actions or detect whether the user is navigating by voice. |
| **Process Isolation (Fission)** | `ZenVoiceNavChild` runs in the unprivileged content sandbox. It cannot execute OS processes or open sockets. Only the privileged Chrome parent interacts with `Subprocess`. |
| **Network Attack Surface** | The IPC uses standard input/output (Stdio NDJSON) via anonymous OS pipes. **No TCP/UDP sockets or HTTP/WebSocket servers are opened on `0.0.0.0` or `127.0.0.1`**, eliminating local port hijacking risks. |
| **Memory DoS & Buffer Overflow** | Stdio streams are capped at 1 MB per line with an automatic truncate guard in `ZenVoiceEngineClient.sys.mjs`. Tree traversal is strictly capped (`MAX_TRAVERSAL_NODES = 5000`, `MAX_TRAVERSAL_DEPTH = 64`). |
| **DOM Injection Vulnerabilities** | **Zero `innerHTML` or `eval`**. All UI elements (visual overlay badges, focus rings, chrome HUD) are constructed via standard `createElement` and `textContent`. |

---

## 4. IPC Protocol Specification (NDJSON Stdio Contract)

All messages between `ZenVoiceEngineClient.sys.mjs` and the native daemon are serialized as newline-delimited JSON (`\n`).

### 4.1 Parent -> Engine: Classification Request
Dispatched when user voice input is transcribed and interactive candidates are harvested from the active tab.

```json
{
  "transcript": "guardar cambios",
  "top_k": 10,
  "candidates": [
    {
      "id": "1042",
      "roleId": 31,
      "role": "pushbutton",
      "name": "Guardar cambios",
      "description": "Guarda los ajustes del perfil",
      "bounds": { "x": 120, "y": 450, "width": 140, "height": 38 },
      "isVisible": true,
      "hasDefaultAction": true
    },
    {
      "id": "1043",
      "roleId": 31,
      "role": "pushbutton",
      "name": "Cancelar",
      "description": "",
      "bounds": { "x": 280, "y": 450, "width": 100, "height": 38 },
      "isVisible": true,
      "hasDefaultAction": true
    }
  ]
}
```

### 4.2 Engine -> Parent: Decision Response

```json
{
  "matched_id": "1042",
  "action": "Guardar cambios",
  "confidence": 0.985,
  "latency_ms": 0.08,
  "tier": "tier1_lexical",
  "fallback_to_vlm": false
}
```

### 4.3 Engine -> Parent: Unsolicited Real-Time Audio Event (Push)
When continuous microphone listening is enabled in the native daemon:

```json
{
  "type": "transcription_ready",
  "transcript": "desplazar abajo"
}
```

---

## 5. Screen Reader & Dual-Mode Matrix

The engine supports two operational modalities via `zen.voicenav.mode`:

| Mode | Target User | Feedback Mechanism | AOM Invocation |
| :--- | :--- | :--- | :--- |
| `visual-overlay` *(default)* | Sighted / Hands-free productivity | Subtle Vimium-style number badges + focus ring | `accNode.doAction(0)` + CSS focus ring |
| `screen-reader` | Visually impaired / Blind users | Silent to eyes, vocalized via system screen reader | `accNode.announce("clic: [name]", POLITE)` + `takeFocus()` |
| `both` | Hybrid / Assisted accessibility | Visual badge flash + screen reader announcement | Both channels simultaneously |

---

## 6. Implementation Lifecycle & Performance

- **Idle Cost:** 0 ms CPU, 0 MB RAM when idle.
- **Viewport Culling at Source:** Only elements intersecting the viewport (`window.innerWidth`, `window.innerHeight`) are serialized over IPC. 10,000 DOM elements in a background document typically prune to fewer than 40 interactive candidates.
- **Shutdown Observer:** Subprocess registers on `quit-application-granted` via `Services.obs` to guarantee clean process teardown without zombie processes.
