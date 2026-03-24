# claw-farm Architecture

> **이 문서는 프로젝트의 아키텍처 소스 오브 트루스(source of truth)입니다.**
> 구조가 변경되면 반드시 이 문서를 먼저 업데이트하세요.
> CLAUDE.md와 README.md는 이 문서를 참조합니다.

## 1. CLI가 하는 일

```
┌─────────────────────────────────────────────────────────────────┐
│                        개발자                                    │
│                                                                 │
│  $ claw-farm init dog-agent --processor mem0                    │
│  $ claw-farm init tamagochi                                     │
│  $ claw-farm init tutor-bot --processor mem0                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     claw-farm CLI                                │
│                   (Bun 스크립트, zero deps)                      │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │   init   │ │  up/down │ │   list   │ │ memory:rebuild   │   │
│  │          │ │          │ │          │ │                   │   │
│  │ 파일 생성 │ │ docker   │ │ 상태표   │ │ raw→processed    │   │
│  │ 등록     │ │ compose  │ │ 출력     │ │ 재구축           │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │  spawn   │ │ despawn  │ │instances │ │ cloud:compose    │   │
│  │          │ │          │ │          │ │                   │   │
│  │ 인스턴스  │ │ 정지 +   │ │ 프로젝트별│ │ 전체 합쳐서      │   │
│  │ 생성     │ │ 제거     │ │ 목록     │ │ 단일 compose     │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
│                                                                 │
│  ┌──────────┐                                                   │
│  │ upgrade  │                                                   │
│  │          │                                                   │
│  │ 템플릿   │                                                   │
│  │ 재생성   │                                                   │
│  └──────────┘                                                   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  글로벌 레지스트리  ~/.claw-farm/registry.json            │   │
│  │                                                          │   │
│  │  dog-agent  → /Users/.../dog-agent    port 18789         │   │
│  │  tamagochi  → /Users/.../tamagochi    port 18790         │   │
│  │  tutor-bot  → /Users/.../tutor-bot    port 18791         │   │
│  │                                                          │   │
│  │  nextPort: 18792                                         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## 2. 생성되는 파일 구조

```
my-agent/
│
├── .claw-farm.json                 ← 프로젝트 메타 (이름, 포트, 프로세서)
├── .env.example                    ← GEMINI_API_KEY= (이것만 채우면 됨)
├── docker-compose.openclaw.yml     ← 전체 스택 정의
│
├── api-proxy/                      ← ★ 보안 사이드카 (자동 생성)
│   ├── api_proxy.py                    PII 리댁션 + 키 주입 + 시크릿 스캔
│   ├── Dockerfile
│   └── requirements.txt
│
├── openclaw/
│   ├── config/
│   │   ├── openclaw.json5          ← LLM 설정 (키 없음! 프록시 경유)
│   │   └── policy.yaml             ← 툴 접근 제한 (fs, http, shell)
│   │
│   ├── workspace/                  ← ★ 에이전트가 읽고 쓰는 공간
│   │   ├── SOUL.md                     성격/행동 규칙
│   │   ├── MEMORY.md                   대화 통해 자동 축적
│   │   └── skills/                     커스텀 스킬
│   │
│   ├── raw/                        ← ★ Layer 0: 절대 삭제 금지
│   │   ├── sessions/                   세션 로그 원본 (.jsonl)
│   │   └── workspace-snapshots/        up/down 시 자동 스냅샷
│   │
│   └── processed/                  ← Layer 1: 날려도 됨, 리빌드 가능
│
├── logs/                           ← 감사 로그
│
├── nginx/                          ← (cloud:compose 시 생성)
│   └── nginx.conf                     클라우드 배포용 리버스 프록시
│                                      (인증, 속도 제한, TLS 종단)
│
├── mem0/                           ← (--processor mem0 일 때만)
│   ├── mem0_server.py
│   ├── Dockerfile
│   └── requirements.txt
│
└── data/qdrant/                    ← (--processor mem0 일 때만)
```

## 3. 컨테이너 토폴로지

### builtin 프로세서 (기본)

```
┌─────────────────────────────────────────────────────┐
│                    Docker                            │
│                                                     │
│   ┌─ proxy-net (internal: true) ──────────────┐     │
│   │                                            │     │
│   │  ┌──────────────┐    ┌──────────────────┐ │     │
│   │  │  api-proxy   │    │    openclaw      │ │     │
│   │  │              │◄───│                  │ │     │
│   │  │ GEMINI_API_  │    │ 키 없음          │ │     │
│   │  │ KEY 보유     │    │ SOUL.md 로드     │ │     │
│   │  │              │    │ MEMORY.md 읽기쓰기│ │     │
│   │  │ :8080        │    │ :18789 → 외부    │ │     │
│   │  └──────┬───────┘    └──────────────────┘ │     │
│   │         │                                  │     │
│   └─────────┼──────────────────────────────────┘     │
│             │                                        │
│             ▼  외부 네트워크                           │
│     generativelanguage.googleapis.com                │
└─────────────────────────────────────────────────────┘
      │
      ▼
  localhost:18789 ──→ 브라우저 대시보드
