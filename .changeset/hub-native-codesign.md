---
"@moonshot-ai/kimi-code": patch
---

Fix the `kimi-hub` native build producing an unsigned executable on macOS. The SEA injection step strips the signature and nothing re-applied it, so on Apple Silicon the kernel SIGKILLed the binary on exec and `kimi-hub` died with a bare `killed` and no diagnostics. The build now re-signs after injection (ad-hoc by default, `APPLE_SIGNING_IDENTITY` for a real identity) and verifies the signature before finishing.
