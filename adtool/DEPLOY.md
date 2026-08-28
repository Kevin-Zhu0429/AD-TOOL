# AD-TOOL 部署到公司服务器

目标机器:`192.168.53.9`(CentOS 7.5 / Docker 26.1.4 / Compose v2.27.1)

## 为什么走 Docker

服务器是 CentOS 7.5,glibc 是 2.17。本项目后端依赖 `better-sqlite3@13`,它要求 **Node ≥ 22**,
而 Node 18 以上的官方二进制都要 glibc ≥ 2.28 —— 直接在这台机器上装 Node 是跑不起来的
(硬装要么自己编译 glibc,要么编译 Node,都不值得)。

容器里用的是 Debian bookworm 基础镜像,自带新版 glibc,宿主机的 glibc 完全不参与,问题绕过去了。
Docker 和 Compose 服务器上已经装好,直接用即可。

## 架构

打包成**一个容器、一个端口**:

```
浏览器 ──> 服务器:8080 ──> 容器内 Node(Express 5)
                             ├── /api/*        后端接口
                             └── 其余路径      前端打包产物 web/dist(SPA 回退)
                                   └── SQLite 落在 /data(挂到宿主机 ./data-prod)
```

生产环境**没有 Vite dev server**,`vite.config.js` 里的 5173 端口和 `/api` 代理只在本地开发用。
后端 `src/index.js` 检测到 `web/dist` 存在就会自己托管前端,所以前后端不需要分开部署,
也不需要额外装 Nginx。

---

## 一、首次部署

### 1. 拉代码

仓库是私有的,服务器上要先有访问权。推荐用 Deploy Key(只绑这一个仓库、可设只读、不过期):

```bash
git --version || sudo yum install -y git          # CentOS 7 不一定预装

ssh-keygen -t ed25519 -C "adtool-server" -f ~/.ssh/adtool_deploy -N ""
cat ~/.ssh/adtool_deploy.pub                      # 整行复制
```

把输出整行贴到 GitHub 仓库页 → Settings → Deploy keys → Add deploy key,
**不要勾 Allow write access**(服务器只需要 pull)。然后:

```bash
cat >> ~/.ssh/config <<'EOF'

Host github-adtool
  HostName github.com
  User git
  IdentityFile ~/.ssh/adtool_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config

ssh -T git@github-adtool                          # 看到 "Hi ...! You've successfully authenticated" 即可
```

> 这一步超时的话,多半是公司防火墙封了出站 22 端口。把 config 里的 `HostName` 改成
> `ssh.github.com` 并加一行 `Port 443`,再试。

```bash
mkdir -p ~/apps && cd ~/apps
git clone git@github-adtool:Kevin-Zhu0429/AD-TOOL.git
cd AD-TOOL/adtool
```

也可以改用 Fine-grained Personal Access Token(仅勾选本仓库 + Contents: Read-only),
走 https 地址 clone,把 token 当密码输;缺点是有有效期,到期要换。

### 2. 写 .env

不用开编辑器,一条命令直接生成(`$(openssl rand -hex 32)` 会在写入时自动执行并填进去):

```bash
cat > .env <<EOF
HOST_PORT=8080
SESSION_SECRET=$(openssl rand -hex 32)
TZ=Asia/Shanghai
APP_UID=$(id -u)
APP_GID=$(id -g)
EOF
cat .env    # 确认 SESSION_SECRET 是一长串随机十六进制,APP_UID/APP_GID 是你的实际 uid
```

`APP_UID`/`APP_GID` 让容器内的进程用**你自己的身份**跑。镜像里默认的 node 用户是 uid 1000,
而服务器上 kevin 是 1067 —— 不对齐的话容器写不了数据库,启动就报 `SQLITE_CANTOPEN`。
用 `$(id -u)` 自动取值,不用手填。

`SESSION_SECRET` 必须填,留空 compose 会直接报错拒绝启动(故意的,防止用默认值上线)。

**这条命令只跑一次。** 重跑会生成新的随机串,所有人的登录态立刻失效需要重新登录。
后面要改别的项(比如 `HOST_PORT`),用 `vi .env`(`i` 进编辑,`Esc` 后 `:wq` 保存退出)
或者 `nano .env`(`Ctrl+O` 回车保存,`Ctrl+X` 退出),别整个重写。

### 3. 准备数据目录

仓库里 `server/data/adtool.db` 带着现有数据(15 个账号、4193 条词库、61 条 SKU),
第一次部署把它复制成生产数据:

```bash
mkdir -p data-prod
# 三个文件都要拷!-wal 里有 4MB 还没落盘的数据,只拷 .db 会丢
cp server/data/adtool.db server/data/adtool.db-wal server/data/adtool.db-shm data-prod/
ls -l data-prod    # 属主应该就是你自己,不需要 chown
```

目录是你建的,属主自然是你;容器又按 `APP_UID` 用同一个身份跑,两边对得上,
所以**不需要 `sudo chown`**。

