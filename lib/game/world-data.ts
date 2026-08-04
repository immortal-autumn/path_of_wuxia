import { directionBetween, OPPOSITE_DIRECTION } from "./map";
import type { Direction, RouteType, TransitionKind } from "./types";

export const WORLD_SEED_REVISION = 10;
export const WORLD_SEED_RETRIEVED_AT = "2026-08-04";

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
  cashWenDelta: number;
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
  shopfronts: WorldSeedShopfront[];
};

export type WorldSeedShopfront = {
  id: string;
  locationId: string;
  name: string;
  category: string;
  documented: boolean;
};

const KAIFENG_STREETS = [
  ["north-wall", "东京城·外城北垣牙道", "horizontal", -35, -65, -5, "外城北垣内侧植有榆柳的防城牙道。"],
  ["wuzhang-river", "东京城·五丈河沿岸", "horizontal", -28, -65, -5, "五丈河运入京东粮斛，两岸仓场与桥市相接。"],
  ["old-fengqiu", "东京城·旧封丘门大街", "horizontal", -21, -65, -5, "由旧封丘门横贯旧城北部的街道。"],
  ["palace-cross", "东京城·东西华门街", "horizontal", -7, -65, -5, "横贯大内东西华门与省府宫宇的街道。"],
  ["bian-river", "东京城·汴河沿岸", "horizontal", 7, -65, -5, "汴河穿城而过，沿岸仓栈、桥市与客店密集。"],
  ["zhuque", "东京城·朱雀门外大街", "horizontal", 21, -65, -5, "州桥向南经朱雀门延伸的繁华街市。"],
  ["cai-river", "东京城·蔡河沿岸", "horizontal", 28, -65, -5, "蔡河绕经东京南部，桥亭与民居沿岸展开。"],
  ["south-wall", "东京城·外城南垣牙道", "horizontal", 35, -65, -5, "外城南垣内侧连接各门与防城库的牙道。"],
  ["west-wall", "东京城·西城门大街", "vertical", -65, -35, 35, "沿外城西壁连接固子、万胜、西水与新郑诸门。"],
  ["liangmen", "东京城·梁门大街", "vertical", -55, -35, 35, "从卫州门经梁门通向州西瓦子与南城的街道。"],
  ["junyi", "东京城·浚仪桥大街", "vertical", -45, -35, 35, "由浚仪桥连接省府、开封府与城南坊巷。"],
  ["imperial", "东京城·御街", "vertical", -35, -35, 35, "自宣德楼向南越州桥、朱雀门直抵南薰门的御路。"],
  ["maxing", "东京城·马行街", "vertical", -25, -35, 35, "旧封丘门至城中商肆、医铺与马市最稠密的街道。"],
  ["panlou", "东京城·潘楼街", "vertical", -15, -35, 35, "连接东角楼、界身巷、土市子与诸瓦子的通衢。"],
  ["east-water", "东京城·东水门街", "vertical", -5, -35, 35, "沿东城诸门与汴河水门展开的仓栈街道。"],
] as const;

