# TEMS TRP Decode and Pilot Pollution Automation Guide

This guide is based on the provided `DATA_Libre_Rab_kesh_aller.trp` file.

## Internal TRP paths

| Purpose | TRP internal path |
|---|---|
| Log metadata | `trp/content.xml` |
| GPS track | `trp/positions/wptrack.xml` |
| Metric declarations | `trp/providers/sp1/cdf/declarations.cdf` |
| Lookup tables | `trp/providers/sp1/cdf/lookuptables.cdf` |
| Timestamped metric values | `trp/providers/sp1/cdf/data.cdf` |
| Service provider metadata | `trp/providers/sp1/serviceprovider.xml` |
| Raw channel logs | `trp/providers/sp1/channels/ch*/channel.log` |

## CDF decoding

1. Open `.trp` as ZIP/OOXML.
2. Read the `.cdf` parts above.
3. Remove the first 8 bytes from each CDF file.
4. zlib-decompress the remaining bytes.
5. Parse the decompressed stream as length-delimited protobuf-like messages.

CDF structure observed:

```text
raw CDF file:
    byte[0:8]     CDF prefix/header
    byte[8:]      zlib stream

decompressed declarations.cdf:
    repeated declaration_message
    each declaration_message is varint_length + protobuf-like message

decompressed data.cdf:
    repeated data_message
    each data_message is varint_length + protobuf-like message
```

## Declaration message fields

Observed declaration fields:

| Field | Meaning |
|---:|---|
| 1 | Metric/event path string |
| 2 | Base metric ID |
| 3 | Title/name |
| 4 | Description |
| 6 | Nested/event-like descriptor in many event records |

Example:

```text
metric_id = 10537
path      = Radio.Lte.Neighbor[64].Rsrp
title     = LTE Neighbor RSRP
```

## Data message fields

Observed data message fields:

| Top-level field | Meaning |
|---:|---|
| 1 | Timestamp sub-message |
| 3 | Repeated metric value sub-message |

Timestamp sub-message:

| Field | Meaning |
|---:|---|
| 1 | Unix seconds |
| 2 | Nanoseconds |

Metric value sub-message:

| Field | Meaning |
|---:|---|
| 1 | Actual metric ID |
| 6 or 9 | Integer/enum value |
| 10 | 32-bit float value |
| 11 | 64-bit double value, if present |
| 12 | String or binary payload, often event/details payload |

## Array expansion and neighbor separation

Declaration paths contain array sizes, not neighbor names. For example:

```text
Radio.Lte.Neighbor[64].Rsrp, base_id = 10537
```

This means:

| Logical neighbor | Array index | Actual metric ID | Expanded path |
|---|---:|---:|---|
| N1 | 0 | 10537 | `Radio.Lte.Neighbor[0].Rsrp` |
| N2 | 1 | 10538 | `Radio.Lte.Neighbor[1].Rsrp` |
| N3 | 2 | 10539 | `Radio.Lte.Neighbor[2].Rsrp` |
| ... | ... | ... | ... |
| N64 | 63 | 10600 | `Radio.Lte.Neighbor[63].Rsrp` |

The same logic applies to neighbor PCI, EARFCN and RSRQ:

```text
N(i) RSRP  = base 10537 + i
N(i) RSRQ  = base 10473 + i
N(i) PCI   = base 10345 + i
N(i) EARFCN= base 11817 + i
```

Important: `Neighbor[0]` is not always the same physical cell across the whole drive. It is the first neighbor slot reported at that instant. To get engineering N1, N2, N3 for pilot pollution, sort neighbors by RSRP at each timestamp and call the strongest N1, second strongest N2, etc.

## Main pilot pollution paths

LTE serving:

```text
Radio.Lte.ServingCell[8].Rsrp
Radio.Lte.ServingCell[8].Rsrq
Radio.Lte.ServingCell[8].RsSinr
Radio.Lte.ServingCell[8].Pdsch.Sinr
Radio.Lte.ServingCell[8].Pci
Radio.Lte.ServingCell[8].Downlink.Earfcn
Radio.Lte.ServingCell[8].CellIdentity.Complete
```

