# Jammy

Jammy is a social music listening platform. The React + Vite frontend includes Home, Search, Library, reusable music cards, a persistent player interface, and a responsive listening room with a shared queue and live text chat.

## Requirements

- Node.js 20.19+ or 22.12+
- npm

## Install and configure

```sh
npm install
Copy-Item .env.example .env
```

The example config uses an in-memory room store so the room flow works locally without a database account. Rooms, queue contents, playback state, and guest sessions are temporary in this mode and are cleared when the backend restarts. `.env` is ignored by Git. YouTube search stays disabled until you add your own Google API key.

### Configure YouTube search

1. Open [Google Cloud Console](https://console.cloud.google.com/), create or select a project, and enable **YouTube Data API v3** in APIs & Services.
2. Create an API key under **Credentials**. Apply an API restriction for YouTube Data API v3 and, where your deployment allows it, an appropriate server-side application restriction.
3. Put the key in the backend `.env` file as `YOUTUBE_API_KEY=...`. Do not use a `VITE_` variable, place it in browser code, or commit the real key.
4. Restart `npm run server`. Search requests go through `GET /api/youtube/search`; the backend asks for embeddable videos and checks each result's Made for Kids and embed status before returning it. Identical searches are coalesced and briefly cached in memory; the server does not cache video or audio content.

If the key is missing, the Search page explains that YouTube search is not configured. Quota exhaustion and upstream API errors also return user-facing messages. Search uses your Google Cloud project's current quota.

### Enable PostgreSQL (including Neon)

1. Create a PostgreSQL project in Neon and copy its connection string from the project dashboard.
2. Put the connection string in the local `.env` file as `DATABASE_URL=...`. Keep the `sslmode=require` setting from Neon’s connection string.
3. Run `npm run migrate` deliberately to apply pending versioned schema changes.
4. Set `ROOM_STORE=postgres` in `.env`, then start `npm run server`.

Normal startup checks the database and clears transient guest memberships, but does not apply schema changes. The versioned migration command applies `0001_room_schema` through `0004_personal_music` in order and tracks applied versions in `schema_migrations`. It exits with an error if PostgreSQL is unavailable; the room server never silently switches to memory mode. Room records, the shared queue, and playback state persist in PostgreSQL. Guest memberships and tokens are temporary: a backend restart clears them, and guests must join again using the room code. When the last guest leaves normally, that room and its queue are deleted. Database credentials stay on the server and are never sent to the frontend.

### Account authentication

The frontend uses Neon Auth as its canonical identity for personal music and Spotify endpoints. The older `/api/auth` routes and `auth_users`/`auth_sessions` tables remain available for compatibility, but are a separate legacy identity and do not grant access to Neon-user music or Spotify data. Do not assume legacy account IDs match Neon Auth subjects.

Account-backed personal music and Spotify storage require PostgreSQL even when `ROOM_STORE=memory`; set `DATABASE_URL` to the intended database. The backend loads project-root `.env.local` first and then `.env`, without overriding process environment values; Neon CLI output in `.env.local` is supported. Deliberately run `npm run migrate` only after confirming the target database. Health/startup status reports each migration and schema readiness, but startup never applies migrations. Do not point the migration command at production until you have reviewed the SQL and chosen the intended database.

The API provides `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/session`, and `POST /api/auth/logout`. Passwords must be 12–128 characters. Usernames are trimmed, lowercased, and restricted to 3–24 ASCII letters, numbers, and underscores. Email addresses are trimmed and lowercased. Password recovery is not available.

Successful registration and login set a seven-day, HttpOnly, SameSite=Lax session cookie. The server stores only the SHA-256 hash of its random token. The client keeps the returned CSRF token in memory and sends it in `X-CSRF-Token` for logout; the session endpoint returns a fresh token. Browser state-changing authentication requests must include an allowed `Origin`. Configure `CLIENT_ORIGINS` with comma-separated exact frontend origins (scheme, host, and port, with no path). The same allowlist controls credentialed HTTP and Socket.IO CORS. In production, run behind HTTPS and set `NODE_ENV=production` so cookies are Secure; terminate TLS at a trusted reverse proxy and do not configure arbitrary forwarded host/origin trust.

Registration is limited to five requests per IP per hour and login to ten per IP per fifteen minutes. Limits are held in process memory and are not shared across multiple server instances; use an edge or shared rate limiter for a multi-instance deployment. Existing guest rooms remain available independently of account sessions. Socket.IO validates an optional account cookie server-side, ignores account identifiers supplied in handshake data, and clears account identity after revocation or expiry; room membership and host permissions continue to use the separate guest room token flow.

PostgreSQL integration tests are separate from `npm test`. To run `npm run test:postgres`, first provision a disposable local PostgreSQL database named `jammy_test` or `jammy_test_<suffix>`, then set `JAMMY_TEST_DATABASE_URL` in the process environment. The suite refuses non-local hosts, production mode, target-overriding URL parameters, and other database names; it never falls back to `DATABASE_URL` or loads `.env`. It creates a randomly named schema inside that dedicated database and drops only that schema after the tests. Coverage includes all four migrations and verifies that 0004 personal-music tables can be used without altering existing room state. If interrupted, its test-owned schema may remain; inspect and remove only the `jammy_it_*` schema after verifying its name. Do not use a database containing valuable or deployment data.

## Run the app

Start the backend and frontend in separate terminals from the project root:

```sh
npm run server
npm run dev
```

The API listens on `http://localhost:3001` and Vite prints the frontend URL. Check backend health at `http://localhost:3001/api/health`.

YouTube selections use YouTube's official IFrame Player API in a visible dock above the bottom player. In a room, the same official player sits in the center turntable panel so it does not cover the queue or chat. The provider-independent `PlaybackController` normalizes track metadata, status, position, repeat mode, errors, and provider capabilities. Room commands still go through the server-authoritative Socket.IO state; provider events are state updates, not duplicate queue commands.

## Search and play YouTube videos

1. Configure `YOUTUBE_API_KEY` as described above, then start `npm run server` and `npm run dev`.
2. Enter a song or artist in Jammy's search box and choose a returned video. It loads in YouTube's official player with its controls and branding intact.
3. Choose **Add to room** to join or create a listening room. Inside a room, use the top-navigation search to add a video or play it immediately; upcoming tracks can be reordered, selected, or removed in the shared queue.

Playback uses the official player for play, pause, seek, buffering, errors, and autoplay-blocked states. A room shares the selected video ID, commands, position, and queue advancement; each member uses their own embedded player. Browsers can block remote autoplay, videos can be unavailable or prohibit embedding, and playback can drift. Jammy does not apply periodic drift correction and does not promise perfect synchronization.

Every authenticated room member can add, remove, and reorder upcoming tracks. Only the current host can select tracks or change shared playback and repeat settings; the server checks the member's current role for every mutation. A host who leaves voluntarily transfers ownership immediately. A disconnected host keeps ownership during the reconnect grace period; after the grace expires, the earliest-joined online member is promoted. If everyone remaining is offline, the earliest-joined member is promoted, with member ID breaking equal join-time ties. Empty rooms are deleted. Playback controls and queue ordering are serialized with the room state in PostgreSQL, and duplicate or stale track-advance events are ignored.

Jammy briefly caches API search results and retains provider metadata in room state for at most 29 days. The backend removes expired YouTube queue and playback data at startup and hourly while running. Before public launch, review the current [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies), [branding guidelines](https://developers.google.com/youtube/terms/branding-guidelines), and [YouTube Terms of Service](https://www.youtube.com/t/terms). The app still needs its own accessible privacy policy and terms flow before public launch; the in-app YouTube notice does not replace those documents.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Express and Socket.IO port; defaults to `3001`. |
| `CLIENT_ORIGINS` | Comma-separated allowed frontend origins; defaults to local Vite origins. |
| `VITE_API_URL` | API and Socket.IO origin used by the frontend; defaults to `http://localhost:3001`. |
| `NEON_AUTH_BASE_URL` | Full Managed Auth base URL copied from the intended Neon branch. Keep the database/auth path (typically `/neondb/auth`); SDK session requests append `/get-session`. Vite exposes only this public endpoint as `VITE_NEON_AUTH_URL`. |
| `YOUTUBE_API_KEY` | Server-only Google API key with YouTube Data API v3 enabled; used for search and video eligibility checks. |
| `ROOM_STORE` | `memory` for temporary local rooms, or `postgres` for PostgreSQL persistence. |
| `DATABASE_URL` | PostgreSQL connection string; enables account authentication and is required for `ROOM_STORE=postgres`. |
| `NEON_AUTH_JWKS_URL` | Server-only HTTPS JWKS URL for validating short-lived Neon Auth bearer JWTs on personal music APIs and taste-aware room recommendations. |
| `NEON_AUTH_ISSUER` | Optional explicit JWT issuer override. By default Jammy uses the origin of `NEON_AUTH_BASE_URL` (without its `/neondb/auth` path), matching Neon Managed Auth's JWT issuer. |
| `NEON_AUTH_AUDIENCE` | Optional JWT audience check. Configure only when the Neon Auth token is issued with that documented audience. |
| `SPOTIFY_CLIENT_ID` | Spotify Developer app client ID from the app's Settings page. Server configuration only. |
| `SPOTIFY_CLIENT_SECRET` | Spotify Developer app client secret. Server-only; never use a `VITE_` prefix. |
| `SPOTIFY_REDIRECT_URI` | Exact OAuth callback URL, such as `http://127.0.0.1:3001/api/spotify/callback` in local development. Register the identical URL in the Spotify Developer Dashboard. |
| `SPOTIFY_TOKEN_ENCRYPTION_KEY` | Base64 encoding of 32 random bytes for AES-256-GCM token encryption. Generate a deployment-specific key with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"`; store it as a server secret and do not commit it. |
| `NODE_ENV` | Set to `production` in HTTPS deployments to enable Secure authentication cookies. |
| `RECONNECT_GRACE_MS` | How long a disconnected participant retains their room place; defaults to 30 seconds. |

## Personal music data and Spotify

Jammy listening history, Spotify imports, Jammy-derived taste profiles, and YouTube playback metadata are separate user-scoped data. Spotify is optional and read-only: Jammy requests `user-top-read`, `user-read-recently-played`, `user-library-read`, and `playlist-read-private` only after the user chooses Connect Spotify. Spotify data is displayed as Spotify-provided metadata and is not analyzed into Jammy's taste profile; the profile and personalized YouTube search/room Autoplay use Jammy listening history only. Spotify access and refresh tokens are encrypted server-side; no Spotify token or Spotify audio is sent to the browser or used for playback. Disconnect deletes Jammy's stored Spotify integration data. Users can also remove Jammy from their Spotify account's app access settings. Spotify's current Developer Policy prohibits analyzing Spotify content into derived listening profiles, so this boundary is deliberate.

Apply migrations `0001_room_schema` through `0004_personal_music` to the intended database before using the database-backed features. `/api/health` reports each migration and verifies the room, Autoplay, authentication, and personal-music tables without applying changes. Set `NEON_AUTH_JWKS_URL` to the HTTPS JWKS endpoint for the matching Neon Auth branch; the verifier checks EdDSA signatures and uses the origin of `NEON_AUTH_BASE_URL` (without `/neondb/auth`) as the expected issuer unless `NEON_AUTH_ISSUER` is explicitly set. Neon Auth tokens do not require an audience by default, so set `NEON_AUTH_AUDIENCE` only if that branch's JWT configuration documents one. The API binds music rows to the verified JWT subject; endpoints do not accept client-provided user IDs. To enable Spotify, create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), copy its Client ID and Client Secret into the server-only variables, add the exact `SPOTIFY_REDIRECT_URI` under the app's Redirect URIs, then set a generated `SPOTIFY_TOKEN_ENCRYPTION_KEY`. Local Spotify OAuth requires the callback URI to be `http://127.0.0.1/...`; production must use the exact HTTPS callback URL configured in the Dashboard. No secret belongs in a `VITE_` variable. Spotify imports use pages of at most 50 and are capped at 150 items per category. Connect starts are limited to 10 per user/hour and imports to 6 per user/hour per backend instance. Spotify 429 responses include a `Retry-After` wait; Jammy does not automatically retry. Disconnect removes outstanding OAuth state, encrypted tokens, and imported items. Users can also remove Jammy authorization from Spotify settings. Current Spotify OAuth refresh tokens expire six months after authorization, so reauthorization is required when refresh returns `invalid_grant`.

Spotify Development Mode currently requires the app owner to have Premium and limits a new app to five authorized users. Endpoint availability can differ for older or extended-quota apps; Jammy handles unavailable import categories as partial syncs. Jammy does not use Spotify's removed Recommendations endpoint. See Spotify's current [Development Mode migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).

## Verify

With the backend running in memory mode, run:

```sh
npm run build
npm run test:rooms
npm run test:queue
npm run test:playback
npm run test:youtube
npm run test:config
npm run test:chat
npm run test:postgres # only after configuring a dedicated local JAMMY_TEST_DATABASE_URL
```

The room smoke check exercises the health endpoint, room creation, invalid and full-room rejection, two independent Socket.IO clients, live roster updates, authenticated chat delivery and validation, room isolation, and leaving a room. The queue check covers synchronization, authorization, reordering, rejects unsigned YouTube metadata, playback commands, idempotent queue advancement, and the 50-item limit. Playback tests cover HTML audio state; YouTube service tests cover response mapping, Made for Kids/embed eligibility, query validation, short caching/request coalescing, missing credentials, quota failures, signed selections, and room queue selection. Chat unit tests cover sanitization, validation, room isolation, and bounded history. The socket checks use the in-memory store; run them against PostgreSQL separately when a configured database is available.

## Current limitations

- The in-memory mode is for local development only; use PostgreSQL for persistence.
- Guest identity is temporary and isn’t connected to accounts. Account authentication also requires PostgreSQL and the explicit migration command above.
- The repository includes no local recordings. Local audio playback requires an authorized user-provided file; YouTube playback requires a configured API key and an embeddable video.
- Room playback shares provider state, but each browser has its own YouTube player. Autoplay, availability, and playback drift vary by browser and video.
- Text chat is real-time for current room members, but its bounded history is held in process memory and clears when the room closes or backend restarts. Voice chat uses browser WebRTC audio with Socket.IO signaling and supports up to six connected participants per room. Microphone access starts only after a member joins voice chat; voice audio is not recorded or stored.

### Voice chat network setup

The server sends configured ICE servers only to authenticated room sockets when a member joins voice chat. By default Jammy uses `stun:stun.l.google.com:19302`, which can discover direct peer routes but cannot guarantee connectivity through restrictive NATs or firewalls. Production deployments should configure a TURN relay when required by their network tests.

- `VOICE_STUN_URLS`: optional comma-separated `stun:` or `stuns:` URLs. Defaults to Google's public STUN endpoint; set an empty value to disable STUN.
- `VOICE_TURN_URLS`: optional comma-separated `turn:` or `turns:` URLs supplied by your deployment.
- `VOICE_TURN_USERNAME` and `VOICE_TURN_CREDENTIAL`: required together when TURN URLs are configured. Use credentials from your TURN provider; Jammy does not create or provide them.

TURN credentials are sent to authenticated room members as part of their WebRTC configuration. For production, use provider-issued short-lived credentials where available and serve Jammy over HTTPS so browsers can grant microphone access.
- Socket.IO checks use independent clients. PostgreSQL behavior and real browser playback still need verification with configured credentials, a database if selected, and a reachable browser.