const KAIFENG_LANDMARKS = [
  ["gate-weizhou", "卫州门", -55, -35, "东京外城北壁西侧城门。", "卷一/东都外城/卫州门"],
  ["gate-suanzao", "新酸枣门", -45, -35, "东京外城北壁城门。", "卷一/东都外城/新酸枣门"],
  ["gate-fengqiu", "封丘门", -35, -35, "北郊御路所经的四正门之一。", "卷一/东都外城/封丘门"],
  ["gate-chenqiao", "陈桥门", -25, -35, "辽使入京驿路所经的北城门。", "卷一/东都外城/陈桥门"],
  ["gate-northeast-water", "东北水门", -5, -28, "五丈河由此穿入东京外城。", "卷一/东都外城/东北水门"],
  ["gate-northwest-water", "西北水门", -65, -28, "金水河由此进入东京外城。", "卷一/东都外城/西北水门"],
  ["gate-guzi", "固子门", -65, -21, "东京外城西壁北段城门，正名金耀门。", "卷一/东都外城/固子门"],
  ["gate-wansheng", "万胜门", -65, -7, "东京外城西壁城门。", "卷一/东都外城/万胜门"],
  ["gate-west-water", "西水门", -65, 7, "汴河上流水门，正名利泽门。", "卷一/东都外城/西水门"],
  ["gate-xinzheng", "新郑门", -65, 21, "西南御路所经的四正门之一。", "卷一/东都外城/新郑门"],
  ["gate-newcao", "新曹门", -5, -21, "东京外城东壁北段城门。", "卷一/东都外城/新曹门"],
  ["gate-newsong", "新宋门", -5, -7, "东城御路所经的四正门之一。", "卷一/东都外城/新宋门"],
  ["gate-east-water", "东水门", -5, 7, "汴河下流水门，两岸均有行人通道。", "卷一/东都外城/东水门"],
  ["gate-east-chenzhou", "陈州门", -5, 21, "东京外城东南侧城门。", "卷一/东都外城/陈州门"],
  ["gate-dailou", "戴楼门", -55, 35, "东京外城西南城门，旁有蔡河水门。", "卷一/东都外城/戴楼门"],
  ["gate-nanxun", "南薰门", -35, 35, "御街正南所对的四正门之一。", "卷一/东都外城/南薰门"],
  ["gate-southeast-chenzhou", "陈州门南关", -15, 35, "蔡河东南出城处附近的南关。", "卷一/东都外城/陈州门"],
  ["gate-southwest-water", "西南蔡河水门", -65, 28, "蔡河由东京西南穿入外城。", "卷一/东都外城/蔡河水门"],
  ["gate-southeast-water", "东南蔡河水门", -5, 28, "蔡河由东京东南穿出外城。", "卷一/东都外城/蔡河水门"],
  ["bridge-wuzhang-small", "小横桥", -55, -28, "五丈河入京后的第一座桥。", "卷一/河道/小横桥"],
  ["bridge-guangbei", "广备桥", -45, -28, "五丈河上的仓运桥梁。", "卷一/河道/广备桥"],
  ["bridge-caishi", "蔡市桥", -35, -28, "五丈河桥市之一。", "卷一/河道/蔡市桥"],
  ["bridge-qinghui", "青晖桥", -25, -28, "五丈河上的青晖桥。", "卷一/河道/青晖桥"],
  ["bridge-ranyuan", "染院桥", -15, -28, "五丈河东段的染院桥。", "卷一/河道/染院桥"],
  ["palace-west-hua", "大内·西华门", -43, -21, "大内西侧宫门。", "卷一/大内/西华门"],
  ["palace-right-jiasu", "大内·右嘉肃门", -41, -21, "文德殿西侧内门。", "卷一/大内/右嘉肃门"],
  ["palace-chongzheng", "大内·崇政殿", -39, -21, "大内后殿之一。", "卷一/大内/崇政殿"],
  ["palace-wende", "大内·文德殿", -37, -21, "东京常朝所御之殿。", "卷一/大内/文德殿"],
  ["palace-daqing", "大内·大庆殿", -35, -21, "正朔朝会与大礼斋宿所用正殿。", "卷一/大内/大庆殿"],
  ["palace-zichen", "大内·紫宸殿", -33, -21, "正朔受朝所用宫殿。", "卷一/大内/紫宸殿"],
  ["palace-xuanyou", "大内·宣祐门", -31, -21, "连接后殿区域的内门。", "卷一/大内/宣祐门"],
  ["palace-left-jiasu", "大内·左嘉肃门", -29, -21, "文德殿东侧内门。", "卷一/大内/左嘉肃门"],
  ["palace-east-hua", "大内·东华门", -27, -21, "宫城东门，门外市井尤盛。", "卷一/大内/东华门"],
  ["office-jingling-west", "景灵西宫", -47, -7, "御街西侧的宫观。", "卷二/宣德楼前省府宫宇/景灵西宫"],
  ["office-kaifeng", "开封府", -45, -7, "治理东京城郭与京畿事务的府署。", "卷三/大内西右掖门外街巷/开封府"],
  ["office-yushitai", "御史台", -43, -7, "尚书省南侧的御史台署。", "卷三/大内西右掖门外街巷/御史台"],
  ["office-shangshu", "尚书省", -41, -7, "宣德楼前西侧省署。", "卷二/宣德楼前省府宫宇/尚书省"],
  ["office-taichang", "太常寺", -39, -7, "大晟府以南的礼乐官署。", "卷二/宣德楼前省府宫宇/太常寺"],
  ["gate-right-ye", "大内·右掖门", -37, -7, "宣德楼西侧入宫门。", "卷一/大内/右掖门"],
  ["gate-xuande", "大内·宣德门", -35, -7, "大内正门宣德楼，御街由此向南。", "卷一/大内/宣德楼"],
  ["gate-left-ye", "大内·左掖门", -33, -7, "宣德楼东侧入宫门。", "卷一/大内/左掖门"],
  ["office-zhongshu", "中书省", -31, -7, "大内东廊省署。", "卷一/大内/中书省"],
  ["office-shumi", "枢密院", -29, -7, "大内东廊军政官署。", "卷一/大内/枢密院"],
  ["office-mingtang", "明堂", -27, -7, "左掖门内的明堂区域。", "卷一/大内/明堂"],
  ["office-jingling-east", "景灵东宫", -23, -7, "御街东侧宫观。", "卷二/宣德楼前省府宫宇/景灵东宫"],
  ["old-gate-liang", "旧城·梁门", -55, -14, "旧京城西壁北段城门。", "卷一/旧京城/梁门"],
  ["old-gate-jinshui", "旧城·金水门", -45, -14, "旧京城北壁西侧城门。", "卷一/旧京城/金水门"],
  ["old-gate-fengqiu", "旧城·旧封丘门", -35, -14, "旧京城北壁主要城门。", "卷一/旧京城/旧封丘门"],
  ["old-gate-jinglong", "旧城·景龙门", -25, -14, "大内城角宝箓宫前的旧城门。", "卷一/旧京城/景龙门"],
  ["old-gate-cao", "旧城·旧曹门", -5, -14, "旧京城东壁北段城门。", "卷一/旧京城/旧曹门"],
  ["old-gate-song", "旧城·旧宋门", -5, 0, "旧京城东壁汴河北岸城门。", "卷一/旧京城/旧宋门"],
  ["old-gate-zheng", "旧城·旧郑门", -65, 14, "旧京城西壁南段城门。", "卷一/旧京城/旧郑门"],
  ["old-gate-new", "旧城·新门", -55, 14, "旧京城南壁西侧城门。", "卷一/旧京城/新门"],
  ["old-gate-zhuque", "旧城·朱雀门", -35, 14, "御街穿越旧京城南壁的正门。", "卷一/旧京城/朱雀门"],
  ["old-gate-baokang", "旧城·保康门", -15, 14, "旧京城南壁东侧城门。", "卷一/旧京城/保康门"],
  ["bridge-heng-west", "横桥", -61, 7, "西水门外汴河桥。", "卷一/河道/横桥"],
  ["bridge-west-water", "西水门便桥", -57, 7, "西水门内外交通桥。", "卷一/河道/西水门便桥"],
  ["bridge-west-float", "西浮桥", -55, 7, "汴河西段木石桥。", "卷一/河道/西浮桥"],
  ["bridge-jinliang", "金梁桥", -49, 7, "汴河西段金梁桥。", "卷一/河道/金梁桥"],
  ["bridge-taishifu", "太师府桥", -45, 7, "蔡太师宅前的汴河桥。", "卷一/河道/太师府桥"],
  ["bridge-xingguo", "兴国寺桥", -41, 7, "太平兴国寺附近的汴河桥。", "卷一/河道/兴国寺桥"],
  ["bridge-junyi", "浚仪桥", -37, 7, "御街西侧汴河要桥。", "卷一/河道/浚仪桥"],
  ["bridge-zhou", "州桥", -35, 7, "正名天汉桥，汴河与御街交汇的东京地标。", "卷一/河道/州桥"],
  ["bridge-xiangguo", "相国寺桥", -31, 7, "大相国寺附近的汴河平桥。", "卷一/河道/相国寺桥"],
  ["bridge-upper-earth", "上土桥", -25, 7, "汴河东段土桥。", "卷一/河道/上土桥"],
  ["bridge-lower-earth", "下土桥", -23, 7, "汴河东段土桥。", "卷一/河道/下土桥"],
  ["bridge-bian", "便桥", -19, 7, "东水门内的汴河便桥。", "卷一/河道/便桥"],
  ["bridge-shuncheng", "顺成仓桥", -15, 7, "顺成仓附近的汴河桥。", "卷一/河道/顺成仓桥"],
  ["bridge-rainbow", "虹桥", -9, 7, "东水门外无柱木构飞桥。", "卷一/河道/虹桥"],
  ["market-zhou-night", "州桥夜市", -39, 21, "州桥向南直至龙津桥的通宵食市。", "卷二/州桥夜市"],
  ["academy-taixue", "太学", -37, 21, "朱雀门外御街东侧的太学。", "卷二/朱雀门外街巷/太学"],
  ["academy-guozijian", "国子监", -35, 21, "太学相邻的中央学府。", "卷二/朱雀门外街巷/国子监"],
  ["academy-wuxue", "武学", -33, 21, "龙津桥南的武学。", "卷二/朱雀门外街巷/武学"],
  ["office-exam", "贡院", -31, 21, "南城横街附近的贡院。", "卷二/朱雀门外街巷/贡院"],
  ["temple-wuyue", "五岳观", -29, 21, "南薰门内街西的大型宫观。", "卷二/朱雀门外街巷/五岳观"],
  ["market-qingfeng", "清风楼", -47, 21, "大巷口以西的著名酒楼。", "卷二/朱雀门外街巷/清风楼"],
  ["market-quyuan", "曲院街", -43, 21, "朱雀门街西的酒楼与馆舍街。", "卷二/朱雀门外街巷/曲院街"],
  ["market-newgate-wazi", "新门瓦子", -41, 21, "朱雀门外西侧瓦子。", "卷二/朱雀门外街巷/新门瓦子"],
  ["bridge-cai-guan", "观桥", -59, 28, "五岳观后门附近的蔡河桥。", "卷一/河道/观桥"],
  ["bridge-cai-xuantai", "宣泰桥", -55, 28, "蔡河西段桥梁。", "卷一/河道/宣泰桥"],
  ["bridge-cai-yunqi", "云骑桥", -51, 28, "蔡河南段桥梁。", "卷一/河道/云骑桥"],
  ["bridge-cai-heng", "横桥子", -45, 28, "蔡河上的横桥子。", "卷一/河道/横桥子"],
  ["bridge-cai-high", "高桥", -43, 28, "蔡河上的高桥。", "卷一/河道/高桥"],
  ["bridge-cai-baokang", "西保康门桥", -39, 28, "西保康门附近的蔡河桥。", "卷一/河道/西保康门桥"],
  ["bridge-longjin", "龙津桥", -35, 28, "蔡河与御街相交的主要桥梁。", "卷一/河道/龙津桥"],
  ["bridge-cai-new", "新桥", -31, 28, "蔡河中段的新桥。", "卷一/河道/新桥"],
  ["bridge-cai-taiping", "太平桥", -25, 28, "蔡河中段桥梁。", "卷一/河道/太平桥"],
  ["bridge-cai-wheat", "籴麦桥", -23, 28, "蔡河附近粮市所用桥梁。", "卷一/河道/籴麦桥"],
  ["bridge-cai-first", "第一座桥", -19, 28, "蔡河东段桥梁。", "卷一/河道/第一座桥"],
  ["bridge-yinan", "宜男桥", -15, 28, "蔡河出城前的桥梁。", "卷一/河道/宜男桥"],
  ["bridge-four-li", "四里桥", -9, 28, "戴楼门外蔡河桥。", "卷一/河道/四里桥"],
  ["garden-jinming", "金明池", -65, 0, "东京西郊皇家水上园林与水军教阅之所。", "北宋东京城/金明池"],
  ["garden-qionglin", "琼林苑", -55, 0, "金明池附近的皇家园苑。", "北宋东京城/琼林苑"],
  ["garden-genyue", "艮岳", -5, -16, "政和年间营建于东京东北的皇家园林。", "北宋东京城遗址/艮岳"],
  ["temple-kaibao", "开宝寺", -25, -16, "旧封丘门外斜街的大寺。", "卷三/上清宫/开宝寺"],
  ["temple-xiangguo", "大相国寺", -15, 3, "每月开放万姓交易的东京名寺。", "卷三/相国寺内万姓交易"],
  ["market-patlou", "潘楼酒店", -15, -3, "潘楼街北的著名酒楼。", "卷二/东角楼街巷/潘楼酒店"],
  ["market-tushizi", "土市子", -15, 1, "潘楼东街的十字市，又称竹竿市。", "卷二/潘楼东街巷/土市子"],
  ["market-sang-wazi", "桑家瓦子", -15, 11, "潘楼街南的大型瓦子。", "卷二/东角楼街巷/桑家瓦子"],
  ["market-middle-wazi", "中瓦", -15, 15, "拥有多座勾栏的市民娱乐场。", "卷二/东角楼街巷/中瓦"],
  ["market-inner-wazi", "里瓦", -15, 19, "潘楼街一带的大型瓦子。", "卷二/东角楼街巷/里瓦"],
  ["market-maxing-medicine", "马行街医铺", -25, -11, "旧封丘门南北密集的医官药铺。", "卷三/马行街北诸医铺"],
  ["market-boundary-lane", "界身巷", -25, 1, "金银彩帛集中交易的街巷。", "卷二/东角楼街巷/界身巷"],
  ["market-sweet-lane", "甜水巷", -25, 11, "南食店、客店与馆舍聚集的坊巷。", "卷三/寺东门街巷/甜水巷"],
] as const;

