# NMF UMTS Drop-Call Analyzer

## Scope
This analyzer adds UMTS voice session analysis from Nemo text `.nmf` logs using:
- Call signaling: `CAA`, `CAC`, `CAD`, `CAF`, `CARE`
- Radio KPIs: `MIMOMEAS`, `TXPC`, `RLCBLER`

It is integrated as an additive output on `NMFParser.parse(...)`:
- `result.umtsCallAnalysis`

Existing parser outputs are preserved.

## Timestamp Normalization
- Base date is extracted from `#START` in `dd.mm.yyyy` format.
- Per-row time comes from column index `1`: `HH:MM:SS.mmm`.
- Midnight rollover rule:
  - when time-of-day moves backwards by more than 6 hours, day offset is incremented by +1.
- Absolute timestamps are built in UTC and exposed as ISO strings.

## Session Builder
Sessions are keyed by `callId` (column index `3`).

Event mapping:
- `CAA`: start attempt, capture `startTs`, dialed number from column `7`.
- `CAC`: connected when state at column `6` equals `3`.
- `CAD`: capture `cadStatus` (col `6`), `cadCause` (col `7`), and end candidate timestamp.
- `CAF`: capture `cafReason` (col `6`) and end candidate timestamp.
- `CARE`: preferred real end timestamp.

End timestamp priority:
- `CARE.ts` > `CAF.ts` > `CAD.ts`

Outcomes:
- `SUCCESS`: `cadStatus == 1 && cadCause == 16`
- `SETUP_FAILURE`: never connected and (`CAF` exists or `cadStatus == 2` or `cadCause == 102`)
- `DROP_CALL`: connected and (`CARE` exists or `cadStatus == 2` or `cadCause != 16`)

## Radio Snapshot (default 10s pre-end window)
For each failed/dropped call in `[endTs-10s, endTs]`:

`MIMOMEAS`
- Parses repeated post-column-7 blocks of 8 fields:
  - `[cellId, uarfcn, psc, branch, ?, rscp, ecno, rssi]`
- Edge-case support: if 8-field parse fails and 9-field blocks fit, parse 9 and ignore last field.
- Branches are averaged per `(timestamp, psc)`.
- Best server per timestamp = highest averaged RSCP.
- Snapshot KPIs from best-server sequence:
  - `rscp_median`, `rscp_min`, `rscp_last`
  - `ecno_median`, `ecno_min`, `ecno_last`
  - `last_psc`, `last_cellId`, `last_uarfcn`

`TXPC`
- UE Tx power from column `4`.
- Snapshot KPIs: `tx_p90`, `tx_max`, `tx_last`.

`RLCBLER`
- Extracts all numeric values in `[0, 100]` from columns `4..end`.
- Per row computes `blerMax` and `blerMean`.
- Snapshot KPIs:
  - `bler_max = max(row.blerMax)`
  - `bler_mean = mean(row.blerMean)`

## Rule Pack
Output fields for each analyzed call:
- `category`
- `confidence` (`0..1`)
- `reason`
- `snapshot`

Categories:
- Setup-failure:
  - `SETUP_TIMEOUT`
  - `SETUP_FAIL_UL_COVERAGE`
  - `SETUP_FAIL_DL_INTERFERENCE`
  - `SETUP_FAIL_UNKNOWN`
- Drop-call:
  - `DROP_INTERFERENCE`
  - `DROP_COVERAGE_UL`
  - `DROP_COVERAGE_DL`
  - `DROP_UNKNOWN`

Confidence heuristic:
- start at `0.50`
- `+0.30` when explicit cause strongly matches (e.g. `cause=102` timeout)
- `+0.20` when strong radio threshold match is present
- clamp to `[0,1]`

## Output Schema Example
```json
{
  "umtsCallAnalysis": {
    "summary": {
      "totalCaaSessions": 37,
      "outcomes": {
        "SUCCESS": 33,
        "SETUP_FAILURE": 3,
        "DROP_CALL": 1,
        "UNCLASSIFIED": 0
      }
    },
    "sessions": [
      {
        "callId": "62",
        "startTsIso": "2025-12-24T00:19:30.000Z",
        "connectedTsIso": "2025-12-24T00:19:35.000Z",
        "endTsRealIso": "2025-12-24T00:20:19.599Z",
        "outcome": "DROP_CALL",
        "category": "DROP_INTERFERENCE",
        "confidence": 0.7,
        "reason": "DROP_INTERFERENCE: RSCP median -55.0 dBm (strong) with Ec/No median -25.0 dB and BLER max 100.0%.",
        "snapshot": {
          "rscp_median": -55.0,
          "ecno_median": -25.0,
          "bler_max": 100.0,
          "tx_p90": 12.0,
          "last_psc": 153
        }
      }
    ]
  }
}
```
