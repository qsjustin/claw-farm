import { join } from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import type { MemoryProcessor } from "./interface.ts";

/**
 * Mem0+Qdrant processor: uses Mem0 for semantic memory with vector search.
 * Requires Qdrant and Mem0 sidecar containers.
 */
export const mem0Processor: MemoryProcessor = {
  name: "mem0",

  async init(projectDir: string) {
    const mem0Dir = join(projectDir, "mem0");
    await mkdir(mem0Dir, { recursive: true });
    await mkdir(join(projectDir, "processed"), { recursive: true });
    await mkdir(join(projectDir, "data", "qdrant"), { recursive: true });

    // Write Mem0 Dockerfile
    await Bun.write(
      join(mem0Dir, "Dockerfile"),
      `FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN useradd -r -s /bin/false appuser
USER appuser

COPY mem0_server.py .

EXPOSE 8050

CMD ["uvicorn", "mem0_server:app", "--host", "0.0.0.0", "--port", "8050"]
`,
    );

    // Write requirements.txt
    await Bun.write(
      join(mem0Dir, "requirements.txt"),
      `mem0ai==0.1.42
fastapi==0.115.12
uvicorn[standard]==0.34.2
google-genai==1.14.0
`,
    );

    // Write mem0_server.py
    await Bun.write(
      join(mem0Dir, "mem0_server.py"),
      `"""Mem0 API server — FastAPI wrapper around mem0ai with Qdrant + Gemini."""

import logging
import os
import secrets
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
MEM0_API_KEY = os.environ.get("MEM0_API_KEY", "")
QDRANT_HOST = os.environ.get("QDRANT_HOST", "qdrant")
QDRANT_PORT = int(os.environ.get("QDRANT_PORT", "6333"))

MEM0_CONFIG = {
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "host": QDRANT_HOST,
            "port": QDRANT_PORT,
            "collection_name": "memories",
        },
    },
    "embedder": {
        "provider": "google",
        "config": {
            "api_key": GEMINI_API_KEY,
            "model": "models/text-embedding-004",
        },
    },
    "llm": {
        "provider": "google",
        "config": {
            "api_key": GEMINI_API_KEY,
            "model": "gemini-2.5-flash",
        },
    },
}

memory = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global memory
    from mem0 import Memory
    memory = Memory.from_config(MEM0_CONFIG)
    yield


app = FastAPI(title="Mem0 API", lifespan=lifespan)


async def verify_api_key(request: Request):
    if not MEM0_API_KEY:
        return
    key = request.headers.get("X-API-Key", "")
    if not secrets.compare_digest(key, MEM0_API_KEY):
        raise HTTPException(status_code=401, detail="Invalid API key")


class MessageItem(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str = Field(max_length=10000)


class AddRequest(BaseModel):
    messages: list[MessageItem] = Field(max_length=50)
    user_id: str = Field(default="default", pattern=r"^[a-zA-Z0-9_-]+$", max_length=64)
    metadata: dict | None = None


class SearchRequest(BaseModel):
    query: str = Field(max_length=2000)
    user_id: str = Field(default="default", pattern=r"^[a-zA-Z0-9_-]+$", max_length=64)
    limit: int = Field(default=10, ge=1, le=100)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/memories/add", dependencies=[Depends(verify_api_key)])
async def add_memory(req: AddRequest):
    try:
        result = memory.add(
            messages=[m.model_dump() for m in req.messages],
            user_id=req.user_id,
            metadata=req.metadata,
        )
        return {"result": result}
    except Exception:
        logger.exception("Failed to add memory")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.post("/memories/search", dependencies=[Depends(verify_api_key)])
async def search_memories(req: SearchRequest):
    try:
        results = memory.search(query=req.query, user_id=req.user_id, limit=req.limit)
        return {"results": results}
    except Exception:
        logger.exception("Failed to search memories")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/memories/all", dependencies=[Depends(verify_api_key)])
async def get_all_memories(user_id: str = "default"):
    try:
        results = memory.get_all(user_id=user_id)
        return {"memories": results}
    except Exception:
        logger.exception("Failed to get all memories")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.delete("/memories/{memory_id}", dependencies=[Depends(verify_api_key)])
async def delete_memory(memory_id: str):
    try:
        memory.delete(memory_id=memory_id)
        return {"status": "deleted"}
    except Exception:
        logger.exception("Failed to delete memory")
        raise HTTPException(status_code=500, detail="Internal server error")
`,
    );

    // Write .env.example
    await Bun.write(
      join(projectDir, ".env.example"),
      `GEMINI_API_KEY=
# WARNING: Leave empty only for local development. Set a key for cloud deployments.
MEM0_API_KEY=
`,
    );
  },

  async rebuild(projectDir: string, runtimeType: "openclaw" | "picoclaw" = "openclaw") {
    console.log(
      "  Mem0 processor rebuild: re-indexing from raw sessions into Qdrant...",
    );
    console.log(
      "  Note: Ensure Qdrant and Mem0 containers are running (claw-farm up)",
    );

    const sessionsDir = runtimeType === "picoclaw"
      ? join(projectDir, "picoclaw", "workspace", "sessions")
      : join(projectDir, "openclaw", "sessions");

    try {
      const files = await readdir(sessionsDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
      if (jsonlFiles.length === 0) {
        console.log("  No session logs found — nothing to rebuild");
        return;
      }
      console.log(`  Found ${jsonlFiles.length} session log(s) to process`);
      // TODO: Parse JSONL and POST to Mem0 /memories/add
      console.log("  (Full re-indexing not yet implemented — raw data preserved)");
    } catch {
      console.log("  Sessions directory not found — nothing to rebuild");
    }
  },
};
