<!-- https://developers.home-assistant.io/docs/apps/presentation#keeping-a-changelog -->
## 0.1.16
- fix bug which did set installation back to online on rebirth
- fix memory leak in shared throttle on installation removal/replacement
- fix shared VRM broker connections exceeding Node's listener cap with multiple installations on one host
- fix aggregate sensors permanently including stale values from phases that stopped reporting
- add request timeout to VRM API calls
- add crash containment so one bad installation can no longer take down the whole bridge
- add forced-exit timeout to shutdown so a hang can't block a restart
- add configurable log level (`log_level` option), replacing always-on console output
- validate HA MQTT port range at startup
- re-enable AppArmor confinement (previous profile was missing required network rules)
- narrow add-on permissions to only what's actually used
- switch to a multi-stage Docker build (smaller image, no npm in production)
- remove dead code and unused per-entity device wiring
- fix version drift across config.yaml/package.json/CHANGELOG

## 0.1.15
- fix bug which did not set installations back online after beeing marked as stale
- start with installations offline and set to online only after we got a message

## 0.1.14
- Mark installations offline after a configurable period of silence (default 5 minutes). Adds the `vrm_offline_timeout_ms` add-on option (env var `VRM_OFFLINE_TIMEOUT_MS`); `0` disables the feature.

## 0.1.13
- automatically remove stale topics on startup
- adjust logging

## 0.1.12
- add custom aggregates
- introduce forward flag

## 0.1.11
- add pvonoutput

## 0.1.10
- remove legacy prune step
- remove aarch64

## 0.1.9
- Add pvOnGrid sensors

## 0.1.8
- Automatically add aggregate sensors if we have multiple phases

## 0.1.7
- Retain every bridged VRM state value on the local broker so Home Assistant
  restarts and VRM-side reconnects no longer show entities as `unknown` /
  `null` / `0`. On installation removal, retained state for that installation
  is cleared.

## 0.1.6
- Introduce rolling update to reduce spikes because of batch loads
- replace installationId with siteId

## 0.1.5
- Spread VRM → HA publish load evenly across the throttle interval.
  Internal `GlobalMessageThrottle` replaced with `RollingMessageThrottle`
  that shards by installation; reduces per-cycle publish bursts on
  Home Assistant for fleets with many installations.

## 0.1.4
- disable apparmor

## 0.1.3
- adjust apparmor

## 0.1.2
- disable automatic mqtt service evaluation during startup

## 0.1.1
- Bump package dependencies
- improve build process

## 0.1.0

- Initial release of the VRM MQTT Home Assistant app.
- Polls the VRM REST API for installations and bridges each installation's
  VRM MQTT feed into the Home Assistant Mosquitto broker.
- Publishes MQTT discovery configs under `homeassistant/...` and a stable
  state topic tree under `vrm/<installation_id>/...`.
- Auto-detects the Home Assistant MQTT service; falls back to manual
  `ha_mqtt_*` options when none is registered.
