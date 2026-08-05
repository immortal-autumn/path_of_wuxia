# 云州江湖志

云州江湖志是一个可自托管的文字武侠游戏 demo。它使用 Next.js、Node.js、SQLite 和 WebSocket，提供持久角色、八方向连续地图、现实时间行动、修炼、战斗、店铺、市易行会以及可选的 NPC 控制进程。

这是一个适合本地体验、规则验证和继续开发的 demo，不是已经完成的商业服务。生产部署前请完成身份、备份、反向代理和容量评估。

## 五分钟启动

需要 Node.js 24 LTS、npm 和可写的本地目录。

```bash
npm ci
npm run dev
```

打开 <http://localhost:3000>。首次访问会创建一个浏览器专属角色并从“嬴长嫚与楼夜秋之家·玄关”开始。使用不同浏览器或隐私窗口即可模拟不同用户；浏览器会保存 HttpOnly session cookie。

开发服务同时承载网页和 `/ws` WebSocket。局域网通过普通 HTTP 访问时，移动和地图编辑仍可用。

## 游戏内容

- 地图是没有背景图片的连续平面。节点使用简短的矩形名称框，普通路线只允许上、下、左、右及四个斜向共八个方向。
- 当前地点附近默认展示三步内的可达地点；“足迹地图”可以查看本人已经到过的地图、路线和快速旅行枢纽。轻功可抵达的位置使用特殊边框标示。
- 角色有力量、敏捷、体质、根骨、悟性和精神六项属性。气血、攻击、防御、速度等战斗值由服务端公式计算；境界提升会获得更多属性点。
- 修炼房会按服务器时间自动积累修为，达到条件后可以突破境界。主动技能立即发动并进入冷却，被动技能显示在角色属性栏中。
- 行动支持一个当前行动和最多八个排队行动。每个行动显示耗时、检定、成本、冷却和结果；取消或离线后仍由服务端按时间结算。
- 开封地图按道路、城门、河桥、宫城、寺院、官署、店铺和单层建筑组织。宋式店铺有营业时间、有限库存和柜上现金；市易行会提供文计价的现货及衍生品。
- 同地点角色可以问候、交往、切磋、交易和接取委托。战斗、掉落、法度和同意规则全部在服务端校验。

## 常用命令

```bash
npm run dev             # 开发服务（网页 + WebSocket）
npm run build           # 生产构建
npm start               # 启动生产服务
npm test                # 单元测试
npm run test:e2e        # Playwright 测试
npm run test:all        # lint、类型检查、地图校验、单元与 E2E 测试
npm run lint            # ESLint
npx tsc --noEmit        # TypeScript 检查
npm run map:validate    # 校验地图来源、方向、层级和可达性
npm run map:seed        # 幂等导入演示地图（会写入 DATABASE_PATH）
npm run db:backup -- ./backup.db  # SQLite 在线备份
npm run smoke:live      # 对已启动服务执行健康和协议 smoke test
```

`npm run map:seed` 会保留玩家数据和编辑器中标记为自定义的内容；执行前仍建议先备份数据库。

## 地图设计工具

访问 <http://localhost:3000/map-editor>，或从游戏世界状态栏进入“地图设计”。开发环境默认允许编辑；生产环境只允许 editor/admin 角色、`EDITOR_PLAYER_IDS` 中的角色，或显式设置 `EDITOR_ALLOW_ALL=true` 的受控实例。

- 拖放地点会吸附到网格；普通路线必须连接同一地图层的八方向相邻格，每个方向最多一条。
- 跨层入口使用门、楼梯、道路、渡船或传送门等明确的过渡类型，不占用普通八方向槽位。
- 大区域编辑使用租约锁，修改自动保存并支持租约内撤销/重做。地图编辑结果会持久覆盖内置种子，重启和重新导入不会恢复已删除或改名的内容。

## 行动规则工具

访问 <http://localhost:3000/action-editor>。生产环境可读取规则，但创建、修改、停用和地点绑定需要 editor/admin 权限。

行动模板包含耗时、分类、目标、可见性、检定、需求、成本、成功/失败结果、技能效果持续时间和冷却。输入使用服务端白名单校验，不能执行任意 JavaScript 或 SQL；正在队列中使用的规则不能停用。

## 可选 NPC 控制进程

游戏服务和 NPC runner 是两个独立进程。先构建并启动服务，再启动 runner：

```bash
npm run build
npm start
npm run npc:start
```

`npc:start` 默认建立与持久居民数量相同的隔离 WebSocket actor。每个 actor 使用独立凭证，只能发送白名单内的移动、行动、战斗和拾取指令；服务端仍是唯一权威。开发时可用 `npm run npc:dev`。

