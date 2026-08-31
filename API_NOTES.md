# Jamcorder API Notes

> The authoritative Jamcorder references are the device API docs at
> <https://www.jamcorder.com/docs/device-api> and the JMX MIDI file format spec
> at <https://www.jamcorder.com/docs/jmx-midi-files>. These notes capture
> behaviors we have learned in the wild that the official docs do not cover (or
> cover only in passing). If anything here contradicts the official docs, trust
> the official docs.

## Connection

- A Jamcorder advertises `jamcorder.local` over mDNS. This project reads the
  device URL from `JAMCORDER_URL` (default `http://jamcorder.local`).
- For a browser extension hosted locally (e.g. on `127.0.0.1:8000`), the
  device's own extension page recommends a helper that picks the device host:

  ```js
  function jamcorderIp() {
    if (self.location.host == "127.0.0.1:8000") {
      return "http://jamcorder.local";
    }
    return "http://" + window.location.hostname;
  }
  ```

## Compression quirk

- JSON responses larger than roughly 1 KB come back with
  `Content-Encoding: deflate`. Standards-compliant clients decode this
  automatically (`curl --compressed`); but some endpoints drop the header (see
  the download quirk below), so robust clients try to inflate the body first
  and fall back to plain JSON/raw bytes. This project does that via
  `pako.inflate` in a try/catch in `server/services/jamcorder.service.ts`.

## File listing and download conventions

- `POST /api/files/list/overview` with `{"filepath": "/"}` lists the root. The
  response is `{ dir, files }`, where `dir` is the listed directory and `files`
  is an array of names; subdirectory entries end with `/`.
- `POST /api/files/list/detailed` with `{"filepath": "/"}` is the same but each
  entry carries `filename`, `isDirectory`, `sizeBytes`, and `modifiedLocalTime`.
  Prefer it for anything that needs sizes. `modifiedLocalTime` is a firmware
  counter, not a Unix timestamp; do not use it for wall-clock comparisons.
- Paths returned by the file endpoints are device-absolute, but the download
  endpoints want them prefixed with `/sdcard/` — e.g. list returns
  `/JAMC/2025/<uuid>/Jmx-A<assetIdx>-<Mon>-<DD>-<YYYY>.mid`, download wants
  `/sdcard/JAMC/2025/<uuid>/Jmx-A<assetIdx>-<Mon>-<DD>-<YYYY>.mid`. This prefix is not
  part of the on-device layout; it is a quirk of the download endpoints.
  **On current firmware (verified live) the `/sdcard/` prefix is NOT required** —
  pass the API-returned path as-is. The official docs agree: "Use paths returned
  by the API rather than assuming an SD-card mount name."
- The recording path and filename convention itself is specified in the JMX
  format docs (`/JAMC/<year>/<jamcorderUuid>/Jmx-A<assetIdx>-<Mon>-<DD>-<YYYY>.mid`).
  Our sync layer uses the `jmxAsset.time` meta event as the authoritative
  recording date, falling back to the trailing `-<Mon>-<DD>-<YYYY>` filename
  portion; see `server/utils/jmxParser.ts`.

## Library API (fallback; filesystem walk is primary)

- `POST /api/library/list/assets` is the authoritative catalog of recorded JMX
  assets. It is flat (no tree traversal) and supports pagination.
- **On this device the library list is crash-prone**: sustained pagination (even
  10-asset pages) repeatedly crashed the firmware (HTTP 000 / reboot loop). Our
  sync therefore uses a recursive `list/detailed` walk as the primary discovery
  source (a handful of cheap directory reads that still return real sizes) and
  keeps the library API as a fallback and for `?full=1` passes.
- Request shape: `{ "getJmxEof": bool, "getFilesize": bool, "getAllDevices": bool,
  "preferredCount": int, "midiPathContinue"?: string }`. **`getAllDevices` is
  required** — omitting it is a hard 400 ("Missing key: getAllDevices").
