---
id: AMUT-FEAT-002
workflow: github
github_issue: https://github.com/emulebb/amutorrent/issues/5
title: Suite automation: cross-network grab + reconcile/orphan actuation
status: OPEN
priority: Major
category: feature
labels: [controller, automation, suite, reconciliation]
milestone: phase-2
created: 2026-06-14
source: suite forward program (notes 16-17); SUITE-AUTOMATION
---

> Workflow status is tracked in GitHub. This local document is retained as an engineering spec/evidence record.

# AMUT-FEAT-002 - Suite automation: cross-network grab + reconcile/orphan actuation

## Summary

Give aMuTorrent the suite-specific automation no single client or the generic Arr
stack can express: cross-network grab decisions (eD2K collection vs BT torrent for
the same content), acting on the Python fabric's reconcile/orphan reports, and
export/publish orchestration. Generic download rules stay where they already work
(qBittorrentBB native rules, Sonarr/Radarr/Prowlarr). Design:
[`docs/SUITE-AUTOMATION.md`](../../SUITE-AUTOMATION.md).

## Why This Matters

Only the controller sees both indexes, both download clients, and the metadata
fabric. Reconcile/orphan reports are report-only by design — the controller is
their natural actuator.

## Intended Shape

- Read reconcile/orphan reports; optionally promote `orphan→harvest-matched` data
  to the live library and start seeding; flag mixed-content directories.
- Given a rule match or intent, choose network + client and dispatch the grab.
- Trigger the qBittorrentBB branded export and (later) the BEP-46 library publish.

## Scope Constraints

- Do not reinvent the Arr stack; own only the cross-network / eD2K-aware /
  metadata-fabric logic.
- Optional layer — clients + Prowlarr stay standalone.
- Scope split (whether aMuTorrent owns all generic rules) is **parked**.

## Acceptance Criteria

- [ ] Reconcile/orphan reports drive at least one actuation (e.g. adopt + seed).
- [ ] A cross-network grab decision routes to the correct client.
- [ ] No required-hop dependency introduced.

## Notes

- Depends on the metadata fabric reports and the branded export (QBBB-FEAT-001).
