import { directionBetween, OPPOSITE_DIRECTION } from "./map";
import type { Direction, RouteType, TransitionKind } from "./types";

export const WORLD_SEED_REVISION = 2;
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
  ["jingji", "京畿路", ["开封府"]],
  ["jingdong-east", "京东东路", ["青州", "密州", "沂州", "登州", "莱州", "潍州", "淄州"]],
  ["jingdong-west", "京东西路", ["应天府", "兖州", "徐州", "曹州", "郓州", "济州", "单州", "濮州"]],
  ["jingxi-south", "京西南路", ["襄州", "邓州", "随州", "金州", "房州", "均州", "郢州", "唐州", "光化军"]],
  ["jingxi-north", "京西北路", ["河南府", "颍昌府", "郑州", "滑州", "孟州", "蔡州", "陈州", "颍州", "汝州", "信阳军"]],
  ["hebei-east", "河北东路", ["大名府", "开德府", "河间府", "沧州", "冀州", "博州", "棣州", "莫州", "雄州", "霸州", "德州", "滨州", "恩州", "清州", "信安军", "保定军"]],
  ["hebei-west", "河北西路", ["真定府", "中山府", "信德府", "庆源府", "相州", "浚州", "怀州", "卫州", "磁州", "深州", "祁州", "保州", "邢州", "赵州"]],
  ["hedong", "河东路", ["太原府", "隆德府", "平阳府", "府州", "绛州", "泽州", "代州", "忻州", "汾州", "辽州", "宪州", "岚州", "石州", "隰州", "慈州", "麟州", "火山军", "宁化军", "岢岚军", "保德军"]],
  ["yongxing", "永兴军路", ["京兆府", "河中府", "延安府", "庆阳府", "同州", "华州", "耀州", "陕州", "邠州", "宁州", "坊州", "鄜州", "丹州", "环州", "银州", "醴州", "保安军", "定边军", "绥德军", "清平军"]],
  ["qinfeng", "秦凤路", ["凤翔府", "秦州", "陇州", "泾州", "渭州", "原州", "熙州", "河州", "岷州", "兰州", "阶州", "成州", "西宁州", "镇戎军", "通远军"]],
  ["huainan-east", "淮南东路", ["扬州", "亳州", "宿州", "楚州", "海州", "泰州", "泗州", "滁州", "真州", "通州"]],
  ["huainan-west", "淮南西路", ["寿春府", "庐州", "舒州", "蕲州", "和州", "濠州", "光州", "黄州", "六安军", "无为军", "安庆军", "广德军", "镇巢军", "怀远军"]],
  ["liangzhe", "两浙路", ["杭州", "越州", "湖州", "婺州", "明州", "温州", "台州", "处州", "衢州", "睦州", "秀州", "常州", "苏州", "润州"]],
  ["jiangnan-east", "江南东路", ["江宁府", "宣州", "徽州", "池州", "饶州", "信州", "太平州", "南康军", "广德军东境", "铅山场"]],
  ["jiangnan-west", "江南西路", ["洪州", "虔州", "吉州", "袁州", "抚州", "筠州", "兴国军", "临江军", "南安军", "建昌军"]],
  ["jinghu-north", "荆湖北路", ["江陵府", "鄂州", "复州", "澧州", "峡州", "归州", "岳州", "辰州", "沅州", "荆门军"]],
  ["jinghu-south", "荆湖南路", ["潭州", "衡州", "道州", "永州", "郴州", "邵州", "全州", "桂阳监"]],
  ["fujian", "福建路", ["福州", "建州", "泉州", "南剑州", "漳州", "汀州", "邵武军", "兴化军"]],
  ["chengdu", "成都府路", ["成都府", "眉州", "蜀州", "彭州", "绵州", "汉州", "嘉州", "邛州", "简州", "黎州", "雅州", "茂州"]],
  ["zizhou", "梓州路", ["潼川府", "遂州", "果州", "资州", "普州", "昌州", "叙州", "泸州", "合州", "荣州", "渠州", "长宁军"]],
  ["lizhou", "利州路", ["兴元府", "利州", "洋州", "阆州", "剑州", "巴州", "文州", "龙州", "蓬州", "政州"]],
  ["kuizhou", "夔州路", ["夔州", "黔州", "施州", "忠州", "万州", "开州", "达州", "涪州", "渝州", "珍州", "南平军", "云安军"]],
  ["guangnan-east", "广南东路", ["广州", "韶州", "循州", "潮州", "连州", "梅州", "南雄州", "英州", "贺州", "封州", "端州", "新州", "康州", "惠州"]],
  ["guangnan-west", "广南西路", ["桂州", "容州", "邕州", "融州", "象州", "昭州", "梧州", "藤州", "龚州", "浔州", "柳州", "贵州", "宾州", "横州", "化州", "高州", "雷州", "钦州", "廉州", "琼州"]],
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

