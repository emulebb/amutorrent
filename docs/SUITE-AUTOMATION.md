# aMuTorrent — Suite automation & cross-network orchestration (notes 6, 16, 17)

Status: design / direction. Captured 2026-06-14. Post-0.7.3; full development
mode. Suite context: `emulebb-tooling/docs/active/SUITE-JOINT-ROADMAP.md`.

aMuTorrent is the BB suite's **cross-network controller**: a web UI that already
manages ED2K *and* BitTorrent from one interface (aMule via EC, qBittorrent via
WebUI API, rTorrent, Deluge, Transmission), with Prowlarr integration, a Torznab
indexer + qBittorrent-compatible API for the eD2K side, push notifications, and
GeoIP. It already brokers both worlds (`server/modules/emulebbManager.js` speaks
eMuleBB `/api/v1`; it also drives qBittorrent). That existing dual-network vantage
is exactly what suite-level automation needs — no single client sees both
networks plus the metadata fabric.

## Core principle: optional layer, never a required hop

Clients (`emulebb-rust`, qBittorrentBB) and Prowlarr must function **fully
standalone**. aMuTorrent is an **additive automation/UI brain** layered on top.
Grabs route directly to the download client by default (standard Arr flow);
aMuTorrent is the operator's choice for centralized orchestration, not a
dependency. Anything below degrades gracefully to direct-to-client when the
controller is absent.

## Note 6 — "Download the torrent instead" intent handoff

The eMuleBB/rust clients surface a file→torrent membership offer ("this file is
part of torrent X — get the whole torrent"). The client emits an **intent**
(`user wants infohash X`); the controller **actuates** by adding the torrent to
qBittorrentBB.

- **Clients surface intents; the controller actuates.** This generalizes to all
  suite automation.
- Membership data is produced by the Python metadata fabric and read by the
  clients (live-library torrents only — real, reachable, branded). See
  `emulebb-tooling/docs/active/SUITE-METADATA-FABRIC.md`.
- When the controller is absent, the handoff degrades to a direct client call.

## Notes 16–17 — Automatic download rules at the controller level

Automatic download rules and logic should sit at the controller level **even
though qBittorrentBB already includes native rules** — because rules that span
*both networks* and implement suite-level logic cannot live inside a single
client. Only the controller sees both indexes, both download clients, and the
metadata fabric.

- **Justified controller scope = what the generic Arr stack cannot express:**
  cross-network grab decisions (eD2K collection vs BT torrent for the same
  content), dedup via v2 file-roots across networks, acting on reconcile/orphan
  reports (notes 2/4 are report-only — the controller is their natural actuator),
  library export/publish orchestration (notes 1/11), cooperative policy.
- **Do not reinvent the Arr stack.** Generic download rules stay where they already
  work (qBittorrentBB's native rules, Sonarr/Radarr/Prowlarr). aMuTorrent owns the
  suite-specific, eD2K-aware, metadata-fabric-aware bits the generic stack cannot
  represent.
- **Scope split (parked):** whether aMuTorrent eventually owns *all* download
  automation or only the cross-network delta is TBD. Revisit when the rust↔
  aMuTorrent integration is designed concretely.

## Driving emulebb-rust as a client

`emulebb-rust` exposes its own eMuleBB-compliant `/api/v1` REST + a Torznab
endpoint + a **qBittorrent-WebUI-emulating download-client API**. aMuTorrent
drives rust the same way it already drives aMule and qBittorrent — register it as
a download client; it presents as "a qBittorrent" to any Arr-style consumer. This
mirrors the eMuleBB `/api/v2` compatibility pattern aMuTorrent already consumes.

## Actuation surface (controller → suite)

- **Reconcile/orphan reports → actions.** Read the Python fabric's reports;
  optionally promote `orphan→harvest-matched` data to the live library and start
  seeding; flag mixed-content directories.
- **Cross-network grabs.** Given an intent or a rule match, choose network +
  client and dispatch.
- **Export/publish orchestration.** Trigger the qBittorrentBB branded export and
  (note 11) the BEP-46 library publish.

## Policy

- GPL fork under the emulebb org. The historical `…-emulebb-v0.7.x` tag pairing
  tracks the MFC release line; since `0.7.3` may be the last MFC release and the
  forward core is **emulebb-rust**, the post-0.7.3 pairing target is open — pair
  to the rust core's `/api/v1` version range rather than the frozen MFC tag.
  (Decide at promotion.)
- Operator VPN credentials and live search terms stay in ignored local files or
  runtime env — never in tracked docs or templates.
- No private data, no real media titles — synthetic placeholders only.
