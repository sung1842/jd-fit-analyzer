# 14. 컨테이너 구성 (docker-compose)

> 루트 `docker-compose.yml`. Dockerfile: `orchestrator/`, `mcp-server/` (context=루트), `crawler/` (context=crawler/).

## 서비스

| 서비스 | 이미지 | 호스트 포트 (127.0.0.1 전용) | 헬스체크 | 비고 |
|---|---|---|---|---|
| redis | redis:7-alpine | 없음 (내부 전용) | `redis-cli ping` | named volume `redis-data`, AOF |
| mcp-server | node:22-alpine | `${MCP_HOST_PORT:-3002}` | `GET /mcp` 4xx = HTTP 생존 (401 정상) | **scale 금지** (rateLimiter 가 프로세스 메모리) |
| orchestrator-api | jdfit-orchestrator | `${ORCHESTRATOR_HOST_PORT:-3001}` | `GET /` 응답 (404 정상) = HTTP 생존 | `ROLE=api` (HTTP + HIL 타임아웃 + promotion). **1개만** |
| orchestrator-worker | jdfit-orchestrator | 없음 | heartbeat 파일 mtime < 60s | `ROLE=worker` (fit-analysis + portfolio-chat), 확장 가능 |
| crawler | python:3.13-slim + chromium | `${CRAWLER_HOST_PORT:-8010}` | `GET /health` | `./crawler/out` bind, `shm_size 1gb`, `init`, `restart: on-failure:5` |

talentfolio(:3000)는 별도 레포라 컨테이너화하지 않음 → 호스트에서 `npm run dev`, orchestrator-api 를 `localhost:3001` 로 호출.

## 네트워크 분리

```
[host 127.0.0.1] ─┬─ :3001 → orchestrator-api ─┐
                  ├─ :3002 → mcp-server ───────┤  backend: redis, mcp-server, orchestrator-api, orchestrator-worker×N
                  └─ :8010 → crawler           │
                              │  crawler 네트워크 (단독)
                              └─→ 인터넷 / Supabase (SUPABASE_DB_URL 직접)
```

| 네트워크 | 멤버 | 목적 |
|---|---|---|
| `backend` | redis, mcp-server, orchestrator-api, orchestrator-worker | 내부 서비스 통신 |
| `crawler` | crawler | egress + 호스트 publish 만. backend 이름 해석 불가 (검증됨) |

- 컨테이너에서 `AUTH_MODE=legacy` = **네트워크 내부에서는 Bearer 없이 userId 를 신뢰** (무인증). crawler 를 backend 와 분리해 완화한다.
  talentfolio Bearer 전환 전까지 backend 에 다른 서비스를 붙이지 말 것.

## 헬스체크 의미

- redis: `PING` 응답. mcp-server / orchestrator-api: HTTP 서버가 응답 (기능 정상까지는 아님).
- orchestrator-worker: 워커가 15초마다 `WORKER_HEARTBEAT_FILE` (기본 `/tmp/worker-heartbeat`, tmpfs) mtime 갱신 →
  60초 넘게 안 바뀌면 실패. 이벤트 루프 정지는 감지, BullMQ 내부 연결 끊김은 감지 못 함.
- crawler: `GET /health`.

## 런타임 하드닝

- node 이미지: 앱 파일(dist/node_modules/package.json) root 소유 + `USER node` → 코드 수정 불가. compose 에서 `read_only: true` + `tmpfs: /tmp`.
- crawler: `CRAWLER_API_KEY` 누락 등 설정 오류는 exit 1 → `on-failure:5` 로 무한 재시작 방지. node 서비스는 실패 원인이
  주로 일시적(redis/mcp 미기동)이라 `unless-stopped` 유지 (ROLE 은 compose 가 고정하므로 설정 오류 exit 가능성 낮음).
- crawler 자식 프로세스 env 허용목록에 `PLAYWRIGHT_BROWSERS_PATH` 포함 (없으면 /ms-playwright chromium 을 못 찾음).

## crawler 의존성 lock

