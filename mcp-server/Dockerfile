# syntax=docker/dockerfile:1
# build context = 레포 루트:  docker build -f mcp-server/Dockerfile -t jdfit-mcp-server .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY mcp-server/package.json mcp-server/
RUN npm ci --workspace mcp-server --include-workspace-root=false
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY mcp-server/tsconfig.json mcp-server/
COPY mcp-server/src/ mcp-server/src/
RUN npm run build --workspace mcp-server
# shared/ 는 루트 package.json(type 미지정) 기준으로 CJS 로 컴파일되지만, 런타임엔 mcp-server/package.json(type: module)
# 아래에 놓여 ESM 으로 오인됨 → dist/shared 에 commonjs 마커를 둬서 원래 포맷으로 로드되게 한다
RUN echo '{"type":"commonjs"}' > mcp-server/dist/shared/package.json

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY mcp-server/package.json mcp-server/
RUN npm ci --workspace mcp-server --include-workspace-root=false --omit=dev && npm cache clean --force

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_SERVER_PORT=3002
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/mcp-server/node_modules* mcp-server/node_modules/
COPY package.json ./
COPY mcp-server/package.json mcp-server/
COPY --from=build /app/mcp-server/dist mcp-server/dist
# 앱 파일은 root 소유 (런타임 사용자 node 는 코드 수정 불가)
USER node
EXPOSE 3002
CMD ["node", "mcp-server/dist/mcp-server/src/index.js"]
