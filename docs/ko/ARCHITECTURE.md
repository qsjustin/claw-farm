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
│  $ claw-farm init tamagochi --llm anthropic                     │
│  $ claw-farm init tutor-bot --processor mem0 --llm openai-compat│
│  $ claw-farm init lite-bot --runtime picoclaw                   │
│  $ claw-farm init shared-bot --runtime picoclaw --proxy-mode shared│
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
├── .claw-farm.json                 ← 프로젝트 메타 (이름, 포트, 프로세서, llm, runtime, proxyMode)
├── .env.example                    ← LLM_PROVIDER + API 키 (--llm 플래그에 따라)
├── docker-compose.openclaw.yml     ← 전체 스택 정의
│
├── api-proxy/                      ← ★ 보안 사이드카 (자동 생성)
│   ├── api_proxy.py                    PII 리댁션 + 키 주입 + 시크릿 스캔
│   ├── Dockerfile
│   └── requirements.txt
│
├── openclaw/                       ← /home/node/.openclaw로 마운트
│   ├── openclaw.json              ← LLM 설정 (키 없음! 프록시 경유)
│   ├── policy.yaml                 ← 툴 접근 제한 (fs, http, shell)
│   ├── workspace/                  ← ★ 에이전트가 읽고 쓰는 공간
│   │   ├── SOUL.md                     성격/행동 규칙
│   │   ├── MEMORY.md                   대화 통해 자동 축적
│   │   └── skills/                     커스텀 스킬
│   ├── sessions/                   ← ★ Layer 0: 절대 삭제 금지 (.jsonl 로그)
│   └── logs/                       ← 에이전트 감사 로그
│
├── raw/                            ← 워크스페이스 스냅샷 (up/down 시 자동)
│   └── workspace-snapshots/
├── processed/                      ← Layer 1: 날려도 됨, 리빌드 가능
├── logs/                           ← API 프록시 감사 로그
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

### 로컬 개발 (기본)

단일 네트워크, nginx 없음. 두 컨테이너가 `proxy-net` (non-internal) 공유.
네트워크 격리는 프로덕션에서 `cloud:compose`로 적용.

```
┌──────────────────────────────────────────────────────┐
│                    Docker                             │
│                                                      │
│   ┌─ proxy-net ──────────────────────────────┐       │
│   │                                           │       │
│   │  ┌──────────────┐    ┌──────────────────┐│       │
│   │  │  api-proxy   │    │    openclaw      ││       │
│   │  │              │◄───│                  ││       │
│   │  │ GEMINI_API_  │    │ 키 없음          ││       │
│   │  │ KEY 보유     │    │ SOUL.md 로드     ││       │
│   │  │              │    │ MEMORY.md 읽기쓰기││       │
│   │  │ :8080        │    │ :18789 → 호스트   ││       │
│   │  └──────┬───────┘    └──────────────────┘│       │
│   └─────────┼────────────────────────────────┘       │
│             ▼                                        │
│     generativelanguage.googleapis.com                │
└──────────────────────────────────────────────────────┘
      │
      ▼
  localhost:18789 ──→ 브라우저 대시보드
```

### 프로덕션 (cloud:compose) — 완전 네트워크 격리

nginx 리버스 프록시가 포트 바인딩 + TLS + 속도 제한 담당.
openclaw은 internal 네트워크에 완전 격리 — 인터넷 접근 불가.

