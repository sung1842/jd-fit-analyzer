# syntax=docker/dockerfile:1
# build context = 레포 루트:  docker build -f orchestrator/Dockerfile -t jdfit-orchestrator .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY orchestrator/package.json orchestrator/
RUN npm ci --workspace orchestrator --include-workspace-root=false
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY orchestrator/tsconfig.json orchestrator/
COPY orchestrator/src/ orchestrator/src/
RUN npm run build --workspace orchestrator
# shared/ 는 루트 package.json(type 미지정) 기준으로 CJS 로 컴파일되지만, 런타임엔 orchestrator/package.json(type: module)
# 아래에 놓여 ESM 으로 오인됨 → dist/shared 에 commonjs 마커를 둬서 원래 포맷으로 로드되게 한다
RUN echo '{"type":"commonjs"}' > orchestrator/dist/shared/package.json

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY orchestrator/package.json orchestrator/
RUN npm ci --workspace orchestrator --include-workspace-root=false --omit=dev && npm cache clean --force

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV ORCHESTRATOR_HOST=0.0.0.0
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/orchestrator/node_modules* orchestrator/node_modules/
COPY package.json ./
COPY orchestrator/package.json orchestrator/
COPY --from=build /app/orchestrator/dist orchestrator/dist
# 앱 파일은 root 소유 (런타임 사용자 node 는 코드 수정 불가)
USER node
EXPOSE 3001
CMD ["node", "orchestrator/dist/orchestrator/src/index.js"]