const KAIFENG_BUILDINGS = [
  {
    layerId: "kaifeng-palace-ground",
    layerName: "大内宫城·一层平面",
    layerDescription: "由宣德门进入的大内宫城单层平面；正殿、常朝殿与后殿沿中轴展开。",
    regionId: "kaifeng-palace",
    regionName: "大内宫城",
    exteriorId: "song-landmark-gate-xuande",
    interiorEntranceId: "kaifeng-palace-xuande-inner",
    transitionKind: "gate",
    locations: [
      ["kaifeng-palace-xuande-inner", "宣德门内", 0, 3, "越过宣德门后的宫城入口。"],
      ["kaifeng-palace-dragon-court", "龙墀", 0, 2, "宣德楼内连接前朝诸殿的宽阔御道。"],
      ["kaifeng-palace-daqing", "大庆殿", 0, 1, "举行正朔朝会与大礼的正殿。"],
      ["kaifeng-palace-wende", "文德殿", 0, 0, "皇帝日常视朝的常朝殿。"],
      ["kaifeng-palace-zichen", "紫宸殿", 0, -1, "内朝受朝所用宫殿。"],
      ["kaifeng-palace-chongzheng", "崇政殿", 0, -2, "处理政务与召对臣僚的后殿。"],
      ["kaifeng-palace-west-gallery", "西庑", -1, 0, "文德殿西侧廊庑。"],
      ["kaifeng-palace-east-gallery", "东庑", 1, 0, "文德殿东侧廊庑。"],
      ["kaifeng-palace-inner-garden", "内宫苑", 1, -2, "后殿东侧供禁中休憩的小苑。"],
    ],
    links: [
      ["kaifeng-palace-xuande-inner", "kaifeng-palace-dragon-court"],
      ["kaifeng-palace-dragon-court", "kaifeng-palace-daqing"],
      ["kaifeng-palace-daqing", "kaifeng-palace-wende"],
      ["kaifeng-palace-wende", "kaifeng-palace-zichen"],
      ["kaifeng-palace-zichen", "kaifeng-palace-chongzheng"],
      ["kaifeng-palace-wende", "kaifeng-palace-west-gallery"],
      ["kaifeng-palace-wende", "kaifeng-palace-east-gallery"],
      ["kaifeng-palace-chongzheng", "kaifeng-palace-inner-garden"],
    ],
  },
  {
    layerId: "kaifeng-prefecture-ground",
    layerName: "开封府署·一层平面",
    layerDescription: "开封府正门、仪门、正堂与办案属房组成的单层府署。",
    regionId: "kaifeng-prefecture",
    regionName: "开封府署",
    exteriorId: "song-landmark-office-kaifeng",
    interiorEntranceId: "kaifeng-prefecture-gate",
    transitionKind: "door",
    locations: [
      ["kaifeng-prefecture-gate", "府署正门内", 0, 3, "从浚仪桥大街进入开封府后的门内。"],
      ["kaifeng-prefecture-front-court", "前院", 0, 2, "府吏与来访百姓等候通传的前院。"],
      ["kaifeng-prefecture-ceremonial-gate", "仪门", 0, 1, "前院与审理区域之间的仪门。"],
      ["kaifeng-prefecture-main-hall", "府署正堂", 0, 0, "开封府公开审理京城事务的正堂。"],
      ["kaifeng-prefecture-rear-hall", "后堂", 0, -1, "正堂之后商议与复核案情的厅堂。"],
      ["kaifeng-prefecture-archive", "架阁库", -1, 0, "收存公文、案牍与城市户籍的库房。"],
      ["kaifeng-prefecture-duty-room", "签押房", 1, 0, "属官签押文书与轮值办公的房间。"],
      ["kaifeng-prefecture-jail", "狱房", -1, 1, "府署西侧看守待审人犯的狱房。"],
    ],
    links: [
      ["kaifeng-prefecture-gate", "kaifeng-prefecture-front-court"],
      ["kaifeng-prefecture-front-court", "kaifeng-prefecture-ceremonial-gate"],
      ["kaifeng-prefecture-ceremonial-gate", "kaifeng-prefecture-main-hall"],
      ["kaifeng-prefecture-main-hall", "kaifeng-prefecture-rear-hall"],
      ["kaifeng-prefecture-main-hall", "kaifeng-prefecture-archive"],
      ["kaifeng-prefecture-main-hall", "kaifeng-prefecture-duty-room"],
      ["kaifeng-prefecture-ceremonial-gate", "kaifeng-prefecture-jail"],
    ],
  },
  {
    layerId: "kaifeng-xiangguo-ground",
    layerName: "大相国寺·一层平面",
    layerDescription: "山门、殿阁、院落与万姓交易廊组成的大相国寺单层平面。",
    regionId: "kaifeng-xiangguo",
    regionName: "大相国寺",
    exteriorId: "song-landmark-temple-xiangguo",
    interiorEntranceId: "kaifeng-xiangguo-gate",
    transitionKind: "gate",
    locations: [
      ["kaifeng-xiangguo-gate", "山门内", 0, 3, "由潘楼街进入寺院后的山门内。"],
      ["kaifeng-xiangguo-market-court", "万姓交易院", 0, 2, "开放日供百工器物与书画交易的院落。"],
      ["kaifeng-xiangguo-heavenly-kings", "天王殿", 0, 1, "山门之后的前殿。"],
      ["kaifeng-xiangguo-main-hall", "大雄宝殿", 0, 0, "寺院中轴上的主殿。"],
      ["kaifeng-xiangguo-luohan", "罗汉院", -1, 0, "主殿西侧供奉罗汉的院落。"],
      ["kaifeng-xiangguo-zisheng", "资圣阁", 1, 0, "主殿东侧收藏经像的阁院。"],
      ["kaifeng-xiangguo-west-market", "西市廊", -1, 1, "万姓交易时陈列书籍古玩的西廊。"],
      ["kaifeng-xiangguo-east-market", "东市廊", 1, 1, "万姓交易时陈列器用百货的东廊。"],
      ["kaifeng-xiangguo-rear-court", "后院", 0, -1, "主殿之后较为清静的院落。"],
    ],
    links: [
      ["kaifeng-xiangguo-gate", "kaifeng-xiangguo-market-court"],
      ["kaifeng-xiangguo-market-court", "kaifeng-xiangguo-heavenly-kings"],
      ["kaifeng-xiangguo-heavenly-kings", "kaifeng-xiangguo-main-hall"],
      ["kaifeng-xiangguo-main-hall", "kaifeng-xiangguo-rear-court"],
      ["kaifeng-xiangguo-main-hall", "kaifeng-xiangguo-luohan"],
      ["kaifeng-xiangguo-main-hall", "kaifeng-xiangguo-zisheng"],
      ["kaifeng-xiangguo-heavenly-kings", "kaifeng-xiangguo-west-market"],
      ["kaifeng-xiangguo-heavenly-kings", "kaifeng-xiangguo-east-market"],
    ],
  },
  {
    layerId: "kaifeng-guozijian-ground",
    layerName: "国子监·一层平面",
    layerDescription: "讲堂、经阁、博士厅与太学斋舍组成的国子监单层平面。",
    regionId: "kaifeng-guozijian",
    regionName: "国子监",
    exteriorId: "song-landmark-academy-guozijian",
    interiorEntranceId: "kaifeng-guozijian-gate",
    transitionKind: "gate",
    locations: [
      ["kaifeng-guozijian-gate", "监门内", 0, 3, "朱雀门外国子监的正门内。"],
      ["kaifeng-guozijian-front-court", "前院", 0, 2, "师生入监后整肃衣冠的前院。"],
      ["kaifeng-guozijian-lecture-hall", "讲堂", 0, 1, "博士讲授经义的主讲堂。"],
      ["kaifeng-guozijian-classics-hall", "经阁", 0, 0, "校勘与收藏经籍的厅阁。"],
      ["kaifeng-guozijian-west-dormitory", "西斋", -1, 1, "太学生居学的西侧斋舍。"],
      ["kaifeng-guozijian-east-dormitory", "东斋", 1, 1, "太学生居学的东侧斋舍。"],
      ["kaifeng-guozijian-doctors-hall", "博士厅", -1, 0, "学官议课与考校的厅房。"],
      ["kaifeng-guozijian-library", "藏书房", 1, 0, "收存监学书籍与课卷的房间。"],
    ],
    links: [
      ["kaifeng-guozijian-gate", "kaifeng-guozijian-front-court"],
      ["kaifeng-guozijian-front-court", "kaifeng-guozijian-lecture-hall"],
      ["kaifeng-guozijian-lecture-hall", "kaifeng-guozijian-classics-hall"],
      ["kaifeng-guozijian-lecture-hall", "kaifeng-guozijian-west-dormitory"],
      ["kaifeng-guozijian-lecture-hall", "kaifeng-guozijian-east-dormitory"],
      ["kaifeng-guozijian-classics-hall", "kaifeng-guozijian-doctors-hall"],
      ["kaifeng-guozijian-classics-hall", "kaifeng-guozijian-library"],
    ],
  },
  {
    layerId: "kaifeng-panlou-ground",
    layerName: "潘楼酒店·一层平面",
    layerDescription: "临街门厅、大堂、雅间与后厨组成的潘楼酒店一层平面。",
    regionId: "kaifeng-panlou",
    regionName: "潘楼酒店",
    exteriorId: "song-landmark-market-patlou",
    interiorEntranceId: "kaifeng-panlou-entrance",
    transitionKind: "door",
    locations: [
      ["kaifeng-panlou-entrance", "门厅", 0, 2, "从潘楼街进入酒店的临街门厅。"],
      ["kaifeng-panlou-main-hall", "酒楼大堂", 0, 1, "食客听曲、饮酒与会友的宽敞大堂。"],
      ["kaifeng-panlou-counter", "酒柜", 0, 0, "登记酒菜与结算银钱的长柜。"],
      ["kaifeng-panlou-west-room", "西雅间", -1, 1, "大堂西侧较安静的会客雅间。"],
      ["kaifeng-panlou-east-room", "东雅间", 1, 1, "大堂东侧临街的会客雅间。"],
      ["kaifeng-panlou-courtyard", "后院", -1, 0, "转运酒瓮与食材的小院。"],
      ["kaifeng-panlou-kitchen", "后厨", 1, 0, "烹制酒菜并储水备火的厨房。"],
    ],
    links: [
      ["kaifeng-panlou-entrance", "kaifeng-panlou-main-hall"],
      ["kaifeng-panlou-main-hall", "kaifeng-panlou-counter"],
      ["kaifeng-panlou-main-hall", "kaifeng-panlou-west-room"],
      ["kaifeng-panlou-main-hall", "kaifeng-panlou-east-room"],
      ["kaifeng-panlou-counter", "kaifeng-panlou-courtyard"],
      ["kaifeng-panlou-counter", "kaifeng-panlou-kitchen"],
    ],
  },
] as const;