```

### mem0 프로세서 (4-tier)

```
┌──────────────────────────────────────────────────────────────┐
│                         Docker                                │
│                                                              │
│  ┌─ proxy-net (outbound OK) ────────────────────────┐        │
│  │                                                   │        │
│  │  ┌──────────────┐        ┌──────────────────┐    │        │
│  │  │  api-proxy   │◄───────│    openclaw      │    │        │
│  │  │  키 주입      │        │    키 없음        │    │        │
│  │  │  PII 리댁션   │        │    :18789 → 외부  │    │        │
│  │  │  시크릿 스캔   │        │                  │    │        │
│  │  │  :8080        │        └────────┬─────────┘    │        │
│  │  └──────┬────────┘                 │              │        │
│  └─────────┼──────────────────────────┼──────────────┘        │
│            │                          │                       │
│            ▼  외부                     │                       │
│    googleapis.com                     │                       │
│                                       │                       │
│  ┌─ frontend (internal: true) ────────┼──────────────┐        │
│  │                                    │              │        │
│  │                            ┌───────▼────────┐     │        │
│  │                            │   mem0-api     │     │        │
│  │                            │   FastAPI      │     │        │
│  │                            │   :8050        │     │        │
│  │                            └───────┬────────┘     │        │
│  └────────────────────────────────────┼──────────────┘        │
│                                       │                       │
│  ┌─ backend (internal: true) ─────────┼──────────────┐        │
│  │                            ┌───────▼────────┐     │        │
│  │                            │    qdrant      │     │        │
│  │                            │  벡터 DB        │     │        │
│  │                            │  :6333         │     │        │
│  │                            └────────────────┘     │        │
│  └───────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────┘
```

**네트워크 격리 규칙:**
- `proxy-net`: api-proxy만 외부 접근 가능. OpenClaw는 프록시를 통해서만 나감.
- `frontend`: OpenClaw ↔ Mem0 통신. 외부 접근 불가.
- `backend`: Mem0 ↔ Qdrant 통신. 외부 접근 불가.

## 4. 보안 데이터 흐름

```
유저: "우리 강아지 전화번호 010-1234-5678 이고 주민번호..."
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│ OpenClaw (에이전트)                                          │
│                                                             │
│  1. SOUL.md 읽음 → "나는 강아지 전문 AI"                      │
│  2. MEMORY.md 읽음 → "뽀삐는 3살 말티즈"                      │
│  3. 유저 메시지 + 컨텍스트를 LLM에 보내려 함                   │
│     → http://api-proxy:8080 으로 요청                        │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ api-proxy (보안 레이어)                                      │
│                                                             │
│  ★ OUTBOUND (에이전트 → LLM)                                │
│                                                             │
│  원본: "전화번호 010-1234-5678, 주민번호 880101-1234567"      │
│                    ↓ PII 리댁션                               │
│  전송: "전화번호 [REDACTED_KR_PHONE],                        │
│         주민번호 [REDACTED_KR_RRN]"                          │
│                                                             │
│  + API 키 주입 (에이전트는 키를 모름)                          │
│  + 감사 로그 기록 (logs/api-proxy-audit.jsonl)               │
│                                                             │
│  ──────────────────→ Gemini API ────────────────→           │
│                                                             │
│  ★ INBOUND (LLM → 에이전트)                                 │
│                                                             │
│  원본: "이전 세션에서 본 키: sk-ant-abc123def456..."          │
│                    ↓ 시크릿 스캔                              │
│  전달: "이전 세션에서 본 키: [REDACTED_ANTHROPIC_KEY]"        │
│                                                             │
│  + 감사 로그 기록                                            │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ OpenClaw (에이전트)                                          │
│                                                             │
│  4. 클린한 LLM 응답 받음                                     │
│  5. MEMORY.md 업데이트: "뽀삐 보호자 연락처 있음"              │
│  6. 유저에게 답변                                            │
│  7. 세션 로그 → raw/sessions/에 자동 저장                     │
└─────────────────────────────────────────────────────────────┘
```

**PII 리댁션 대상:** 한국 주민번호, 휴대폰, 유선전화, 미국 SSN, 전화번호, 신용카드, 이메일
**시크릿 스캔 대상:** Google/OpenAI/Anthropic/GitHub/GitLab/AWS/Stripe 키, JWT, Private Key
**PII 모드:** `PII_MODE=redact` (기본, 자동 마스킹) | `block` (차단) | `warn` (경고만)

## 5. 메모리 2-Layer 구조

```
              ┌─────────────────────────────────┐
              │         Layer 0: raw/            │
              │       "성경" — 절대 안 지움         │
              │                                 │
              │  sessions/                      │
              │    2026-03-20-session1.jsonl     │  ← 대화 원본
              │    2026-03-21-session2.jsonl     │
              │                                 │
              │  workspace-snapshots/            │
              │    2026-03-20T11-34-46/          │  ← up/down 시 자동
              │      MEMORY.md                  │
              │      SOUL.md                    │
              └──────────────┬──────────────────┘
                             │
                             │  claw-farm memory:rebuild
                             │  (언제든 재구축 가능)
                             ▼
              ┌─────────────────────────────────┐
              │       Layer 1: processed/       │
              │     "교체 가능" — 날려도 됨        │
              │                                 │
              │  현재: builtin (MEMORY.md)       │
              │   또는: mem0 (Qdrant 벡터)       │
              │                                 │
              │  나중에 새 방법론 나오면?           │
              │   → processed/ 삭제             │
              │   → 프로세서 교체                 │
              │   → memory:rebuild              │
              │   → raw에서 다시 만듦!            │
              └─────────────────────────────────┘
