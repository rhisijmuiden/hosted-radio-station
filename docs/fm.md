# FM/MPX and RDS

An FM/MPX node puts a station on FM. It is a node like a relay (see [nodes.md](nodes.md)): its own Debian 13 LXC, paired with a one-time code and updated from the main server. It takes the station's stream from the main server and makes the complete FM multiplex signal:

- **Stereo encoder**: mono (L+R), the 38 kHz stereo subcarrier (L−R) and the 19 kHz pilot, at 192 kHz.
- **RDS**: PI, PS, programme type, TP/TA, music/speech, alternative frequencies, clock time, **RadioText** and **RadioText+**. The song comes from the titles in the stream itself, so the text on the radio changes together with the music. Who is live and which show runs come from the main server.
- **Audio processing**: pre-emphasis (50 µs or 75 µs), a peak limiter and a steep 15 kHz low-pass, so the pilot stays clean.

The MPX goes to a **192 kHz sound card** wired to the exciter, or over the network as **MPX over IP** (uncompressed RTP, L24 at 192 kHz). Instead of making MPX, or next to it, the node can steer an **existing RDS encoder over UECP** (TCP, UDP or a serial port).

While the stream is away, the pilot and RDS stay on air, so receivers keep showing the station.

## Add an FM node

1. In the panel go to **Infrastructure → Nodes**, click **Add node** and choose the role **FM/MPX**.
2. Create a fresh Debian 13 LXC (for example with the community script `ct/debian.sh`; 2 vCPU, 1 GB RAM and 8 GB disk are plenty) and run the command from the panel in it as root:

```bash
curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/hosted-radio-station/main/install-fm.sh | bash -s -- --server https://radio.example.com --code XXXX-XXXX-XXXX
```

`install-fm.sh` is the node installer with `--fm`: it also installs ffmpeg and the ALSA tools and gives the agent access to the sound cards and serial ports. All options of `install-node.sh` work. An existing node gets FM by running `install-node.sh --fm` (or `install-fm.sh`) on it again and adding the role in the panel.

3. On the node page, under **Settings**, choose the station, RDS and the output. The node rolls it out by itself; the **Overview** shows what is on air: a radio display with the PS and RadioText as listeners see them, the modulation and audio levels, and the state of the stream, the output and the RDS encoder.

## A sound card in the container

An LXC sees no sound cards until you pass them through. On the Proxmox host, add to `/etc/pve/lxc/<id>.conf`:

```
lxc.cgroup2.devices.allow: c 116:* rwm
lxc.mount.entry: /dev/snd dev/snd none bind,optional,create=dir
```

and restart the container. The node lists the cards it sees in the panel. Use a card that really does 192 kHz (for example an RME, Lynx or a USB interface with a 192 kHz DAC); the output is mono MPX, copied to both channels of a stereo card unless you choose one channel.

A serial RDS encoder (UECP over RS-232/USB) is passed through the same way, for example `lxc.cgroup2.devices.allow: c 188:* rwm` and `lxc.mount.entry: /dev/ttyUSB0 dev/ttyUSB0 none bind,optional,create=file`.

## Settings

| Setting | Meaning |
| --- | --- |
| Station, stream | What goes on air. Take the best quality the station has; the node decodes it. |
| PI code | Four hex characters from your licence (in the Netherlands from the RDI). |
| PS | The station name on the display, 8 characters. **Fixed** is recommended; **scrolling** shows artist and title in pieces of 8 characters for radios without RadioText (some regulators do not allow it). |
| RadioText | Three templates: while a song plays, while a DJ is live and otherwise. Placeholders `{artist}`, `{title}`, `{song}`, `{station}`, `{dj}`, `{show}`. At most 64 characters go out; empty parts take their separators with them. |
| RadioText+ | Tags where artist and title are in the RadioText (sent in group 11A, announced in 3A). |
| PTY, TP/TA, music | Programme type (European list), traffic programme and announcement, music or speech. |
| AF | Up to 25 alternative frequencies of the same programme (method A). |
| Clock time | Group 4A once a minute, with the time zone of the station's scheduler. |
| Stereo, pre-emphasis, limiter | Switch the limiter and pre-emphasis off when a broadcast processor (for example Stereo Tool or Omnia) already does this before the stream. |
| Pilot, RDS injection | Share of 100% modulation: 8–10% pilot and 3–5% RDS are usual. |
| Output gain | Set it once so 100% on the meter is 75 kHz deviation on the transmitter. |
| Buffer | Audio kept in hand against network hiccups (1.5 s by default). The node also corrects the small clock difference between the stream and the sound card, so the delay stays the same for weeks. |

## MPX over IP

The node sends RTP with 24-bit samples at 192 kHz, mono, payload type 97, to a unicast address or a multicast group. The panel shows the SDP for the receiver, for example:

```
v=0
o=- 0 0 IN IP4 10.10.4.130
s=fm-node MPX
c=IN IP4 239.10.4.1/16
t=0 0
m=audio 5004 RTP/AVP 97
a=rtpmap:97 L24/192000/1
```

That is about 4.6 Mb/s. Receivers that take an SDP (ffmpeg, Stereo Tool, many IP exciters) play it as is.

## UECP to an existing encoder

Turn on **Send RDS over UECP**, choose TCP, UDP or a serial port and the encoder's address; site and encoder address 0 reach every encoder. The node sends PI, PS, RadioText (with the A/B flag), PTY, TP/TA, music/speech and stereo, the changes right away and everything again every minute. RadioText+ and AF are set on the encoder itself.

## Troubleshooting

- **No sound card in the list**: pass `/dev/snd` through (see above) and restart the container; `aplay -l` on the node shows what it sees.
- **Output: aplay stopped**: another program uses the card, or the card cannot do 192 kHz. Choose a card that can.
- **ffmpeg is not installed**: run `install-fm.sh` on the node again.
- **The modulation meter goes over 100%**: lower the output gain, or let the limiter work (it is on by default).
- On the node, `hrs-node logs` shows what the FM role does.