const KAIFENG_RETAIL_INTERIORS = [
  { slug: "medicine", name: "惠民药铺", district: "maxing", category: "medicine", rooms: ["门厅", "药柜", "诊室", "炮制房", "药库", "后院"] },
  { slug: "tea", name: "春风茶坊", district: "panlou", category: "tea", rooms: ["门厅", "茶堂", "雅座", "点茶台", "后厨", "储茶房"] },
  { slug: "warehouse", name: "广济邸店", district: "bian-river", category: "warehouse", rooms: ["门厅", "客堂", "货栈", "账房", "马厩", "后院"] },
  { slug: "silk", name: "汴京绫罗铺", district: "panlou", category: "textile", rooms: ["门厅", "绫罗堂", "量体间", "裁作间", "库房", "后院"] },
  { slug: "pawn", name: "永通金银质库", district: "palace-cross", category: "finance", rooms: ["门厅", "柜台", "验货间", "契房", "金银库", "后院"] },
  { slug: "books", name: "崇文书铺", district: "zhuque", category: "books", rooms: ["门厅", "书堂", "经籍架", "抄书间", "印作间", "书库"] },
  { slug: "smithy", name: "通济铁器作", district: "junyi", category: "smithy", rooms: ["门面", "炉房", "锻台", "磨房", "铁料库", "后院"] },
  { slug: "bath", name: "安乐浴堂", district: "liangmen", category: "bath", rooms: ["门厅", "更衣间", "浴池", "热水房", "休息堂", "后院"] },
] as const;

