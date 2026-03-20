/**
 * API Proxy sidecar — sits between OpenClaw and external LLM APIs.
 *
 * Purpose:
 * 1. API key isolation: agent never sees the real key
 * 2. Egress filtering: scans & REDACTS PII in outbound prompts
 * 3. Response scanning: strips secrets from LLM responses before they reach the agent
 * 4. Request logging: audit trail of all LLM calls
 *
 * OpenClaw talks to http://api-proxy:8080, proxy injects real API key
 * and forwards to the actual LLM endpoint.
 */

export function apiProxyServerTemplate(): string {
  return `"""
API Proxy — key injection + PII redaction + response secret scanning.
Sits between OpenClaw and external LLM APIs.

Egress (outbound):  PII detected → auto-redacted before sending to LLM
Ingress (response): Secrets detected → stripped before returning to agent

OpenClaw → http://api-proxy:8080/v1beta/... → (redact + key inject) → Gemini API
                                             ← (secret scan) ←
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
UPSTREAM_BASE = os.environ.get("UPSTREAM_BASE", "https://generativelanguage.googleapis.com")
AUDIT_LOG_PATH = os.environ.get("AUDIT_LOG_PATH", "/logs/api-proxy-audit.jsonl")
MAX_PROMPT_SIZE_MB = int(os.environ.get("MAX_PROMPT_SIZE_MB", "5"))

# PII_MODE: "redact" (default) | "block" | "warn"
PII_MODE = os.environ.get("PII_MODE", "redact")

# --- PII Patterns (outbound — redact user data before it reaches the LLM) ---
PII_PATTERNS = [
    # Korean
    (r"\\d{6}-[1-4]\\d{6}", "KR_RRN"),                         # 주민등록번호
    (r"01[016789]-\\d{3,4}-\\d{4}", "KR_PHONE"),                # 한국 휴대폰
    (r"0[2-6][0-9]-\\d{3,4}-\\d{4}", "KR_LANDLINE"),            # 한국 유선전화

    # Financial
    (r"\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\\b", "CREDIT_CARD"),
    (r"\\b\\d{3,4}-\\d{4}-\\d{4}-\\d{4}\\b", "CARD_FORMATTED"),  # 카드번호 (포맷)

    # US
    (r"\\b\\d{3}-\\d{2}-\\d{4}\\b", "US_SSN"),
    (r"\\b\\d{3}[-.\\s]\\d{3}[-.\\s]\\d{4}\\b", "US_PHONE"),

    # Universal
    (r"\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b", "EMAIL"),
]

COMPILED_PII = [(re.compile(p), label) for p, label in PII_PATTERNS]

# --- Secret Patterns (response — strip secrets before they reach the agent) ---
SECRET_PATTERNS = [
    # API Keys
    (r"AIza[0-9A-Za-z_-]{35}", "GOOGLE_API_KEY"),
    (r"sk-[A-Za-z0-9]{20,}", "OPENAI_KEY"),
    (r"sk-ant-[A-Za-z0-9-]{80,}", "ANTHROPIC_KEY"),
    (r"\\bghp_[A-Za-z0-9]{36}\\b", "GITHUB_PAT"),
    (r"\\bgho_[A-Za-z0-9]{36}\\b", "GITHUB_OAUTH"),
    (r"\\bghs_[A-Za-z0-9]{36}\\b", "GITHUB_APP"),
    (r"\\bglpat-[A-Za-z0-9_-]{20,}\\b", "GITLAB_PAT"),

    # AWS
    (r"AKIA[0-9A-Z]{16}", "AWS_ACCESS_KEY"),
    (r"(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)[\\s=:]+[A-Za-z0-9/+=]{40}", "AWS_SECRET_KEY"),

    # Stripe
    (r"\\b[rs]k_live_[A-Za-z0-9]{24,}\\b", "STRIPE_KEY"),
    (r"\\b[rs]k_test_[A-Za-z0-9]{24,}\\b", "STRIPE_TEST_KEY"),

    # JWT / Bearer
    (r"eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}", "JWT"),

    # Private keys
    (r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----", "PRIVATE_KEY"),

    # Generic long hex/base64 that look like secrets
    (r"(?:token|secret|password|apikey|api_key)\\s*[=:]\\s*['\\"\\x60]?([A-Za-z0-9+/=_-]{32,})['\\"\\x60]?", "GENERIC_SECRET"),
]

COMPILED_SECRETS = [(re.compile(p, re.IGNORECASE), label) for p, label in SECRET_PATTERNS]


def redact_pii(text: str) -> tuple[str, list[dict]]:
    """Scan text for PII and replace with [REDACTED_TYPE]. Returns (redacted_text, findings)."""
    findings = []
    redacted = text
    for pattern, label in COMPILED_PII:
        matches = pattern.findall(redacted)
        if matches:
            findings.append({"type": label, "count": len(matches)})
            redacted = pattern.sub(f"[REDACTED_{label}]", redacted)
    return redacted, findings


def scan_secrets(text: str) -> tuple[str, list[dict]]:
    """Scan text for secrets and replace with [REDACTED_SECRET]. Returns (cleaned_text, findings)."""
    findings = []
    cleaned = text
    for pattern, label in COMPILED_SECRETS:
        matches = pattern.findall(cleaned)
        if matches:
            findings.append({"type": label, "count": len(matches) if isinstance(matches[0], str) else len(matches)})
            cleaned = pattern.sub(f"[REDACTED_{label}]", cleaned)
    return cleaned, findings


def redact_request_body(body: bytes) -> tuple[bytes, list[dict]]:
    """Parse JSON body, redact PII from all text fields, return modified body."""
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return body, []

    all_findings = []

    def walk_and_redact(obj):
        if isinstance(obj, str):
            redacted, findings = redact_pii(obj)
            all_findings.extend(findings)
            return redacted
        elif isinstance(obj, dict):
            return {k: walk_and_redact(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [walk_and_redact(item) for item in obj]
        return obj

    redacted_data = walk_and_redact(data)

    if all_findings:
        return json.dumps(redacted_data).encode(), all_findings
    return body, []


def scan_response_body(body: bytes) -> tuple[bytes, list[dict]]:
    """Parse JSON response, strip secrets from all text fields, return cleaned body."""
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return body, []

    all_findings = []

    def walk_and_clean(obj):
        if isinstance(obj, str):
            cleaned, findings = scan_secrets(obj)
            # Also check for PII in responses (agent might echo back user data)
            cleaned2, pii_findings = redact_pii(cleaned)
            all_findings.extend(findings)
            all_findings.extend(pii_findings)
            return cleaned2
        elif isinstance(obj, dict):
            return {k: walk_and_clean(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [walk_and_clean(item) for item in obj]
        return obj

    cleaned_data = walk_and_clean(data)

    if all_findings:
        return json.dumps(cleaned_data).encode(), all_findings
    return body, []


def check_content_size(body: bytes) -> bool:
    """Reject requests larger than MAX_PROMPT_SIZE_MB."""
    return len(body) <= MAX_PROMPT_SIZE_MB * 1024 * 1024


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
    return {"status": "ok", "upstream": UPSTREAM_BASE, "pii_mode": PII_MODE}


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

    # --- Guard 2: PII redaction on outbound request ---
    pii_findings = []
    if PII_MODE == "redact":
        body, pii_findings = redact_request_body(body)
        if pii_findings:
            audit_log({
                "event": "pii_redacted",
                "findings": pii_findings,
                "path": path,
                "action": "redacted",
            })
            logger.warning(f"PII redacted in request to {path}: {pii_findings}")
    elif PII_MODE == "block":
        # Check without redacting
        try:
            text = json.dumps(json.loads(body)) if body else ""
        except Exception:
            text = ""
        _, pii_findings = redact_pii(text)
        if pii_findings:
            audit_log({
                "event": "pii_blocked",
                "findings": pii_findings,
                "path": path,
                "action": "blocked",
            })
            return Response(
                content=json.dumps({"error": "Request blocked: PII detected", "types": [f["type"] for f in pii_findings]}),
                status_code=422,
                media_type="application/json",
            )
    elif PII_MODE == "warn":
        try:
            text = json.dumps(json.loads(body)) if body else ""
        except Exception:
            text = ""
        _, pii_findings = redact_pii(text)
        if pii_findings:
            audit_log({
                "event": "pii_detected",
                "findings": pii_findings,
                "path": path,
                "action": "warn",
            })
            logger.warning(f"PII detected (warn mode) in request to {path}: {pii_findings}")

    # --- Guard 3: Content hash for audit trail ---
    content_hash = hashlib.sha256(body).hexdigest()[:16] if body else "empty"

    # --- Forward with key injection ---
    upstream_url = f"{UPSTREAM_BASE}/{path}"

    # Inject API key as query param (Gemini style)
    separator = "&" if "?" in upstream_url else "?"
    upstream_url = f"{upstream_url}{separator}key={GEMINI_API_KEY}"

    # Forward headers (minus hop-by-hop)
    headers = dict(request.headers)
    for h in ("host", "content-length", "transfer-encoding"):
        headers.pop(h, None)

    start = time.monotonic()

    async with httpx.AsyncClient(timeout=120.0) as client:
        upstream_resp = await client.request(
            method=request.method,
            url=upstream_url,
            content=body,
            headers=headers,
        )

    elapsed_ms = int((time.monotonic() - start) * 1000)

    # --- Guard 4: Secret scanning on LLM response ---
    response_body = upstream_resp.content
    secret_findings = []

    if upstream_resp.status_code == 200:
        response_body, secret_findings = scan_response_body(response_body)
        if secret_findings:
            audit_log({
                "event": "secrets_redacted_response",
                "findings": secret_findings,
                "path": path,
            })
            logger.warning(f"Secrets stripped from LLM response: {secret_findings}")

    # --- Audit log ---
    audit_log({
        "event": "request",
        "method": request.method,
        "path": path,
        "content_hash": content_hash,
        "request_size": len(body),
        "response_status": upstream_resp.status_code,
        "response_size": len(response_body),
        "elapsed_ms": elapsed_ms,
        "pii_redacted": bool(pii_findings),
        "secrets_stripped": bool(secret_findings),
    })

    # Forward response headers (skip hop-by-hop)
    resp_headers = {}
    for k, v in upstream_resp.headers.items():
        if k.lower() not in ("transfer-encoding", "content-encoding", "content-length"):
            resp_headers[k] = v

    return Response(
        content=response_body,
        status_code=upstream_resp.status_code,
        headers=resp_headers,
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
