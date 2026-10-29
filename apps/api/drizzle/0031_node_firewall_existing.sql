-- Security hardening for external nodes, step 4: nodes from before it get the same firewall default as new nodes.
-- At their next connection with software that has a firewall, a node with a public address of its own gets it
-- switched on, any other node keeps it off. A firewall already switched on by hand is left as it is.
UPDATE "nodes" SET "config" = jsonb_set("config", '{firewall}', coalesce("config"->'firewall', '{}'::jsonb) || '{"auto": true}'::jsonb)
WHERE NOT coalesce("config"->'firewall' ? 'auto', false)
  AND coalesce(("config"->'firewall'->>'enabled')::boolean, false) = false;
