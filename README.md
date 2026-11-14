# IMPASSE

第一人称射击游戏：无血条，模块化分区毁伤判定。v0.10：开源素材落地——Quaternius 步枪视图模型、士兵假人（命中点高度带判定部位）、Kenney 城市套件重建 90×90m 街区、Poly Haven PBR 地面/墙面 + HDRI 环境光、真实枪声/换弹/脚步/命中采样（AAC .m4a，采样失败退回合成音）、Rajdhani 标题字体；两张地图（室内靶场 + 室外城市街区），主页可选地图；射击记录两张图共用。缓存隔离：本地模块与素材带 `?v=0.10` 查询串，版本号由脚本写入界面。纯静态文件，无构建步骤。素材加载失败时各自走程序化/纯色回退，游戏始终可玩。

## 本地运行

```bash
cd ~/workspace/fps-range
python3 -m http.server 8901
```

然后用浏览器打开 http://127.0.0.1:8901/（需要联网加载 Three.js CDN）。

## 操作

**桌面端（键鼠）**

| 按键 | 动作 |
|---|---|
| WASD | 移动 |
| 鼠标 | 瞄准（Pointer Lock） |
| 左键 | 射击 |
| 右键（按住） | 机瞄 |
| R | 换弹 |
| V | 切换单发 / 连发 |
| Shift | 疾跑 |
| 空格 | 跳跃（可跳上/跳过射手区内的 1.1m 枪道隔板） |
| B（按住 2.5s） | 包扎止血 |
| T | 重置靶子 |

以上键位均可在设置里重绑（开始界面 / 暂停界面的 ⚙ 设置）。

**触屏（iPad）**

| 操作 | 动作 |
|---|---|
| 左半屏虚拟摇杆 | 移动 |
| 右半屏滑动 | 转动视角 |
| 开火键（按住） | 射击 |
| 瞄准键 | 切换机瞄 |
| 换弹键 | 换弹 |
| 连发/单发键 | 切换射击模式 |
| 跳跃键（开火键上方） | 跳跃 |
| 包扎键（点按开关，2.5s 读条） | 包扎止血（带包扎动画） |
| 右上角按钮 | 重置靶子 |

设置里可调：触屏灵敏度、摇杆在左/在右、按钮大小、机瞄方式（切换/按住），以及拖拽编辑按钮布局。设置保存在浏览器 localStorage（`impasse.settings.v1`）。

## 毁伤模型（无血条）

假人分头 / 胸 / 腹 / 手臂 / 腿部五个模块。命中按部位、入射角、距离、弹头能量判定：

- **贯穿**：近距离高速穿透能量释放有限，远距离弹头翻滚能量释放充分
- **擦伤**：入射角过大，只擦过体表
- **命中骨骼偏转**：小概率，弹头擦过颅骨/长骨发生偏转
- **跳弹**：只发生在钢板、墙体、地面等硬表面，不发生在无护甲人体上

头部贯穿即失能；胸部模块损毁也失能；手臂/腿部模块损毁分别造成瞄准受扰 / 行动受限。

## 失血 debuff

命中可能触发失血（全身五个部位都可能；胸部概率 0.65 最高，腹部 0.5 其次，头部/腿部 0.3，手臂 0.25）。每处失血每秒累积严重度：假人 0.1，v0.5 起玩家 0.05（放缓，游戏不再那么难玩）：

- **假人**：失血计入所在模块毁伤，可能导致模块损毁甚至失能；伤口滴落、脚下血泊随失血量长大。部位损毁、目标失能或重置靶子后停止。
- **玩家**：红屏、瞄准晃动、移速惩罚随总失血量渐变加重（满额 -15% 移速），总失血量达到 1.5 即倒地重生（单处失血约 28 秒）。包扎 2.5 秒止住全部失血：键盘按住 B，触屏点按包扎键开关；包扎时枪身下沉内扣、左手持绷带缠绕；开火打断，与换弹互斥。v0.5 没有敌人，设置里的“模拟受伤”是唯一的触发测试钩子。

## 文件结构

```
index.html          入口 + HUD 骨架（Three.js import map，jsdelivr 0.160.0）
css/style.css       HUD、准星、触屏控制、浮层样式
js/main.js          主循环、射击判定、曳光/命中特效、计分、素材加载后建造
js/controls.js      桌面端 Pointer Lock + 触屏摇杆/视角/按钮
js/gun.js           步枪视图模型（Quaternius GLB，加载失败退回程序化模型）+ 后坐力系统
js/damage.js        纯函数毁伤模型（可独立测试，不依赖渲染器）
js/bleeding.js      纯函数失血模型（触发概率/滴答/止血/倒地阈值，可独立测试）
js/targets.js       纸靶、钢板、移动靶、分区假人（士兵 GLB，高度带判定部位；两套布局）
js/range.js         靶场环境（地面/墙体/灯光/掩体）
js/street.js        城市街区环境（90×90m 街区/Kenney 建筑车辆/5 间可进房间/PBR 地面/阳光阴影）
js/hud.js           HUD 更新（弹药/日志/计分/命中标记）
js/audio.js         采样音效（AAC .m4a，经 .b64 解码）+ WebAudio 合成回退（枪声/命中/换弹/脚步/落地/UI）
js/assets.js        素材加载（.b64 解码 → GLB/PBR/HDRI/字体，逐件 try/catch + 8 秒超时，失败即回退）
assets/             开源素材的 base64 文本（<原名>.b64，约 12.9MB，见下方致谢；二进制原件在 staging，见“素材编码”）
tools/encode-assets.mjs  素材编码器：二进制 → .b64（node，无依赖）
js/settings.js      设置存储（localStorage）+ 设置面板 + 按钮布局编辑 + 键位重绑
js/records.js       射击记录（localStorage）：最高命中率/最多命中/最快全清/总场次/上次成绩
```