- Response is a bare JSON array of `{ midiPath, dsel, assetIdx, isCurrentAsset,
  filesize, jmxEof? }`, newest asset first. To fetch the next page, send
  `midiPathContinue` = the last `midiPath` of the previous page. Stop when a
  page returns fewer than `preferredCount` entries (or zero).
- `getJmxEof` is expensive on low-power firmware (parses EOF summaries for every
  asset) and can crash the device at large page sizes. Our sync leaves it off —
  duration is parsed locally from each downloaded file anyway.
- **This firmware is resource-constrained (Pi-class)**: `preferredCount` of 100+
  crashed the device (HTTP 000). Our client uses `preferredCount` 10 with a
  250 ms inter-page delay and retries each page up to 3 times
  (`JAMCORDER_LIBRARY_PAGE_SIZE`, `JAMCORDER_LIBRARY_PAGE_DELAY_MS`).
- `GET /api/library/list/years` returns the years present.
- `GET /api/library/download/newest/midi` returns the newest recording as MIDI.

## Sync model: high-water mark and change detection

- Discovery is library-first. After a sync completes with **zero errors**, a
  high-water mark is recorded (`high_water_asset_idx` + the owning device's
  `jamcorderUuid` in `sync_metadata`). Later syncs pass it to the library list,
  which stops as soon as it reaches an already-synced asset — a steady-state
  sync is a single page instead of the whole library. The mark is ignored if
  the newest asset belongs to a different device (new SD card / reprovisioned
  device), and `POST /api/sync/start?full=1` forces a full pass.
- Change detection uses `filesize` from the library API. A device file that is
  **larger** than the synced copy (recording resumed / reopened asset) is
  re-synced; one that is **smaller** is skipped with a warning — on the
  observed device old files sometimes exist as truncated, header-only stubs,
  and overwriting good local data with them would lose data.
- Active recordings occasionally download as an empty body (file is mid-write);
  our sync treats that as an error for the file and retries it next sync.
- **A brand-new asset can read as 0 bytes while it is still the current (open)
  asset.** A freshly-opened recording has been observed reporting `filesize: 0`
  through both the `list/detailed` walk and the library API (whose MIDI reader
  fails with "filesize is zero") while `isCurrentAsset: true` — the recording
  data had not been flushed to the SD card yet. Sync skips such files as empty
  but emits a "0 bytes on the device (may be a live recording not yet flushed)"
  warning and **does not advance the high-water mark**, so the file is re-checked
  every pass and is picked up the moment it grows. A 0-byte file is distinct
  from a permanent empty stub (which is ~256 bytes); there is no download path
  for a 0-byte asset, so a recording stuck there is unrecoverable until the
  device flushes it.

## Download quirk (firmware bug)

- The file download endpoints (`download/simple`, `download/offset`) can respond
  with both `Content-Length` and `Transfer-Encoding: chunked` (an HTTP/1.1
  violation). Strict HTTP clients (e.g. `got`) reject the response even with
  `strictContentLength: false`; this project works around it by shelling out to
  `curl -s`. The downloaded body may also be deflate-compressed, so the same
  inflate-then-fallback logic applies. We use `execFile` (async) so downloads
  don't block the server's event loop.
- `POST /api/files/download/offset` takes `{"filepath", "offset", "length"}`
  (`length <= 0` means through EOF; negative `offset` is relative to EOF). Our
  incremental re-sync fetches the bytes after the JMX trailer offset and splices
  them onto the local file, which is byte-identical to a fresh full download.

## MIDI stones

- `POST /api/midi-stones/download/stone` takes `{"midiPath", "stoneIdx"}` and
  returns a deflate-compressed ~45 KiB stone. Stone indices are **1-based**
  (0 is an error); negative indices count backward from the newest stone.
- **Current firmware rejects stone downloads for the actively-growing asset**
  ("expected size (N) != actual size (M)") because it validates the cached file
  size at open. Stones are reliable for completed assets. Our sync therefore
  uses `download/offset` for live-asset incremental sync and keeps stones as an
  available primitive for completed-file use.

