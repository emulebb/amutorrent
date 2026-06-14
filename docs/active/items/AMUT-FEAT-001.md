---
id: AMUT-FEAT-001
workflow: github
github_issue: https://github.com/emulebb/amutorrent/issues/4
title: Cross-network "download the torrent instead" intent handoff
status: OPEN
priority: Major
category: feature
labels: [controller, cross-network, suite, ed2k-bridge]
milestone: phase-2
created: 2026-06-14
source: suite forward program (note 6); SUITE-AUTOMATION
---

> Workflow status is tracked in GitHub. This local document is retained as an engineering spec/evidence record.

# AMUT-FEAT-001 - Cross-network "download the torrent instead" intent handoff

## Summary

When an eD2K client (emulebb-rust / eMuleBB) surfaces a file→torrent membership
offer ("this file is part of torrent X — get the whole torrent"), aMuTorrent
receives the intent (`user wants infohash X`) and actuates it by adding the
torrent to qBittorrentBB. Design:
[`docs/SUITE-AUTOMATION.md`](../../SUITE-AUTOMATION.md).

## Why This Matters

This is the suite's headline cross-network moment: discover a file on eD2K, pivot
to the full bundle on BitTorrent. It generalizes the principle "clients surface
intents; the controller actuates."

## Intended Shape

- Accept a membership/intent payload from the eD2K client (infohash + provenance).
- Resolve the torrent and add it to the configured qBittorrentBB instance.
- Optional and non-required: when aMuTorrent is absent, the client degrades to a
  direct client call. aMuTorrent never becomes a required hop.

## Acceptance Criteria

- [ ] An intent carrying an infohash adds the torrent to qBittorrentBB.
- [ ] Membership data is read from the suite metadata fabric (live-library torrents
      only); harvested torrents never generate an offer.
- [ ] With aMuTorrent absent, the client path still works direct-to-client.

## Notes

- Depends on the metadata fabric (`emulebb-tooling` SUITE-METADATA-FABRIC) producing
  `file_membership`, and on the eD2K client emitting the intent.
