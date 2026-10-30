# Recorder nodes (phase 21)

A recorder node only records. It keeps a **logging** recording of the stations it is given: what went out on air,
all the time, in MP3 files of one clock hour; and it records every **live show** of those stations as it was sent.
A later step adds upload targets.

It can stand at a customer's site (an LXC or PC next to the studio, installed like any other node) or in the
datacenter, recording many stations. The files stay on the recorder; the panel fetches them from there when someone
listens or downloads, also when the recorder sits behind NAT (it sends the file over its own connection to the
orchestrator, in parts of 8 MB).

## Setting one up

1. Create a container (Debian 13 LXC) with enough disk for the recordings (see below) and install the node agent as
   usual (see [nodes.md](nodes.md)), with `--role recorder` or by giving it the role **Recorder** after pairing.
   The node installs ffmpeg by itself.
2. Under **Settings → Recorder**, choose the stations it records: all stations it serves, or a list. A new recorder
   records nothing until stations are chosen. A recorder of a customer, or one dedicated to a customer or station
   (Shared or dedicated), only offers those stations.
3. Per station, under **Recordings**: logging on or off, the bitrate (32–128 kbps, default 64) and how many days the
   hours are kept (1–366, default 31).

The recorder needs no incoming ports: it listens to the station's default stream through the listen route of the
orchestrator, which sends it to the nearest relay that carries the stream (or to the orchestrator itself), so it
follows the station when relays come and go. A short drop is bridged by ffmpeg; after a longer one the recorder
starts a new file and tries again, a little later each time.

## Live shows

When a DJ goes live on a station the recorder records (Go live in RHIS Studio, or an encoder on an ingest, a station
node or the orchestrator), the orchestrator puts the broadcast in the recorder's plan and the recorder starts
recording it within seconds; when the broadcast ends it stops. The show is recorded as it is sent (no new encoding,
so in the station's full quality and format: MP3, AAC, Opus or Vorbis), from the mount the DJ sends to, through the
nearest relay, which carries exactly the bytes the station node or ingest sends. If the stream drops during the show
the recorder starts a new part; parts of one show belong together.

Per station, under **Recordings**: *Record live shows* (on by default), *Keep shows for* (default 90 days) and
*Shortest show to keep* (default 2 minutes; a DJ testing the connection is thrown away). Shows are never removed to
make room on a full disk, only after their retention. The **Live shows** list shows the last month with the DJ, length
and size; play a show with its play log, or download it.

## Uploads

Per station, under **Recordings → Upload**, a manager adds destinations: an **SFTP**, **FTPS** or **FTP** server or
**OneDrive**, set up the same way as a backup location (OneDrive: sign in with a code when the server has a Microsoft
app under backup settings, otherwise paste a token from `rclone authorize onedrive`). Per destination: what goes
there (logging, live shows or both) and whether it is active. **Test connection** checks the login and makes the
folder.

The orchestrator does the uploads: every 30 seconds it looks for finished recordings a destination does not have yet,
fetches each once from the recorder (the same way the player does, so a recorder behind NAT works) and copies it with
rclone. Recordings made before a destination was added are not uploaded there (except the hour it was added in). A
failed upload is tried again after 1, 5, 15 and 30 minutes, then every hour; the destination shows how many wait and
the newest error, with **Try again now**. Changing a destination tries the failed ones again at once. The lists show a
cloud icon per recording: green when uploaded, orange when an upload failed.

Layout at the destination, times in UTC:

```
<folder>/<station>/logging/2026-10/<station>_2026-10-29_21-00-00Z_64k.mp3
<folder>/<station>/shows/2026-10/<station>_2026-10-29_21-04Z_DJ-Reinder_1a2b3c.mp3
```

**Remove from the recorder once uploaded** (off by default): a recording is removed from the recorder as soon as every
active destination that takes it has it, and a show is an on-demand item when the station wants that. It is then no
longer listed under Recordings; listen back from the destination.

## Shows on demand

With *Make shows available on demand* (on by default), a show becomes an on-demand item of the station two minutes
after its broadcast ended: the orchestrator fetches it from the recorder (parts of one show are joined into one file
without new encoding) and puts it in the station's `recordings` folder, on the orchestrator or, for a station on a
station node, on that node. The item is a draft or published right away as set under **Public page → On demand**
(*Publish recordings right away*), and drafts that are never published are removed after the days set there. A
broadcast that already has an item (because *Record live broadcasts* on the public page recorded it on the server too)
gets no second one; the Recordings page warns when both are on. Shows that ended more than 7 days ago are not offered
any more.

## Disk space

| Bitrate | Per hour | Per day | 31 days |
| --- | --- | --- | --- |
| 32 kbps | 14 MB | 0.35 GB | 11 GB |
| 64 kbps | 29 MB | 0.7 GB | 21 GB |
| 128 kbps | 58 MB | 1.4 GB | 43 GB |

Per station. When the free space drops below 1 GB (or 5% of the disk), the recorder removes the oldest logging files
first and logs a *recorder_disk_full* event. The node page shows the disk.

## Listening back

The station page **Recordings** lists the hours of a day. **Play** opens the player with the play log of that hour:
every song with its start time, and whether a DJ was live (with the DJ's name) or the AutoDJ played it. A click on a
song jumps there. The running hour can be played too; its play log fills while it runs. **Download** saves the hour
as an MP3 file. A file can only be played while its recorder is online.

## Files on the recorder

`/var/lib/hrs-node/recordings/<station id>/log/2026-10-29_21-00-00Z_64k.mp3`: the start of the file in UTC and its
bitrate. Shows: `…/<station id>/show/2026-10-29_21-04-13Z_192k_<broadcast id>.mp3`. The recorder reports the list of files to the orchestrator when it changes (and every ten minutes); the
orchestrator keeps it in the `recordings` table.

## API

- `GET /api/stations/:id/recording` and `PUT /api/stations/:id/recording`: the logging settings and the recorders of
  the station.
- `GET /api/stations/:id/recordings?from=…&to=…&kind=log|show`: the files between two moments (at most 32 days).
- `GET /api/stations/:id/recordings/:rid/songs`: the play log of a file.
- `GET /api/stations/:id/recordings/:rid/audio`: the audio, with `Range` for seeking; `?download=1` for the whole file
  as an attachment.
- `GET/POST /api/stations/:id/recording/destinations`, `PUT/DELETE …/destinations/:did`: upload destinations (secrets
  are masked in answers; send the mask back to keep them). `POST …/destinations/test` checks one before or after
  saving, `POST …/destinations/:did/retry` tries the failed uploads again now. `POST /api/stations/:id/recording/onedrive/device-code`
  and `…/device-token` sign in to OneDrive.
- The settings `showsOnDemand` and `deleteUploaded` are part of `PUT /api/stations/:id/recording`. The file list has
  `uploads` (done, failed, newest error) and `onDemand` per file.