function serpentine(index: number, width: number) {
  const row = Math.floor(index / width);
  const column = index % width;
  return { gridX: row % 2 === 0 ? column : width - 1 - column, gridY: row };
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function buildWorldSeed(): WorldSeedData {
  const sources: WorldSeedSource[] = [
    {
      id: "source-home-design",
      title: "嬴长嫚与楼夜秋之家设计稿",
      url: "project://path-of-wuxia/home-v1",
      contentVersion: "home-v1",
      retrievedAt: WORLD_SEED_RETRIEVED_AT,
      notes: "项目原创现代多层住宅结构。",
    },
    {
      id: "source-song-wikipedia",
      title: "维基百科：宋朝行政区划",
      url: "https://zh.wikipedia.org/w/index.php?title=宋朝行政区划&oldid=39684822",
      contentVersion: "revid-39684822@2016-04-11T06:09:51Z",
      retrievedAt: WORLD_SEED_RETRIEVED_AT,
      notes: "用于约1110年北宋路、府、州、军层级；游戏内驿市节点为便于行走的抽象。",
    },
    {
      id: "source-palworld-map",
      title: "fa0311/palworld-map public/pin_data.json",
      url: "https://github.com/fa0311/palworld-map/blob/31eb23472af96061ac868950a985f83ad5406298/public/pin_data.json",
      contentVersion: "blob-1f8f90525b9463870630758fc066da493432bff0",
      retrievedAt: WORLD_SEED_RETRIEVED_AT,
      notes: "267个具名帕洛斯公开地图标记：57传送点、5高塔、43野外头目、123洞窟与39手记。中文地名为演示译名。",
    },
  ];

  const layers: WorldSeedLayer[] = [
    { id: "home-upper", name: "住宅二层", description: "卧室、书房和客房所在楼层。", parentLayerId: "home-ground" },
    { id: "home-basement", name: "住宅地下层", description: "修炼、健身、工坊和储藏空间。", parentLayerId: "home-ground" },
    { id: "home-yard", name: "住宅庭院", description: "住宅外围的前后花园和附属空间。", parentLayerId: "home-ground" },
    { id: "home-roof", name: "住宅屋顶", description: "屋顶露台、花园与设备区。", parentLayerId: "home-ground" },
  ];
  const regions: WorldSeedRegion[] = [];
  const locations: WorldSeedLocation[] = [];
  const routes: WorldSeedRoute[] = [];
  const actions: WorldSeedAction[] = [];
  const baseLocationSources: WorldSeedData["baseLocationSources"] = [
    { locationId: "home-entrance", sourceId: "source-home-design", sourceKey: "home/ground/entrance" },
    { locationId: "loumen-road", sourceId: "source-home-design", sourceKey: "outside/loumen-road" },
    { locationId: "song-gate", sourceId: "source-song-wikipedia", sourceKey: "song/gate" },
    { locationId: "song-overview-entry", sourceId: "source-song-wikipedia", sourceKey: "song/overview" },
    { locationId: "palos-gate", sourceId: "source-palworld-map", sourceKey: "palos/gate" },
    { locationId: "palos-overview-entry", sourceId: "source-palworld-map", sourceKey: "palos/overview" },
  ];
  const coordinates = new Map<string, { gridX: number; gridY: number; layerId: string }>([
    ["home-entrance", { gridX: 3, gridY: 1, layerId: "home-ground" }],
    ["loumen-road", { gridX: 3, gridY: 2, layerId: "world-root" }],
    ["song-gate", { gridX: 2, gridY: 2, layerId: "world-root" }],
    ["palos-gate", { gridX: 4, gridY: 2, layerId: "world-root" }],
    ["song-overview-entry", { gridX: 0, gridY: 0, layerId: "song-overview" }],
    ["palos-overview-entry", { gridX: 0, gridY: 0, layerId: "palos-overview" }],
  ]);

  const addLocation = (location: WorldSeedLocation) => {
    locations.push(location);
    coordinates.set(location.id, { gridX: location.gridX, gridY: location.gridY, layerId: location.layerId });
  };
  const addNormal = (id: string, fromLocation: string, toLocation: string) => {
    const from = coordinates.get(fromLocation);
    const to = coordinates.get(toLocation);
    if (!from || !to || from.layerId !== to.layerId) throw new Error(`普通路线 ${id} 的地点无效。`);
    const fromDirection = directionBetween(from, to);
    if (!fromDirection) throw new Error(`普通路线 ${id} 的地点不相邻。`);
    routes.push({
      id, fromLocation, toLocation, routeType: "normal", transitionKind: null,
      fromDirection, toDirection: OPPOSITE_DIRECTION[fromDirection],
    });
  };
  const addTransition = (id: string, fromLocation: string, toLocation: string, transitionKind: TransitionKind) => {
    routes.push({ id, fromLocation, toLocation, routeType: "transition", transitionKind, fromDirection: null, toDirection: null });
  };
  const addChain = (prefix: string, ids: string[]) => {
    for (let index = 1; index < ids.length; index += 1) addNormal(`${prefix}-${index}`, ids[index - 1], ids[index]);
  };

  const homeFloors = [
    ["home-ground", "住宅一层", [
      ["home-hall", "门厅"], ["home-living-room", "客厅"], ["home-dining-room", "餐厅"],
      ["home-kitchen", "厨房"], ["home-guest-bathroom", "客用卫生间"], ["home-garage", "车库"],
    ]],
    ["home-upper", "住宅二层", [
      ["home-upper-landing", "二层平台"], ["home-main-bedroom", "主卧"], ["home-main-bathroom", "主卫"],
      ["home-ying-study", "嬴长嫚书房"], ["home-lou-study", "楼夜秋书房"], ["home-guest-bedroom", "客卧"],
    ]],
    ["home-basement", "住宅地下层", [
      ["home-basement-landing", "地下层平台"], ["home-training-room", "修炼房"], ["home-gym", "健身房"],
      ["home-workshop", "工坊"], ["home-storage", "储藏室"], ["home-utility-room", "设备间"],
    ]],
    ["home-yard", "住宅庭院", [
      ["home-front-garden", "前庭"], ["home-driveway", "车道"], ["home-side-garden", "侧庭"],
      ["home-back-garden", "后庭"], ["home-greenhouse", "温室"], ["home-pavilion", "庭院亭"],
    ]],
    ["home-roof", "住宅屋顶", [
      ["home-roof-landing", "屋顶平台"], ["home-roof-terrace", "屋顶露台"],
      ["home-roof-garden", "屋顶花园"], ["home-solar-area", "屋顶设备区"],
    ]],
  ] as const;

  for (const [layerId, layerName, floorLocations] of homeFloors) {
    const regionId = `region-${layerId}`;
    if (layerId !== "home-ground") {
      regions.push({ id: regionId, layerId, name: `嬴长嫚与楼夜秋之家·${layerName}`, description: `${layerName}的完整房间结构。`, x: -80, y: -80, width: 1120, height: 480 });
    }
    const chain = layerId === "home-ground" ? ["home-entrance"] : [];
    floorLocations.forEach(([id, name], index) => {
      const groundPoints = [
        { gridX: 3, gridY: 2 }, { gridX: 4, gridY: 2 }, { gridX: 5, gridY: 2 },
        { gridX: 5, gridY: 1 }, { gridX: 6, gridY: 1 }, { gridX: 6, gridY: 2 },
      ];
      const point = layerId === "home-ground" ? groundPoints[index] : serpentine(index, 4);
      if (!point) throw new Error(`住宅地点 ${id} 缺少坐标。`);
      addLocation({
        id, layerId, name: `嬴长嫚与楼夜秋之家·${name}`, description: `${layerName}的${name}。`,
        regionId: layerId === "home-ground" ? "home" : regionId, ...point,
        sourceId: "source-home-design", sourceKey: `home/${layerId}/${id}`,
        trainingMultiplier: id === "home-training-room" ? 1.5 : undefined,
      });
      chain.push(id);
    });
    addChain(`route-${layerId}`, chain);
  }
  addTransition("route-home-upstairs", "home-hall", "home-upper-landing", "stairs");
  addTransition("route-home-basement", "home-hall", "home-basement-landing", "stairs");
  addTransition("route-home-yard", "home-entrance", "home-front-garden", "door");
  addTransition("route-home-roof", "home-upper-landing", "home-roof-landing", "stairs");
  actions.push({
    id: "action-training-room-focus", locationId: "home-training-room", name: "静心修炼",
    description: "停留在修炼房中，修为会按服务器时间自动增长。", silverDelta: 0, hpDelta: 0,
    resultTemplate: "{name}在修炼房中静心吐纳。",
  });

  regions.push({ id: "region-song-overview", layerId: "song-overview", name: "北宋二十四路总览", description: "约1110年的北宋路级结构入口。", x: -80, y: -80, width: 1120, height: 960 });
  const songOverviewIds = ["song-overview-entry"];
  SONG_CIRCUITS.forEach(([circuitSlug, circuitName, prefectures], circuitIndex) => {
    const layerId = `song-${circuitSlug}`;
    const hubId = `song-hub-${circuitSlug}`;
    const entryId = `song-entry-${circuitSlug}`;
    const hubPoint = serpentine(circuitIndex + 1, 6);
    layers.push({ id: layerId, name: `北宋·${circuitName}`, description: `${circuitName}所属府、州、军的可行走结构。`, parentLayerId: "song-overview" });
    regions.push({ id: `region-${layerId}`, layerId, name: `北宋${circuitName}辖境`, description: `${circuitName}行政地点与驿市。`, x: -80, y: -80, width: 1440, height: Math.max(640, Math.ceil((prefectures.length * 2 + 1) / 7) * 160 + 160) });
    addLocation({ id: hubId, layerId: "song-overview", name: `北宋总览·${circuitName}`, description: `进入${circuitName}。`, regionId: "region-song-overview", ...hubPoint, sourceId: "source-song-wikipedia", sourceKey: `route/${circuitName}` });
    addLocation({ id: entryId, layerId, name: `${circuitName}·路口`, description: `${circuitName}的层级入口。`, regionId: `region-${layerId}`, gridX: 0, gridY: 0, sourceId: "source-song-wikipedia", sourceKey: `route/${circuitName}/entry` });
    songOverviewIds.push(hubId);
    addTransition(`route-enter-song-${circuitSlug}`, hubId, entryId, "gate");
    const circuitIds = [entryId];
    prefectures.forEach((prefecture, prefectureIndex) => {
      const cityId = `song-${circuitSlug}-${prefectureIndex + 1}-seat`;
      const marketId = `song-${circuitSlug}-${prefectureIndex + 1}-post`;
      const cityPoint = serpentine(prefectureIndex * 2 + 1, 7);
      const marketPoint = serpentine(prefectureIndex * 2 + 2, 7);
      addLocation({ id: cityId, layerId, name: `${circuitName}·${prefecture}治所`, description: `${prefecture}的行政治所。`, regionId: `region-${layerId}`, ...cityPoint, sourceId: "source-song-wikipedia", sourceKey: `${circuitName}/${prefecture}` });
      addLocation({ id: marketId, layerId, name: `${circuitName}·${prefecture}驿市`, description: `连接${prefecture}治所与下一处州府的驿路市集。`, regionId: `region-${layerId}`, ...marketPoint, sourceId: "source-song-wikipedia", sourceKey: `${circuitName}/${prefecture}/game-post` });
      circuitIds.push(cityId, marketId);
    });
    addChain(`route-song-${circuitSlug}`, circuitIds);
  });
  addChain("route-song-overview", songOverviewIds);

  regions.push({ id: "region-palos-overview", layerId: "palos-overview", name: "帕洛斯标记总览", description: "按公开地图标记类型组织的帕洛斯层级入口。", x: -80, y: -80, width: 960, height: 480 });
  const palOverviewIds = ["palos-overview-entry"];
  PAL_CATEGORIES.forEach(([category, name, description], categoryIndex) => {
    const layerId = `palos-${category}`;
    const hubId = `palos-hub-${category}`;
    const entryId = `palos-entry-${category}`;
    const hubPoint = serpentine(categoryIndex + 1, 6);
    layers.push({ id: layerId, name, description, parentLayerId: "palos-overview" });
    regions.push({ id: `region-${layerId}`, layerId, name: `${name}区域`, description, x: -80, y: -80, width: 1760, height: category === "dungeons" ? 2240 : 1280 });
    addLocation({ id: hubId, layerId: "palos-overview", name: `帕洛斯总览·${name}`, description: `进入${name}地图层。`, regionId: "region-palos-overview", ...hubPoint, sourceId: "source-palworld-map", sourceKey: `category/${category}` });
    addLocation({ id: entryId, layerId, name: `${name}·入口`, description, regionId: `region-${layerId}`, gridX: 0, gridY: 0, sourceId: "source-palworld-map", sourceKey: `category/${category}/entry` });
    palOverviewIds.push(hubId);
    addTransition(`route-enter-palos-${category}`, hubId, entryId, category === "dungeons" ? "dungeon" : "fast-travel");
    const categoryIds = [entryId];
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
    markers.forEach((marker, index) => {
      const point = serpentine(index + 1, 10);
      addLocation({
        id: marker.id, layerId, name: `${name}·${marker.name}`, description: marker.description,
        regionId: `region-${layerId}`, ...point, sourceId: "source-palworld-map", sourceKey: marker.sourceKey,
      });
      categoryIds.push(marker.id);
    });
    addChain(`route-palos-${slug(category)}`, categoryIds);
  });
  addChain("route-palos-overview", palOverviewIds);

  return { sources, layers, regions, locations, routes, actions, baseLocationSources };
}
