# Working rules

This repository contains OpenWrt packaging and LuCI integration, not a fork of
the transport. Keep wire behavior in the upstream Queqiao repository.
Never commit router profiles, invitations, private keys, host configuration or
private infrastructure details. Keep metrics on loopback. SOCKS defaults to
loopback; LAN access requires the explicit mode and named LAN-interface gate.
Do not add tests unless explicitly requested. Validate package manifests,
shell/JavaScript syntax, rpcd ACLs and on-device behavior for relevant changes.
Packages are unsigned development artifacts; do not publish or sign releases
without an explicit request. Keep default installation disabled.