```

**원칙:**
- Raw 데이터는 절대 삭제하지 않음 (hallucination 방지, 감사 추적)
- Processing layer는 언제든 갈아끼움 (새 방법론 나오면 바로 테스트)
- `claw-farm memory:rebuild` 한 방으로 원본에서 재인덱싱

## 6. 멀티 인스턴스 아키텍처 (템플릿 + 유저별 격리)

### 싱글 인스턴스 (기본)

프로젝트 하나 = OpenClaw 인스턴스 하나. 기존과 동일.

### 멀티 인스턴스 (`--multi`)

여러 유저가 하나의 프로젝트를 공유할 때 (예: dog-agent), 각 유저는 격리된 메모리와 컨텍스트를 가지면서 동일한 에이전트 성격과 스킬을 공유.

```
dog-agent/                             ← 프로젝트 루트
├── .claw-farm.json                    ← multiInstance: true
├── .gitignore                         ← instances/, *.env
├── api-proxy/                         ← 공유 보안 사이드카 (git 추적)
│
├── template/                          ← ★ 공유 파일 (git 추적, 읽기 전용 마운트)
│   ├── SOUL.md                            에이전트 성격 (모든 유저 동일)
│   ├── AGENTS.md                          행동 규칙 (모든 유저 동일)
│   ├── skills/                            커스텀 스킬 (모든 유저 동일)
│   ├── CONTEXT.template.md                플레이스홀더: {{USER_ID}}, {{NAME}} 등
│   └── config/
│       ├── openclaw.json5
│       └── policy.yaml
│
└── instances/                         ← ★ 유저별 데이터 (gitignored)
    ├── alice/
    │   ├── docker-compose.openclaw.yml    인스턴스별 compose
    │   ├── CONTEXT.md                     "강아지: 뽀삐, 3살 말티즈"
    │   ├── MEMORY.md                      Alice의 대화 기억
    │   ├── raw/sessions/
    │   ├── raw/workspace-snapshots/
    │   ├── processed/
    │   └── logs/
    │
    └── bob/
        ├── docker-compose.openclaw.yml
        ├── CONTEXT.md                     "강아지: 맥스, 5살 골든리트리버"
        ├── MEMORY.md                      Bob의 대화 기억
        ├── raw/sessions/
        └── ...
```

**핵심 설계:**
- `SOUL.md` (공유): "나는 강아지 전문 AI" — 모든 유저 동일
- `CONTEXT.md` (유저별): "강아지: 뽀삐, 3살 말티즈, 닭고기 알러지" — 항상 로드
- `MEMORY.md` (유저별): 축적된 대화 기억 — 유저별 격리
- `template/` → git 추적. `instances/` → gitignored (유저 데이터는 로컬 유지)

### 인스턴스별 컨테이너 격리

각 인스턴스는 고유 컨테이너 이름과 포트로 독립된 Docker Compose 스택 실행:

```
$ claw-farm instances dog-agent
┌──────────────────┬─────────┬───────────┐
│ alice             │ 18790   │ 🟢 running │
│ bob               │ 18791   │ 🟢 running │
└──────────────────┴─────────┴───────────┘
```

공유 템플릿 파일은 읽기 전용으로 각 인스턴스에 마운트:
```yaml
volumes:
  # 설정 파일 개별 마운트 (상위 디렉토리 쉐도잉 방지)
  - ../../template/config/openclaw.json5:/...openclaw.json5:ro
  - ../../template/config/policy.yaml:/...policy.yaml:ro
  # 공유 워크스페이스 파일
  - ../../template/SOUL.md:/...workspace/SOUL.md:ro
  - ../../template/AGENTS.md:/...workspace/AGENTS.md:ro
  - ../../template/skills:/...workspace/skills:ro
  # 유저별 데이터
  - ./CONTEXT.md:/...workspace/CONTEXT.md       # 유저별
  - ./MEMORY.md:/...workspace/MEMORY.md         # 유저별
