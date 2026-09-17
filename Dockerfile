# syntax=docker/dockerfile:1
# Nuvyn 的多阶段构建 —— 一个 Vue 3 + Hono Personal OS。
#
# 阶段 1（deps）：安装全部依赖（包括 devDependencies），因为后面要跑 `vite build`。
# better-sqlite3 的原生构建步骤在 Node 基础镜像之外还需要 python3 + make + g++。
#
# 阶段 2（build）：在 dist/ 生成静态资源包。
#
# 阶段 3（runtime）：只拷入产线 node_modules、预构建好的 dist/、server/ 和 shared/ 源码、tsx
#（用来跑 server/prod.ts）。以非 root 用户身份运行，单端口同时服务 SPA 和
# Hono 的 /api/* 接口。
#
# 构建加速要点：
# - `RUN --mount=type=cache,...` 是 BuildKit 的缓存挂载，挂载点的内容**不进入最终镜像**，
#   只存在构建缓存里，多次构建之间共享。改 apt 源、换依赖都不需要 `--no-cache`。
# - 之前 `rm -rf /var/lib/apt/lists/*` 是为了压小镜像；现在那目录挂在 cache mount 上，
#   不进镜像，留着反而能跨构建复用索引。

# ---------- 1. 安装依赖 ----------
FROM node:22-bookworm-slim AS deps

# better-sqlite3 走 node-gyp 时需要的原生工具链。
# 不装这几个，`npm ci` 在尝试装可选依赖时会失败。
# 顺手把 apt 源换成阿里云镜像：默认的 deb.debian.org 在国内极慢，
# 单这一步就要 10+ 分钟。换回官方源只需把镜像 URL 改回 https://deb.debian.org。
# 用 for 循环覆盖所有可能的 apt 源文件位置（新 deb822 格式和老 one-line 格式都试），
# 之前只 sed /etc/apt/sources.list 和 *.sources 时碰到其它位置会静默失败。
# 分隔符用 # 而不是 |：GNU sed 的 s-命令不会跳过 (deb|security) 里的 |，
# 会把它当成结束分隔符，模式就被截断了。
# 源用 http 而非 https：bookworm-slim 不带 ca-certificates，HTTPS 校验过不去；
# 包有 GPG 签名，apt 验签不靠 TLS，构建期用 HTTP 是安全的。
# sharing=locked 防止并发构建写到同一缓存造成损坏。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    set -e; \
    for f in /etc/apt/sources.list \
             /etc/apt/sources.list.d/debian.sources \
             /etc/apt/sources.list.d/*.list \
             /etc/apt/sources.list.d/*.sources; do \
        if [ -f "$f" ]; then \
            sed -i -E 's#https?://(deb|security)\.debian\.org#http://mirrors.aliyun.com#g' "$f"; \
        fi; \
    done; \
    apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates

WORKDIR /app

# 用 lockfile 安装，确保产线镜像可复现。
# `--ignore-scripts` 会跳过 better-sqlite3 的原生编译 —— 如果后面再补一次带工具链
# 的安装也行，但直接在这里让 install 脚本跑更简单，runtime 阶段拷过去就是一份能跑的工作目录。
# cache mount /root/.npm 跨构建复用下载的包（不会复用编译产物 —— npm ci 总是清空 node_modules
# 再装，所以 better-sqlite3 的 node-gyp 每次都要重跑。优化它要换包管理器（pnpm）或自维护一份
# node_modules 基础镜像，超出本 Dockerfile 范围）。
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ---------- 2. 构建前端 ----------
FROM deps AS build

# 类型检查 + 打包 SPA。vue-tsc -b 跑 tsconfig.app.json 里的 project references；
# 之后 vite 把产物输出到 dist/。
COPY tsconfig*.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY server ./server
COPY shared ./shared
RUN npm run build

# 砍掉 dev 依赖，让 runtime 镜像只带启动 server/prod.ts（通过 tsx）真正需要的包。
RUN npm prune --omit=dev

# ---------- 3. 运行阶段 ----------
FROM node:22-bookworm-slim AS runtime

# tini 提供正确的 SIGTERM/SIGINT 处理，这样 `docker stop` 时 Node 进程不会被半路截断。
# ca-certificates 让 Node 调用已配置的 AI API 时能正常校验 TLS 证书。
# git 是 server/history/* 功能的运行时依赖 —— vault 的本地 history 面板通过
# `spawn('git', ...)` 调 git 子命令(rev-parse / log / show / add / commit /
# checkout),不在 runtime 装 git 的话 history 路由会全部 503 (`GitUnavailableError`)。
# bookworm-slim 上 git 包 ~21MB,换来 history 功能完整可用,值得。
# 同上：apt 源换成阿里云镜像，覆盖所有可能的源文件位置。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    set -e; \
    for f in /etc/apt/sources.list \
             /etc/apt/sources.list.d/debian.sources \
             /etc/apt/sources.list.d/*.list \
             /etc/apt/sources.list.d/*.sources; do \
        if [ -f "$f" ]; then \
            sed -i -E 's#https?://(deb|security)\.debian\.org#http://mirrors.aliyun.com#g' "$f"; \
        fi; \
    done; \
    apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates git

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# 复用基础镜像自带的 `node` 用户（uid/gid 1000），不要新 groupadd/useradd 一个 —
# 名字 `node` 在 node:22-bookworm-slim 里已经被占用了。docker-compose.yml 里的
# `user: "1000:1000"` 与之对应。
WORKDIR /app
RUN chown -R node:node /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/package.json ./package.json

# data/ 放 SQLite 的 WAL；它包含 settings、加密 AI 凭据、会话历史和应用元数据。
# src/content/ 是 markdown 笔记库 —— 两者在 docker-compose 里都挂成了卷。
RUN mkdir -p /app/data /app/src/content && chown -R node:node /app/data /app/src/content

USER node
EXPOSE 3000

# /api/health 是 Hono 应用最便宜的端点，正好给 compose 的 `healthcheck:` 和
# 外部负载均衡器用。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# Keep the actual Nuvyn Node process as tini's direct child. An npm/tsx
# launcher chain can consume Docker's SIGTERM before it reaches prod.ts,
# preventing the Vault writer ownership file from being released.
CMD ["node", "--import", "tsx", "server/prod.ts"]
