# Jieter ORC Data — Structure Analysis

Source: https://github.com/jieter/orc-data  
Site: https://jieter.github.io/orc-data/site/

---

## Files in the GitHub repo root

| File | Content | Coverage |
|------|---------|----------|
| `orc-data.json` | Current year's dataset, updated daily from orc.org | **AUS only, ~34 boats** |
| `ALL2025.json` | Same as `orc-data.json` | **AUS only, ~34 boats** |
| `ALL2024.json` … `ALL2019.json` | Yearly snapshots | Unknown, likely AUS only |

Despite the name `ALL*.json`, these files appear to contain only the current Australian ORC certificate holders. The data reflects which boats hold an active ORC certificate in the given year — boats without a current certificate (e.g. Wild Oats XI, Black Jack 100) are **not** included.

---

## Files served by the GitHub Pages site

Base URL: `https://jieter.github.io/orc-data/site/`

### `index.json`

Compact search index. Format: array of `[sailnumber, name, type]` tuples.

```json
[
  ["AUS/Sm35", "ARCHIE", "A-35"],
  ["AUS/52542", "BLACK DIAMOND", "Stallion 42"],
  ...
]
```

- Currently **34 AUS boats** (same as `orc-data.json`)
- Used by the site's search/autocomplete feature

### `data/<country>/<number>.json`

Full polar data for an individual boat. **Globally available, all years.**

URL pattern: `https://jieter.github.io/orc-data/site/data/{sailnumber}.json`  
where the `/` in the sail number is a directory separator.

**Example:** sail number `AUS/AUS10001` → URL `data/AUS/AUS10001.json`

Structure is identical to an entry in `orc-data.json`:

```json
{
  "sailnumber": "AUS/AUS10001",
  "country": "AUS",
  "name": "WILD OATS XI",
  "rating": { "gph": 321.8, ... },
  "boat": {
    "builder": "Mc Conaughy Boats",
    "type": "REICHEL/PUGH 30m",
    "designer": "REICHEL/PUGH",
    "year": 2015,
    "sizes": { "loa": 30.48, "draft": 5.89, ... }
  },
  "vpp": {
    "angles": [52, 60, 75, 90, 110, 120, 135, 150],
    "speeds": [6, 8, 10, 12, 14, 16, 20],
    "52": [10.24, 11.63, ...],
    ...
    "beat_angle": [45.6, 42.7, ...],
    "beat_vmg":   [6.53, 7.6, ...],
    "run_angle":  [132.5, 136.2, ...],
    "run_vmg":    [7.1, 8.81, ...]
  }
}
```

All speeds in the VPP are in **knots**. The sail number may vary in format (numeric, alphanumeric with prefix, etc.).

---

## VPP field semantics

| Field | Unit | Note |
|-------|------|------|
| `vpp.speeds` | knots TWS | Column headers |
| `vpp.angles` | degrees TWA | Row headers for speed table |
| `vpp[angle]` | knots BSP | Boat speed at that TWA/TWS combination |
| `beat_angle` | degrees TWA | One value per TWS column |
| `beat_vmg` | knots | **VMG** at beat angle — NOT boat speed |
| `run_angle` | degrees TWA | One value per TWS column |
| `run_vmg` | knots | **VMG** at run angle — NOT boat speed |

**Important:** `beat_vmg` and `run_vmg` are VMG values. The Jieter CSV format (used by `PolarTable.loadFromJieter`) stores **boat speed** in the beat/run rows, not VMG. Conversion required on import:

```
beat_bsp = beat_vmg / cos(beat_angle_rad)
run_bsp  = run_vmg  / abs(cos(run_angle_rad))
```

---

## Sail number formats observed

| Example | Pattern |
|---------|---------|
| `AUS/Sm35` | Country / prefix + number |
| `AUS/52542` | Country / number |
| `AUS/AUS10001` | Country / country + number |
| `ITA/ITA77774` | Country / country + number |
| `SUI/SUI001` | Country / country + number |
| `NED/NED2318` | Country / country + number |

The part before the first `/` is the country code. The site's `data/` URL uses the full sail number as a path, treating `/` as a directory separator.

---

## Current plugin usage

- **Search index**: `https://raw.githubusercontent.com/jieter/orc-data/master/orc-data.json`  
  → AUS only, ~34 boats
- **Import**: finds boat in the loaded `orcIndex`, extracts `boat.vpp`, converts to Jieter CSV

## Options for global coverage

1. **Direct fetch by sail number** — fetch `data/<sailnumber>.json` from the site when the boat is not in `orcIndex`. Requires the user to know the sail number (visible in the jieter site URL `#<sailnumber>`).
2. **Accept the limitation** — the AUS index is sufficient for Australian users; non-AUS boats can be uploaded as CSV.