> 拷之前确认开发机上的服务已经停了,否则拷到的可能是写了一半的状态。

如果想从空库开始,跳过 cp,启动后用第 6 步建管理员账号即可。

### 4. 构建并启动

```bash
docker compose build      # 第一次约 2-5 分钟,要下 npm 依赖
docker compose up -d
```

### 5. 验证

```bash
docker compose ps                 # STATUS 应该是 Up (healthy)
docker compose logs -f --tail=50  # 看到 [db] /data/adtool.db 和 [server] http://localhost:8080
curl http://localhost:8080/api/health
```

浏览器打开 `http://192.168.53.9:8080`。

### 6. 建超级管理员(只有从空库开始才需要)

```bash
docker compose exec adtool node src/seed.js kevin 凯文 你的密码
```

### 7. 放行端口

CentOS 7 上 Docker 会自己往 iptables 插 DOCKER 链,端口通常已经能通。
如果外部访问不了,再开 firewalld:

```bash
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
```

想让同事直接敲 `http://192.168.53.9` 不带端口,把 `.env` 里改成 `HOST_PORT=80`,
然后 `docker compose up -d` 重建容器即可(容器内部端口不用动)。

---

## 二、日常更新

```bash
cd ~/apps/AD-TOOL
git pull
cd adtool
docker compose up -d --build
```

`data-prod/` 不在 git 里,`git pull` 不会碰生产数据。
数据库结构变更由 `src/db.js` 的 `migrate()` 在每次启动时自动跑,不用手工执行 SQL。

> 注意:`server/data/adtool.db` 目前还在 git 里跟踪着。它**只在第一次部署时用来打底**,
> 之后 `git pull` 拉下来的是别人提交的旧快照,和生产数据无关,不要再往 `data-prod` 拷。
> 建议后续把它从 git 里摘掉(见文末)。

## 三、备份

数据全部在 `data-prod/` 一个目录里。加一条 crontab 每天 2 点打包,保留 14 天:

```bash
crontab -e
```

```
0 2 * * * cd /home/kevin/apps/AD-TOOL/adtool && tar czf ~/adtool-backup/$(date +\%F).tar.gz data-prod && find ~/adtool-backup -name '*.tar.gz' -mtime +14 -delete
```

```bash
mkdir -p ~/adtool-backup
```

热备(容器在跑的时候)更稳妥的做法是用 sqlite 的在线备份,避免抓到 WAL 中间态:

```bash
docker compose exec adtool node -e "
  const D=require('better-sqlite3');
  new D('/data/adtool.db').backup('/data/backup-'+new Date().toISOString().slice(0,10)+'.db');
"
```

恢复:停容器 → 用备份覆盖 `data-prod/adtool.db`(同时删掉 `-wal`/`-shm`)→ 启容器。

## 四、常用运维命令

```bash
docker compose logs -f --tail=100    # 看日志
docker compose restart               # 重启
docker compose down                  # 停掉(数据不受影响)
docker compose up -d                 # 起来
docker compose exec adtool sh        # 进容器
docker image prune -f                # 清理旧镜像层,省磁盘
```

服务器根分区已用 88%(剩 218G),镜像每次重建会留旧层,记得偶尔 `docker image prune`。

## 五、服务器连不上外网怎么办

构建需要访问 npm registry 和 Docker Hub。如果公司网络限制:

**方案 A:换国内源**。在 `Dockerfile` 三个 `npm ci` 之前加一行:

```dockerfile
RUN npm config set registry https://registry.npmmirror.com
```

**方案 B:本地构建,导过去**。在能上网的机器上:

```bash
cd adtool
docker build -t adtool:latest .
docker save adtool:latest | gzip > adtool.tar.gz
scp adtool.tar.gz kevin@192.168.53.9:~/
```

服务器上:

```bash
gunzip -c ~/adtool.tar.gz | docker load
# 然后把 docker-compose.yml 里的 build: 那几行注释掉,只留 image: adtool:latest
docker compose up -d
```

## 六、几个已知事项

- **Cookie 是 `secure: false`**(`src/index.js`)。内网 HTTP 下必须这样,否则登录态发不出去。
  将来如果套 HTTPS 域名,记得把它改成 `true`,并加上 `app.set('trust proxy', 1)`。
- **端口 8080 直接对内网开放**,没有反代、没有 HTTPS。内网工具够用;
  要是以后需要域名或证书,在前面加一层 Nginx 反代到 `127.0.0.1:8080` 即可,应用不用改。
- **建议把数据库从 git 里摘掉**。数据库进版本库会导致多人协作时二进制冲突,而且 4MB 的 WAL
  每次改动都要重传。建议:

  ```bash
  git rm --cached server/data/adtool.db server/data/adtool.db-wal server/data/adtool.db-shm
  echo "adtool/server/data/" >> ../.gitignore
  git commit -m "chore: 数据库不再进版本库"
  ```

  做之前先确保生产 `data-prod/` 已经有数据、并且有一份备份 —— 摘掉之后 git 里就不再有兜底副本了。
