# OpenClaw에서 picoclaw로 마이그레이션

> 기존 OpenClaw 프로젝트를 picoclaw 런타임으로 전환하는 가이드입니다.

---

## 사전 요구 사항

- claw-farm v0.3.0 이상
- claw-farm에 등록된 기존 OpenClaw 프로젝트

---

## 마이그레이션 권장 상황

- 리소스 사용량을 줄이고 싶을 때 (인스턴스당 메모리 75배 절감)
- OpenClaw 전용 기능(플러그인, 마켓플레이스, 브라우저 자동화)이 필요 없을 때
- 제한된 하드웨어에서 많은 사용자 인스턴스를 운영할 때

## 마이그레이션하면 안 되는 경우

- OpenClaw 플러그인 또는 ClawHub 마켓플레이스가 필요할 때
- mem0 프로세서를 사용 중일 때 (picoclaw에서 아직 미지원)
- 브라우저 자동화 기능이 필요할 때
- 단일 인스턴스를 운영하며 리소스가 충분할 때

---

## 마이그레이션 단계 (단일 인스턴스)

```bash
# 1. 현재 프로젝트 중지
claw-farm down my-project

# 2. 데이터 백업
cp -r openclaw/ openclaw-backup/

# 3. 마이그레이션 명령 실행
claw-farm migrate-runtime my-project --to picoclaw

# 4. 확인 및 시작
claw-farm up my-project
```

`migrate-runtime` 명령을 사용할 수 없는 경우 (v0.3.0) 수동 단계:

```bash
# 1. 중지 및 백업
claw-farm down my-project
cp -r openclaw/ openclaw-backup/

# 2. picoclaw 디렉토리 구조 생성
mkdir -p picoclaw/workspace/{memory,sessions,state,skills}

# 3. 데이터 파일 복사
cp openclaw/workspace/SOUL.md picoclaw/workspace/
cp openclaw/workspace/MEMORY.md picoclaw/workspace/memory/
cp openclaw/workspace/USER.md picoclaw/workspace/ 2>/dev/null
cp -r openclaw/workspace/skills/* picoclaw/workspace/skills/ 2>/dev/null

# 4. .claw-farm.json 수정
# "runtime"을 "picoclaw"로 변경 (또는 없으면 추가)
# 선택적으로 "proxyMode": "shared" 추가

# 5. compose 및 config 재생성
claw-farm upgrade my-project

# 6. 새 런타임으로 시작
claw-farm up my-project
```

---

## 마이그레이션 단계 (멀티 인스턴스)

```bash
# 1. 모든 인스턴스 중지
claw-farm down my-project

# 2. 백업
cp -r instances/ instances-backup/
cp -r template/ template-backup/

# 3. 각 인스턴스의 디렉토리 구조 변환:
for user in instances/*/; do
  uid=$(basename "$user")
  mkdir -p "instances/$uid/picoclaw/workspace/{memory,sessions,state,skills}"
  cp "instances/$uid/openclaw/workspace/SOUL.md" "instances/$uid/picoclaw/workspace/"
  cp "instances/$uid/openclaw/workspace/MEMORY.md" "instances/$uid/picoclaw/workspace/memory/"
  cp "instances/$uid/openclaw/workspace/USER.md" "instances/$uid/picoclaw/workspace/" 2>/dev/null
  cp -r "instances/$uid/openclaw/workspace/skills/"* "instances/$uid/picoclaw/workspace/skills/" 2>/dev/null
done

# 4. 템플릿 설정 업데이트
mv template/config/openclaw.json template/config/openclaw.json.backup
# config.json은 upgrade 시 자동 재생성됩니다

# 5. .claw-farm.json 수정
# "runtime": "picoclaw" 설정

# 6. 전체 재생성
claw-farm upgrade my-project

# 7. 시작
claw-farm up my-project
```

---

## 마이그레이션되는 데이터

| 데이터 | 원본 (OpenClaw) | 대상 (picoclaw) |
|--------|----------------|----------------|
| SOUL.md | openclaw/workspace/SOUL.md | picoclaw/workspace/SOUL.md |
| MEMORY.md | openclaw/workspace/MEMORY.md | picoclaw/workspace/memory/MEMORY.md |
| USER.md | openclaw/workspace/USER.md | picoclaw/workspace/USER.md |
| Skills | openclaw/workspace/skills/ | picoclaw/workspace/skills/ |
| 세션 로그 | openclaw/sessions/*.jsonl | 마이그레이션 불가 (형식 상이) |
| 설정 | openclaw.json + policy.yaml | config.json (재생성) |

## 마이그레이션되지 않는 데이터

- 세션 로그 (OpenClaw JSONL 형식과 picoclaw 형식이 다름)
- OpenClaw 전용 설정 (policy.yaml, controlUi 설정)
- 처리된 메모리 (Layer 1) — `claw-farm memory:rebuild`로 재구축 가능

---

## 롤백

```bash
# picoclaw 중지
claw-farm down my-project

# OpenClaw 데이터 복원
rm -rf picoclaw/
cp -r openclaw-backup/ openclaw/

# .claw-farm.json 되돌리기 ("runtime" 필드 제거 또는 "openclaw"으로 설정)
claw-farm upgrade my-project
claw-farm up my-project
```

---

## proxyMode 선택 가이드

| 시나리오 | 권장 proxyMode |
|---------|---------------|
| 모든 사용자가 동일한 LLM API 키를 공유 | `shared` (리소스 절약) |
| 사용자마다 다른 API 키 사용 | `per-instance` |
| 사용자에게 민감한 비밀 정보가 있음 (지갑, 거래 키) | `per-instance` |
| 비용 절감이 중요한 배포 | `shared` |
| 최대 보안 격리가 필요 | `per-instance` |