## JMX parsing gotchas

- SMF variable-length quantities encode the **first byte as the most-significant
  7-bit group** — a naive little-endian VLQ reader silently skips events past
  the first large delta and misses `jmxEof`. See `server/utils/jmxParser.ts`.
- JMX meta JSON is pretty-printed (tabs/newlines) and NUL-terminated; parse from
  the first `{` to the first NUL.
- `jmxAsset` is a `FF 01` text meta event (no leading zero byte); all other JMX
  events are `FF 7F` with a leading `00` prefix. `jmxAsset` holds the local
  creation `time`; `jmxStoneHdr` holds `asset.assetUuid` (stable sync key) and
  `identities.jamcorderUuid`; `jmxEof` holds `fileOffset` (renewable-trailer
  start) and `totalMillis` (silence-compressed duration).

### Passage bookmarks (`jmxBookmark`)

- `jmxBookmark` marks the **end of a user-selected passage**; the start is the
  client's choice (previous bookmark, or the recording start). The payload is
  `{ bookmarkIdx, bookmarkUuid, bookmarkSource, unixtime, localOffset }` — there
  is **no name field**. `bookmarkIdx` is a device-local counter that continues
  across assets (the counter keeps increasing from one recording to the next).
- `bookmarkSource` in the recordings we have seen is `byPianoTrigger` (a physical
  trigger/pedal, presumably).
- **Position in the file:** a bookmark sits at some cumulative SMF delta-tick in
  the track. JMX defines 1 ms per tick, so `position_sec = cumulative_ticks /
  1000`, which is the same silence-compressed coordinate system the app's
  annotations use. Our parser records that as `JmxBookmark.timeSec` and stores
  the array on `files.bookmarks_json` at sync time.
- **Do not trust bookmarks as song boundaries.** They are sparse in practice
  (typically only a couple of files in a library carry any) and do not always
  align with annotated songs: bookmarks have been observed sitting in an
  unannotated tail, far from the annotated song spans. A bookmark can also
  split the *same* song if the player stepped away, and a rapid song change can
  have no bookmark. We use them as *passage boundary hints* (predicted segments
  are split at each bookmark) rather than as a naming or boundary truth signal.

### Silence gaps (`jmxSkip`)

- `jmxSkip{millis, unixtime?, localOffset?}` records wall-clock silence that was
  **compressed out** of the MIDI timeline: when the player stops for the
  configured silence threshold (3 s in the common configuration), MIDI recording
  pauses and a `jmxSkip` is written. `millis` is the omitted wall-clock
  duration; the playback timeline does not include it (playback + skip total =
  elapsed time).
- **Far more common than bookmarks:** the vast majority of recordings contain
  `jmxSkip` events, while bookmarks are rare. A skip's playback position
  (`timeSec`) is the cumulative SMF delta-tick at the event, same coordinate
  system as annotations.
- **Useful as hints, not truth.** Skip durations range from the ~3 s threshold
  up to hours (overnight gaps). In the annotated data used to calibrate the
  thresholds, only ~13-18% of skips sit near an annotation boundary and
  ~25-30% fall *inside* an annotated span (breathing / page-turn pauses within
  one song). The prediction pipeline therefore splits segments only at skips
  **>= 30 s** (`minSkipSplitSec`, configurable), reserving short gaps for the
  many times a player pauses briefly within a song. The detail-page piano roll
  renders bookmarks as solid green circles and skips >= 8 s as green rings to
  make them visible while annotating.

### Section / song naming

- **Jamcorder has no section-naming feature in the JMX format.** There is no
  meta event or JSON field that carries a section/song name, and a raw byte
  scan of recording files found no human-readable song/section-name strings
  anywhere. If the device/app offers naming somewhere, it is not persisted into
  the MIDI files we sync, so it cannot drive auto-annotation.
