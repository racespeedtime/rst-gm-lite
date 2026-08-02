/**
 * 车辆分类数据（移植自原版 RST 的 scriptfiles/Vehicles/*.txt）。
 * 每类含 车型 modelId 列表；e-selection 图片菜单会自动 3D 预览车辆模型。
 */
export interface VehicleCategory {
  /** 分类名（对话框显示） */
  label: string;
  /** 图片菜单标题 */
  menuTitle: string;
  /** 车型 modelId 列表 */
  models: number[];
}

export const VEHICLE_CATEGORIES: VehicleCategory[] = [
  { label: "跑车", menuTitle: "→ 跑车 ←", models: [562, 411, 451, 541, 415, 477, 555, 401, 402, 404, 405, 409, 410, 412, 418, 419, 421, 422, 426, 429, 436, 439, 445, 458, 466, 467, 474, 475, 479, 480, 491, 492, 496, 504, 507, 516, 517, 518, 526, 527, 529, 533, 534, 536, 540, 542, 545, 546, 547, 549, 550, 551, 558, 559, 561, 565, 566, 567, 575, 576, 580, 585, 589, 600, 603, 604, 605] },
  { label: "警车", menuTitle: "→ 警车 ←", models: [425, 427, 430, 432, 433, 470, 472, 476, 490, 497, 500, 520, 523, 528, 548, 563, 592, 595, 596, 597, 598, 599, 601] },
  { label: "飞机", menuTitle: "→ 飞机 ←", models: [460, 476, 511, 512, 513, 519, 520, 553, 577, 592, 593] },
  { label: "摩托", menuTitle: "→ 摩托 ←", models: [522, 521, 523, 581, 586, 510, 509, 481, 471, 468, 463, 462, 461, 448] },
  { label: "船", menuTitle: "→ 船 ←", models: [430, 460, 452, 453, 454, 472, 473, 484, 493, 539, 595] },
  { label: "越野", menuTitle: "→ 越野 ←", models: [400, 424, 444, 470, 489, 495, 500, 505, 556, 557, 568, 573, 579, 599] },
  { label: "拖车", menuTitle: "→ 拖车 ←", models: [403, 435, 450, 485, 514, 515, 525, 530, 531, 552, 583, 584, 591, 606, 607, 608, 610, 611] },
  { label: "货车", menuTitle: "→ 货车 ←", models: [406, 413, 414, 423, 428, 440, 443, 455, 456, 459, 478, 482, 498, 499, 524, 535, 543, 554, 573, 578, 588, 609] },
  { label: "火车及玩具车", menuTitle: "→ 火车及玩具车 ←", models: [441, 449, 464, 465, 501, 537, 538, 564, 569, 570, 590] },
  { label: "民政车", menuTitle: "→ 民政车 ←", models: [407, 408, 416, 420, 431, 437, 438, 442, 488, 544, 552, 572, 574, 577, 582] },
  { label: "其他车", menuTitle: "→ 其他车 ←", models: [457, 483, 486, 508, 532, 571, 594] },
  { label: "常用车", menuTitle: "→ 常用车 ←", models: [560, 562, 411, 451, 541, 415, 477, 555, 494, 502, 503, 506, 587, 602] },
];

