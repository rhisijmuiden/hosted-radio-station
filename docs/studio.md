# RHIS Studio (Windows client)

RHIS Studio is the studio PC client of Hosted Radio Station: live assist for the AutoDJ queues, live broadcasting from
any sound card input (also a mixing desk), and a cart wall. It talks to the server through the same API as the admin
panel and sends its audio to the server's source ingest, like any Icecast encoder.

## Install

1. In the admin panel open **Windows client** in the left menu and download the installer of the **Production**
   channel (or **Test** for the newest test build).
2. Run it. The installer is not code-signed yet, so Windows SmartScreen asks once: choose *More info* → *Run anyway*.
   It installs for the current user, without administrator rights.
3. Start **RHIS Studio**, enter the address of your panel (for example `radio.example.com`) and choose
   **Sign in with your browser**. Your browser opens the panel; check that it shows the same code as the client and
   choose **Link this PC**. The client signs in by itself.

The PC gets its own API key, kept in the Windows Credential Manager. Linked PCs are listed on the **Windows client**
page, where you can unlink them; **Sign out** in the client revokes its key too.

## Live assist

For stations with the Radio station edition. The screen has a narrow menu on the left (Assist, Live, Carts,
Settings, and your account at the bottom) and a status bar at the bottom: the connection of your broadcast, the
server and quality, the sound card input, the language, the theme and **Info**.

The **top bar** shows the station (click it to switch), who is on air (you, another DJ, or the AutoDJ in Auto or
Manual), the **next fixed block** of the format (news, commercials) with a countdown, the listeners and the clock.

The **player** shows what is on air, when it ends and the time left in large figures, and on the line below it what
comes next. **Next** starts the next line of the playlist at once (in Auto it skips the track on air).

Below the jingle buttons is the **playlist**: one queue (server 1.3 and later), with the time each line starts.
Drag tracks to reorder them, or use the buttons that appear on hover (to the top, remove). The eraser empties the
rotation; requests and tracks added by hand stay. Search the library on the right and drag a track onto the
playlist, or use **+** (Shift = at the top); see *Library and preview* below.

The fixed blocks of the hour clock sit in the playlist at their minute, with a lock and their expected length. A
block on the minute (*hard*) cuts the track that runs into it; another block waits for that track to end. The header
**backtimes** to the next block: how much the track that runs into it is too long, or how much the playlist is too
short to reach it. The lengths of news and commercials are estimates (the average track of their playlist).

### Auto and Manual

- **Auto**: the AutoDJ plays on from track to track.
- **Manual**: after each track the player waits, silent, until you press **Play**. The next track is already cued, so
  it starts at once. **Play** while a track plays starts the next one when it ends; **Next** starts it right away;
  **Stop** ends the track on air (with the crossfade of the station) and waits.

Manual stays on only while a studio PC is connected: the client checks in every 10 seconds. When it closes or loses
its connection, the server goes back to Auto by itself after 30 seconds and plays on with what is in the queues.
Hard timed items of the hour clock (news on the hour) still start on their minute in Manual.

The level meter at the right edge shows the stream this PC sends while you are live.

The countdown, the fixed blocks and backtiming need server 1.1 or newer (expected lengths: 1.3); on an older server
the client says the server needs an update.

### Library and preview

The panel on the right has three sources:

- **Server**: the station library. Search, drag a track onto the playlist or use +.
- **Network**: the network shares you added under *Settings › Network shares* (for example `\\nas\music`). They
  open with the Windows sign-in of the PC, like in Explorer.
- **This PC**: the drives of the PC, including a USB stick and mapped network drives.

The headphones button plays a track on the **preview output** (*Settings › Preview*), off air: never in the stream
and not on the output of the cart wall unless you choose the same sound card. The bar at the bottom of the panel has
pause, stop and a position slider.

Drag a track onto the **player** (the Now playing card) to play it now: from the playlist, the library or this PC. The track
on air fades out and the dropped track starts at once, in Auto and in Manual. It needs server 1.1.

