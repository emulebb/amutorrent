# Rules

- Read `EMULEBB_WORKSPACE_ROOT\repos\emulebb-tooling\docs\WORKSPACE-POLICY.md`
  first; it is authoritative for workspace-wide rules.
- Start from
  `EMULEBB_WORKSPACE_ROOT\repos\emulebb-tooling\docs\reference\AGENT-CHECKLIST.md`
  for the repeatable operating path.

Everything below is this repo's local guidance for the eMuleBB-maintained
aMuTorrent fork.

## Status: FROZEN / deprecated

This fork is **frozen** as the controller bundled with the eMuleBB `0.7.3`
release: sustainability mode only (bug/security/packaging fixes). **Do not add
new features.** The forward eMuleBB Suite controller is **TrackMuleBB**
(`emulebb/trackmulebb`), which drives any `/api/v1` core by advertised
capability and supersedes aMuTorrent. The `AMUT-FEAT-*` backlog is retained as
design reference for TrackMuleBB. Authoritative:
`emulebb-tooling/docs/active/PRODUCT-PORTFOLIO.md` and
`API-V1-COMPATIBILITY.md`.

## eMuleBB Integration Guidance

- Treat eMuleBB as its own client infrastructure, not as an aMule variant.
  aMule uses EC over a binary TCP socket; eMuleBB uses native REST. Both may
  report `networkType: 'ed2k'` for shared ED2K UI behavior.
- Keep the integration shape split across explicit extension points:
  `server/modules/emulebbManager.js`, `server/lib/emulebb/`, `server/lib/clientMeta.js`,
  registry wiring, setup/settings UI, and focused tests. If an eMuleBB REST
  transport class is needed, put it under `server/lib/emulebb/` instead of
  embedding more transport code in shared services.
- Prefer additive PR shape for upstreamability. If shared services need behavior
  changes, split those abstraction changes from the eMuleBB integration itself.
- Completion detection must come from a native verified-and-written completion
  signal. Do not infer `isComplete` from display progress or byte equality such
  as `completedBytes >= sizeBytes`. For current eMuleBB REST payloads, map
  active transfer completion from `state === 'completed'`.
- Keep eMuleBB REST state vocabulary aligned with the final native contract. Do
  not add compatibility aliases for retired spellings unless explicitly asked.
- Keep `sharedMeansComplete: true` for eMuleBB while shared-file presence remains
  the authoritative completed-file signal. Keep `removeSharedMustDeleteFiles:
  false` while native REST can unshare without deleting the file.
- Preserve per-instance behavior. Use compound `instanceId:hash` identity and do
  not assume a singleton per network type.
- Keep eMuleBB's native Torznab and qBittorrent-compatible adapters separate
  from aMuTorrent's aMule-oriented adapters. Do not route Arr integration through
  aMuTorrent when users can point Arr directly at eMuleBB's native endpoints.
- Local tests and preview servers on this operator machine must use `X_LOCAL_IP`
  rather than loopback. Do not bind new local test servers to `127.0.0.1` here.

## Validation

- For Node-side fork changes, run `npm run test:emulebb`.
- When tests open local listeners, set or preserve `X_LOCAL_IP` and avoid
  loopback-only assumptions.
