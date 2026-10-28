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
3. Set `ROOM_STORE=postgres` in `.env`, then restart `npm run server`.

At startup the backend applies `server/schema.sql` and checks the database connection. It exits with an error if PostgreSQL is unavailable; it never silently switches to memory mode. Room records, the shared queue, and playback state persist in PostgreSQL. Guest memberships and tokens are temporary: a backend restart clears them, and guests must join again using the room code. When the last guest leaves normally, that room and its queue are deleted. Database credentials stay on the server and are never sent to the frontend.

## Run the app

Start the backend and frontend in separate terminals from the project root:

```sh
npm run server
npm run dev
```

The API listens on `http://localhost:3001` and Vite prints the frontend URL. Check backend health at `http://localhost:3001/api/health`.

## Configure authorized local audio

Jammy has no bundled recordings. The catalog’s commercial sample tracks therefore show as unavailable for playback. To test the HTML audio player with a file you own or are authorized to use:

1. Create `public/audio/` and place your file there, for example `public/audio/demo-audio.mp3`.
2. Set `VITE_JAMMY_DEMO_AUDIO_URL=/audio/demo-audio.mp3` in the local `.env` file.
3. Restart `npm run dev`, open Jammy, select **Local audio demo**, and press Play.

The file is served by Vite as a normal local static asset. Jammy does not download, proxy, or extract audio from streaming platforms. The source resolver is in `src/playback/audioSources.js`, separate from the HTML audio engine and catalog.

The bottom player keeps one persistent `HTMLAudioElement` for authorized local audio. Outside a listening room, YouTube selections use YouTube's official IFrame Player API in a visible dock above the bottom player. In a room, the same official player sits in the center turntable panel so it does not cover the queue or chat. The provider-independent `PlaybackController` normalizes track metadata, status, position, repeat mode, errors, and provider capabilities, and delegates supported operations to the existing HTML audio and YouTube adapters. Room commands still go through the server-authoritative Socket.IO state; provider events are state updates, not duplicate queue commands.

## Search and play YouTube videos

1. Configure `YOUTUBE_API_KEY` as described above, then start `npm run server` and `npm run dev`.
2. Enter a song or artist in Jammy's search box and choose a returned video. It loads in YouTube's official player with its controls and branding intact.
3. Choose **Add to room** to join or create a listening room. Inside a room, use the top-navigation search to add a video or play it immediately; upcoming tracks can be reordered, selected, or removed in the shared queue.

Playback uses the official player for play, pause, seek, buffering, errors, and autoplay-blocked states. A room shares the selected video ID, commands, position, and queue advancement; each member uses their own embedded player. Browsers can block remote autoplay, videos can be unavailable or prohibit embedding, and playback can drift. Jammy does not apply periodic drift correction and does not promise perfect synchronization.

Jammy briefly caches API search results and retains provider metadata in room state for at most 29 days. The backend removes expired YouTube queue and playback data at startup and hourly while running. Before public launch, review the current [YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies), [branding guidelines](https://developers.google.com/youtube/terms/branding-guidelines), and [YouTube Terms of Service](https://www.youtube.com/t/terms). The app still needs its own accessible privacy policy and terms flow before public launch; the in-app YouTube notice does not replace those documents.

### Optional Spotify search and embed

Spotify search is a metadata feature separate from Jammy playback. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), then put its **Client ID** and **Client Secret** in the backend `.env` as `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`. These values stay on the server. The backend uses Spotify's [Client Credentials flow](https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow) to call the Web API [Search endpoint](https://developer.spotify.com/documentation/web-api/reference/search) for track metadata; the search result can be opened as Spotify's [official embed](https://developer.spotify.com/documentation/embeds/tutorials/creating-an-embed) or linked to the original Spotify track. Jammy never routes Spotify results into the YouTube or local audio engine, shared room queue, or room playback.

In Spotify Development Mode, the app owner needs an active Premium subscription and the app is subject to Spotify's current developer access restrictions, including the developer/app and authorized-user limits. New Development Mode apps are limited to one Client ID per developer and five authorized users according to Spotify's [current migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide). Spotify currently documents a maximum of 10 results per search request. Spotify may also apply quotas or restrict access; Jammy reports missing credentials, access denial, and rate limiting in Search. The official embed is a separate Spotify-controlled player; available playback and account prompts are determined by Spotify and the listener's context. Jammy does not provide Spotify audio through its custom player, and it does not use the [Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk/howtos/web-app-player/) (which requires Premium).

For local setup, add both Spotify values to the same project-root `.env` file as the YouTube key, restart `npm run server`, and enter a query on Search. Selecting **Show embed** opens Spotify's official player for that result. The embed itself does not use Jammy's Spotify API credentials; the current Jammy UI selects an embed from the search results.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Express and Socket.IO port; defaults to `3001`. |
| `CLIENT_ORIGINS` | Comma-separated allowed frontend origins; defaults to local Vite origins. |
| `VITE_API_URL` | API and Socket.IO origin used by the frontend; defaults to `http://localhost:3001`. |
| `VITE_JAMMY_DEMO_AUDIO_URL` | Optional public path for an authorized local demo file; defaults to no configured audio. |
| `YOUTUBE_API_KEY` | Server-only Google API key with YouTube Data API v3 enabled; used for search and video eligibility checks. |
| `SPOTIFY_CLIENT_ID` | Optional server-only Spotify app Client ID for track metadata search. |
| `SPOTIFY_CLIENT_SECRET` | Optional server-only Spotify app Client Secret for the Client Credentials flow. |
| `ROOM_STORE` | `memory` for temporary local rooms, or `postgres` for PostgreSQL persistence. |
| `DATABASE_URL` | PostgreSQL connection string; required only with `ROOM_STORE=postgres`. |
| `RECONNECT_GRACE_MS` | How long a disconnected participant retains their room place; defaults to 30 seconds. |

## Verify

With the backend running in memory mode, run:

```sh
npm run build
npm run test:rooms
npm run test:queue
npm run test:playback
npm run test:spotify
npm run test:youtube
npm run test:config
npm run test:chat
```

The room smoke check exercises the health endpoint, room creation, invalid and full-room rejection, two independent Socket.IO clients, live roster updates, authenticated chat delivery and validation, room isolation, and leaving a room. The queue check covers synchronization, authorization, reordering, rejects unsigned YouTube metadata, playback commands, idempotent queue advancement, and the 50-item limit. Playback tests cover HTML audio state; YouTube service tests cover response mapping, Made for Kids/embed eligibility, query validation, short caching/request coalescing, missing credentials, quota failures, signed selections, and room queue selection. Chat unit tests cover sanitization, validation, room isolation, and bounded history. The socket checks use the in-memory store; run them against PostgreSQL separately when a configured database is available.

## Current limitations

- The in-memory mode is for local development only; use PostgreSQL for persistence.
- Guest identity is temporary and isn’t connected to accounts.
- The repository includes no local recordings. Local audio playback requires an authorized user-provided file; YouTube playback requires a configured API key and an embeddable video.
- Spotify search requires a configured Spotify developer app and may be unavailable under the account's current Development Mode access or quota. Spotify embeds run separately under Spotify's own playback rules and cannot be controlled or synchronized by Jammy.
- Room playback shares provider state, but each browser has its own YouTube player. Autoplay, availability, and playback drift vary by browser and video.
- Text chat is real-time for authenticated room members, but its bounded history is held in process memory and clears when the room closes or backend restarts. Voice chat is not available yet.
- Socket.IO checks use independent clients. PostgreSQL behavior and real browser playback still need verification with configured credentials, a database if selected, and a reachable browser.