/** 车型英文名（modelId-400 索引，对齐原版 VehicleNames[212][]，缺省用 ID） */
const VEHICLE_NAMES: Record<number, string> = {
  400: "Landstalker", 401: "Bravura", 402: "Buffalo", 403: "Linerunner", 404: "Pereniel",
  405: "Sentinel", 406: "Dumper", 407: "Firetruck", 408: "Trashmaster", 409: "Stretch",
  410: "Manana", 411: "Infernus", 412: "Voodoo", 413: "Pony", 414: "Mule",
  415: "Cheetah", 416: "Ambulance", 417: "Leviathan", 418: "Moonbeam", 419: "Esperanto",
  420: "Taxi", 421: "Washington", 422: "Bobcat", 423: "Mr Whoopee", 424: "BF Injection",
  425: "Hunter", 426: "Premier", 427: "Enforcer", 428: "Securicar", 429: "Banshee",
  430: "Predator", 431: "Bus", 432: "Rhino", 433: "Barracks", 434: "Hotknife",
  435: "Trailer", 436: "Previon", 437: "Coach", 438: "Cabbie", 439: "Stallion",
  440: "Rumpo", 441: "RC Bandit", 442: "Romero", 443: "Packer", 444: "Monster",
  445: "Admiral", 446: "Squalo", 447: "Seasparrow", 448: "Pizzaboy", 449: "Tram",
  450: "Trailer", 451: "Turismo", 452: "Speeder", 453: "Reefer", 454: "Tropic",
  455: "Flatbed", 456: "Yankee", 457: "Caddy", 458: "Solair", 459: "Berkley's RC Van",
  460: "Skimmer", 461: "PCJ-600", 462: "Faggio", 463: "Freeway", 464: "RC Baron",
  465: "RC Raider", 466: "Glendale", 467: "Oceanic", 468: "Sanchez", 469: "Sparrow",
  470: "Patriot", 471: "Quad", 472: "Coastguard", 473: "Dinghy", 474: "Hermes",
  475: "Sabre", 476: "Rustler", 477: "ZR-350", 478: "Walton", 479: "Regina",
  480: "Comet", 481: "BMX", 482: "Burrito", 483: "RC Goblin", 484: "Caddy",
  485: "Baggage", 486: "Tug", 487: "Hunter", 488: "FBI Rancher", 489: "FBI Truck",
  490: "FBI Rancher", 491: "Virgo", 492: "Greenwood", 493: "Jetmax", 494: "Hotring Racer",
  495: "Sandking", 496: "Blista Compact", 497: "Police Maverick", 498: "Boxville", 499: "Benson",
  500: "Mesa", 501: "RC Go-Kart", 502: "Hotring Racer", 503: "Hotring Racer", 504: "Bloodring Banger",
  505: "Rancher", 506: "Super GT", 507: "Elegant", 508: "Journey", 509: "Bike",
  510: "Mountain Bike", 511: "Beagle", 512: "Cropduster", 513: "Stuntplane", 514: "Tanker",
  515: "Roadtrain", 516: "Nebula", 517: "Majestic", 518: "Thunder", 519: "Shamal",
  520: "Hydra", 521: "FCR-900", 522: "NRG-500", 523: "HPV1000", 524: "Cement Truck",
  525: "Tow Truck", 526: "Fortune", 527: "Cadrona", 528: "FBI Truck", 529: "Willard",
  530: "Forklift", 531: "Tractor", 532: "Combine", 533: "Feltzer", 534: "Remington",
  535: "Slamvan", 536: "Blade", 537: "Freight", 538: "Brown Streak", 539: "Vortex",
  540: "Vincent", 541: "Bullet", 542: "Clover", 543: "Sadler", 544: "Firetruck",
  545: "Hustler", 546: "Intruder", 547: "Primo", 548: "Cargobob", 549: "Tampa",
  550: "Sunrise", 551: "Merit", 552: "Utility", 553: "Nevada", 554: "Yosemite",
  555: "Windsor", 556: "Monster", 557: "Monster", 558: "Uranus", 559: "Jester",
  560: "Sultan", 561: "Stratum", 562: "Elegy", 563: "Raindance", 564: "RC Tiger",
  565: "Flash", 566: "Tahoma", 567: "Savanna", 568: "Bandito", 569: "Freight",
  570: "Brown Streak", 571: "Kart", 572: "Mower", 573: "Duneride", 574: "Sweeper",
  575: "Broadway", 576: "Tornado", 577: "AT-400", 578: "DFT-30", 579: "Huntley",
  580: "Stafford", 581: "BF-400", 582: "Newsvan", 583: "Tug", 584: "Petrol Tanker",
  585: "Emperor", 586: "Wayfarer", 587: "Euros", 588: "Hotdog", 589: "Club",
  590: "Freight", 591: "Trailer", 592: "Andromada", 593: "Dodo", 594: "RC Cam",
  595: "Launch", 596: "Police Car", 597: "Police Car", 598: "Police Car", 599: "Police Ranger",
  600: "Picador", 601: "S.W.A.T. Van", 602: "Alpha", 603: "Phoenix", 604: "Glendale",
  605: "Sadler", 606: "Baggage", 607: "Baggage", 608: "Baggage", 609: "Boxville",
  610: "Baggage", 611: "Baggage",
};

/** 获取车型名（modelId 不在表内返回 ID 字符串） */
export function vehicleName(modelId: number): string {
  return VEHICLE_NAMES[modelId] ?? `模型${modelId}`;
}