LTE neighbors:

```text
Radio.Lte.Neighbor[64].Rsrp
Radio.Lte.Neighbor[64].Rsrq
Radio.Lte.Neighbor[64].Pci
Radio.Lte.Neighbor[64].Earfcn
```

MR-DC common cell list:

```text
Radio.Common.Mrdc.Cell[64].Rsrp
Radio.Common.Mrdc.Cell[64].Rsrq
Radio.Common.Mrdc.Cell[64].Sinr
Radio.Common.Mrdc.Cell[64].Pci
Radio.Common.Mrdc.Cell[64].Channel
Radio.Common.Mrdc.Cell[64].Technology
```

NR serving:

```text
Radio.Nr.ServingCell[16].SsRsrp
Radio.Nr.ServingCell[16].SsRsrq
Radio.Nr.ServingCell[16].SsSinr
Radio.Nr.ServingCell[16].Pci
Radio.Nr.ServingCell[16].Downlink.NrArfcn
```

NR strongest SSB beams:

```text
Radio.Nr.StrongestSsbBeam[20].Rsrp
Radio.Nr.StrongestSsbBeam[20].Rsrq
Radio.Nr.StrongestSsbBeam[20].Pci
Radio.Nr.StrongestSsbBeam[20].NrArfcn
Radio.Nr.StrongestSsbBeam[20].BeamIndex
```

Inter-system NR neighbors in NSA context:

```text
Radio.Intersystem.NrNeighbor[32].SsRsrp
Radio.Intersystem.NrNeighbor[32].SsRsrq
Radio.Intersystem.NrNeighbor[32].Pci
Radio.Intersystem.NrNeighbor[32].NrArfcn
```

Events:

```text
Radio.Common.ServingCellChangedEvent
Radio.Lte.HandoverStartEvent
Radio.Lte.HandoverDetailsEvent
Radio.Lte.IntraFrequencyHandoverEvent
Radio.Lte.InterFrequencyHandoverEvent
Radio.Lte.MeasurementReporting.A3Event
Radio.Lte.MeasurementReporting.A1Event
Radio.Lte.MeasurementReporting.A5Event
Radio.Lte.MeasurementReporting.B1Event
Radio.Nr.ScgFailureEvent
Radio.Nr.CellGroupAdditionEvent
Radio.Nr.CellGroupRemovalEvent
Radio.Nr.SecondaryCellAdditionEvent
Radio.Nr.SecondaryCellRemovalEvent
Radio.Nr.SecondaryCellReplacementEvent
Radio.Nr.Rrc.Measurement.A3Event
Radio.Nr.Rrc.Measurement.A2Event
Radio.Nr.Rrc.Measurement.A4Event
Radio.5G.ServiceLostEvent
Pocket.Radio.Nr.DataSessionDropEvent
Data.IpInterruptionTimeEvent
Radio.Common.Layer3MessageEvent
Message.3Gpp.Layer3Message
```

## LTE pollution rule

At every timestamp and EARFCN:

1. Collect serving and neighbor cells.
2. Keep same EARFCN only.
3. Sort by RSRP descending.
4. Define `best_rsrp = max(RSRP)`.
5. Strong cell if `RSRP >= -105 dBm` and `best_rsrp - RSRP <= 5 dB`.
6. Polluted LTE sample if `strong_cell_count >= 3` and quality is bad:

```text
Radio.Lte.ServingCell[8].RsSinr < 5 dB
OR Radio.Lte.ServingCell[8].Pdsch.Sinr < 5 dB
OR Radio.Lte.ServingCell[8].Rsrq <= -12 dB
```

## NR pollution rule

At every timestamp and NR-ARFCN:

1. Collect NR serving, strongest SSB beam and intersystem NR neighbor cells.
2. Sort by SS-RSRP descending.
3. Strong NR cell/beam if `SS-RSRP >= -108 dBm` and within 5 dB of best.
4. Polluted NR sample if `strong_count >= 3` and quality is bad:

```text
Radio.Nr.ServingCell[16].SsSinr < 5 dB
OR Radio.Nr.ServingCell[16].SsRsrq <= -12 dB
```
