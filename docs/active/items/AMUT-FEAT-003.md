---
id: AMUT-FEAT-003
workflow: github
github_issue: https://github.com/emulebb/amutorrent/issues/6
title: Drive emulebb-rust as a qBittorrent-emulating download client
status: OPEN
priority: Minor
category: feature
labels: [controller, integration, rust, suite]
milestone: phase-2
created: 2026-06-14
source: suite forward program (note 15); SUITE-AUTOMATION
---

> Workflow status is tracked in GitHub. This local document is retained as an engineering spec/evidence record.

# AMUT-FEAT-003 - Drive emulebb-rust as a qBittorrent-emulating download client

## Summary

Register and drive emulebb-rust through its qBittorrent-WebUI-emulating
download-client API (RUST-FEAT-004), the same way aMuTorrent already drives aMule
and qBittorrent. emulebb-rust presents as "a qBittorrent" to Arr-style consumers,
so this is an integration + verification slice, not new protocol work.

## Why This Matters

It makes the forward eD2K core a first-class managed client in the suite
controller with zero bespoke integration, mirroring the eMuleBB `/api/v2`
compatibility pattern aMuTorrent already consumes.

## Acceptance Criteria

- [ ] aMuTorrent can add, list, pause, resume, and remove a download on
      emulebb-rust via its qBittorrent-compatible API.
- [ ] emulebb-rust appears as a download client in the setup wizard alongside
      aMule/qBittorrent.

## Notes

- Depends on RUST-FEAT-004 (Arr surfaces) landing the qBittorrent-compatible API.
