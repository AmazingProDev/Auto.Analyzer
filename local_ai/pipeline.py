from __future__ import annotations

import os
import tempfile
import time

from .aggregation import aggregate_chunk_analyses
from .config import LocalAIConfig
from .lmstudio_client import LMStudioClient, LMStudioClientError, LMStudioModelUnavailableError
from .preprocessing import preprocess_log_text


ALLOWED_TEXT_EXTENSIONS = {".txt", ".log", ".nmf", ".csv"}


class LocalAIUploadError(ValueError):
    pass


def _decode_text(data: bytes) -> tuple[str, str]:
    for encoding in ("utf-8-sig", "utf-16", "latin1"):
        try:
            return data.decode(encoding), encoding
        except Exception:
            continue
    raise LocalAIUploadError("Unable to decode uploaded file as plain text.")


def _validate_upload(filename: str, data: bytes, config: LocalAIConfig):
    safe_name = os.path.basename(str(filename or "upload.txt"))
    extension = os.path.splitext(safe_name)[1].lower()
    if extension not in ALLOWED_TEXT_EXTENSIONS:
        raise LocalAIUploadError(
            f"Unsupported file type '{extension or 'unknown'}'. Allowed text formats: {', '.join(sorted(ALLOWED_TEXT_EXTENSIONS))}."
        )
    size_bytes = len(data or b"")
    if size_bytes <= 0:
        raise LocalAIUploadError("Uploaded file is empty.")
    if size_bytes > config.max_upload_bytes:
        raise LocalAIUploadError(
            f"Uploaded file is too large ({round(size_bytes / (1024 * 1024), 2)} MB). "
            f"Max allowed is {round(config.max_upload_bytes / (1024 * 1024), 2)} MB."
        )
    return safe_name, extension, size_bytes


def analyze_uploaded_log(
    *,
    filename: str,
    data: bytes,
    config: LocalAIConfig,
    request_id: str,
    logger=None,
) -> dict:
    logger = logger or (lambda *_args, **_kwargs: None)
    safe_name, extension, size_bytes = _validate_upload(filename, data, config)
    text, encoding = _decode_text(data)
    os.makedirs(config.upload_dir, exist_ok=True)
    temp_path = None
    started = time.perf_counter()
    try:
        with tempfile.NamedTemporaryFile(prefix="optim_local_ai_", suffix=extension, dir=config.upload_dir, delete=False) as handle:
            handle.write(data)
            temp_path = handle.name
        logger("stored_local_ai_upload", request_id=request_id, file_name=safe_name, size_bytes=size_bytes, temp_path=temp_path)

        preprocessing = preprocess_log_text(
            text,
            chunk_target_lines=config.chunk_target_lines,
            overlap_lines=config.chunk_overlap_lines,
            max_identifier_values=config.max_identifiers_per_type,
        )
        if not preprocessing.get("chunks"):
            raise LocalAIUploadError("The uploaded file did not contain any non-empty text lines to analyze.")

        client = LMStudioClient(config, logger=logger)
        model_status = client.model_check()
        if not model_status.get("ok"):
            raise LMStudioModelUnavailableError(model_status.get("message") or "Configured model is unavailable.")
        chunk_results = []
        logger(
            "local_ai_preprocessed",
            request_id=request_id,
            chunk_count=len(preprocessing.get("chunks") or []),
            line_count=preprocessing.get("lineCount"),
            strategy=preprocessing.get("segmentationStrategy"),
            detected_rat=preprocessing.get("detectedRat"),
        )
        for chunk in preprocessing.get("chunks") or []:
            chunk_started = time.perf_counter()
            try:
                result = client.analyze_chunk(chunk, request_id=request_id)
                chunk_results.append(
                    {
                        "chunk": chunk,
                        "analysis": result.get("analysis"),
                        "jsonRecovered": bool(result.get("jsonRecovered")),
                        "latencyMs": result.get("latencyMs"),
                        "radio_series": result.get("radio_series"),
                        "neighbor_series": result.get("neighbor_series"),
                        "signal_series": result.get("signal_series"),
                    }
                )
                logger(
                    "local_ai_chunk_success",
                    request_id=request_id,
                    chunk_id=chunk.get("id"),
                    latency_ms=round((time.perf_counter() - chunk_started) * 1000, 1),
                )
            except (LMStudioClientError, LMStudioModelUnavailableError) as exc:
                chunk_results.append(
                    {
                        "chunk": chunk,
                        "analysis": None,
                        "error": str(exc),
                        "latencyMs": round((time.perf_counter() - chunk_started) * 1000, 1),
                    }
                )
                logger(
                    "local_ai_chunk_failure",
                    request_id=request_id,
                    chunk_id=chunk.get("id"),
                    latency_ms=round((time.perf_counter() - chunk_started) * 1000, 1),
                    error=str(exc),
                )

        total_duration_ms = (time.perf_counter() - started) * 1000
        report = aggregate_chunk_analyses(preprocessing, chunk_results, total_duration_ms)
        status = "success"
        if report["stats"]["analyzed_chunks"] <= 0:
            status = "error"
        elif report["stats"]["failed_chunks"] > 0:
            status = "partial_success"

        return {
            "status": status,
            "requestId": request_id,
            "file": {
                "name": safe_name,
                "sizeBytes": size_bytes,
                "encoding": encoding,
                "temporaryPath": temp_path if config.keep_uploads else None,
            },
            "preprocessing": {
                "lineCount": preprocessing.get("lineCount"),
                "segmentationStrategy": preprocessing.get("segmentationStrategy"),
                "detectedRat": preprocessing.get("detectedRat"),
                "identifiersFound": preprocessing.get("identifiersFound"),
                "chunkCount": len(preprocessing.get("chunks") or []),
            },
            "report": report,
        }
    finally:
        if temp_path and not config.keep_uploads:
            try:
                os.remove(temp_path)
            except FileNotFoundError:
                pass