const KAIFENG_SHOP_DISTRICTS = [
  { streetId: "maxing", count: 24, names: ["惠民药铺", "保和堂", "广济药铺", "陈家香药铺", "仁济医馆", "顺安鞍辔行", "骏马行", "和剂药铺"] },
  { streetId: "panlou", count: 24, names: ["春风茶坊", "汴京绫罗铺", "潘楼脚店", "会仙酒楼", "丰乐食店", "张家果子铺", "彩帛铺", "香茶铺"] },
  { streetId: "bian-river", count: 18, names: ["广济邸店", "通津货栈", "顺成米行", "汴河木行", "丰盈油店", "盐引铺", "船脚牙行", "惠民粮铺"] },
  { streetId: "zhuque", count: 18, names: ["崇文书铺", "孙好手馒头店", "御街肉行", "朱雀鱼行", "五味食店", "南门客店", "纸墨铺", "鞋履铺"] },
  { streetId: "junyi", count: 12, names: ["通济铁器作", "开封木作", "铜器铺", "冠帽铺", "车马修作", "瓷器铺"] },
  { streetId: "liangmen", count: 8, names: ["安乐浴堂", "梁门布铺", "染坊", "花木铺"] },
  { streetId: "east-water", count: 8, names: ["东水门邸店", "河鲜行", "脚夫行", "竹木铺"] },
  { streetId: "palace-cross", count: 8, names: ["永通金银质库", "界身珠玉铺", "金银彩帛铺", "文房铺"] },
] as const;

