# ============================================================
# AD-TOOL 生产镜像:前端打包产物 + 后端合成一个进程,只暴露一个端口
# 基础镜像用 Debian(bookworm),不受宿主机 CentOS 7 的 glibc 2.17 限制
# ============================================================

# 基础镜像地址。Docker Hub 连不上时(国内常见 DNS 污染),在 .env 里改成加速器地址,
# 例如 NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- 1. 打包前端 ----------
FROM ${NODE_IMAGE} AS web
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" && npm ci
COPY web/ ./
RUN npm run build

# ---------- 2. 装后端依赖 ----------
# better-sqlite3 是原生模块:优先下预编译包,下不到就现场编译,所以带上编译工具链
FROM ${NODE_IMAGE} AS deps
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app/server
# 兜底用的编译工具链:better-sqlite3 有预编译包时根本用不上。
# Debian 源在国内可能很慢甚至不通,所以限时 180s 且失败不中断构建。
RUN (timeout 180 apt-get update \
      && timeout 180 apt-get install -y --no-install-recommends python3 make g++) \
    || echo "[warn] 编译工具链未装上,继续 —— better-sqlite3 走预编译包时不受影响" ; \
    rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" && npm ci --omit=dev

# ---------- 3. 运行镜像 ----------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app/server
COPY --from=deps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
# index.js 里找的是 ../../web/dist,对应容器内 /app/web/dist
COPY --from=web /app/web/dist /app/web/dist

# 数据库和 session 全部落在 /data,由 compose 挂到宿主机目录
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
