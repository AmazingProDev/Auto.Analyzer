# Codex execution plan — Memory-bounded benchmark pipeline (large-file scaling)

Problem: the Nemo benchmark loads **all rows of all operators into memory** as expanded dicts and
keeps them resident, pickles them into SQLite, and deep-copies row subsets per DT. This is fine for
~10k-row files (Mohammedia, ~3.5 MB) but **exhausts RAM** on real drives (Kenitra: 621k–651k rows,
187–217 MB each × 3 → >10 GB → swap-death → "import takes forever").

Goal: make peak memory bounded by *what the analysis needs* (transfer-session windows + a downsample),
not by total file size. Target: a 3×200 MB import completes in minutes with <~2–3 GB peak.

Read `CLAUDE.md` + `AGENTS.md` first. Line numbers approximate — `grep` for anchors. This is a
parser/pipeline change → **bump `_BENCHMARK_NEMO_PARSER_VERSION`** (and analysis version). Validate
that Mohammedia results are byte-for-byte unchanged (no regression) at every step.

## Hotspots (verified)
- `_nemo_parse_operator_file_uncached` (~L3566) builds a full dict per row for ALL rows.
- `_nemo_read_tabular_file` (~L2714) does `f.read()` of the whole file into a string, then
  `list(csv.reader(StringIO(...)))` — two full in-memory copies.
- `BENCHMARK_NEMO_DATASET["operator_files"] = operator_files` (~L10672) keeps every row resident
  in the global, indefinitely, for per-DT re-analysis.
- `_benchmark_nemo_pack_blob(operator_files)` (~L854/881) pickles+zlib-compresses ALL rows to SQLite
  on every load (huge + slow).
- `_nemo_clone_operator_file_for_dt_index_with_window` (~L10498) deep-copies row subsets per DT.

Implement in this order (each independently shippable; stop and verify Mohammedia parity after each).

---

## STEP 1 — Stream the file read (quick win, low risk)
In `_nemo_read_tabular_file`, replace `text = f.read()` + `StringIO` + `list(csv.reader(...))` with a
streaming `csv.reader(f)` over the open file handle (detect delimiter from a small `f.readline()`
sniff, then `f.seek(0)`). Return an iterator/generator of rows where callers allow, or at minimum
avoid the duplicate full-string copy. Saves ~one full-file copy (200 MB+) per file.

**Verify:** Mohammedia parse output identical; peak RSS for a single Kenitra file drops.

---

## STEP 2 — Don't keep raw rows resident, and don't pickle them
The cross-operator comparison only needs **compact summaries**, not 1.9M raw rows.

1. After `_benchmark_nemo_build_dataset` extracts everything it needs (timeline points, DL/UL/ping
   KPIs, RF, tech presence, serving cells, layer analysis), **drop `operator_file["rows"]`** from
   what's stored in `BENCHMARK_NEMO_DATASET["operator_files"]` — keep only the small derived fields
   needed for per-DT re-analysis (see Step 4), or a compact per-DT row index.
2. In `_benchmark_nemo_library_store_dataset` (~L854), **stop blobbing raw rows**: persist only the
   built `dataset` (compact). Gate the `operator_files` blob behind a size cap (e.g. skip when total
   rows > 50k); on cache load, if rows are absent, re-derive on demand instead of trusting the blob.

**Verify:** load still works from a cold cache; SQLite file size for Kenitra is small (MB not GB);
resident RSS after load is a fraction of before.

---

## STEP 3 — Two-pass parse (the big memory win)
Most rows are outside any transfer session and only feed route-wide presence stats.

1. **Pass 1 (cheap scan):** read only Time + Event-ID + transfer-direction/protocol/bytes/download-time
   columns to locate the ping/upload/download **session windows** (reuse `_nemo_extract_dl_events`
   logic on a lightweight row view). Keep just timestamps + a handful of scalars per row — not the
   full dict.
2. **Pass 2 (targeted full parse):** fully expand to row dicts ONLY for rows whose `_dt` falls inside
   (or within a small margin of) a session window, **plus** a uniform **downsample** (e.g. 1 row/sec
   or every Nth row) across the whole drive for route-wide technology-presence / coverage stats.
3. Everything downstream (timeline, RF, KPIs) already operates on the in-window rows, so it is
   unaffected; only the route-wide presence stats switch to the downsampled set (document the change;
   keep it accurate to ±1%).

**Verify:** Mohammedia KPIs unchanged within rounding; Kenitra parses with <~2 GB peak and in a small
fraction of the current time; `technologyStatus` presence percentages match full-parse within ±1%.

---

## STEP 4 — Per-DT analysis without full clones
Replace `_nemo_clone_operator_file_for_dt_index_with_window` deep copies with **time-window slices by
index**: parse once, build a per-DT `(start,end)` index, and have per-DT analysis read the relevant
slice (or precompute per-DT summaries in the single Step-3 pass). No N× row duplication.

**Verify:** per-DT view matches the pre-refactor per-DT output on Mohammedia.

---

## STEP 5 — Guardrails & UX
- Stream the upload to disk (the handler already saves files) and run the parse in a background
  thread with a **progress/status** the UI can poll (`/api/benchmark-nemo/status`), so a big import
  shows progress instead of appearing hung.
- If total input > a threshold (e.g. >150 MB or >300k rows), show a one-line UI notice
  ("Large drive — analysis may take a few minutes; using windowed parse").

## Versions & cache
- Parser-stage change → bump `_BENCHMARK_NEMO_PARSER_VERSION` (current 7) and
  `_BENCHMARK_NEMO_ANALYSIS_VERSION` (current 51). Clear SQLite + restart (`./reset-benchmark.sh`).
- No frontend logic change except the Step-5 progress/notice (bump `app.js?v=` if touched).

## Verification checklist
1. Mohammedia: full benchmark output unchanged (diff KPIs before/after each step).
2. Kenitra (smaller set, ~45–68 MB ×3): import completes < ~3 min, peak RSS < ~3 GB.
3. Kenitra (full set, 187–217 MB ×3): import completes without swap-death.
4. `python3 -m pytest tests/ -q` benchmark tests green; JS tests green.
5. SQLite cache size reasonable (MB); reload from warm cache fast.

## Do not change
- KPI definitions / decision logic (validity + macro). This is purely about *how much* is held in
  memory and *when* rows are released — results must be identical (presence stats within ±1%).
