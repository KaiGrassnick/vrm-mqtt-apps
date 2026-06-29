<!-- https://developers.home-assistant.io/docs/apps/presentation#keeping-a-changelog -->
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