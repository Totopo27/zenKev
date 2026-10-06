# Zen Maintainers Testing Guide: Voice Navigation (`zen-voice-nav`)

> **Executive Goal:** Verify and test the full Voice Navigation subsystem without needing Rust, Cargo, PyTorch, or external binaries.

---

## 1. Quick Path (30 Seconds in Browser Console)

1. Launch Zen Browser with a test profile:
   ```bash
   zen -profile /tmp/zen-test-profile -jsconsole
   ```
2. In `about:config`, set:
   - `zen.voicenav.enabled` = `true`
   - `zen.voicenav.mock-engine` = `true` *(Enables pure JS in-process lexical matcher)*
3. Open any web page with buttons (e.g. `https://example.com` or GitHub).
4. Open the **Browser Console** (`Ctrl+Shift+J` or `Cmd+Option+J`) and paste:
   ```javascript
   // 1. Get actor of current tab
   const actor = gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor("ZenVoiceNav");

   // 2. Extract AOM candidates (should print visible buttons/links)
   const data = await actor.getCandidates(true);
   console.log("Visible Candidates:", data.candidates);

   // 3. Show visual number badges
   await actor.showVisualOverlay(data.candidates);

   // 4. Test simulated voice command
   await actor.processVoiceCommand("More information");
   ```
5. **Expected Result:**
   - Cyan badges appear over actionable buttons.
   - The button matching "More information" highlights with a cyan ring and triggers its native action.

---

## 2. Automated Testing (Gecko Mochitest)

Run the included automated mochitest through `./mach`:

```bash
./mach mochitest src/zen/voice-nav/tests/browser_voice_nav_basic.js
```

### What this test verifies:
- `ZenVoiceNav` JSWindowActor registration across content and parent processes.
- Viewport-based pruning of off-screen elements via `nsIAccessibilityService`.
- Execution of `doAction(0)` without synthesizing untrusted mouse clicks.
- Deterministic match resolution using the built-in mock engine.

---

## 3. Testing with the Optional Native Daemon (For Full Audio/AI Testing)

If you want to test live microphone audio and sub-millisecond Rust lexical/NLI classification:

1. Compile or place `zen-voice-engine` binary:
   ```bash
   # In modules/voice-engine
   cargo build --release
   ```
2. Tell Zen where the binary is located:
   - In `about:config`:
     `zen.voicenav.engine-path` = `/path/to/zen-voice-engine`
     *(On Windows: `C:\path\to\zen-voice-engine.exe`)*
   - Or set the environment variable:
     `ZEN_VOICE_ENGINE_BIN=/path/to/zen-voice-engine`
3. Set `zen.voicenav.mock-engine` = `false`.
4. Speak into the microphone. Commands are processed live with acoustic normalization.

---

## 4. Configuration Preferences Matrix

| Preference | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `zen.voicenav.enabled` | `boolean` | `false` | Master kill-switch. When `false`, zero actors/listeners are loaded. |
| `zen.voicenav.mode` | `string` | `"visual-overlay"` | Options: `"visual-overlay"`, `"screen-reader"`, `"both"`. |
| `zen.voicenav.mock-engine` | `boolean` | `false` | When `true`, uses the in-process JS matcher instead of spawning the daemon. |
| `zen.voicenav.engine-path` | `string` | `""` | Path to the `zen-voice-engine` executable. Defaults to profile directory if empty. |
| `zen.voicenav.debug` | `boolean` | `false` | Enables verbose logging in browser console and profile log. |

---

## 5. Reviewer Empathy Checklist

Before merging, maintainers can confirm:

- [ ] **No regression when disabled:** With `zen.voicenav.enabled = false`, performance, memory, and tab opening benchmarks are identical to stock Zen.
- [ ] **Fission safe:** Content process does not initiate native processes or access network sockets.
- [ ] **No DOM pollution:** Websites cannot detect `ZenVoiceNav` or tamper with accessibility tree extraction.
- [ ] **Zero innerHTML:** All overlay DOM manipulation uses safe `createElement` / `textContent` APIs.
- [ ] **Clean shutdown:** When closing the browser, the shutdown observer terminates the background subprocess cleanly.
