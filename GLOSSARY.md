# Zen Voice Navigation (zenKev)

Voice-driven accessibility and hands-free control system for Zen Browser, integrating real-time speech processing with Gecko browser navigation.

## Language

### Interaction & Feedback

**Interaction Mode**:
The active presentation profile governing how feedback and targets are presented to the user (`screen-reader`, `visual-overlay`, or `both`).
_Avoid_: Profile, theme, display style

**Earcon**:
A brief, distinct audio cue providing non-verbal acoustic feedback on state transitions (mute, unmute, command success, error).
_Avoid_: Beep, sound effect, chime, notification tone

**Visual Badge**:
A floating numbered marker rendered over interactive web elements for hands-free identification and targeting.
_Avoid_: Hint, tag, label, marker number

**Barge-in**:
The capability of the speech subsystem to immediately suppress ongoing audio or announcements the instant user speech is detected.
_Avoid_: Interruption, audio cutoff, mute toggle

### System & Architecture

**Voice Engine**:
The standalone real-time audio pipeline that captures microphone input, applies Voice Activity Detection (VAD), and infers command intents.
_Avoid_: Backend, server, mic script

**Command Intent**:
A normalized semantic instruction emitted by the Voice Engine to trigger a specific browser operation.
_Avoid_: Utterance, transcript, query, action string

**Voice Nav Actor**:
The Gecko `JSWindowActor` pair (`Parent` and `Child`) coordinating privileged browser chrome capabilities with DOM execution in web content.
_Avoid_: Extension script, content script, addon
