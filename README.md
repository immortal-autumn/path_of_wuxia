# 云州江湖志

一个基于 Next.js 16、Node 内置 SQLite 和 WebSocket 的多人文字武侠游戏 demo。首次访问会自动生成并持久化独立角色；不同浏览器共享八方向网格地图、在线位置、世界动态和聊天消息。

初始地图从“嬴长嫚与楼夜秋之家 - 玄关”开始，屋外的楼门路向左通往约1110年的北宋，向右通往帕洛斯。内置种子只有一张连续大世界和一张完整单层住宅图，共4个区域、922个可达地点和930条路线；所有地点都能从玄关抵达。界面不使用地图背景图，地图、行动、角色和聊天均以最简单的白底边框布局显示。

## 本地运行

推荐使用 Node.js 24 LTS。

```bash
npm install
npm run dev
```

访问 <http://localhost:3000>。如果需要模拟多名玩家，可使用不同浏览器或普通窗口与隐私窗口分别访问。

地图中的地点使用紧凑长方形框显示，只加载当前地图内从当前位置出发三步可达的地点。实线框表示下一步可达，可以直接点击；地图下方的“下一步”栏也会列出明确的上、下、左、右及四个斜向按钮。同名道路由独立 ID 和网格坐标区分，完整名称与坐标显示在地图状态或编辑器选择项中。门、楼梯、道路、渡船和传送门等跨图连接只出现在行动栏，不占用八方向槽位。若右上角不是“江湖在线”，移动按钮会暂时禁用，等待 WebSocket 重连后即可继续。

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
npm run map:seed  # 幂等导入完整演示世界并校验
npm run map:validate # 校验来源、层级、方向槽与全图可达性
npm run map:seed-load -- --locations=50000 # 生成五万地点性能数据
```

## 角色、属性与修炼

角色有力量、敏捷、体质、根骨、悟性和精神六项基础属性。气血、派生耐力、最小/最大攻击、防御、速度、命中、闪避、暴击、暴伤和修炼速度都由服务器公式计算。移动和普通行动不检查也不消耗耐力。

境界依次为凡人、后天、先天、宗师、大宗师、炼气、筑基、金丹、元婴、化神、炼虚、合体和大乘，每个境界有12级。小等级奖励为 `2 + floor(境界序号 / 2)` 点属性；突破新境界奖励为 `12 + 3 × 新境界序号` 点，因此境界越高获得的属性点越多。属性分配永久保存，demo 不提供洗点。

从门厅经主卧向下走到同一层的修炼房即可开始修炼。在线和离线修为只按服务器时间结算且没有离线时长上限。境界第9至12级的突破成功率分别为45%、60%、75%和100%；失败扣除突破修为，成功保留30%修为并获得新境界属性点。

## 地图设计工具

访问 <http://localhost:3000/map-editor>，或在游戏世界状态栏点击“地图设计”。当前测试阶段允许所有有效玩家编辑共享地图。

- 地点拖放后自动吸附到最近的空网格。
- 普通路线只允许上、下、左、右、左上、左下、右上、右下八个相邻方向，并且每个方向最多一条。
- 可以新增、改名、调整父级和删除空的地图层；服务端会拒绝父子层循环。
- 普通路线只能连接同层相邻格；跨层目标可按地图层和名称搜索，再选择门、楼梯、电梯、关门、道路、渡船、地下城、快速传送或传送门。
- 大区域或公共区块由两分钟租约锁保护，每30秒续租；完成编辑后主动释放。
- 新增、移动、缩放和连接会自动保存，并支持当前租约内最近50步撤销/重做。
- 地图按9、25或49个空间区块加载；低缩放仅显示区域和区块聚合，详细响应最多返回1200个地点。

## 数据和配置

默认数据库为 `data/wuxia.db`，首次运行自动创建、迁移并幂等写入完整世界和行动种子。已有玩家、编辑内容和活动路线会在安全升级中保留。可以通过环境变量调整：

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

## 地图数据来源

种子地点都保存稳定 ID、来源键、来源 URL、内容版本和获取日期（2026-08-03）：

- 住宅为项目原创的21地点现代单层结构，前后庭、起居区、卧室、书房、工坊和1.5倍修炼房位于同一张平面图；住宅入口及三段楼门路另位于大世界。
- 北宋以[《宋朝行政区划》历史版本 39684822](https://zh.wikipedia.org/w/index.php?title=宋朝行政区划&oldid=39684822)为路、府、州、军依据，展开为24路和618个来源关联节点；游戏内“驿市”是为了八方向行走而增加的抽象连接点。
- 帕洛斯使用 [`fa0311/palworld-map` 的固定 `pin_data.json` 版本](https://github.com/fa0311/palworld-map/blob/31eb23472af96061ac868950a985f83ad5406298/public/pin_data.json)，保留267个公开标记来源键（57传送点、5高塔、43野外头目、123洞窟、39手记）；本 demo 不实现头目战斗。

运行 `npm run map:validate` 可重新检查最低地点数、所有来源关联、地图层循环、八方向坐标/互逆槽、跨层连接、修炼房和从玄关出发的全图可达性。

## 架构边界

当前实现面向一台持久化 Node 主机和一个应用进程。SQLite 以 WAL 模式运行，所有移动与行动使用短事务，实时层只发送增量事件，断线重连才发送完整快照。

未来扩展为多实例服务时，保留现有协议和游戏服务接口，将 SQLite 替换为 PostgreSQL 等共享数据库，并将进程内 WebSocket 广播替换为 Redis Pub/Sub 或专用实时服务即可。
