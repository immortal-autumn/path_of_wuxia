# 云州江湖志

一个基于 Next.js 16、Node 内置 SQLite 和 WebSocket 的多人文字游戏 demo。首次访问会自动生成角色；不同浏览器可以共享八方向网格地图、在线状态、世界动态和聊天消息。

初始地图从“嬴长嫚与楼夜秋之家 - 玄关”开始，屋外的楼门路向左通往大宋，向右通往帕洛斯。世界状态使用中国标准时间。

## 本地运行

推荐使用 Node.js 24 LTS。

```bash
npm install
npm run dev
```

访问 <http://localhost:3000>。如果需要模拟多名玩家，可使用不同浏览器或普通窗口与隐私窗口分别访问。

地图中的地点使用方形框显示。实线框表示下一步可达，可以直接点击；地图下方的“下一步”栏也会列出明确的上、下、左、右及斜向前往按钮。若右上角不是“江湖在线”，移动按钮会暂时禁用，等待 WebSocket 重连后即可继续。

局域网内通过普通 HTTP 和服务器 IP 访问时也可以移动和编辑地图；客户端不依赖仅在安全上下文中提供的 `crypto.randomUUID()`。

常用命令：

```bash
npm test          # 数据库与游戏规则测试
npm run test:e2e  # Playwright 全入口与功能测试
npm run test:all  # 单元测试与 Playwright 测试
npm run lint      # ESLint
npm run build     # Next.js 与自定义服务端生产构建
npm start         # 启动生产服务
npm run db:backup # 在线安全备份 SQLite
npm run map:seed-load -- --locations=50000 # 生成五万地点性能数据
```

## 地图设计工具

访问 <http://localhost:3000/map-editor>，或在游戏世界状态栏点击“地图设计”。当前测试阶段允许所有有效玩家编辑共享地图。

- 地点拖放后自动吸附到最近的空网格。
- 普通路线只允许上、下、左、右、左上、左下、右上、右下八个相邻方向，并且每个方向最多一条。
- 跨距离连接必须显式创建为传送门。
- 大区域或公共区块由两分钟租约锁保护，每30秒续租；完成编辑后主动释放。
- 新增、移动、缩放和连接会自动保存，并支持当前租约内最近50步撤销/重做。
- 地图按9、25或49个空间区块加载；低缩放仅显示区域和区块聚合，详细响应最多返回1200个地点。

## 数据和配置

默认数据库为 `data/wuxia.db`，首次运行自动创建、迁移并写入玄关世界和行动种子。可以通过环境变量调整：

```bash
DATABASE_PATH=/srv/wuxia/data/wuxia.db
PORT=3000
GAME_HOST=127.0.0.1
```

生产环境必须将 `DATABASE_PATH` 指向持久磁盘，并确保运行用户对目录有写权限。备份命令会使用 SQLite 在线备份 API，默认写入 `data/backups/`；也可以指定目标文件：

```bash
npm run db:backup -- /srv/backups/wuxia-$(date +%F).db
```

## 自托管

应用使用自定义 Node 服务在同一端口承载 Next.js 和 `/ws` WebSocket，不能部署到 Vercel 一类无常驻进程或无持久磁盘的环境。生产部署流程：

```bash
npm ci
npm run build
NODE_ENV=production DATABASE_PATH=/srv/wuxia/data/wuxia.db PORT=3000 GAME_HOST=127.0.0.1 npm start
```

建议使用 systemd、Docker 或其他进程管理器托管单个应用进程，并在前方放置 nginx。最小 nginx 配置如下：

```nginx
location /ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

进程收到 `SIGINT` 或 `SIGTERM` 时会停止 WebSocket、关闭 Next.js、执行 WAL checkpoint 并安全关闭数据库。

## 架构边界

当前实现面向一台持久化 Node 主机和一个应用进程。SQLite 以 WAL 模式运行，所有移动与行动使用短事务，实时层只发送增量事件，断线重连才发送完整快照。

未来扩展为多实例服务时，保留现有协议和游戏服务接口，将 SQLite 替换为 PostgreSQL 等共享数据库，并将进程内 WebSocket 广播替换为 Redis Pub/Sub 或专用实时服务即可。