## 主页与记录

主页含模式列表（靶场与城市街区可选，点卡片切换，主页背景 3D 场景跟随切换；团队死斗 5v5 置灰“开发中”，不可点）与射击记录面板（`impasse.records.v1`，两张图共用）：最高命中率只统计 ≥10 发的场次；最快全清要求当前地图的纸靶（含移动靶）全倒 + 钢板全倒 + 假人失能，全清达成时即时保存，回主页结算时再记一场。暂停界面（桌面端指针锁定丢失，或触屏点右上角“暂停”）可返回主页。

## 城市街区（v0.10 重建，90×90m）

三纵三横街道（宽 8m）+ 16 个街区：双广场（砖铺地面、花坛、遮阳伞、树、围栏）、工业角（厂房、水塔、集装箱）、5 间可进入的房间（门 + 窗，窗台 1.0m 可翻越，砖墙 PBR + 暖色顶灯）、环形天际线（界外摩天楼/矮楼/烟囱装饰）。建筑、车辆、街灯、交通灯、垃圾箱、路障、交通锥、树木均为 Kenney 城市套件模型（微缩比例放大 ×6–×8，以 1.8m 士兵模型校准）；地面沥青、人行道混凝土、广场砖铺、房间砖墙用 Poly Haven PBR 贴图（法线 + 粗糙度）；HDRI 环境光（PMREM，仅街区）+ 太阳 2048 阴影（±55m）。掩体：木箱、路障、沙袋、垃圾箱（1.15m 可跳）、停放的车（实心，跳不上去）。靶子散布 5–45m：纸靶 10、钢板 5、假人 5（士兵模型），另有移动靶横穿主街。出生点主街南端，面向北。

## 技术选型

- 渲染：Three.js 0.160.0（CDN import map，无构建；GLTFLoader/RGBELoader 走 `three/addons/`）；视图模型（枪/双手/绷带）单独一个场景、用与主镜头同步的第二台相机渲染，只吃镜头补光 + HDRI 环境光——世界点光源（房间顶灯）照不到枪上，室内不再爆白
- 命中判定：Three.js 射线检测 + 自写毁伤规则；当前版本不用物理库
- 素材：开源素材（CC0/OFL，见致谢）+ 程序化回退；模型加载失败时用同尺寸色块盒子、贴图失败时用纯色、采样失败时用合成音

## 素材编码（.b64）

推送工具只接受 UTF-8 文本文件，二进制素材无法直接入库，所以 `assets/` 里存的是 base64 文本（每个二进制文件对应一个 `<原名>.b64`），运行时由 `js/assets.js` 分块解码回字节再用（Kenney 模型的外部 colormap 贴图经 blob URL + `LoadingManager.setURLModifier` 按套件分流）。新增/更新素材时：

```bash
# 1. 把新二进制文件放进 assets/（保持 Kenney 套件目录结构）
# 2. 编码（跳过已有 .b64 与 .txt，可重复执行）
node tools/encode-assets.mjs
# 3. 验证解码与原件逐字节一致后，删除 assets/ 下的二进制文件
find assets -type f ! -name '*.b64' ! -name '*.txt' -delete
```

二进制原件的权威来源是 staging 目录（`~/workspace/impasse-assets/`），不要从那里删除。

## 致谢（开源素材）

全部素材均为 CC0 1.0（无需署名，此处自愿致谢），字体为 SIL OFL 1.1（许可证文本随附于 `assets/fonts/OFL.txt`）：

- 3D 模型：Kenney（https://kenney.nl）—— 城市套件（道路/商业/住宅/工业）与车辆套件，CC0 1.0
- 角色与武器模型：Quaternius（https://quaternius.com）—— 士兵与步枪，CC0 1.0；Kenney 狙击枪（备用）经 Cinevva CC0 rehost（https://app.cinevva.com/game-assets/free-3d-weapon-models）
- PBR 贴图与 HDRI：Poly Haven（https://polyhaven.com）—— asphalt_01 / concrete / brick_wall_001 / brick_pavement / qwantani_noon_puresky，CC0 1.0
- 枪声采样：Ben Jaszczak、Brian Nelson、Kevin Heras、Matthew Nanney（The Free Firearm Sound Library，https://opengameart.org/content/the-free-firearm-sound-library），CC0 1.0
- 换弹/脚步/命中/UI 采样：SpringySpringo、BMacZero、LFA（OpenGameArt）与 Kenney（https://kenney.nl/assets/impact-sounds、https://kenney.nl/assets/interface-sounds），CC0 1.0
- 字体：Rajdhani by Indian Type Foundry，SIL Open Font License 1.1