```

### 멀티 인스턴스 명령어

```bash
claw-farm init dog-agent --multi             # template/ 구조 생성
claw-farm spawn dog-agent --user alice \
  --context name=Poppy breed=Maltese age=3   # 템플릿에서 인스턴스 생성
claw-farm spawn dog-agent --user bob         # 다른 인스턴스, 다른 포트
claw-farm instances dog-agent                # 모든 인스턴스 목록
claw-farm up dog-agent --user alice          # 특정 인스턴스 시작
claw-farm down dog-agent --user bob          # 특정 인스턴스 중지
claw-farm despawn dog-agent --user bob       # 인스턴스 제거
```

### 프로그래밍 API (가입 플로우용)

```typescript
import { spawn, despawn, listInstances } from "@permissionlabs/claw-farm";

// 유저 가입 → 에이전트 인스턴스 생성
const { port } = await spawn({
  project: "dog-agent",
  userId: "user-123",
  context: { name: "Poppy", breed: "Maltese", age: "3" },
});

// 유저의 에이전트: http://localhost:${port}
```

### 마이그레이션 (싱글 → 멀티)

싱글 인스턴스 프로젝트에서 첫 `spawn` 시 자동 마이그레이션:
1. 기존 `openclaw/workspace/`에서 `template/` 생성 (SOUL.md, AGENTS.md, skills/, config/)
2. 레지스트리와 설정에 `multiInstance: true` 설정
3. `instances/`용 `.gitignore` 생성

### 멀티 프로젝트 개요

```
localhost
    │
    ├── :18789  dog-agent    (builtin) multi: 2 instances
    │   ├── :18790  alice
    │   └── :18791  bob
    ├── :18792  tamagochi    (builtin) single
    ├── :18793  tutor-bot    (mem0)    single
    │
    │   $ claw-farm list
    │   ┌──────────────┬───────┬───────────┬────────────┐
    │   │ dog-agent    │ 18789 │ 🟢 running │ 2          │
    │   │ tamagochi    │ 18792 │ ⚪ stopped │ -          │
    │   │ tutor-bot    │ 18793 │ 🟢 running │ -          │
    │   └──────────────┴───────┴───────────┴────────────┘
    │
    │   $ claw-farm up --all     # 전부 켜기 (모든 인스턴스 포함)
    │   $ claw-farm down --all   # 전부 끄기
    │
    ▼
  cloud:compose → 하나의 docker-compose.cloud.yml로 합침
    │
    ▼
  Hetzner VPS + Coolify → git push 한 방 배포
```

## 7. 기존 프로젝트 온보딩

```
dog-agent (기존)                    dog-agent (claw-farm 등록 후)
├── docker-compose.yml  ← 안 건드림  ├── docker-compose.yml    (그대로)
├── .env                            ├── .env                  (그대로)
├── openclaw/                       ├── openclaw/
│   ├── config/                     │   ├── config/
│   │   └── openclaw.json5          │   │   ├── openclaw.json5 (그대로)
│   └── workspace/                  │   │   └── policy.yaml    ★ 추가
│       ├── SOUL.md                 │   ├── workspace/         (그대로)
│       ├── MEMORY.md               │   ├── raw/               ★ 추가
│       ├── AGENTS.md               │   │   ├── sessions/
│       └── skills/                 │   │   └── workspace-snapshots/
├── mem0/                           │   └── processed/         ★ 추가
│   ├── Dockerfile                  ├── mem0/                  (그대로)
│   └── mem0_server.py              ├── api-proxy/             ★ 추가
└── data/qdrant/                    │   ├── api_proxy.py
                                    │   ├── Dockerfile
                                    │   └── requirements.txt
                                    ├── logs/                  ★ 추가
                                    └── .claw-farm.json        ★ 추가

★ = claw-farm init --existing 이 추가한 것. 기존 파일 절대 안 건드림.
```

**온보딩 명령:**
```bash
cd /path/to/existing-project
claw-farm init <name> --existing [--processor mem0]
```