```
┌──────────────────────────────────────────────────────────────┐
│                         Docker                                │
│                                                              │
│  ┌─ public-net ──────────────────────────────┐               │
│  │  ┌──────────────┐                         │               │
│  │  │    nginx     │  :18789 → 호스트         │               │
│  │  │  TLS + 인증   │                         │               │
│  │  │  속도 제한    │                         │               │
│  │  └──────┬───────┘                         │               │
│  └─────────┼─────────────────────────────────┘               │
│            │                                                  │
│  ┌─ proxy-net (internal: true) ──────────────────────┐       │
│  │         │                                          │       │
│  │  ┌──────▼───────┐    ┌──────────────────┐         │       │
│  │  │   openclaw   │    │   api-proxy      │         │       │
│  │  │              │───►│                  │         │       │
│  │  │ 키 없음       │    │ 키 주입          │         │       │
│  │  │ 인터넷 없음    │    │ PII 리댁션       │         │       │
│  │  │              │    │ 시크릿 스캔       │         │       │
│  │  └──────────────┘    └──────┬───────────┘         │       │
│  └─────────────────────────────┼─────────────────────┘       │
│                                │                              │
│  ┌─ egress-net ────────────────┼─────────────────────┐       │
│  │                     ┌───────┘                     │       │
│  │                     ▼                             │       │
│  │         generativelanguage.googleapis.com          │       │
│  └───────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────┘
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

**네트워크 격리 규칙 (프로덕션 / cloud:compose):**
- `public-net`: nginx 전용. 호스트 포트 바인딩 + TLS 종단.
- `proxy-net` (internal): nginx ↔ openclaw ↔ api-proxy. 인터넷 접근 불가.
- `egress-net`: api-proxy 전용. Gemini API 아웃바운드.
- `frontend` (internal, mem0 전용): OpenClaw ↔ Mem0 통신.
- `backend` (internal, mem0 전용): Mem0 ↔ Qdrant 통신.

**로컬 개발:** 단일 `proxy-net` (non-internal)으로 단순하게 운영.

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
│  7. 세션 로그 → sessions/에 자동 저장                         │
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
│   ├── USER.template.md                플레이스홀더: {{USER_ID}}, {{NAME}} 등
│   └── config/
│       ├── openclaw.json
│       └── policy.yaml
│
└── instances/                         ← ★ 유저별 데이터 (gitignored)
    ├── alice/
    │   ├── docker-compose.openclaw.yml    인스턴스별 compose
    │   ├── openclaw/                      /home/node/.openclaw로 마운트
    │   │   ├── openclaw.json                 template/config/에서 복사
    │   │   ├── policy.yaml                   template/config/에서 복사
    │   │   ├── workspace/
    │   │   │   ├── USER.md                "강아지: 뽀삐, 3살 말티즈"
    │   │   │   ├── MEMORY.md                 Alice의 대화 기억
    │   │   │   └── memory/
    │   │   ├── sessions/
    │   │   └── logs/
    │   ├── raw/workspace-snapshots/
    │   └── processed/
    │
    └── bob/
        ├── docker-compose.openclaw.yml
        ├── openclaw/                      alice와 동일한 구조
        └── ...
```

**핵심 설계:**
- `SOUL.md` (공유): "나는 강아지 전문 AI" — 모든 유저 동일
- `USER.md` (유저별): "강아지: 뽀삐, 3살 말티즈, 닭고기 알러지" — 항상 로드
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

각 인스턴스는 자체 `openclaw/` 디렉토리를 `/home/node/.openclaw`로 마운트하고,
공유 템플릿 파일은 spawn/upgrade 시 `openclaw/workspace/`에 복사:
```yaml
volumes:
  # 디렉토리 마운트 (쓰기 가능 — OpenClaw config atomic rename 필요)
  # 템플릿 파일 (SOUL.md, AGENTS.md, skills/)은 spawn/upgrade 시 복사
  - ./openclaw:/home/node/.openclaw
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
│   ├── config/                     │   ├── openclaw.json     ★ 추가 (프록시 라우팅)
│   │   └── openclaw.json          │   ├── policy.yaml        ★ 추가
│   └── workspace/                  │   ├── workspace/         (그대로)
│       ├── SOUL.md                 │   ├── sessions/          ★ 추가
│       ├── MEMORY.md               │   └── logs/              ★ 추가
│       ├── AGENTS.md               ├── raw/workspace-snapshots/ ★ 추가
│       └── skills/                 ├── processed/             ★ 추가
├── mem0/                           ├── mem0/                  (그대로)
│   ├── Dockerfile                  ├── api-proxy/             ★ 추가
│   └── mem0_server.py              │   ├── api_proxy.py
└── data/qdrant/                    │   ├── Dockerfile
                                    │   └── requirements.txt
                                    ├── logs/                  ★ 추가
                                    └── .claw-farm.json        ★ 추가

★ = claw-farm init --existing 이 추가한 것. 기존 파일 절대 안 건드림.
```

**온보딩 명령:**
```bash
cd /path/to/existing-project
claw-farm init <name> --existing [--processor mem0] [--llm anthropic]
```

