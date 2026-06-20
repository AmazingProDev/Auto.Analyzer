from __future__ import annotations

import os
from dataclasses import dataclass


def _to_bool(value, default=False) -> bool:
    if value is None:
        return bool(default)
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return bool(default)


def _to_int(value, default: int, minimum: int | None = None, maximum: int | None = None) -> int:
    try:
        parsed = int(str(value).strip())
    except Exception:
        parsed = default
    if minimum is not None:
        parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def normalize_base_url(raw: str | None) -> str:
    value = str(raw or "").strip()
    if not value:
        return "http://localhost:11434/v1"
    value = value.rstrip("/")
    if not value.endswith("/v1"):
        value = value + "/v1"
    return value


@dataclass(frozen=True)
class LocalAIConfig:
    backend: str  # "ollama" | "lmstudio"
    base_url: str
    model: str
    timeout_sec: int
    max_retries: int
    max_upload_bytes: int
    upload_dir: str
    keep_uploads: bool
    chunk_target_lines: int
    chunk_overlap_lines: int
    max_identifiers_per_type: int

    @property
    def is_ollama(self) -> bool:
        return self.backend == "ollama"

    @property
    def models_url(self) -> str:
        return f"{self.base_url}/models"

    @property
    def chat_completions_url(self) -> str:
        return f"{self.base_url}/chat/completions"

    @property
    def ollama_chat_url(self) -> str:
        """Native Ollama /api/chat endpoint — properly supports think:false for qwen3."""
        base = self.base_url.removesuffix("/v1").rstrip("/")
        return f"{base}/api/chat"


def load_local_ai_config(upload_root: str | None = None) -> LocalAIConfig:
    backend = str(os.environ.get("OPTIM_AI_BACKEND") or "ollama").strip().lower()
    if backend not in {"ollama", "lmstudio"}:
        backend = "ollama"

    if backend == "ollama":
        default_url = "http://localhost:11434/v1"
        default_model = "qwen3:8b"
    else:
        default_url = "http://localhost:1234/v1"
        default_model = "gemma-4-e4b-it"

    raw_url = (
        os.environ.get("OPTIM_AI_BASE_URL")
        or os.environ.get("OPTIM_LM_STUDIO_BASE_URL")
        or os.environ.get("OPTIM_LM_STUDIO_URL")
        or default_url
    )
    base_url = normalize_base_url(raw_url)

    model = str(
        os.environ.get("OPTIM_AI_MODEL")
        or os.environ.get("OPTIM_LM_STUDIO_MODEL")
        or default_model
    ).strip() or default_model

    upload_base = str(
        os.environ.get("OPTIM_LOCAL_AI_UPLOAD_DIR")
        or os.path.join(upload_root or "/tmp/optim_uploads", "local_ai_uploads")
    )
    max_upload_mb = _to_int(os.environ.get("OPTIM_LOCAL_AI_MAX_UPLOAD_MB"), 25, minimum=1, maximum=250)

    return LocalAIConfig(
        backend=backend,
        base_url=base_url,
        model=model,
        timeout_sec=_to_int(os.environ.get("OPTIM_LOCAL_AI_TIMEOUT_SEC"), 120, minimum=10, maximum=900),
        max_retries=_to_int(os.environ.get("OPTIM_LOCAL_AI_MAX_RETRIES"), 2, minimum=0, maximum=5),
        max_upload_bytes=max_upload_mb * 1024 * 1024,
        upload_dir=upload_base,
        keep_uploads=_to_bool(os.environ.get("OPTIM_LOCAL_AI_KEEP_UPLOADS"), default=False),
        chunk_target_lines=_to_int(os.environ.get("OPTIM_LOCAL_AI_CHUNK_LINES"), 160, minimum=40, maximum=1000),
        chunk_overlap_lines=_to_int(os.environ.get("OPTIM_LOCAL_AI_CHUNK_OVERLAP"), 30, minimum=0, maximum=300),
        max_identifiers_per_type=_to_int(os.environ.get("OPTIM_LOCAL_AI_MAX_IDENTIFIER_VALUES"), 12, minimum=1, maximum=50),
    )
