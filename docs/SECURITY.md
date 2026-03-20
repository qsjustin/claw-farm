# OpenClaw Security Hardening Guide

> 2026-03-20 기준 리서치. claw-farm 보안 설계의 근거 문서.

## Sources

- [OpenClaw Official Security Docs](https://docs.openclaw.ai/gateway/security)
- [Nebius: OpenClaw Security Architecture Guide](https://nebius.com/blog/posts/openclaw-security)
- [Snyk: 280+ Leaky Skills — Credential Leak Research](https://snyk.io/blog/openclaw-skills-credential-leaks-research/)
- [Knostic: openclaw-shield (PII/Secret Prevention)](https://www.knostic.ai/blog/openclaw-shield-preventing-secret-leaks-pii-exposure-and-destructive-commands)
- [DEV.to: Complete Privacy & Security Guide 2026](https://dev.to/apilover/how-to-secure-your-openclaw-installation-complete-privacy-security-guide-2026-750)
- [Docker Blog: Run OpenClaw Securely in Docker Sandboxes](https://www.docker.com/blog/run-openclaw-securely-in-docker-sandboxes/)
- [Microsoft Security Blog: Running OpenClaw Safely (2026-02)](https://www.microsoft.com/en-us/security/blog/2026/02/19/running-openclaw-safely-identity-isolation-runtime-risk/)
- [HN Discussion on Docker Security](https://news.ycombinator.com/item?id=46884143)

---

## 1. API 키 / 크레덴셜 관리

### 핵심 원칙
- **에이전트는 API 키를 절대 볼 수 없어야 함**
- 키를 env var로 직접 전달하면 에이전트가 `env` 명령이나 `/proc/self/environ`으로 읽을 수 있음
- Snyk 연구: ClawHub 스킬 7.1% (283/3,984개)에서 크리티컬 크레덴셜 유출 발견

### 권장 아키텍처: API Proxy Sidecar
```
OpenClaw ──(키 없음)──→ API Proxy ──(키 주입)──→ LLM API
```
- OpenClaw은 `apiBaseUrl: "http://api-proxy:8080"` 사용
- 프록시만 API 키 보유, 외부 포트 노출 없음
- 프록시에서 키 주입 후 upstream 포워딩

### 추가 권장사항
- Secret Manager (Vault, AWS SM, 1Password CLI) 사용 — .env 대신
- 프로젝트별 별도 API 키 + spending limit 설정
- 90일 주기 키 로테이션
- `openclaw security audit` 정기 실행

### claw-farm 구현
- `api-proxy/` 사이드카: FastAPI, 키 주입, 감사 로그
- OpenClaw 컨테이너에 `GEMINI_API_KEY` 없음
- `openclaw.json5`에서 `apiKey: "proxied"` 설정

---

## 2. 데이터 유출 방지 (PII / 개인정보)

### 위협 모델
1. **아웃바운드 유출**: 유저의 개인정보(동영상, 사진, 문서)가 LLM 프롬프트에 포함되어 외부 전송
2. **스킬 통한 유출**: 악성/취약 스킬이 MEMORY.md에 키 저장 → 유출
3. **로그 유출**: 세션 트랜스크립트에 민감 데이터 잔류
4. **LLM 응답 유출**: 에이전트가 이전에 본 시크릿을 응답에 포함

### Snyk 발견 4대 유출 패턴
1. **Verbatim Output**: 스킬이 API 키를 채팅에 직접 출력
2. **Financial Exfil**: 카드번호를 curl 명령에 임베딩
3. **Log Leakage**: 세션 파일을 리댁션 없이 export
4. **Plaintext Storage**: MEMORY.md에 키를 평문 저장

### openclaw-shield 5-Layer 방어
1. **Prompt Guard**: 에이전트 컨텍스트에 보안 정책 주입
2. **Output Scanner**: 툴 출력에서 시크릿/PII 리댁션
3. **Tool Blocker**: 위험한 툴 콜 호스트 레벨 차단
4. **Input Audit**: 인바운드 메시지 로깅 + 시크릿 탐지
5. **Security Gate**: exec/file-read 전 ALLOWED/DENIED 판정

### claw-farm 구현
- `api-proxy`에서 아웃바운드 PII 패턴 탐지 (SSN, 카드, 전화번호, 한국 주민번호)
- `MAX_PROMPT_SIZE_MB=5` 제한 (대용량 파일 통째 전송 차단)
- PII 자동 리댁션 (탐지 → [REDACTED] 마스킹)
- LLM 응답 시크릿 스캐닝 (AWS 키, GitHub 토큰, 카드번호 등)
- 감사 로그에 content hash + PII 탐지 플래그 기록

---

## 3. 컨테이너 / 인프라 격리

### Docker 하드닝 체크리스트
- [x] `read_only: true` — 컨테이너 파일시스템 읽기 전용
- [x] `tmpfs` — /tmp, .cache만 임시 쓰기 (크기 제한)
- [x] `cap_drop: ALL` — 모든 Linux capabilities 제거
- [x] `security_opt: no-new-privileges` — 권한 상승 방지
- [x] `deploy.resources.limits` — 메모리/CPU 제한
- [x] non-root 유저 (OpenClaw: node, mem0/proxy: appuser)
- [x] 볼륨 마운트 `:ro` (config 디렉토리)

### 네트워크 토폴로지
```
                    ┌─ proxy-net (outbound OK) ─┐
  openclaw ────────→│ api-proxy ───────────→ Gemini API
     │              └───────────────────────────┘
     │
     ├─ frontend (internal, no outbound)
     └────────────→ mem0-api
                      │
                    backend (internal)
                      │
                    qdrant
```
- `proxy-net`: api-proxy만 외부 접근 가능
- `frontend`: OpenClaw ↔ Mem0 only (internal)
- `backend`: Mem0 ↔ Qdrant only (internal)

---

## 4. 네트워크 접근 제어

### 로컬 개발
- `127.0.0.1` 바인딩 (외부 접근 불가)
- `gateway.bind: "loopback"` 기본값

### 클라우드 배포
- `gateway.auth.mode: "token"` 필수
- Nginx 리버스 프록시 + TLS + Basic Auth
- IP allowlist 또는 Tailscale VPN
- `dmPolicy: "pairing"` (알 수 없는 sender 차단)

### 절대 하지 말 것
- `0.0.0.0` 바인딩 without auth token
- `dmPolicy: "open"` (무제한 인바운드)
- 대시보드 공개 노출

---

## 5. 툴 접근 제어

### 원칙: Allowlist-first
```yaml
tools:
  filesystem:
    allow: [/home/node/.openclaw/workspace/**]
    deny: [/etc/**, /proc/**, /sys/**]
  http:
    deny: ["*"]  # deny all by default
  shell:
    enabled: false
  code_execution:
    sandbox: true
    timeout_seconds: 30
```

### 위험한 툴 (명시적 제어 필요)
- `exec` / `process`: 명령 실행
- `browser`: 브라우저 자동화
- `web_fetch` / `web_search`: 외부 콘텐츠
- `gateway`: 설정 변경
- `cron`: 스케줄 작업

### ClawHub 스킬 보안
- 설치 전 소스 코드 리뷰 필수
- `mcp-scan`으로 스킬 감사
- 샌드박스에서 먼저 테스트
- 2026-01 ClawHavoc 캠페인: 수백 개 악성 스킬 발견 (키로거, API 키 탈취)

---

## 6. 감사 / 모니터링

### 필수 감사 항목
- 모든 tool call (타임스탬프 + 유저 + 액션)
- LLM API 요청 (content hash, 크기, 응답 코드, 소요 시간)
- PII 탐지 이벤트
- 실패한 인증 시도

### 명령어
```bash
openclaw security audit              # 기본 감사
openclaw security audit --deep       # 라이브 게이트웨이 프로브 포함
openclaw security audit --fix        # 자동 교정
openclaw security audit --json       # 머신 리더블 출력
```

### 로그 관리
- JSON/JSONL 포맷
- 100MB 단위 로테이션, 최대 10개 보관
- 민감 데이터 리댁션 후 보관
- 30일 이상 로그 자동 삭제 정책

---

## 7. 인시던트 대응

### 즉시 격리
1. 게이트웨이 프로세스 중지
2. `gateway.bind: "loopback"` 설정
3. Tailscale Funnel/Serve 비활성화
4. 위험 채널 `dmPolicy: "disabled"`

### 키 로테이션 (시크릿 노출 시)
1. `gateway.auth.token`
2. LLM API 키 (Gemini, OpenAI 등)
3. 채널 크레덴셜 (Slack, Discord 등)
4. `secrets.json` 내 암호화된 시크릿

### 사후 분석
1. `/tmp/openclaw/openclaw-YYYY-MM-DD.log` 검토
2. 세션 트랜스크립트 검사
3. 설정 변경 이력 확인
4. `openclaw security audit --deep` 재실행
