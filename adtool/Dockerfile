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
FROM ${NODE_IMAGE} AS deps
ARG NPM_REGISTRY=https://registry.npmjs.org
# Debian 源。官方 deb.debian.org 在国内基本拉不动,换成 http://mirrors.aliyun.com 之类。
# 留空则用镜像自带的官方源。
ARG DEBIAN_MIRROR=
# node-gyp 编译时要下 Node 头文件,默认从 nodejs.org 取。慢的话换国内镜像。
ARG NODE_DISTURL=
WORKDIR /app/server

# better-sqlite3 是原生模块。它的预编译包托管在 GitHub Releases 上,国内下不到时
# 会退回源码编译,所以这套工具链是必需的 —— 装不上就该在这里失败,
# 而不是拖到 npm ci 那步报一句莫名其妙的「找不到 Python」。
RUN if [ -n "$DEBIAN_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org|$DEBIAN_MIRROR|g" \
        /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY server/package.json server/package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" \
 && if [ -n "$NODE_DISTURL" ]; then npm config set disturl "$NODE_DISTURL"; fi \
 && npm ci --omit=dev

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
