# Installation

aMuTorrent can be installed using Docker (recommended) or natively.

**Prerequisites:** At least one of: aMule with External Connections enabled, eMuleBB with REST enabled, rTorrent with XML-RPC/SCGI enabled, qBittorrent with WebUI enabled, Deluge with WebUI enabled, or Transmission with RPC enabled.

## Docker Installation (Recommended)

Available on [Docker Hub](https://hub.docker.com/r/g0t3nks/amutorrent). Supports `linux/amd64` and `linux/arm64`.

The Docker image above is the upstream aMuTorrent distribution. This repository
is the eMuleBB organization fork; use fork-owned package or image names only
when they are published by an eMuleBB release. Otherwise, install the upstream
image intentionally and report eMuleBB-specific integration problems to the
eMuleBB fork.

### 1. Pull the image

```bash
docker pull g0t3nks/amutorrent:latest
```

### 2. Create directories

```bash
mkdir -p data logs
sudo chown -R 1000:1000 data logs
```

### 3. Create `docker-compose.yml`

```yaml
services:
  amutorrent:
    image: g0t3nks/amutorrent:latest
    user: "1000:1000"
    container_name: amutorrent
    ports:
      - "4000:4000"
    environment:
      - NODE_ENV=production
      - PORT=4000
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./logs:/usr/src/app/server/logs
      - ./data:/usr/src/app/server/data
    restart: unless-stopped
```

### 4. Start and configure

```bash
docker compose up -d
```

Open `http://localhost:4000` and follow the setup wizard to configure your download clients.

> **All-in-One Setup:** For a complete setup with aMule, rTorrent, and qBittorrent in Docker, see [docker-compose.all-in-one.yml](https://github.com/got3nks/amutorrent/blob/main/docker-compose.all-in-one.yml).

## Native Installation

### Prerequisites

- Node.js 24 or later
- npm

### Windows package runner

The eMuleBB release package owns the native Windows suite installer and start
scripts. aMuTorrent no longer ships its own `installer/windows/amutorrent.ps1`;
it remains a portable controller runtime that is launched with
`AMUTORRENT_DATA_DIR` pointing at package-local state.

For standalone development from a checkout, set `AMUTORRENT_DATA_DIR` yourself
before launching the server:

```powershell
$env:AMUTORRENT_DATA_DIR = "$PWD\data"
$env:PORT = "4000"
node .\server\server.js
```

### Steps

1. Clone the repository:

```bash
git clone https://github.com/emulebb/amutorrent.git
cd amutorrent
```

2. Install dependencies and build:

```bash
cd server && npm install && cd ..
npm install && npm run build
```

3. Start the server:

```bash
node server/server.js
```

4. Open `http://localhost:4000` and complete the setup wizard

## First Run Setup

On first launch, aMuTorrent will display a setup wizard to configure:

- **Download clients** - Enable at least one: aMule, rTorrent, qBittorrent, Deluge, Transmission, or any combination
- **Web authentication** (optional) - Protect the web interface with a password, optionally with multi-user accounts

## Next Steps

After completing the setup wizard, explore additional features:

> **Configuration:** Settings, environment variables, and Docker networking. See [Configuration](./CONFIGURATION.md).
>
> **Download Clients:** Detailed setup for [aMule](./AMULE.md), [rTorrent](./RTORRENT.md), [qBittorrent](./QBITTORRENT.md), [Deluge](./DELUGE.md), and [Transmission](./TRANSMISSION.md).
>
> **Prowlarr:** Search torrents directly from the web UI. See [Prowlarr Setup](./PROWLARR.md).
>
> ***arr Apps:** Use aMuTorrent as an indexer and download client for Sonarr, Radarr, and other *arr apps. See [*arr Integration](./INTEGRATIONS.md).
>
> **Notifications:** Get notified when downloads complete. See [Notifications](./NOTIFICATIONS.md).
>
> **Scripting:** Run custom scripts on download events. See [Scripting](../scripts/README.md).
>
> **GeoIP:** Display peer locations on a map. See [GeoIP Setup](./GEOIP.md).
>
> **User Management:** Multi-user authentication, capabilities, and SSO. See [User Management](./USERS.md).
