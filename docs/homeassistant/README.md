# Home Assistant setup for vrm-mqtt

## Prerequisites

- [HACS](https://hacs.xyz/) installed
- A running `vrm-mqtt` pointing at this HA's Mosquitto broker
- A VRM account with an [access token](https://vrm.victronenergy.com/access-tokens)

## UI setup

1. Install `flex-table-card` from HACS → Frontend.
2. Install the Mosquitto broker add-on (Settings → Add-ons → Add-on Store).
3. Create an MQTT user matching your `vrm-mqtt` `.env` credentials (Settings → People → Users).
4. Add the MQTT integration pointing at that broker with those credentials (Settings → Devices & Services → Add Integration).
5. Restart HA so the integration and user settle.
6. Create the dashboard card — Settings → Dashboards → add or edit a view → add a **Manual** card, set type to `custom:flex-table-card`, and paste the contents of `dashboard.yaml` (everything below the `type:` line).
7. Create the script — Settings → Automations & Scenes → Scripts → Create script → switch to **Edit in YAML** → paste the contents of `script.yaml`.
8. Restart HA.

## File setup

9. Copy `templates/vrm_installation_list.yaml` into a `templates/` folder next to your `configuration.yaml`.
10. Append `configuration.yaml` with the contents of `configuration.yaml` in this folder. It does two things:
    - `!include_dir_merge_list`s the `templates/` folder
    - excludes `sensor.vrm_installations` from the recorder (it updates every 5 s; without this the DB fills up)
11. Restart HA.

## Verify

`sensor.vrm_installations` exists in Developer Tools → States with a populated `installations` attribute. The dashboard card shows one row per installation and refreshes every 5 s.