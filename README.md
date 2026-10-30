# MusicSeerr

A music request manager for Lidarr, built on [Seerr](https://github.com/seerr-team/seerr) (the Overseerr/Jellyseerr codebase). Users search MusicBrainz, request albums, and MusicSeerr sends them to Lidarr and tells the requester when the album is in the library.

## Features

- Search artists and albums from MusicBrainz, with artist pages, discographies and track lists
- Album requests go to Lidarr with only that album monitored, so one request doesn't subscribe you to the artist's whole future catalog
- Seerr's users, permissions, approvals and notifications (Discord, email, ntfy, webhooks and more)
- Requests are marked available once Lidarr has imported the album (checked every 10 minutes)
- Sign in with Jellyfin, Emby, Plex or Navidrome accounts, or through a forward-auth proxy such as Authentik
- Keeps working when musicbrainz.org is unreachable (outages, or MetaBrainz blocking your IP) by falling back to Lidarr's metadata service, which serves the same IDs
- Artist photos and backdrops from Lidarr's metadata, with no fanart.tv key needed

## Run with Docker

Every push to `main` publishes `ghcr.io/<owner>/musicseerr` through GitHub Actions (`.github/workflows/docker-publish.yml`).

```yaml
services:
  musicseerr:
    image: ghcr.io/OWNER/musicseerr:latest
    container_name: musicseerr
    restart: unless-stopped
    ports:
      - '5757:5757'
    environment:
      PORT: '5757'
      TZ: America/New_York
    volumes:
      - ./config/musicseerr:/app/config
```

Then open `http://<host>:5757` and follow setup:

1. Choose your media server and sign in as its admin. It's used for accounts only; music availability comes from Lidarr, so there are no libraries to pick.
2. Add Lidarr: host, port, API key, then pick the root folder, quality profile and metadata profile. Leave **Enable Scan** on.

### Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default `5055`) |
| `TZ` | Time zone |
| `LASTFM_API_KEY` | Optional. Popular artists/albums/tracks on Discover |
| `FANART_API_KEY` | Optional. Artist images |
| `AUTH_PROXY_HEADER` | Optional. Enables forward-auth sign-in (see below) |
| `AUTH_PROXY_EMAIL_HEADER` | Optional. Header carrying the user's email |
| `AUTH_PROXY_AUTO_CREATE` | Optional. `true` creates unknown proxy users with default permissions |
| `MUSIC_UPLOAD_DIR` | Optional. Enables album uploads (see below). Inbox folder inside this container |
| `LIDARR_UPLOAD_DIR` | Optional. The same inbox as Lidarr sees it, if mounted at a different path |

## Uploading your own albums

Admins get an **Upload Music** page for CD rips and purchased downloads. Drag in an album folder; MusicSeerr reads the tags, checks for common problems (mixed albums, missing tags, duplicate track numbers), finds the album, and after you confirm, has Lidarr import it into the library. The page includes ripping instructions for less technical users.

Uploads need a folder that both containers can see. Mount the same host folder into both and point MusicSeerr at it:

```yaml
  musicseerr:
    environment:
      MUSIC_UPLOAD_DIR: /music-inbox
    volumes:
      - /path/to/music-inbox:/music-inbox

  lidarr:
    volumes:
      - /path/to/music-inbox:/music-inbox
```

If Lidarr mounts it somewhere else, set `LIDARR_UPLOAD_DIR` to Lidarr's path. Lidarr only imports files it can match to the chosen album; anything it rejects stays in the inbox and the page shows why.

## Signing in with Authentik

There are two ways, and they work together.

**Jellyfin accounts backed by Authentik (LDAP).** If Jellyfin authenticates against Authentik through the LDAP plugin, choose Jellyfin in setup. Users sign in with their Authentik username and password.

**Forward-auth single sign-on.** Put MusicSeerr behind your reverse proxy with an Authentik proxy provider in forward-auth mode, then set:

```yaml
    environment:
      AUTH_PROXY_HEADER: X-authentik-username
      AUTH_PROXY_EMAIL_HEADER: X-authentik-email
      # AUTH_PROXY_AUTO_CREATE: 'true'
```

Users who are signed in to Authentik land in MusicSeerr without a second login. They're matched to existing accounts (for example imported Jellyfin users) by username or email. Unknown users are refused unless `AUTH_PROXY_AUTO_CREATE` is `true`.

> Only enable forward-auth when MusicSeerr can be reached **solely** through the proxy. If the container's port is reachable directly, anyone can send the header themselves. Don't publish the port on the host, or firewall it to the proxy.

Signing out of MusicSeerr ends its session, but the next visit signs the user straight back in from Authentik. Sign out of Authentik to fully sign out.

## Development

```bash
pnpm install
pnpm dev        # http://localhost:5055
pnpm typecheck
pnpm lint
pnpm build      # what the Docker image runs
```

## License

MIT. Derived from Seerr/Overseerr.
