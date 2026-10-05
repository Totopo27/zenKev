# Security Policy

## Supported Versions

Only the latest release and the current active development branch (`main`) receive security updates.

| Version | Supported          |
| ------- | ------------------ |
| `main`  | :white_check_mark: |
| Latest  | :white_check_mark: |
| Older   | :x:                |

## Reporting a Vulnerability

We take the security of this project seriously. If you discover a security vulnerability, please report it responsibly and privately.

- **Private Reporting**: Submit vulnerability reports directly through [GitHub Private Vulnerability Reporting](https://github.com/Totopo27/zenKev/security/advisories/new).
- **No Public Issues**: Please do **not** open public GitHub issues, discussions, or pull requests for unmitigated security vulnerabilities.
- **Response Commitment**: We aim to acknowledge receipt of reports within 48 to 72 hours and provide an initial triage evaluation.

When reporting, please include:
- A description of the issue and potential security impact.
- Step-by-step reproduction instructions or a minimal proof of concept (PoC).
- Relevant environment details (operating system, build/commit hash).

## Security Architecture Highlights

zenKev builds upon the Mozilla Gecko platform and Zen Browser foundation, adhering to standard security principles:

- **Zero-Telemetry Local Design**: Core features operate locally without unsolicited background telemetry or external data collection.
- **Fission-Compliant Gecko JSWindowActors**: Subsystems and custom browser logic communicate across process boundaries via standard `JSWindowActor` pairs, respecting Mozilla Site Isolation (Fission) boundaries.
- **Sandboxed Content Actors**: Content-facing actors execute within unprivileged child processes with minimal, validated IPC contracts exposed to privileged parent actors.
