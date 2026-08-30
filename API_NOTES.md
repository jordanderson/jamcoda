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
- Paths returned by the file endpoints are device-absolute, but the download
  endpoints want them prefixed with `/sdcard/` — e.g. list returns
  `/JAMC/2025/<uuid>/Jmx-A00001-Oct-14-2025.mid`, download wants
  `/sdcard/JAMC/2025/<uuid>/Jmx-A00001-Oct-14-2025.mid`. This prefix is not
  part of the on-device layout; it is a quirk of the download endpoints.
- The recording path and filename convention itself is specified in the JMX
  format docs (`/JAMC/<year>/<jamcorderUuid>/Jmx-A<assetIdx>-<Mon>-<DD>-<YYYY>.mid`).
  Our sync layer only relies on the trailing `-<Mon>-<DD>-<YYYY>` portion to
  derive the recording date; see `extractDate` in
  `server/services/sync.service.ts`.

## Download quirk (firmware bug)

- The file download endpoint can respond with both `Content-Length` and
  `Transfer-Encoding: chunked` (an HTTP/1.1 violation). Strict HTTP clients
  (e.g. `got`) reject the response. This project works around it by shelling
  out to `curl -s`. The downloaded body may also be deflate-compressed, so the
  same inflate-then-fallback logic applies.

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