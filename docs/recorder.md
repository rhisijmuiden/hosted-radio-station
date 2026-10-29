# Recorder nodes (phase 21)

A recorder node only records. It keeps a **logging** recording of the stations it is given: what went out on air,
all the time, in MP3 files of one clock hour. Later steps add live shows in high quality and upload targets.

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
bitrate. The recorder reports the list of files to the orchestrator when it changes (and every ten minutes); the
orchestrator keeps it in the `recordings` table.

## API

- `GET /api/stations/:id/recording` and `PUT /api/stations/:id/recording`: the logging settings and the recorders of
  the station.
- `GET /api/stations/:id/recordings?from=…&to=…`: the files between two moments (at most 32 days).
- `GET /api/stations/:id/recordings/:rid/songs`: the play log of a file.
- `GET /api/stations/:id/recordings/:rid/audio`: the audio, with `Range` for seeking; `?download=1` for the whole file
  as an attachment.