export const KAIFENG_BUILDING_LAYER_IDS = [
  ...KAIFENG_BUILDINGS.map((building) => building.layerId),
  ...KAIFENG_RETAIL_INTERIORS.map((building) => `kaifeng-shop-${building.slug}-ground`),
];

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
      title: "维基百科：北宋东京城遗址",
      url: "https://zh.wikipedia.org/wiki/北宋东京城遗址",
      contentVersion: "pageid-1637237@2026-08-04",
      retrievedAt: WORLD_SEED_RETRIEVED_AT,
      notes: "用于东京开封府三重城郭、宫城、艮岳与金明池等历史结构；坐标为适配八方向行走的相对复原。",
    },
    {
      id: "source-song-map",
      title: "维基文库：《东京梦华录》卷一至三",
      url: "https://zh.wikisource.org/wiki/東京夢華錄",
      contentVersion: "lastrevid-2503718@2026-05-21",
      retrievedAt: WORLD_SEED_RETRIEVED_AT,
      notes: "公有领域史料；用于外城、旧城、大内、御街、四河、桥梁、街巷、市场、寺观与官署名称及相对关系。",
    },
  ];

  const layers: WorldSeedLayer[] = [
    { id: "world-root", name: "八方世界", description: "楼门路与北宋东京开封府相连的连续大地图；东境仍在建设。", parentLayerId: null },
    { id: "home-ground", name: "嬴长嫚与楼夜秋之家", description: "庭院、起居、卧室、书房与修炼空间相连的单层住宅。", parentLayerId: "world-root" },
    ...KAIFENG_BUILDINGS.map((building) => ({
      id: building.layerId,
      name: building.layerName,
      description: building.layerDescription,
      parentLayerId: "world-root",
    })),
    ...KAIFENG_RETAIL_INTERIORS.map((building) => ({
      id: `kaifeng-shop-${building.slug}-ground`,
      name: `${building.name}·一层平面`,
      description: `${building.name}临街营业与后场作业相连的单层店铺。`,
      parentLayerId: "world-root",
    })),
  ];
  const regions: WorldSeedRegion[] = [
    { id: "home", layerId: "home-ground", name: "嬴长嫚与楼夜秋之家·单层平面", description: "两人共同生活、修炼与工作的现代单层住宅。", x: -240, y: -80, width: 960, height: 800 },
    { id: "world-home", layerId: "world-root", name: "嬴长嫚与楼夜秋之家", description: "楼门路旁住宅的外部入口。", x: 400, y: 80, width: 160, height: 160 },
    ...KAIFENG_BUILDINGS.map((building) => ({
      id: building.regionId,
      layerId: building.layerId,
      name: building.regionName,
      description: building.layerDescription,
      x: -240,
      y: -560,
      width: 480,
      height: 1200,
    })),
    ...KAIFENG_RETAIL_INTERIORS.map((building) => ({
      id: `kaifeng-shop-${building.slug}`,
      layerId: `kaifeng-shop-${building.slug}-ground`,
      name: building.name,
      description: `${building.name}的单层营业空间。`,
      x: -240,
      y: -240,
      width: 480,
      height: 800,
    })),
  ];
  const locations: WorldSeedLocation[] = [];
  const routes: WorldSeedRoute[] = [];
  const actions: WorldSeedAction[] = [
    { id: "observe-entrance", locationId: "home-entrance", name: "整理衣装", description: "在玄关整理衣装，准备出门。", cashWenDelta: 0, hpDelta: 0, resultTemplate: "{name}在玄关整理好衣装。" },
    { id: "observe-road", locationId: "loumen-road", name: "观察街道", description: "看看楼门路上来往的人群。", cashWenDelta: 0, hpDelta: 0, resultTemplate: "{name}站在楼门路上观察四周。" },
    { id: "observe-song", locationId: "song-gate", name: "眺望东京", description: "从入口眺望北宋东京开封府。", cashWenDelta: 0, hpDelta: 0, resultTemplate: "{name}在入口处眺望东京城。" },
    { id: "observe-construction", locationId: "world-construction-site", name: "查看建设告示", description: "查看楼门路东端的封路与建设告示。", cashWenDelta: 0, hpDelta: 0, resultTemplate: "{name}查看了东境建设告示。" },
  ];
  const baseLocationSources: WorldSeedData["baseLocationSources"] = [];
  const shopfronts: WorldSeedShopfront[] = [];
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
  addLocation({ id: "home-entrance", layerId: "home-ground", name: "玄关", description: "嬴长嫚与楼夜秋之家的内外分界。", regionId: "home", gridX: 0, gridY: 0, sourceId: "source-home-design", sourceKey: "home/ground/entrance" });
  addLocation({ id: "home-exterior", layerId: "world-root", name: "嬴长嫚与楼夜秋之家·入口", description: "从楼门路进入住宅的门前。", regionId: "world-home", gridX: 3, gridY: 1, sourceId: "source-home-design", sourceKey: "outside/home-entrance" });
  addLocation({ id: "loumen-road-west", layerId: "world-root", name: "楼门路", description: "楼门路西段，沿街向西接入北宋东京开封府。", regionId: null, gridX: 2, gridY: 2, sourceId: "source-home-design", sourceKey: "outside/loumen-road/west" });
  addLocation({ id: "loumen-road", layerId: "world-root", name: "楼门路", description: "住宅门前的楼门路中段。", regionId: null, gridX: 3, gridY: 2, sourceId: "source-home-design", sourceKey: "outside/loumen-road/center" });
  addLocation({ id: "loumen-road-east", layerId: "world-root", name: "楼门路", description: "楼门路东段通往仍在建设的东境边界。", regionId: null, gridX: 4, gridY: 2, sourceId: "source-home-design", sourceKey: "outside/loumen-road/east" });
  addLocation({ id: "song-gate", layerId: "world-root", name: "东京开封府入口", description: "由楼门路进入北宋东京开封府城市路网。", regionId: "song", gridX: 1, gridY: 2, sourceId: "source-song-wikipedia", sourceKey: "东京城/入口" });
  addLocation({ id: "world-construction-site", layerId: "world-root", name: "东境建设中", description: "楼门路东端设有围挡与告示，后续区域尚未开放。", regionId: null, gridX: 5, gridY: 2, sourceId: "source-home-design", sourceKey: "outside/east-construction" });

  addTransition("route-home-door-v4", "home-entrance", "home-exterior", "door");
  addNormal("route-home-road-v4", "home-exterior", "loumen-road");
  addNormal("route-loumen-west-v4", "loumen-road", "loumen-road-west");
  addNormal("route-loumen-east-v4", "loumen-road", "loumen-road-east");
  addNormal("route-road-song-v4", "loumen-road-west", "song-gate");
  addNormal("route-road-construction-v10", "loumen-road-east", "world-construction-site");

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
    description: "停留在修炼房中，修为会按服务器时间自动增长。", cashWenDelta: 0, hpDelta: 0,
    resultTemplate: "{name}在修炼房中静心吐纳。",
  });

  addLocation({
    id: "song-overview-entry", layerId: "world-root", name: "东京东关驿道", description: "由楼门路抵达东京开封府东关的驿道。",
    regionId: "song", gridX: 0, gridY: 2, sourceId: "source-song-wikipedia", sourceKey: "东京城/东关驿道",
  });
  addNormal("route-world-song-v3", "song-gate", "song-overview-entry");

  for (const [slug, name, gridX, gridY, description, sourceKey] of KAIFENG_LANDMARKS) {
    addLocation({
      id: `song-landmark-${slug}`, layerId: "world-root", name: `东京城·${name}`, description,
      regionId: "song", gridX, gridY, sourceId: "source-song-wikipedia", sourceKey,
    });
  }

  for (const building of KAIFENG_BUILDINGS) {
    for (const [id, name, gridX, gridY, description] of building.locations) {
      addLocation({
        id,
        layerId: building.layerId,
        name: `${building.regionName}·${name}`,
        description,
        regionId: building.regionId,
        gridX,
        gridY,
        sourceId: "source-song-map",
        sourceKey: `东京梦华录/建筑/${building.regionId}/${id}`,
      });
    }
    building.links.forEach(([fromLocation, toLocation], index) => {
      addNormal(`route-${building.regionId}-ground-${index + 1}`, fromLocation, toLocation);
    });
    addTransition(
      `route-${building.regionId}-entrance`,
      building.exteriorId,
      building.interiorEntranceId,
      building.transitionKind,
    );
  }

  const ensureKaifengStreetCell = (
    streetId: string,
    streetName: string,
    description: string,
    gridX: number,
    gridY: number,
  ) => {
    const existing = locationIdsByCell.get(cellKey("world-root", gridX, gridY));
    if (existing) return existing;
    const id = `song-street-${streetId}-${coordinateToken(gridX)}-${coordinateToken(gridY)}`;
    addLocation({
      id, layerId: "world-root", name: streetName, description, regionId: "song", gridX, gridY,
      sourceId: "source-song-map", sourceKey: `东京梦华录/街路/${streetId}/${gridX}/${gridY}`,
    });
    return id;
  };

  for (const [streetId, streetName, axis, fixed, start, end, description] of KAIFENG_STREETS) {
    let previousId: string | null = null;
    let previousX = 0;
    let previousY = 0;
    for (let value = start; value <= end; value += 1) {
      const gridX = axis === "horizontal" ? value : fixed;
      const gridY = axis === "horizontal" ? fixed : value;
      const currentId = ensureKaifengStreetCell(streetId, streetName, description, gridX, gridY);
      if (previousId) {
        addNormal(
          `route-kaifeng-${streetId}-${coordinateToken(previousX)}-${coordinateToken(previousY)}-${coordinateToken(gridX)}-${coordinateToken(gridY)}`,
          previousId,
          currentId,
        );
      }
      previousId = currentId;
      previousX = gridX;
      previousY = gridY;
    }
  }

  let previousEntryId = "song-overview-entry";
  for (let gridX = -1; gridX >= -5; gridX -= 1) {
    const currentId = ensureKaifengStreetCell(
      "east-entry",
      "东京城·东关驿道",
      "从东关驿亭通往东水门街的入城道路。",
      gridX,
      2,
    );
    addNormal(`route-kaifeng-east-entry-${Math.abs(gridX)}`, previousEntryId, currentId);
    previousEntryId = currentId;
  }

  const shopCategory = (name: string) => {
    if (["药", "医"].some((part) => name.includes(part))) return "medicine";
    if (["茶"].some((part) => name.includes(part))) return "tea";
    if (["酒", "食", "馒头", "肉", "鱼", "果子"].some((part) => name.includes(part))) return "food";
    if (["绫罗", "彩帛", "布", "染"].some((part) => name.includes(part))) return "textile";
    if (["金银", "质库", "珠玉", "盐引"].some((part) => name.includes(part))) return "finance";
    if (["书", "纸墨", "文房"].some((part) => name.includes(part))) return "books";
    if (["铁器", "木作", "铜器", "修作"].some((part) => name.includes(part))) return "craft";
    if (["邸店", "货栈", "客店", "脚店"].some((part) => name.includes(part))) return "lodging";
    if (name.includes("浴堂")) return "bath";
    return "general";
  };
  for (const district of KAIFENG_SHOP_DISTRICTS) {
    const candidates = locations
      .filter((location) => location.id.startsWith(`song-street-${district.streetId}-`))
      .sort((left, right) => left.gridY - right.gridY || left.gridX - right.gridX || left.id.localeCompare(right.id));
    if (candidates.length < district.count) throw new Error(`${district.streetId} 没有足够街路地点铺设店面。`);
    const selected = new Set<number>();
    for (let index = 0; index < district.count; index += 1) {
      let cursor = Math.floor(((index + 1) * candidates.length) / (district.count + 1));
      while (selected.has(cursor)) cursor = (cursor + 1) % candidates.length;
      selected.add(cursor);
      const location = candidates[cursor];
      const baseName = district.names[index % district.names.length];
      const cycle = Math.floor(index / district.names.length);
      const name = cycle === 0 ? baseName : `${baseName}${["东柜", "西柜", "南柜"][cycle - 1] ?? `${cycle + 1}号`}`;
      location.name = `东京城·${name}`;
      location.description = `${name}位于${KAIFENG_STREETS.find(([streetId]) => streetId === district.streetId)?.[1] ?? "东京街市"}，店面类型依据北宋东京行业记载复原，具体字号为项目推定。`;
      shopfronts.push({
        id: `shop-${district.streetId}-${String(index + 1).padStart(2, "0")}`,
        locationId: location.id,
        name,
        category: shopCategory(name),
        documented: false,
      });
    }
  }

  for (const shop of KAIFENG_RETAIL_INTERIORS) {
    const frontage = shopfronts.find((candidate) => candidate.name === shop.name);
    if (!frontage) throw new Error(`${shop.name} 缺少街面入口。`);
    const layerId = `kaifeng-shop-${shop.slug}-ground`;
    const regionId = `kaifeng-shop-${shop.slug}`;
    const roomCoordinates = [[0, 2], [0, 1], [-1, 0], [1, 0], [0, 0], [0, -1]] as const;
    const roomIds = shop.rooms.map((roomName, index) => {
      const id = `kaifeng-shop-${shop.slug}-room-${index + 1}`;
      addLocation({
        id,
        layerId,
        name: `${shop.name}·${roomName}`,
        description: `${shop.name}的${roomName}。`,
        regionId,
        gridX: roomCoordinates[index][0],
        gridY: roomCoordinates[index][1],
        sourceId: "source-song-map",
        sourceKey: `东京梦华录/行业复原/${shop.slug}/${roomName}`,
      });
      return id;
    });
    [[0, 1], [1, 2], [1, 3], [1, 4], [4, 5]].forEach(([from, to], index) => {
      addNormal(`route-kaifeng-shop-${shop.slug}-${index + 1}`, roomIds[from], roomIds[to]);
    });
    addTransition(`route-kaifeng-shop-${shop.slug}-entrance`, frontage.locationId, roomIds[0], "door");
  }

  for (const location of locations) {
    if (location.regionId === "song" && location.sourceId === "source-song-wikipedia") {
      baseLocationSources.push({ locationId: location.id, sourceId: "source-song-map", sourceKey: "东京梦华录/城市关系" });
    }
  }

  const addRegionBounds = (id: string, name: string, description: string) => {
    const members = locations.filter((location) => location.regionId === id);
    const minX = Math.min(...members.map((location) => location.gridX)) * 160 - 80;
    const minY = Math.min(...members.map((location) => location.gridY)) * 160 - 80;
    const maxX = Math.max(...members.map((location) => location.gridX)) * 160 + 80;
    const maxY = Math.max(...members.map((location) => location.gridY)) * 160 + 80;
    regions.push({ id, layerId: "world-root", name, description, x: minX, y: minY, width: maxX - minX, height: maxY - minY });
  };
  addRegionBounds("song", "大宋·东京开封府", "依《东京梦华录》与北宋东京城遗址资料复原的城门、宫城、御街、河桥与坊市路网。");

  return { sources, layers, regions, locations, routes, actions, baseLocationSources, shopfronts };
}
