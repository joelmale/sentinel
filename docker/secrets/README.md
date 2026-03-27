# Dockhand scrape secret files

This directory is mounted read-only into selected containers at:

- `/run/secrets/sentinel`

Use it for parser-hostile scrape values that should not be stored directly in
Dockhand env vars, especially values containing semicolons or browser-style
header syntax.

## Files you may need

### MarineTraffic

Create these files only if you enable MarineTraffic enrichment:

- `docker/secrets/marinetraffic_cookie_header`
- `docker/secrets/marinetraffic_sec_ch_ua`

Example values:

`marinetraffic_cookie_header`

```text
__cf_bm=...; cf_clearance=...; other_cookie=...
```

`marinetraffic_sec_ch_ua`

```text
"Not:A-Brand";v="99", "Microsoft Edge";v="145", "Chromium";v="145"
```

Related env vars:

```env
MARINETRAFFIC_ENRICH_ENABLED=true
MARINETRAFFIC_COOKIE_HEADER_FILE=/run/secrets/sentinel/marinetraffic_cookie_header
MARINETRAFFIC_SEC_CH_UA_FILE=/run/secrets/sentinel/marinetraffic_sec_ch_ua
```

### ADSBx binCraft

Create these files only if you use the advanced binCraft scrape path:

- `docker/secrets/adsbx_bincraft_cookies`
- `docker/secrets/bincraft_sec_ch_ua`

Example values:

`adsbx_bincraft_cookies`

```text
adsbx_sid=...; adsbx_identity_exp=...
```

`bincraft_sec_ch_ua`

```text
"Not:A-Brand";v="99", "Microsoft Edge";v="145", "Chromium";v="145"
```

Related env vars:

```env
ADSBX_BINCRAFT_COOKIES_FILE=/run/secrets/sentinel/adsbx_bincraft_cookies
BINCRAFT_SEC_CH_UA_FILE=/run/secrets/sentinel/bincraft_sec_ch_ua
```

## Where to put them on the server

Set this in Dockhand:

```env
SCRAPE_SECRETS_DIR=./docker/secrets
```

Then create the actual files on the server inside the checked-out repo:

- `docker/secrets/marinetraffic_cookie_header`
- `docker/secrets/marinetraffic_sec_ch_ua`
- `docker/secrets/adsbx_bincraft_cookies`
- `docker/secrets/bincraft_sec_ch_ua`

Only create the files for the integrations you are actually using.

## Precedence

If both a plain env var and a `*_FILE` env var are set, the file-backed value
wins.
