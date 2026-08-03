import { directionBetween, OPPOSITE_DIRECTION } from "./map";
import { PALWORLD_MARKER_COORDINATES } from "./palworld-coordinates";
import type { Direction, RouteType, TransitionKind } from "./types";

export const WORLD_SEED_REVISION = 5;
export const WORLD_SEED_RETRIEVED_AT = "2026-08-03";

export type WorldSeedSource = {
  id: string;
  title: string;
  url: string;
  contentVersion: string;
  retrievedAt: string;
  notes: string;
};

export type WorldSeedLayer = {
  id: string;
  name: string;
  description: string;
  parentLayerId: string | null;
};

export type WorldSeedRegion = {
  id: string;
  layerId: string;
  name: string;
  description: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorldSeedLocation = {
  id: string;
  layerId: string;
  name: string;
  description: string;
  regionId: string | null;
  gridX: number;
  gridY: number;
  sourceId: string;
  sourceKey: string;
  trainingMultiplier?: number;
};

export type WorldSeedRoute = {
  id: string;
  fromLocation: string;
  toLocation: string;
  routeType: RouteType;
  transitionKind: TransitionKind | null;
  fromDirection: Direction | null;
  toDirection: Direction | null;
};

export type WorldSeedAction = {
  id: string;
  locationId: string;
  name: string;
  description: string;
  silverDelta: number;
  hpDelta: number;
  resultTemplate: string;
};

export type WorldSeedData = {
  sources: WorldSeedSource[];
  layers: WorldSeedLayer[];
  regions: WorldSeedRegion[];
  locations: WorldSeedLocation[];
  routes: WorldSeedRoute[];
  actions: WorldSeedAction[];
  baseLocationSources: Array<{ locationId: string; sourceId: string; sourceKey: string }>;
};

const SONG_CIRCUITS = [
  ["jingji", "京畿路", ["开封府"], [-14, 0]],
  ["jingdong-east", "京东东路", ["青州", "密州", "沂州", "登州", "莱州", "潍州", "淄州"], [-4, -8]],
  ["jingdong-west", "京东西路", ["应天府", "兖州", "徐州", "曹州", "郓州", "济州", "单州", "濮州"], [-16, -8]],
  ["jingxi-south", "京西南路", ["襄州", "邓州", "随州", "金州", "房州", "均州", "郢州", "唐州", "光化军"], [-28, 12]],
  ["jingxi-north", "京西北路", ["河南府", "颍昌府", "郑州", "滑州", "孟州", "蔡州", "陈州", "颍州", "汝州", "信阳军"], [-27, 0]],
  ["hebei-east", "河北东路", ["大名府", "开德府", "河间府", "沧州", "冀州", "博州", "棣州", "莫州", "雄州", "霸州", "德州", "滨州", "恩州", "清州", "信安军", "保定军"], [-10, -24]],
  ["hebei-west", "河北西路", ["真定府", "中山府", "信德府", "庆源府", "相州", "浚州", "怀州", "卫州", "磁州", "深州", "祁州", "保州", "邢州", "赵州"], [-24, -24]],
  ["hedong", "河东路", ["太原府", "隆德府", "平阳府", "府州", "绛州", "泽州", "代州", "忻州", "汾州", "辽州", "宪州", "岚州", "石州", "隰州", "慈州", "麟州", "火山军", "宁化军", "岢岚军", "保德军"], [-40, -24]],
  ["yongxing", "永兴军路", ["京兆府", "河中府", "延安府", "庆阳府", "同州", "华州", "耀州", "陕州", "邠州", "宁州", "坊州", "鄜州", "丹州", "环州", "银州", "醴州", "保安军", "定边军", "绥德军", "清平军"], [-52, -10]],
  ["qinfeng", "秦凤路", ["凤翔府", "秦州", "陇州", "泾州", "渭州", "原州", "熙州", "河州", "岷州", "兰州", "阶州", "成州", "西宁州", "镇戎军", "通远军"], [-68, -10]],
  ["huainan-east", "淮南东路", ["扬州", "亳州", "宿州", "楚州", "海州", "泰州", "泗州", "滁州", "真州", "通州"], [-10, 15]],
  ["huainan-west", "淮南西路", ["寿春府", "庐州", "舒州", "蕲州", "和州", "濠州", "光州", "黄州", "六安军", "无为军", "安庆军", "广德军", "镇巢军", "怀远军"], [-22, 15]],
  ["liangzhe", "两浙路", ["杭州", "越州", "湖州", "婺州", "明州", "温州", "台州", "处州", "衢州", "睦州", "秀州", "常州", "苏州", "润州"], [-5, 28]],
  ["jiangnan-east", "江南东路", ["江宁府", "宣州", "徽州", "池州", "饶州", "信州", "太平州", "南康军", "广德军东境", "铅山场"], [-17, 29]],
  ["jiangnan-west", "江南西路", ["洪州", "虔州", "吉州", "袁州", "抚州", "筠州", "兴国军", "临江军", "南安军", "建昌军"], [-30, 30]],
  ["jinghu-north", "荆湖北路", ["江陵府", "鄂州", "复州", "澧州", "峡州", "归州", "岳州", "辰州", "沅州", "荆门军"], [-36, 21]],
  ["jinghu-south", "荆湖南路", ["潭州", "衡州", "道州", "永州", "郴州", "邵州", "全州", "桂阳监"], [-37, 36]],
  ["fujian", "福建路", ["福州", "建州", "泉州", "南剑州", "漳州", "汀州", "邵武军", "兴化军"], [-7, 42]],
  ["chengdu", "成都府路", ["成都府", "眉州", "蜀州", "彭州", "绵州", "汉州", "嘉州", "邛州", "简州", "黎州", "雅州", "茂州"], [-61, 22]],
  ["zizhou", "梓州路", ["潼川府", "遂州", "果州", "资州", "普州", "昌州", "叙州", "泸州", "合州", "荣州", "渠州", "长宁军"], [-51, 28]],
  ["lizhou", "利州路", ["兴元府", "利州", "洋州", "阆州", "剑州", "巴州", "文州", "龙州", "蓬州", "政州"], [-55, 8]],
  ["kuizhou", "夔州路", ["夔州", "黔州", "施州", "忠州", "万州", "开州", "达州", "涪州", "渝州", "珍州", "南平军", "云安军"], [-43, 28]],
  ["guangnan-east", "广南东路", ["广州", "韶州", "循州", "潮州", "连州", "梅州", "南雄州", "英州", "贺州", "封州", "端州", "新州", "康州", "惠州"], [-18, 51]],
  ["guangnan-west", "广南西路", ["桂州", "容州", "邕州", "融州", "象州", "昭州", "梧州", "藤州", "龚州", "浔州", "柳州", "贵州", "宾州", "横州", "化州", "高州", "雷州", "钦州", "廉州", "琼州"], [-34, 53]],
] as const;

const PAL_FAST_TRAVEL = [
  "初始台地", "飞龙密域", "海风群岛·漂流者海滩", "探索者岔路", "草巨兽山陵", "竹林深处", "海风群岛教堂", "要塞遗迹", "雷恩盗猎团高塔入口", "小海湾",
  "小青龙海滨", "被遗忘的岛屿教堂遗址", "火山脚", "冰鸟密域", "雷鸣龙密域", "被遗忘的岛屿", "破败教堂", "寒风呼啸之岛", "修行者瀑布", "小型聚落",
  "剑豪密域", "溪谷入口", "彩蝶之森", "湿地之岛", "湿地岛教堂遗址", "天然陆桥", "东方荒岛", "跳岛海岸", "小鲨鱼地盘", "叶胖达之森",
  "古老祭祀场", "双骑士大桥", "神速密域", "花兔山山顶", "湖心", "帕鲁保护团体高塔入口", "通往雪山的岔路", "守护者密域", "生者禁入山道", "冷水海滨",
  "冰鼬之丘", "不溶湖", "纯白雪原", "伪善者之丘", "黑曜火山阿努比斯像", "永炎同心会高塔入口", "常夏海滨", "边远渔村", "古代文明遗址", "黑曜火山中腹",
  "毁灭要塞都市", "基因研究部队高塔入口", "绝对零度之地", "沙丘入口", "沙漠之镇", "自卫团高塔入口", "沙丘深处",
] as const;

const PAL_TOWERS = ["雷恩盗猎团高塔", "帕鲁保护团体高塔", "自卫团高塔", "基因研究部队高塔", "永炎同心会高塔"] as const;

const PAL_FIELD_BOSSES = [
  "森猛犸 Lv38", "疾旋鼬 Lv11", "企丸王 Lv15", "君王美露帕 Lv23", "毛掸儿 Lv23", "碧海龙 Lv17", "浪刃武士 Lv23", "雷角马 Lv31", "花丽娜 Lv11", "秘斯媞雅 Lv32",
  "海誓龙 Lv23", "绸笠蛾 Lv11", "覆海龙 Lv30", "云海鹿 Lv25", "派克龙 Lv31", "覆海龙 Lv45", "迅雷鸟 Lv29", "烽歌龙 Lv23", "阿努比斯 Lv47", "荷鲁斯 Lv18",
  "海象兽 Lv14", "夜幕魔蝠 Lv23", "空涡龙 Lv50", "魔渊龙 Lv48", "焰煌 Lv49", "花冠龙 Lv28", "天羽龙 Lv30", "女皇蜂 Lv31", "铠格力斯 Lv30", "猫蝠怪 Lv17",
  "暴电熊 Lv31", "绿苔绒怪 Lv38", "覆海龙·东 Lv45", "踏春兔 Lv35", "白绒雪怪 Lv40", "百合女王 Lv38", "冥铠蝎 Lv44", "朱雀 Lv45", "波鲁杰克斯 Lv47", "圣光骑士 Lv50",
  "唤夜兽 Lv49", "冰棘兽 Lv46", "唤冬兽 Lv50",
] as const;

const PAL_CATEGORIES = [
  ["travel", "帕洛斯传送点", "公开地图中的传送点与主要地标。"],
  ["towers", "帕洛斯高塔", "各组织高塔及其入口。"],
  ["bosses", "帕洛斯野外头目", "公开地图中的野外头目地点。"],
  ["dungeons", "帕洛斯洞窟", "公开地图中的123处洞窟入口。"],
  ["memos", "帕洛斯手记", "漂流者与高塔首领留下的39份手记。"],
] as const;

function compactSerpentine(index: number, count: number, centerX: number, centerY: number) {
  const width = Math.ceil(Math.sqrt(count));
  const height = Math.ceil(count / width);
  const row = Math.floor(index / width);
  const column = index % width;
  const startX = centerX - Math.floor(width / 2);
  const startY = centerY - Math.floor(height / 2);
  return {
    gridX: row % 2 === 0 ? startX + column : startX + (width - 1 - column),
    gridY: startY + row,
  };
}

function coordinateToken(value: number) {
  return value < 0 ? `m${Math.abs(value)}` : `p${value}`;
}

export function buildWorldSeed(): WorldSeedData {
  const sources: WorldSeedSource[] = [
    {
      id: "source-home-design",
      title: "嬴长嫚与楼夜秋之家设计稿",
      url: "project://path-of-wuxia/home-v1",
      contentVersion: "home-v2",
      retrievedAt: WORLD_SEED_RETRIEVED_AT,
      notes: "项目原创现代单层住宅结构；庭院、起居、卧室与修炼功能位于同一平面。",
    },
    {
      id: "source-song-wikipedia",
      title: "维基百科：宋朝行政区划",
      url: "https://zh.wikipedia.org/w/index.php?title=宋朝行政区划&oldid=39684822",
      contentVersion: "revid-39684822@2016-04-11T06:09:51Z",
      retrievedAt: WORLD_SEED_RETRIEVED_AT,
      notes: "用于约1110年北宋路、府、州、军名录；游戏内驿市节点为便于行走的抽象。",
    },
    {
      id: "source-song-map",
      title: "Wikimedia Commons：北宋行政区划（1123年）（简）",
      url: "https://commons.wikimedia.org/w/index.php?curid=18369695",
      contentVersion: "commons-curid-18369695@2012-02-13",
      retrievedAt: WORLD_SEED_RETRIEVED_AT,
      notes: "CC BY 3.0，作者玖巧仔；用于二十四路及州府的相对地理布局，不作为现代精确经纬度。",
    },
    {
      id: "source-palworld-map",
      title: "fa0311/palworld-map public/pin_data.json",
      url: "https://github.com/fa0311/palworld-map/blob/31eb23472af96061ac868950a985f83ad5406298/public/pin_data.json",
      contentVersion: "blob-1f8f90525b9463870630758fc066da493432bff0",
      retrievedAt: WORLD_SEED_RETRIEVED_AT,
      notes: "MIT许可坐标数据；267个具名帕洛斯公开地图标记：57传送点、5高塔、43野外头目、123洞窟与39手记。中文地名为演示译名。",
    },
  ];

  const layers: WorldSeedLayer[] = [
    { id: "world-root", name: "八方世界", description: "楼门路、大宋与帕洛斯相连的连续大地图。", parentLayerId: null },
    { id: "home-ground", name: "嬴长嫚与楼夜秋之家", description: "庭院、起居、卧室、书房与修炼空间相连的单层住宅。", parentLayerId: "world-root" },
  ];
  const regions: WorldSeedRegion[] = [
    { id: "home", layerId: "home-ground", name: "嬴长嫚与楼夜秋之家·单层平面", description: "两人共同生活、修炼与工作的现代单层住宅。", x: -240, y: -80, width: 960, height: 800 },
    { id: "world-home", layerId: "world-root", name: "嬴长嫚与楼夜秋之家", description: "楼门路旁住宅的外部入口。", x: 400, y: 80, width: 160, height: 160 },
  ];
  const locations: WorldSeedLocation[] = [];
  const routes: WorldSeedRoute[] = [];
  const actions: WorldSeedAction[] = [
    { id: "observe-entrance", locationId: "home-entrance", name: "整理衣装", description: "在玄关整理衣装，准备出门。", silverDelta: 0, hpDelta: 0, resultTemplate: "{name}在玄关整理好衣装。" },
    { id: "observe-road", locationId: "loumen-road", name: "观察街道", description: "看看楼门路上来往的人群。", silverDelta: 0, hpDelta: 0, resultTemplate: "{name}站在楼门路上观察四周。" },
    { id: "observe-song", locationId: "song-gate", name: "眺望大宋", description: "从入口眺望大宋方向。", silverDelta: 0, hpDelta: 0, resultTemplate: "{name}在入口处眺望大宋。" },
    { id: "observe-palos", locationId: "palos-gate", name: "眺望帕洛斯", description: "从入口眺望帕洛斯方向。", silverDelta: 0, hpDelta: 0, resultTemplate: "{name}在入口处眺望帕洛斯。" },
  ];
  const baseLocationSources: WorldSeedData["baseLocationSources"] = [];
  const coordinates = new Map<string, { gridX: number; gridY: number; layerId: string }>();
  const locationIdsByCell = new Map<string, string>();
  const normalEdges = new Set<string>();
  const cellKey = (layerId: string, gridX: number, gridY: number) => `${layerId}:${gridX},${gridY}`;

  const addLocation = (location: WorldSeedLocation) => {
    const occupiedBy = locationIdsByCell.get(cellKey(location.layerId, location.gridX, location.gridY));
    if (occupiedBy) throw new Error(`地点 ${location.id} 与 ${occupiedBy} 占用同一网格。`);
    locations.push(location);
    coordinates.set(location.id, { gridX: location.gridX, gridY: location.gridY, layerId: location.layerId });
    locationIdsByCell.set(cellKey(location.layerId, location.gridX, location.gridY), location.id);
  };
  const addNormal = (id: string, fromLocation: string, toLocation: string) => {
    const from = coordinates.get(fromLocation);
    const to = coordinates.get(toLocation);
    if (!from || !to || from.layerId !== to.layerId) throw new Error(`普通路线 ${id} 的地点无效。`);
    const fromDirection = directionBetween(from, to);
    if (!fromDirection) throw new Error(`普通路线 ${id} 的地点不相邻。`);
    const edgeKey = [fromLocation, toLocation].sort().join("|");
    if (normalEdges.has(edgeKey)) return;
    normalEdges.add(edgeKey);
    routes.push({
      id, fromLocation, toLocation, routeType: "normal", transitionKind: null,
      fromDirection, toDirection: OPPOSITE_DIRECTION[fromDirection],
    });
  };
  const addTransition = (id: string, fromLocation: string, toLocation: string, transitionKind: TransitionKind) => {
    routes.push({ id, fromLocation, toLocation, routeType: "transition", transitionKind, fromDirection: null, toDirection: null });
  };
  const reserveNearestCell = (layerId: string, targetX: number, targetY: number) => {
    for (let radius = 0; ; radius += 1) {
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          if (Math.max(Math.abs(offsetX), Math.abs(offsetY)) !== radius) continue;
          const gridX = targetX + offsetX;
          const gridY = targetY + offsetY;
          if (!locationIdsByCell.has(cellKey(layerId, gridX, gridY))) return { gridX, gridY };
        }
      }
    }
  };
  const addGeographicRoadNetwork = ({
    pointIds,
    roadPrefix,
    roadName,
    description,
    regionId,
    sourceId,
    sourceKeyPrefix,
  }: {
    pointIds: string[];
    roadPrefix: string;
    roadName: string;
    description: string;
    regionId: string;
    sourceId: string;
    sourceKeyPrefix: string;
  }) => {
    if (pointIds.length < 2) return;
    const connected = [pointIds[0]];
    const remaining = new Set(pointIds.slice(1));
    const links: Array<[string, string]> = [];
    while (remaining.size > 0) {
      let nearest: { fromId: string; toId: string; distance: number } | null = null;
      for (const fromId of connected) {
        const from = coordinates.get(fromId)!;
        for (const toId of remaining) {
          const to = coordinates.get(toId)!;
          const distance = Math.max(Math.abs(from.gridX - to.gridX), Math.abs(from.gridY - to.gridY));
          if (!nearest || distance < nearest.distance) nearest = { fromId, toId, distance };
        }
      }
      if (!nearest) throw new Error(`${roadName}无法连接全部地点。`);
      links.push([nearest.fromId, nearest.toId]);
      connected.push(nearest.toId);
      remaining.delete(nearest.toId);
    }

    const ensureRoadCell = (gridX: number, gridY: number) => {
      const existing = locationIdsByCell.get(cellKey("world-root", gridX, gridY));
      if (existing) return existing;
      const id = `${roadPrefix}-${coordinateToken(gridX)}-${coordinateToken(gridY)}`;
      addLocation({
        id, layerId: "world-root", name: roadName, description, regionId, gridX, gridY,
        sourceId, sourceKey: `${sourceKeyPrefix}/${gridX}/${gridY}`,
      });
      return id;
    };

    for (const [fromId, toId] of links) {
      const destination = coordinates.get(toId)!;
      let currentId = fromId;
      let current = coordinates.get(currentId)!;
      while (current.gridX !== destination.gridX || current.gridY !== destination.gridY) {
        const nextX = current.gridX + Math.sign(destination.gridX - current.gridX);
        const nextY = current.gridY + Math.sign(destination.gridY - current.gridY);
        const nextId = ensureRoadCell(nextX, nextY);
        addNormal(
          `route-${roadPrefix}-${coordinateToken(current.gridX)}-${coordinateToken(current.gridY)}-${coordinateToken(nextX)}-${coordinateToken(nextY)}`,
          currentId,
          nextId,
        );
        currentId = nextId;
        current = coordinates.get(currentId)!;
      }
    }
  };
  addLocation({ id: "home-entrance", layerId: "home-ground", name: "玄关", description: "嬴长嫚与楼夜秋之家的内外分界。", regionId: "home", gridX: 0, gridY: 0, sourceId: "source-home-design", sourceKey: "home/ground/entrance" });
  addLocation({ id: "home-exterior", layerId: "world-root", name: "嬴长嫚与楼夜秋之家·入口", description: "从楼门路进入住宅的门前。", regionId: "world-home", gridX: 3, gridY: 1, sourceId: "source-home-design", sourceKey: "outside/home-entrance" });
  addLocation({ id: "loumen-road-west", layerId: "world-root", name: "楼门路", description: "楼门路西段，沿街向西接入大宋官道。", regionId: null, gridX: 2, gridY: 2, sourceId: "source-home-design", sourceKey: "outside/loumen-road/west" });
  addLocation({ id: "loumen-road", layerId: "world-root", name: "楼门路", description: "住宅门前的楼门路中段。", regionId: null, gridX: 3, gridY: 2, sourceId: "source-home-design", sourceKey: "outside/loumen-road/center" });
  addLocation({ id: "loumen-road-east", layerId: "world-root", name: "楼门路", description: "楼门路东段，沿街向东接入帕洛斯海岸。", regionId: null, gridX: 4, gridY: 2, sourceId: "source-home-design", sourceKey: "outside/loumen-road/east" });
  addLocation({ id: "song-gate", layerId: "world-root", name: "大宋入口", description: "由楼门路进入大宋连续舆图的入口。", regionId: "song", gridX: 1, gridY: 2, sourceId: "source-song-wikipedia", sourceKey: "song/gate" });
  addLocation({ id: "palos-gate", layerId: "world-root", name: "帕洛斯入口", description: "由楼门路进入帕洛斯连续群岛地图的入口。", regionId: "palos", gridX: 5, gridY: 2, sourceId: "source-palworld-map", sourceKey: "palos/gate" });

  addTransition("route-home-door-v4", "home-entrance", "home-exterior", "door");
  addNormal("route-home-road-v4", "home-exterior", "loumen-road");
  addNormal("route-loumen-west-v4", "loumen-road", "loumen-road-west");
  addNormal("route-loumen-east-v4", "loumen-road", "loumen-road-east");
  addNormal("route-road-song-v4", "loumen-road-west", "song-gate");
  addNormal("route-road-palos-v4", "loumen-road-east", "palos-gate");

  const homeLocations = [
    ["home-front-garden", "前庭", -1, 0], ["home-hall", "门厅", 0, 1],
    ["home-guest-bathroom", "客用卫生间", -1, 1], ["home-living-room", "客厅", 1, 1],
    ["home-dining-room", "餐厅", 2, 1], ["home-kitchen", "厨房", 3, 1], ["home-garage", "车库", 3, 0],
    ["home-main-bathroom", "主卫", -1, 2], ["home-main-bedroom", "主卧", 0, 2],
    ["home-ying-study", "嬴长嫚书房", 1, 2], ["home-lou-study", "楼夜秋书房", 2, 2],
    ["home-guest-bedroom", "客卧", 3, 2], ["home-training-room", "修炼房", 0, 3],
    ["home-gym", "健身房", 1, 3], ["home-workshop", "工坊", 2, 3],
    ["home-storage", "储藏室", 3, 3], ["home-utility-room", "设备间", 4, 3],
    ["home-back-garden", "后庭", 0, 4], ["home-greenhouse", "温室", 1, 4],
    ["home-pavilion", "庭院亭", 2, 4],
  ] as const;
  for (const [id, name, gridX, gridY] of homeLocations) {
    addLocation({
      id, layerId: "home-ground", name: `嬴长嫚与楼夜秋之家·${name}`, description: `单层住宅的${name}。`,
      regionId: "home", gridX, gridY, sourceId: "source-home-design", sourceKey: `home/ground/${id}`,
      trainingMultiplier: id === "home-training-room" ? 1.5 : undefined,
    });
  }
  const homeRoutes = [
    ["home-front-garden", "home-entrance"], ["home-entrance", "home-hall"],
    ["home-hall", "home-guest-bathroom"], ["home-hall", "home-living-room"], ["home-hall", "home-main-bedroom"],
    ["home-living-room", "home-dining-room"], ["home-living-room", "home-ying-study"],
    ["home-dining-room", "home-kitchen"], ["home-dining-room", "home-lou-study"],
    ["home-kitchen", "home-garage"], ["home-kitchen", "home-guest-bedroom"],
    ["home-guest-bathroom", "home-main-bathroom"], ["home-main-bathroom", "home-main-bedroom"],
    ["home-main-bedroom", "home-ying-study"], ["home-main-bedroom", "home-training-room"],
    ["home-ying-study", "home-lou-study"], ["home-ying-study", "home-gym"],
    ["home-lou-study", "home-guest-bedroom"], ["home-lou-study", "home-workshop"],
    ["home-guest-bedroom", "home-storage"], ["home-training-room", "home-gym"],
    ["home-training-room", "home-back-garden"], ["home-gym", "home-workshop"],
    ["home-gym", "home-greenhouse"], ["home-workshop", "home-storage"],
    ["home-workshop", "home-pavilion"], ["home-storage", "home-utility-room"],
    ["home-back-garden", "home-greenhouse"], ["home-greenhouse", "home-pavilion"],
  ] as const;
  homeRoutes.forEach(([fromLocation, toLocation], index) => addNormal(`route-home-ground-${index + 1}-v4`, fromLocation, toLocation));
  actions.push({
    id: "action-training-room-focus", locationId: "home-training-room", name: "静心修炼",
    description: "停留在修炼房中，修为会按服务器时间自动增长。", silverDelta: 0, hpDelta: 0,
    resultTemplate: "{name}在修炼房中静心吐纳。",
  });

  addLocation({
    id: "song-overview-entry", layerId: "world-root", name: "大宋东关官道", description: "由楼门路进入北宋二十四路地理舆图的东关。",
    regionId: "song", gridX: 0, gridY: 2, sourceId: "source-song-wikipedia", sourceKey: "song/overview",
  });
  addNormal("route-world-song-v3", "song-gate", "song-overview-entry");
  const songNetworkPoints = ["song-overview-entry"];
  SONG_CIRCUITS.forEach(([circuitSlug, circuitName, prefectures, anchor]) => {
    const hubId = `song-hub-${circuitSlug}`;
    const entryId = `song-entry-${circuitSlug}`;
    const circuitLocationCount = 2 + prefectures.length * 2;
    const circuitIds: string[] = [];
    const addCircuitLocation = (location: Omit<WorldSeedLocation, "layerId" | "regionId" | "sourceId">) => {
      addLocation({ ...location, layerId: "world-root", regionId: "song", sourceId: "source-song-wikipedia" });
      const previousId = circuitIds.at(-1);
      circuitIds.push(location.id);
      if (previousId) addNormal(`route-song-${circuitSlug}-atlas-${circuitIds.length - 1}-v5`, previousId, location.id);
    };
    addCircuitLocation({
      id: hubId, name: `${circuitName}官道`, description: `${circuitName}在北宋地理舆图上的官道入口。`,
      ...compactSerpentine(0, circuitLocationCount, anchor[0], anchor[1]), sourceKey: `route/${circuitName}`,
    });
    addCircuitLocation({
      id: entryId, name: `${circuitName}官道`, description: `${circuitName}官道内段，串联所属府、州、军。`,
      ...compactSerpentine(1, circuitLocationCount, anchor[0], anchor[1]), sourceKey: `route/${circuitName}/entry`,
    });
    songNetworkPoints.push(hubId);
    prefectures.forEach((prefecture, prefectureIndex) => {
      const cityId = `song-${circuitSlug}-${prefectureIndex + 1}-seat`;
      const marketId = `song-${circuitSlug}-${prefectureIndex + 1}-post`;
      const cityIndex = 2 + prefectureIndex * 2;
      addCircuitLocation({
        id: cityId, name: `${circuitName}·${prefecture}治所`, description: `${prefecture}的行政治所。`,
        ...compactSerpentine(cityIndex, circuitLocationCount, anchor[0], anchor[1]), sourceKey: `${circuitName}/${prefecture}`,
      });
      addCircuitLocation({
        id: marketId, name: `${circuitName}·${prefecture}驿市`, description: `连接${prefecture}治所与邻近州府的驿路市集。`,
        ...compactSerpentine(cityIndex + 1, circuitLocationCount, anchor[0], anchor[1]), sourceKey: `${circuitName}/${prefecture}/game-post`,
      });
    });
  });
  addGeographicRoadNetwork({
    pointIds: songNetworkPoints,
    roadPrefix: "song-atlas-road",
    roadName: "大宋官道",
    description: "依北宋行政舆图连接二十四路的跨路官道。",
    regionId: "song",
    sourceId: "source-song-map",
    sourceKeyPrefix: "atlas-road",
  });
  for (const location of locations) {
    if (location.regionId === "song" && location.sourceId === "source-song-wikipedia") {
      baseLocationSources.push({ locationId: location.id, sourceId: "source-song-map", sourceKey: "atlas-1123-layout" });
    }
  }

  addLocation({
    id: "palos-overview-entry", layerId: "world-root", name: "帕洛斯西部航路", description: "由楼门路抵达帕洛斯群岛西缘的航路。",
    regionId: "palos", gridX: 6, gridY: 2, sourceId: "source-palworld-map", sourceKey: "palos/overview",
  });
  addNormal("route-world-palos-v3", "palos-gate", "palos-overview-entry");
  const palosNetworkPoints = ["palos-overview-entry"];
  PAL_CATEGORIES.forEach(([category, name]) => {
    const markers: Array<{ id: string; name: string; description: string; sourceKey: string }> = [];
    if (category === "travel") {
      PAL_FAST_TRAVEL.forEach((markerName, index) => markers.push({ id: `palos-fasttravel-${1001 + index}`, name: markerName, description: "公开地图传送点。", sourceKey: String(1001 + index) }));
    } else if (category === "towers") {
      PAL_TOWERS.forEach((markerName, index) => markers.push({ id: `palos-tower-${2001 + index}`, name: markerName, description: "公开地图高塔。", sourceKey: String(2001 + index) }));
    } else if (category === "bosses") {
      PAL_FIELD_BOSSES.forEach((markerName, index) => markers.push({ id: `palos-fieldboss-${4001 + index}`, name: markerName, description: "公开地图野外头目标记；本演示不实现战斗。", sourceKey: String(4001 + index) }));
    } else if (category === "dungeons") {
      for (let marker = 5001; marker <= 5123; marker += 1) markers.push({ id: `palos-dungeon-${marker}`, name: `洞窟入口 ${marker}`, description: "公开地图洞窟标记。", sourceKey: String(marker) });
    } else {
      for (let marker = 10001; marker <= 10039; marker += 1) markers.push({ id: `palos-memo-${marker}`, name: `帕洛斯手记 ${marker - 10000}`, description: "公开地图手记标记。", sourceKey: String(marker) });
    }
    markers.forEach((marker) => {
      const rawCoordinate = PALWORLD_MARKER_COORDINATES[marker.sourceKey as keyof typeof PALWORLD_MARKER_COORDINATES];
      if (!rawCoordinate) throw new Error(`帕洛斯地点 ${marker.id} 缺少公开地图坐标。`);
      const point = reserveNearestCell(
        "world-root",
        43 + Math.round(rawCoordinate[0] * 0.5),
        13 - Math.round(rawCoordinate[1] * 0.5),
      );
      addLocation({
        id: marker.id, layerId: "world-root", name: `${name}·${marker.name}`, description: marker.description,
        regionId: "palos", ...point, sourceId: "source-palworld-map", sourceKey: marker.sourceKey,
      });
      palosNetworkPoints.push(marker.id);
    });
  });
  addGeographicRoadNetwork({
    pointIds: palosNetworkPoints,
    roadPrefix: "palos-map-road",
    roadName: "帕洛斯道路",
    description: "依公开帕洛斯地图坐标连接邻近地标的道路。",
    regionId: "palos",
    sourceId: "source-palworld-map",
    sourceKeyPrefix: "coordinate-road",
  });

  const addRegionBounds = (id: string, name: string, description: string) => {
    const members = locations.filter((location) => location.regionId === id);
    const minX = Math.min(...members.map((location) => location.gridX)) * 160 - 80;
    const minY = Math.min(...members.map((location) => location.gridY)) * 160 - 80;
    const maxX = Math.max(...members.map((location) => location.gridX)) * 160 + 80;
    const maxY = Math.max(...members.map((location) => location.gridY)) * 160 + 80;
    regions.push({ id, layerId: "world-root", name, description, x: minX, y: minY, width: maxX - minX, height: maxY - minY });
  };
  addRegionBounds("song", "大宋", "依1123年北宋行政舆图展开的二十四路地理大区域。");
  addRegionBounds("palos", "帕洛斯", "依公开地图标记坐标展开的帕洛斯群岛大区域。");

  return { sources, layers, regions, locations, routes, actions, baseLocationSources };
}
