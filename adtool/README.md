# CYES 广告工作台

公司内网工具:自动广告批量开发 + 分站点否定词库。

## 目录

    adtool/
      server/    后端 Node + Express + SQLite
      web/       前端 React + Vite

## 首次安装

    cd server
    npm install
    copy .env.example .env      # 然后改掉里面的 SESSION_SECRET
    node src/seed.js kevin 凯文 你的密码

    cd ../web
    npm install

## 开发模式(两个终端)

    cd server && node src/index.js      # 后端 8080
    cd web    && npm run dev            # 前端 5173,发这个的 Network 地址给同事

## 正式模式(一个进程,推荐给同事用)

    cd web && npm run build
    cd ../server && node src/index.js   # 只开 8080,前端由它一起托管

## 角色

| 角色 | 开设广告 | 词库 | 账号管理 |
|---|---|---|---|
| owner    | 全部站点 | 全部站点可编辑 | 有 |
| admin    | 本国     | 本国可编辑     | 无 |
| operator | 本国     | 本国只读       | 无 |

## 备份

数据全在 server/data/ 目录。每天拷一份 adtool.db 到 Z 盘即可。
注意:数据库文件本身不能放在 Z 盘(SMB 文件锁不可靠,会损坏)。
