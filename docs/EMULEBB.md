# eMuleBB Integration

aMuTorrent can connect to eMuleBB through the native eMuleBB REST API. This is
separate from aMule support: aMule uses the EC protocol, while eMuleBB uses HTTP
REST with an API key.

Use this integration when eMuleBB is your ED2K/Kad client and you want the
aMuTorrent web UI, category handling, search, shared-file views, logs, and Arr
adapter workflows to operate against eMuleBB.

## Requirements

- eMuleBB running with WebServer/REST enabled
- eMuleBB REST API key configured
- aMuTorrent able to reach the eMuleBB WebServer host and port
- Firewall and bind settings that intentionally allow that connection

The default eMuleBB REST port is `4711`. If eMuleBB is behind a reverse proxy,
configure the proxy base path in aMuTorrent's **Path** field.

For complete eMuleBB stack setup, adapter boundaries, and Arr behavior, use
the maintained eMuleBB docs:

- <https://emulebb.github.io/emulebb-tooling/reference/GUIDE-STACK-INTEGRATIONS/>
- <https://emulebb.github.io/emulebb-tooling/rest/REST-API-ADAPTERS/>

Those contracts matter because eMuleBB's qBittorrent and Torznab surfaces are
Arr compatibility subsets. They are not full qBittorrent, torrent RSS, tracker,
peer-management, or generic Newznab provider implementations.

## Setup Wizard

1. Open aMuTorrent.
2. Go to the setup wizard or **Settings**.
3. In **Download Clients**, enable **eMuleBB**.
4. Enter the eMuleBB REST host, port, API key, optional path, and SSL mode.
5. Use **Test ED2K Clients** before saving.

The eMuleBB fields are:

| Field | Description |
|-------|-------------|
| Host | Hostname or IP address where eMuleBB WebServer/REST listens |
| Port | eMuleBB WebServer/REST port, usually `4711` |
| API Key | eMuleBB native REST API key |
| Path | Optional reverse-proxy base path, such as `/emulebb` |
| Use SSL | Use HTTPS when eMuleBB serves REST through TLS |

## Environment Variables

Environment variables can pre-populate or lock the first eMuleBB instance.

```env
EMULEBB_ENABLED=true
EMULEBB_HOST=host.docker.internal
EMULEBB_PORT=4711
EMULEBB_API_KEY=your_emulebb_rest_api_key
EMULEBB_USE_SSL=false
EMULEBB_PATH=
```

Optional identity fields:

```env
EMULEBB_ID=emulebb-main
EMULEBB_NAME=eMuleBB
```

`EMULEBB_API_KEY` is sensitive. When it is set through the environment,
aMuTorrent uses it as the effective value and does not expose it for editing in
the UI.

## Docker Host Access

If aMuTorrent runs in Docker and eMuleBB runs on the host, add
`host.docker.internal` support:

```yaml
services:
  amutorrent:
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      - EMULEBB_ENABLED=true
      - EMULEBB_HOST=host.docker.internal
      - EMULEBB_PORT=4711
      - EMULEBB_API_KEY=your_emulebb_rest_api_key
```

If eMuleBB runs on another machine, use that machine's LAN address and make the
eMuleBB bind, allowed-IP, firewall, and router policy explicit.

## Supported Operations

The eMuleBB manager adapts eMuleBB REST data into the same ED2K surface used by
aMuTorrent:

- download list, shared files, logs, and server information
- ED2K search and add-link workflows
- pause, resume, stop, rename, delete, and category assignment where supported
- shared-file metadata such as rating and comment
- category reads and assignments through eMuleBB REST

eMuleBB remains the source of truth for ED2K/Kad behavior. aMuTorrent controls
it through REST; it does not use the aMule EC protocol and does not edit eMuleBB
profile files directly.

## Troubleshooting

Connection test fails:

1. Confirm eMuleBB is running and WebServer/REST is enabled.
2. Confirm host, port, SSL mode, and optional path match the eMuleBB listener.
3. Confirm the API key is the native eMuleBB REST key.
4. Check eMuleBB bind address, allowed IPs, firewall, and reverse proxy rules.
5. From the aMuTorrent host or container, test the eMuleBB REST URL with curl.

Wrong protocol errors usually mean aMuTorrent is pointed at an aMule EC port or
at an HTTP reverse proxy path that does not forward to eMuleBB REST.

Authentication errors mean the REST API key is missing, wrong, or being
overridden by `EMULEBB_API_KEY`.

Open eMuleBB-specific aMuTorrent integration issues in the eMuleBB fork:
<https://github.com/emulebb/amutorrent/issues>. Use the upstream issue tracker
for upstream package/image questions that are unrelated to eMuleBB behavior.