A file from the network or this PC goes on air through the station library: + or dragging it onto the playlist uploads
it to the library, waits until the server has read its tags and then puts it in the playlist. This needs the manager or
owner role (it counts towards the storage of the station); DJs can preview local files.

### Jingle buttons

Above the queues are your own jingle buttons: six on a page, more pages with **+** (up to 48 buttons). Click a button
to play it, again to stop. Fill an empty button by clicking it (choose a file), or drag a file from *This PC* or
*Network*, or a track of the server library, onto it; a file dropped on a full button replaces it. The pencil sets
the label, colour and loop, or empties the button.

The jingles are kept in your profile on the server, per station, so you get the same buttons on every studio PC. The
client downloads them once and plays them itself, like the cart wall: into the stream and/or on the output device, as
set in *Settings*. The jingles of the station itself (station IDs, news intros) come with the format from the server.
It needs server 1.1 (`/api/studio/stations/:id/jingles`, at most 25 MB per file).

## Going live

1. In **Settings** choose the driver (**WASAPI**, or **ASIO** for professional sound cards), the sound card, and the
   channels: a stereo pair such as *3 – 4* (for example the output of a mixing desk on inputs 3 and 4), or one channel
   as mono. Check the level on the meter and set the input level.
2. In **Go live** choose your DJ account, the mount and the quality (64–320 kbps MP3, up to what the mount allows),
   and type a show title if you like.
3. Press **Go live**. The client asks the server for a temporary encoder password for your DJ account (valid 12
   hours), so you never type it. It connects over TLS when the server has a certificate, and reconnects by itself when
   the connection drops. A refusal (outside your show, wrong mount) is shown and not retried.

When Windows does not trust the certificate of the encoder address (for example a name without a public
certificate yet), the client shows the error with **Connect without encryption**, if the server has a plain port.
The temporary password then goes over the network readable. The choice is kept for that address; *Try encrypted
again* under *Connection* undoes it.

DJs can only broadcast with the DJ account linked to their own user; managers and owners can use any account of the
station. The server's normal rules apply: show times, mount limits and bitrate limits.

A limiter keeps the stream below −0.5 dBFS. The mount must be an MP3 mount (the client warns otherwise).

## Cart wall

Four pages of twelve carts, played with **F1–F12** (from every screen) or a click; press again to stop. Each cart has
a file (MP3, WAV, FLAC, OGG, AAC/M4A, up to 10 minutes), a label, a colour and an optional loop. In **Settings** choose
where carts play: straight into the stream (a studio without a mixing desk), and/or on an output device (into a channel
of the mixing desk). *Listen to the input* plays the sound card input on the output device.

## Updates

**Info** (bottom left) shows the version, the update channel (**Production** or **Test**) and whether a newer build is
available. **Download and install** downloads the installer, checks its SHA-256 against the release and installs it;
the client restarts afterwards. Switching the channel to Test and back works the same way.

Builds come from GitHub Actions (`.github/workflows/studio.yml`):

| Branch | Release | Channel |
| --- | --- | --- |
| `main` | `studio-v<version>` | Production |
| `test` | `studio-v<version>-test.<run>` (pre-release) | Test |

A production release is published once per version: raise `version` in `apps/studio/package.json` for the next one.
The server lists the newest release per channel at `GET /api/studio/releases`.

## Development

```bash
cd apps/studio
pnpm dev                      # the interface in a browser, with a simulated sound card, on http://localhost:5174
pnpm tauri dev                # the real app (on Windows, or Linux with WebKitGTK)
cd src-tauri && cargo test    # audio engine, encoder and streamer tests
```

In the browser, enter `http://localhost:5174` as the server: `/api` is proxied to a local API on port 8000
(`HRS_API` changes that).

ASIO builds (`--features asio`) download Steinberg's ASIO SDK at build time and need LLVM (`LIBCLANG_PATH`).
Distributing ASIO builds outside your own organisation requires Steinberg's ASIO licence agreement.