## 8. 런타임 추상화

claw-farm은 `src/runtimes/`의 `AgentRuntime` 인터페이스를 통해 여러 에이전트 런타임을 지원합니다.

```
src/
├── runtimes/
│   ├── interface.ts        ← AgentRuntime 인터페이스 정의
│   ├── openclaw.ts         ← OpenClaw 런타임 (~1.5GB, 풀 기능)
│   ├── picoclaw.ts         ← picoclaw 런타임 (~20MB, 경량 Go)
│   └── index.ts            ← 런타임 리졸버 (이름으로)
├── commands/
├── lib/
├── processors/
└── templates/
```

### AgentRuntime 인터페이스

각 런타임이 구현하는 메서드:
- **scaffoldProject()** — 프로젝트 파일 생성 (compose, config, workspace)
- **scaffoldInstance()** — 유저별 인스턴스 파일 생성
- **getComposeFile()** — 런타임의 compose 파일명 반환
- **getWorkspacePaths()** — 런타임별 경로 반환 (config, memory, sessions)

### 런타임 선택

```bash
claw-farm init my-agent                          # 기본값: openclaw
claw-farm init my-agent --runtime openclaw       # 명시적: OpenClaw
claw-farm init my-agent --runtime picoclaw       # 경량: picoclaw
```

`runtime` 필드는 `.claw-farm.json`에 저장:
```json
{
  "name": "my-agent",
  "runtime": "picoclaw",
  "proxyMode": "per-instance",
  "processor": "builtin",
  "port": 18789
}
```

### 런타임 비교

| | OpenClaw | picoclaw |
|---|---|---|
| **이미지 크기** | ~1.5GB | ~20MB (75배 가벼움) |
| **언어** | Node.js | Go |
| **설정** | openclaw.json + policy.yaml | 단일 config.json |
| **메모리 경로** | workspace/MEMORY.md | workspace/memory/MEMORY.md |
| **세션** | sessions/ (.jsonl) | workspace/sessions/ |
| **적합한 용도** | 풀 기능 에이전트, 풍부한 플러그인 생태계 | 경량 에이전트, 리소스 제한 환경 |
| **멀티 에이전트** | 유저별 격리 (spawn) | 내장 역할(role) 기반 (유저별 아님) |

## 9. proxyMode: 공유 vs 인스턴스별 API 프록시

`--proxy-mode` 플래그는 인스턴스 간 `api-proxy` 배포 방식을 제어합니다.

```bash
claw-farm init my-agent --runtime picoclaw --proxy-mode shared
claw-farm init my-agent --runtime picoclaw --proxy-mode per-instance  # 기본값
```

### per-instance (기본값)

각 유저 인스턴스마다 자체 api-proxy 컨테이너 배포. OpenClaw과 동일한 모델.

```
instances/alice/  →  alice-agent + alice-api-proxy
instances/bob/    →  bob-agent   + bob-api-proxy
```

- 유저별 완전한 시크릿 격리 (각 프록시에 다른 키 가능)
- 리소스 사용량 높음 (인스턴스당 프록시 하나)

### shared

모든 유저 인스턴스가 프로젝트 수준의 단일 api-proxy 컨테이너 공유.

```
api-proxy/        →  shared-api-proxy (전체 하나)
instances/alice/  →  alice-agent ──→ shared-api-proxy
instances/bob/    →  bob-agent   ──→ shared-api-proxy
```

- 리소스 사용량 낮음 (프록시 하나)
- 모든 인스턴스가 동일한 API 키 사용
- 유저별 시크릿 격리 불가 (docs/SECURITY.md 참조)

## 10. picoclaw 파일 구조

### 싱글 인스턴스 (picoclaw)

