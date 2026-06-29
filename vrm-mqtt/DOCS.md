# Home Assistant App: VRM MQTT

Bridges every Victron VRM installation that your account can see to the
Home Assistant Mosquitto broker using MQTT discovery.

## What it does

1. Calls the VRM REST API with your personal access token to list all
   installations you have access to.
2. Opens an MQTT connection to each installation's VRM MQTT broker
   (`mqtt.victronenergy.com`) and subscribes to its full topic tree.
3. Translates the published values to a stable, HA-friendly schema under
   `vrm/<installation_id>/...` and republishes them on your local broker.
4. Publishes MQTT discovery configs under `homeassistant/...` so the
   entities appear automatically in Home Assistant.
5. Polls the installation list periodically (default 5 min) and reconciles
   connections as installations are added or removed.

## Configuration

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `vrm_api_token` | yes | — | Personal access token from the VRM Portal. |
| `vrm_api_base_url` | no | `https://vrmapi.victronenergy.com/v2` | VRM REST API base URL. |
| `vrm_poll_interval_ms` | no | `300000` | How often to poll the installation list (ms). |
| `vrm_disabled_installation_ids` | no | empty | Comma-separated IDs to skip. |
| `vrm_installation_startup_delay_ms` | no | `500` | Stagger between per-installation connects (ms). |
| `vrm_throttle_interval_ms` | no | `500` | Window (ms) for cross-installation message coalescing; `0` disables. Publishes are spread evenly across this window across all installations, so broker load scales smoothly with the fleet size. |
| `ha_mqtt_host` | no | `core-mosquitto` | HA MQTT broker host. Auto-detected from the MQTT service if available. |
| `ha_mqtt_port` | no | `1883` | HA MQTT broker port. |
| `ha_mqtt_username` | no | empty | MQTT username (only needed for non-anonymous brokers). |
| `ha_mqtt_password` | no | empty | MQTT password. |

## Getting a VRM API token

1. Sign in to <https://vrm.victronenergy.com>.
2. Open the user menu (top right) → **Preferences**.
3. Click **Access tokens** → **Generate token**.
4. Copy the token into the `vrm_api_token` add-on option.

## MQTT

If you run the official Mosquitto add-on, the bridge will pick up the
broker host, port, username and password from the MQTT service
automatically. Otherwise fill in the `ha_mqtt_*` options manually.

## Discovery

Entities are published on a stable schema. Example for installation
`123456`:

- `homeassistant/sensor/vrm-123456/battery_soc/config` → battery state of charge
- `homeassistant/sensor/vrm-123456/battery_voltage/config` → battery voltage
- `homeassistant/sensor/vrm-123456/battery_state/config` → battery state
- `homeassistant/sensor/vrm-123456/custom_aggregate_pv_power/config` → PV power (DC + AC combined)
- `homeassistant/sensor/vrm-123456/custom_aggregate_ac_grid_power/config` → grid power (3-phase sum)

After startup the device panel contains 7 entities per installation:
3 battery sensors (`Dc/Battery/Soc`, `Dc/Battery/Voltage`, `Dc/Battery/State`)
and 4 custom aggregates (under `custom/aggregate/`). Per-phase readings and most other VRM
topics are subscribed internally (to feed the aggregates) but are not
exposed in HA.

The full per-topic mapping is documented in
[`docs/debug/topics/topics.txt`](https://github.com/KaiGrassnick/vrm-mqtt-apps/blob/main/vrm-mqtt/docs/debug/topics/topics.txt).

To expose additional entities, set `forward: true` on the corresponding
entry in `vrm-mqtt/app/src/ha/entityDefs.ts` (`SYSTEM_ENTITIES`). To define a
new aggregate (e.g. a per-phase PV breakdown), add an entry to
`CUSTOM_AGGREGATES` in the same file — `aggregateFrom` is required and may
mix `{n}`-template and literal source paths.

## Dashboard

A ready-made Lovelace dashboard and helper script are provided under
[`docs/homeassistant/`](https://github.com/KaiGrassnick/vrm-mqtt-apps/tree/main/vrm-mqtt/docs/homeassistant).
Copy `configuration.yaml` into your HA config and adapt the template
entity to your own installation ID.