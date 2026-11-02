# jd-fit crawler HTTP server (python -m jdcrawler.server, :8010)
# Build context = crawler/.  .env / out/ / tests are excluded via .dockerignore.
# Base: python:3.13-slim + `playwright install --with-deps chromium` (same Python as local venv;
# smaller than mcr.microsoft.com/playwright/python which ships firefox/webkit too).
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# 재현성: requirements.lock (pip freeze 결과, playwright 포함) 로 설치. requirements.txt 는 사람이 편집하는 원본.
# lock 재생성: requirements.txt 수정 -> 아래 줄을 임시로 `pip install -r requirements.txt "playwright==<ver>"` 로 바꿔 빌드 ->
#   docker run --rm --entrypoint pip <image> freeze > requirements.lock (헤더 주석 유지) -> 원복 후 재빌드
COPY requirements.lock .
RUN pip install -r requirements.lock \
 && python -m playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 crawler \
 && mkdir -p /app/out \
 && chown -R crawler:crawler /app/out /ms-playwright

COPY --chown=root:root jdcrawler/ ./jdcrawler/
COPY --chown=root:root schemas/ ./schemas/

# Binds 0.0.0.0 inside the container only. Host exposure MUST be restricted by compose
# (ports: "127.0.0.1:8010:8010"). CRAWLER_API_KEY is required at runtime (fail-closed).
ENV CRAWLER_API_HOST=0.0.0.0 \
    CRAWLER_API_PORT=8010 \
    CRAWLER_ALLOW_NON_LOOPBACK=1

USER crawler
# Data (JSON/CSV, checkpoints, _history.json) — mount a volume here.
VOLUME ["/app/out"]
EXPOSE 8010
CMD ["python", "-m", "jdcrawler.server"]
