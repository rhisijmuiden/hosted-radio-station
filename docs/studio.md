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

For stations with the Radio station edition. The top shows what is on air with the time left, and **Skip**. Below are
**Q1** and **Q2** side by side: drag tracks to reorder them or move them to the other queue, or use the buttons that
appear on hover (to the top, to the other queue, remove). The eraser empties the rotation of a queue; requests and
tracks added by hand stay. Search the library on the right and drag a track onto a queue, or use the Q1/Q2 buttons
(Shift = at the top).

## Going live

1. In **Settings** choose the driver (**WASAPI**, or **ASIO** for professional sound cards), the sound card, and the
   channels: a stereo pair such as *3 – 4* (for example the output of a mixing desk on inputs 3 and 4), or one channel
   as mono. Check the level on the meter and set the input level.
2. In **Go live** choose your DJ account, the mount and the quality (64–320 kbps MP3, up to what the mount allows),
   and type a show title if you like.
3. Press **Go live**. The client asks the server for a temporary encoder password for your DJ account (valid 12
   hours), so you never type it. It connects over TLS when the server has a certificate, and reconnects by itself when
   the connection drops. A refusal (outside your show, wrong mount) is shown and not retried.

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
