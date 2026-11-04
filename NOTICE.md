# Licence notice

Hosted Radio Station, including the node agent (`apps/node`), the panel (`apps/web`), the API and orchestrator
(`apps/api`) and the Windows client RHIS Studio (`apps/studio`).

Copyright (C) 2026 RHIS (Reinder Halewijn)

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General
Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
details. The full text is in [LICENSE](LICENSE).

SPDX-License-Identifier: AGPL-3.0-or-later

## Source code for network users (section 13)

Everyone who uses the panel, the public pages or RHIS Studio over a network can get the source code of the version
that runs: the **Info** screen of the panel and of RHIS Studio links to this repository,
<https://github.com/rhisijmuiden/hosted-radio-station>, at the running commit or release. Whoever runs a modified
version must offer the source of that modified version in the same way.

## Additional permission: Steinberg ASIO SDK (section 7)

As an additional permission under section 7 of the GNU AGPL version 3, the copyright holder gives you permission to
link RHIS Studio with the Steinberg ASIO SDK (through the `asio` feature of the `cpal` crate), and to convey the
resulting work, without the ASIO SDK itself being covered by this licence. You must still follow the terms of the
AGPL for all other code of RHIS Studio, and the Steinberg licence agreement for the ASIO SDK. If you modify RHIS Studio,
you may extend this exception to your version, but you are not obliged to do so; if you do not wish to, delete this
paragraph from your version.

## Name and logo

The licence covers the code. The name RHIS and the RHIS logos in `brand/` and `apps/*/public/brand/` are not
licensed for use beyond identifying this unmodified software; a modified version should not present itself as RHIS.

## Programs it works with

The platform starts other programs as separate processes, each under its own licence: Icecast (GPL-2.0),
Liquidsoap (GPL-2.0-or-later), FFmpeg (LGPL-2.1-or-later or GPL, depending on the build), Caddy (Apache-2.0),
PostgreSQL (PostgreSQL licence) and, when an operator uploads it, Stereo Tool (proprietary, its own licence). They are
installed by the install scripts and are not part of this program.

## Libraries

All JavaScript dependencies are under permissive licences (MIT, ISC, BSD, Apache-2.0, BlueOak-1.0.0 and similar).
The Rust dependencies of RHIS Studio are permissive too, except `symphonia` (MPL-2.0) and `mp3lame-encoder` /
LAME (LGPL-3.0), both of which may be combined with AGPL-3.0 code.