```
my-agent/
│
├── .claw-farm.json                 ← runtime: "picoclaw", proxyMode: "per-instance"
├── .env.example                    ← LLM_PROVIDER + API 키
├── docker-compose.picoclaw.yml     ← picoclaw 스택 정의
│
├── api-proxy/                      ← 보안 사이드카 (OpenClaw과 동일)
│   ├── api_proxy.py
│   ├── Dockerfile
│   └── requirements.txt
│
├── picoclaw/                       ← picoclaw 컨테이너에 마운트
│   ├── config.json                 ← 단일 설정 파일 (LLM + 도구 + 정책)
│   └── workspace/
│       ├── SOUL.md                     성격/행동 규칙
│       ├── memory/
│       │   └── MEMORY.md               대화 통해 자동 축적
│       ├── sessions/                   세션 로그
│       └── skills/                     커스텀 스킬
│
├── raw/                            ← 워크스페이스 스냅샷
│   └── workspace-snapshots/
├── processed/                      ← Layer 1: 날려도 됨, 리빌드 가능
└── logs/                           ← API 프록시 감사 로그
```

### 멀티 인스턴스 (picoclaw)

```
dog-agent/
├── .claw-farm.json                    ← runtime: "picoclaw", multiInstance: true
├── api-proxy/                         ← 공유 또는 인스턴스별 (proxyMode에 따라)
│
├── template/
│   ├── SOUL.md                            공유 성격
│   ├── AGENTS.md                          공유 행동 규칙
│   ├── skills/                            공유 스킬
│   ├── USER.template.md                   유저별 플레이스홀더
│   └── config/
│       └── config.json                    picoclaw 설정 (단일 파일)
│
└── instances/
    ├── alice/
    │   ├── docker-compose.picoclaw.yml
    │   ├── picoclaw/
    │   │   ├── config.json                    template/config/에서 복사
    │   │   └── workspace/
    │   │       ├── USER.md                    Alice의 컨텍스트
    │   │       ├── memory/
    │   │       │   └── MEMORY.md              Alice의 기억
    │   │       └── sessions/                  Alice의 세션
    │   ├── raw/workspace-snapshots/
    │   └── processed/
    │
    └── bob/
        └── ...                                alice와 동일한 구조
```

## 11. picoclaw 컨테이너 토폴로지

### 로컬 개발 (picoclaw, 인스턴스별 프록시)

```
┌──────────────────────────────────────────────────────┐
│                    Docker                             │
│                                                      │
│   ┌─ proxy-net ──────────────────────────────┐       │
│   │                                           │       │
│   │  ┌──────────────┐    ┌──────────────────┐│       │
│   │  │  api-proxy   │    │ picoclaw-gateway ││       │
│   │  │              │◄───│                  ││       │
│   │  │ API 키 보유   │    │ ~20MB Go 바이너리 ││       │
│   │  │              │    │ 키 없음           ││       │
│   │  │ :8080        │    │ :18789 → 호스트   ││       │
│   │  └──────┬───────┘    └──────────────────┘│       │
│   └─────────┼────────────────────────────────┘       │
│             ▼                                        │
│     LLM API 엔드포인트                                │
└──────────────────────────────────────────────────────┘
      │
      ▼
  localhost:18789 ──→ 에이전트 인터페이스
```

### 로컬 개발 (picoclaw, 공유 프록시)

```
┌──────────────────────────────────────────────────────────┐
│                         Docker                            │
│                                                          │
│   ┌─ proxy-net ──────────────────────────────────┐       │
│   │                                               │       │
│   │  ┌──────────────┐                             │       │
│   │  │  api-proxy   │  (공유, 전체 하나)            │       │
│   │  │  :8080       │◄──────┬──────────┐          │       │
│   │  └──────┬───────┘       │          │          │       │
│   │         │          ┌────┴───┐ ┌────┴───┐      │       │
│   │         │          │ alice  │ │  bob   │      │       │
│   │         │          │ :18790 │ │ :18791 │      │       │
│   │         │          └────────┘ └────────┘      │       │
│   └─────────┼────────────────────────────────────┘       │
│             ▼                                            │
│     LLM API 엔드포인트                                    │
└──────────────────────────────────────────────────────────┘
```

**picoclaw 멀티 에이전트 참고:** picoclaw에는 단일 인스턴스 내에서 에이전트 역할(예: 연구자, 작성자, 리뷰어)을 정의하는 내장 멀티 에이전트 기능이 있습니다. 이것은 유저별 격리를 제공하는 claw-farm의 멀티 인스턴스 모델과 다릅니다. picoclaw의 역할은 하나의 컨테이너 안에서 실행되고, claw-farm의 인스턴스는 별도의 데이터를 가진 별도의 컨테이너입니다.
