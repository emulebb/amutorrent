# aMuTorrent Active Backlog — Issue Index

This directory is the active local/spec layer for the **aMuTorrent** fork's role
in the BB suite. It follows the eMuleBB backlog convention
([`BACKLOG-PROCESS`](../../../emulebb-tooling/docs/reference/BACKLOG-PROCESS.md),
[`BACKLOG-ITEM-TEMPLATE`](../../../emulebb-tooling/docs/reference/BACKLOG-ITEM-TEMPLATE.md)).

## Current Snapshot

**Source of truth:** `EMULEBB_WORKSPACE_ROOT\repos\amutorrent` (`main` branch)
**Status:** **FROZEN / deprecated** — aMuTorrent is the controller bundled with
the frozen eMuleBB `0.7.3` release (sustainability: bug/security/packaging only).
The forward cross-network controller is **TrackMuleBB** (`emulebb/trackmulebb`),
which supersedes it. See `emulebb-tooling/docs/active/PRODUCT-PORTFOLIO.md`.
**Phase:** Phase 2 of `emulebb-tooling/docs/active/SUITE-JOINT-ROADMAP.md`
(legacy controller layer).
**Role:** the optional cross-network controller in the `0.7.3` bundle; clients +
Prowlarr stay fully standalone. The `AMUT-FEAT-*` items below are retained as
**design reference for TrackMuleBB**, not active aMuTorrent scope. Design:
[`docs/SUITE-AUTOMATION.md`](../SUITE-AUTOMATION.md).
**Tracking:** issues live in `emulebb/amutorrent` and aggregate on the org
**eMuleBB Suite** board (`https://github.com/orgs/emulebb/projects/3`,
`Product = aMuTorrent`).

## ID Taxonomy

Item IDs carry a **product prefix**: aMuTorrent uses `AMUT-<CLASS>-<NNN>` with
classes `BUG`, `FEAT`, `REF`, `CI`. (Other products use `RUST-`, `QBBB-`,
`GOED2K-`; the frozen MFC app keeps legacy unprefixed IDs.)

## Features (`FEAT`)

| ID | Priority | Status | Title |
|----|----------|--------|-------|
| [AMUT-FEAT-001](items/AMUT-FEAT-001.md) | Major | OPEN | Cross-network "download the torrent instead" intent handoff |
| [AMUT-FEAT-002](items/AMUT-FEAT-002.md) | Major | OPEN | Suite automation: cross-network grab + reconcile/orphan actuation |
| [AMUT-FEAT-003](items/AMUT-FEAT-003.md) | Minor | OPEN | Drive emulebb-rust as a qBittorrent-emulating download client |

## Bugs (`BUG`)

| ID | Priority | Status | Title |
|----|----------|--------|-------|
| _none yet_ | | | |