商贸 actor 使用更严格的独立通道：

```bash
npm run npc:trade:start
npm run npc:trade:replay -- --decision=<决策ID>
```

商贸通道不能读取普通游戏快照、移动、聊天、战斗或编辑地图。外部策略服务（若配置）只能返回受限的下单、撤单或观望结果；无效或超时响应会回退到内置确定性策略。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DATABASE_PATH` | `data/wuxia.db` | SQLite 数据库路径，生产环境必须位于持久磁盘 |
| `PORT` | `3000` | HTTP/WebSocket 端口 |
| `GAME_HOST` | `0.0.0.0` | 监听地址 |
| `PUBLIC_ORIGIN` | 开发环境自动推断 | 生产环境必填，用于安全的来源和重定向校验 |
| `NPC_RUNNER_SECRET` | 无 | 游戏 NPC runner 与服务端共享的密钥 |
| `NPC_TRADE_RUNNER_SECRET` | 无 | 商贸 runner 与服务端共享的密钥 |
| `NPC_COUNT` | 内置居民数 | 游戏 NPC actor 数量（开发/压测可减少） |
| `NPC_TRADE_COUNT` | 内置居民数 | 商贸 actor 数量 |
| `NPC_TRADE_INTERVAL_MS` | `300000` | 商贸 actor 的最小循环间隔 |
| `NPC_SERVER_URL` | `ws://127.0.0.1:<PORT>/ws` | runner 连接的 WebSocket 地址 |
| `NPC_CONTROLLER_URL` | 未设置 | 可选的外部 NPC 决策 HTTP 服务 |
| `NPC_TRADE_STRATEGY_URL` | 未设置 | 可选的外部商贸策略 HTTP 服务 |
| `OIDC_PROXY_SECRET` | 未设置 | 可信反向代理身份绑定密钥 |
| `EDITOR_PLAYER_IDS` | 空 | 允许编辑地图和行动规则的角色 ID（逗号分隔） |
| `EDITOR_ALLOW_ALL` | 开发环境开启 | 受控实例中临时开放编辑权限 |

生产环境至少设置 `DATABASE_PATH`、`PORT`、`PUBLIC_ORIGIN`、两个 runner secret，并将密钥放入进程管理器的 secret store，不要提交到 Git。

## 生产自托管

应用需要常驻 Node 进程、持久磁盘和 WebSocket 反向代理，不能部署到无状态或无法升级 WebSocket 的托管环境。

```bash
npm ci
npm run build
NODE_ENV=production \
  DATABASE_PATH=/srv/wuxia/data/wuxia.db \
  PORT=3000 GAME_HOST=127.0.0.1 \
  PUBLIC_ORIGIN=https://wuxia.example.com \
  NPC_RUNNER_SECRET='use-a-long-random-secret' \
  NPC_TRADE_RUNNER_SECRET='use-another-long-random-secret' \
  npm start
```

反向代理需要把 `/ws` 的 `Upgrade` 和 `Connection: upgrade` 头转发到同一端口，并传递正确的 `Host`、`X-Forwarded-Proto`。只有受信任的代理可以写入身份和客户端地址相关的 forwarded headers。应用关闭时会停止 WebSocket、checkpoint WAL 并关闭数据库。

备份示例：

```bash
npm run db:backup -- /srv/backups/wuxia-$(date +%F).db
```

建议定期验证备份可读，限制数据库目录权限，并在公开部署前运行完整测试和 `npm audit --omit=dev`。

## 数据来源与许可

住宅与游戏规则为项目原创。开封地图参考公有领域的[《东京梦华录》](https://zh.wikisource.org/wiki/東京夢華錄)、[北宋东京城遗址](https://zh.wikipedia.org/wiki/北宋东京城遗址)资料及旧版地图的相对布局；道路和店铺名称经过项目化整理，历史记录与推定内容在地点说明中区分。

具体来源、版本、获取日期和第三方许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。项目代码以 [MIT License](./LICENSE) 发布。

## 架构边界

当前实现面向一台持久化 Node 主机和一个应用进程。SQLite 使用 WAL，游戏命令在短事务中执行，WebSocket 发送增量更新，断线重连后再发送完整快照。若未来扩展多实例，可在保持协议边界的前提下替换为共享数据库和独立实时广播层。

## 贡献与问题反馈

请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。提交功能改动时同步更新 `FUNCTIONS.md` 并增加自动化测试；安全问题请勿在公开 issue 中披露完整利用细节。