- `crawler/requirements.txt` = 사람이 편집하는 원본, `crawler/requirements.lock` = 이미지 내부 `pip freeze` 결과 (Dockerfile 은 lock 으로 설치).
- 재생성: Dockerfile 설치 줄을 임시로 `pip install -r requirements.txt "playwright==<ver>"` 로 바꿔 빌드 →
  `docker run --rm --entrypoint pip <image> freeze > crawler/requirements.lock` (헤더 주석 유지) → 원복 후 재빌드.
  현재 crawl4ai 0.9.5, playwright 1.64.0.

## 환경변수 분리 (보안)

- node 서비스: 루트 `.env.local` (`env_file`). compose 가 덮어쓰는 값: `REDIS_URL=redis://redis:6379`,
  `MCP_SERVER_URL=http://mcp-server:3002/mcp`, `CORS_ALLOWED_ORIGINS` (기본 `http://localhost:3000,http://127.0.0.1:3000`
  — 이미지가 `NODE_ENV=production` 이라 dev 기본 CORS 가 꺼지기 때문).
- crawler: **`crawler/.env` 만**. Gemini/Anthropic/Slack 키 미전달 (검증됨).
- `TALENTFOLIO_URL` 은 브라우저/Slack 링크용이므로 `localhost` 값을 그대로 둔다.
- compose `env_file` 은 `"..."` 따옴표를 정상 제거함 (`LANGFUSE_BASE_URL` 유효 URL 확인). `docker run --env-file` 은 따옴표가 남으니 쓰지 말 것.

## 실행

```bash
docker compose up -d --build
docker compose up -d --scale orchestrator-worker=2     # 워커 확장
docker compose ps / logs -f orchestrator-api
docker compose down                                    # -v 는 redis 데이터까지 삭제
```

호스트 dev 서버(3001/3002/8010, redis 6379)와 같이 띄울 때는 포트·프로젝트명을 바꾼다 (redis 는 publish 안 해서 충돌 없음):

```bash
ORCHESTRATOR_HOST_PORT=13001 MCP_HOST_PORT=13002 CRAWLER_HOST_PORT=18010 \
  docker compose -p jdfit-verify up -d --build
```

## 한계 / 미검증

- `GEMINI_RPM` 리미터는 mcp-server 프로세스 단위 → mcp-server 를 확장하면 실제 RPM 이 배수가 됨. 확장하지 말 것.
- orchestrator-api 는 1개만: promotion `setInterval` 이 인스턴스마다 돈다. 같은 이유로 호스트 `ROLE=all` dev 서버와 같은 Redis 를 공유하지 말 것.
- crawler 이미지 약 2.84GB (chromium).
- 컨테이너 redis 는 호스트 redis 와 별개 → 호스트 dev 서버의 큐/캐시와 공유되지 않음.
- 실제 핏 분석 job 종단 테스트(LLM 호출·Supabase 쓰기)와 크롤 실행은 컨테이너에서 미검증.
- 워커 헬스체크는 heartbeat (이벤트 루프 생존) 수준. BullMQ 연결 끊김은 감지 안 됨.
- 후속: base image digest 고정, 서비스별 env 키 최소화.

## 문제 해결: Docker Desktop 이 `... dockerInference: The file cannot be accessed by the system` 으로 안 켜질 때

- 증상 (2026-10-25~26, 이 PC): 엔진이 비정상 종료된 뒤 남은 소켓 파일(0바이트 ReparsePoint)을 Windows 가 지우지 못해, 다음 기동 때마다 같은 오류로 꺼진다. **재부팅해도 파일이 남아 있어 해결되지 않았다.** `del`, `wsl --shutdown` 도 실패.
- 해결: Docker 를 완전히 끈 뒤 **파일이 아니라 폴더 이름을 바꾼다** (Docker 가 새 폴더를 만든다).
  - `%LOCALAPPDATA%\Docker\run` → `run.stale-<날짜>`
  - `%LOCALAPPDATA%\docker-secrets-engine` → `docker-secrets-engine.stale-<날짜>` (오류 메시지에 `engine.sock` 이 나오면)
- 오류 창의 **"Reset to factory defaults" 는 누르지 말 것** — "Quit" 선택. (2026-10-25 한 번 눌렸지만 이미지·볼륨은 남아 있었다.)
- 원인(엔진이 왜 자꾸 비정상 종료되는지)은 미확인. 6월부터 여러 번 기록됨.
