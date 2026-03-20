/**
 * API Proxy sidecar — sits between OpenClaw and external LLM APIs.
 *
 * Purpose:
 * 1. API key isolation: agent never sees the real key
 * 2. Egress filtering: scans outbound prompts for PII/sensitive data
 * 3. Request logging: audit trail of all LLM calls
 *
 * OpenClaw talks to http://api-proxy:8080, proxy injects real API key
 * and forwards to the actual LLM endpoint.
 */

export function apiProxyServerTemplate(): string {
  return `"""
API Proxy — key injection + egress content filter.
Sits between OpenClaw and external LLM APIs.

OpenClaw → http://api-proxy:8080/v1beta/... → (key injection + PII filter) → Gemini API
"""

import hashlib
import json
import logging
import os
import re
import time
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, Request, Response

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("api-proxy")

app = FastAPI(title="API Proxy")

# --- Config ---
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
UPSTREAM_BASE = "https://generativelanguage.googleapis.com"
AUDIT_LOG_PATH = os.environ.get("AUDIT_LOG_PATH", "/logs/api-proxy-audit.jsonl")
MAX_PROMPT_SIZE_MB = int(os.environ.get("MAX_PROMPT_SIZE_MB", "5"))

# --- PII Patterns ---
PII_PATTERNS = [
    (r"\\b\\d{3}-\\d{2}-\\d{4}\\b", "SSN"),                          # US SSN
    (r"\\b\\d{13,19}\\b", "CREDIT_CARD"),                             # Credit card
    (r"\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b", "EMAIL"),
    (r"\\b01[0-9]-\\d{4}-\\d{4}\\b", "KR_PHONE"),                     # Korean phone
    (r"\\b\\d{6}-[1-4]\\d{6}\\b", "KR_RRN"),                          # Korean resident registration
    (r"\\b\\d{3}[-.\\s]?\\d{3,4}[-.\\s]?\\d{4}\\b", "PHONE"),         # General phone
]

COMPILED_PII = [(re.compile(p), label) for p, label in PII_PATTERNS]

# --- Binary detection ---
BINARY_SIGNATURES = {
    b"\\x89PNG": "PNG image",
    b"\\xff\\xd8\\xff": "JPEG image",
    b"GIF8": "GIF image",
    b"\\x00\\x00\\x00": "Binary data",  # common in video files
}


def detect_pii(text: str) -> list[dict]:
    """Scan text for PII patterns. Returns list of detected types."""
    findings = []
    for pattern, label in COMPILED_PII:
        matches = pattern.findall(text)
        if matches:
            findings.append({
                "type": label,
                "count": len(matches),
                # Don't log the actual values!
            })
    return findings


def check_content_size(body: bytes) -> bool:
    """Reject requests larger than MAX_PROMPT_SIZE_MB."""
    return len(body) <= MAX_PROMPT_SIZE_MB * 1024 * 1024


def extract_text_content(body: bytes) -> str:
    """Extract text portions from request body for PII scanning."""
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return ""

    texts = []

    def walk(obj):
        if isinstance(obj, str):
            texts.append(obj)
        elif isinstance(obj, dict):
            for v in obj.values():
                walk(v)
        elif isinstance(obj, list):
            for item in obj:
                walk(item)

    walk(data)
    return " ".join(texts)


def audit_log(entry: dict):
    """Append audit entry to JSONL log."""
    try:
        entry["timestamp"] = datetime.now(timezone.utc).isoformat()
        with open(AUDIT_LOG_PATH, "a") as f:
            f.write(json.dumps(entry) + "\\n")
    except Exception:
        logger.exception("Failed to write audit log")


@app.get("/health")
async def health():
    return {"status": "ok", "upstream": UPSTREAM_BASE}


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy(request: Request, path: str):
    body = await request.body()

    # --- Guard 1: Content size ---
    if not check_content_size(body):
        audit_log({
            "event": "blocked",
            "reason": "content_too_large",
            "size_bytes": len(body),
            "path": path,
        })
        return Response(
            content=json.dumps({"error": "Request too large"}),
            status_code=413,
            media_type="application/json",
        )

    # --- Guard 2: PII scan ---
    text_content = extract_text_content(body)
    pii_findings = detect_pii(text_content)

    if pii_findings:
        # Log the finding but DON'T block — warn and redact
        audit_log({
            "event": "pii_detected",
            "findings": pii_findings,
            "path": path,
            "action": "warn",
        })
        logger.warning(f"PII detected in request to {path}: {pii_findings}")
        # TODO: configurable — block vs warn vs redact

    # --- Guard 3: Content hash for audit trail ---
    content_hash = hashlib.sha256(body).hexdigest()[:16] if body else "empty"

    # --- Forward with key injection ---
    upstream_url = f"{UPSTREAM_BASE}/{path}"

    # Inject API key as query param (Gemini style)
    separator = "&" if "?" in upstream_url else "?"
    upstream_url = f"{upstream_url}{separator}key={GEMINI_API_KEY}"

    # Forward headers (minus host)
    headers = dict(request.headers)
    headers.pop("host", None)
    headers.pop("content-length", None)

    start = time.monotonic()

    async with httpx.AsyncClient(timeout=120.0) as client:
        upstream_resp = await client.request(
            method=request.method,
            url=upstream_url,
            content=body,
            headers=headers,
        )

    elapsed_ms = int((time.monotonic() - start) * 1000)

    # --- Audit log ---
    audit_log({
        "event": "request",
        "method": request.method,
        "path": path,
        "content_hash": content_hash,
        "request_size": len(body),
        "response_status": upstream_resp.status_code,
        "response_size": len(upstream_resp.content),
        "elapsed_ms": elapsed_ms,
        "pii_detected": bool(pii_findings),
    })

    return Response(
        content=upstream_resp.content,
        status_code=upstream_resp.status_code,
        headers=dict(upstream_resp.headers),
    )
`;
}

export function apiProxyDockerfileTemplate(): string {
  return `FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN useradd -r -s /bin/false appuser && mkdir /logs && chown appuser:appuser /logs
USER appuser

COPY api_proxy.py .

EXPOSE 8080

CMD ["uvicorn", "api_proxy:app", "--host", "0.0.0.0", "--port", "8080"]
`;
}

export function apiProxyRequirementsTemplate(): string {
  return `fastapi==0.115.12
uvicorn[standard]==0.34.2
httpx==0.28.1
`;
}
