/**
 * The port plan (1.3): every role has its own incoming ports, so roles on one machine never clash and a node is easy
 * to put behind a firewall or in a DMZ. Every port of a node can be overridden in its settings.
 *
 * | Role         | Incoming                                                          |
 * |--------------|-------------------------------------------------------------------|
 * | Orchestrator | 443 (+80 for certificates)                                        |
 * | Ingest       | 8200 plain, 8201 TLS, 8210–8299 Shoutcast v1                      |
 * | Relay        | 443/80 for listeners, 8301 TLS for pushes from ingests and studios |
 * | Station node | 8400 plain, 8401 TLS (RHIS Studio and Go Live), 8402 SFTP         |
 *
 * FM/MPX nodes only connect outwards. Studio and station nodes push to an ingest or the relays, never the other way.
 */
export const PORTS = {
  orchestrator: { https: 443, http: 80 },
  ingest: { plain: 8200, tls: 8201, shoutcastFrom: 8210, shoutcastTo: 8299 },
  relay: { push: 8301 },
  stationNode: { plain: 8400, tls: 8401, sftp: 8402 },
} as const;

/**
 * The ports from before the port plan. A server or node installed before it keeps them open next to the new ones
 * ("old ports", 1.2 and earlier) until the administrator switches them off, so encoders and studios that were set up earlier keep
 * working. Pushes between nodes keep using the old push port while it is on, because a firewall in between may only
 * let that one through.
 */
export const OLD_PORTS = { plain: 8010, tls: 8443, push: 8001, sftp: 2022, shoutcastFrom: 8100, shoutcastTo: 8199 } as const;