- Empty recordings are real: files of a few hundred bytes (header + one stone +
  EOT) are valid, opened-but-unused assets. **They are not imported.** The
  firmware sometimes opens and closes assets in a burst without recording a note
  — 118 in 42 seconds on 2026-02-19, 147 across two bursts on 2026-04-11 — which
  would otherwise bury a day's real recording under hundreds of dead rows. Sync
  drops them two ways:
  - Before download, on the size the device reports: at or below
    `JAMCODA_SYNC_EMPTY_ASSET_MAX_BYTES` (default 1024). Observed stubs are all
    256 bytes (22 for truncated leftovers); the smallest real recording seen is
    2397, so the threshold sits in a wide gap.
  - After download, if the JMX trailer itself reports `totalNotes: 0` and
    `totalMillis: 0`. This backstop reads the device's own summary rather than a
    local parse — a failed MIDI parse also looks like "0 duration", and throwing
    a file away on that basis would lose real data. No trailer means keep it.

  Skipping is safe: nothing is written, so if the device ever appends to a
  skipped asset it grows past the threshold and the next sync takes it as new.
  Only *new* assets are checked; an already-synced file keeps its normal
  change-detection path. `npm run db:prune-empty` clears out empties imported
  before this rule existed (dry run by default, `--apply` to delete).

## WebSocket MIDI streaming

- `ws://<device>/api/midi-io/websocket` streams MIDI in binary frames. Frame
  convention: first byte `0x00` standard frame, `0x01` server ping (reply with
  a one-byte `0x02` pong), `0x02` pong. Each standard frame then carries one or
  more 12-byte MIDI records:

  | Offset | Size | Meaning |
  | --- | --- | --- |
  | 0 | 1 | Input source enum |
  | 1 | 1 | Flags; inbound bit 0 requests recording |
  | 2 | 6 | Event timestamp, unsigned big-endian milliseconds |
  | 8 | 1 | USB-MIDI cable/CIN header |
  | 9 | 3 | MIDI bytes |

- A JS parsing approach that reads the frame as hex (slice header/source/time/
  data):

  ```js
  ws.onmessage = function (event) {
    const u8 = [...new Uint8Array(event.data)];
    if (u8[0] === 1) { ws.send(new Uint8Array([2])); return; } // ping -> pong
    const hex = u8.map(b => b.toString(16).padStart(2, '0')).join('');
    const hdr = hex.substr(0, 4);    // PING vs MIDI
    const input = hex.substr(4, 4);  // input source (DIN, UART, BLE)
    const time = hex.substr(8, 12);  // time since boot
    const midi = hex.substr(20, 8);  // MIDI data
    console.log('MIDI:', { hdr, input, time, midi });
  };
  ```

## Observed JSON response shapes

These are shapes observed on a real device; treat field presence as
firmware-dependent and rely on `/api/meta/endpoints` for the runtime contract.

- `GET /api/device-state/get` aggregates: `identities`
  (`jamcorderUuid`, `jamcorderName`, `performerUuid`, `performerName`),
  `softwareInfo`, `cpuInfo`, `wifiInfo` (`macAddress`, `wifiMode`,
  `home: { connected, ssid, ip, rssi }`), `bluetoothState`, `sdCardInfo`,
  `midiIoSettings`, `lifestats` (`lifeNotesPlayed`, `lifeMillisPlayed`),
  `time` (`unixtime`, `localOffset`, `localTimeStr`), `midiMsgCounts`,
  `currentIssues`.
- `GET /api/midi-io/settings/get` returns booleans `filtering`, `dinToDin`,
  `dinToBle`, `dinToUsb`, `usbToDin`, `usbToBle`, `bleToUsb`, `bleToDin`.
  All eight are required when setting routes.
- `GET /api/piano/state` is per-channel: `inputSource` (`port`, `cable`,
  `channel`), `program`, `pitchBend`, `controlChanges` (`{ cc, name, data }`),
  and `notes` (`depressedMap`, `sustainPedal`, `depressed`, `sustained`, ...),
  plus top-level `activity` (`inactivityCount`, `mostRecentNoteTimestamp`) and
  `sound` (`cur: { state, duration, timeStart }`).