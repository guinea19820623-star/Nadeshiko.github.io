"""撫子動畫片段建置：把「精靈表 + JSON」切格、清雜點、對齊身高，輸出桌寵用的 660x660 WebP 與 manifest 片段資料。
用法：python build_clips.py --src <精靈表資料夾> --out <桌寵專案根目錄> --raw <切格原圖輸出資料夾> [--only key1,key2]
"""
import argparse, glob, json, os, statistics as st
from PIL import Image, ImageChops, ImageStat

CANVAS, GROUND = 660, 648
S_GLOBAL = 614 / 701.5      # 新素材站姿首格約 701px 高 → 舊桌寵站姿 614px
STAND_X = 332                # 舊 idle 的外框中心 x
HANG = (330, 30)             # 拎起：頭頂中心對到這一點（舊 drag 的頭頂在 (330, 21)，程式從這裡往下 6% 抓住後頸）

# no：切格原圖的編號（資料夾前綴，固定不變）；src：claude-workspaces 裡的資料夾名；name：切格原圖用的短名（省略＝src）
# key：桌寵裡的片段名；anchor：對齊方式；格序都是 1 起算
#   once    ：整段播一次，最後淡回站姿
#   intro   ：開頭只播一次的範圍；loop：之後反覆播的範圍；xfade：循環接縫的交叉淡化秒數
#   k       ：額外縮放。坐姿影片是近景，頭比站姿大；用頭部橫帶寬度對齊新版站姿（197px）算出來
#   sprites ：同時輸出成單張圖（2026-11-03 起所有單張圖都來自新動畫，舊立繪全部退場）（取代同名的舊立繪），{單張圖名: 格序}；片段還沒載好、淡入淡出、碰撞判定都用它
#   wired   ：False 代表只切格與輸出，不接進桌寵
#   range   ：只用這幾格（祐標出能用的範圍）；intro／loop／sprites 的格序仍用原本的編號
#   stabilize：逐格把外框中心拉回同一高度（原地循環用）
#   shift   ：{格序: (dx, dy)} 原圖像素逐格平移，拉回飄走的人
#   track   ：鏡頭會拉遠拉近的影片用。[(格序, k, 水平微調), …] 之間的格線性內插；每格最低點（貼地處）放到 648，水平以原圖中心 384 → 332
#             top_min：頭頂最高只到畫布這個 y，跳太高的格往下挪
#             ground_src：鏡頭不動時給原圖的地面 y（腳底），每格都用它，不逐格貼最低點（裙擺垂下來時人才不會跳）
#   match   ：顏色對齊用的格序（要是站姿）；整段乘上讓那格跟站著發呆一樣亮的紅綠藍倍率
#   derive  ：用同一批圖另外登記幾個片段，不多存檔：dict(key, seq=(起, 迄)（迄 < 起＝倒著播）或多段 [(起, 迄, 速度), …], loop=True?, xfade, speed)
#   register：False 代表只輸出圖檔、不登記自己（只登記 derive 出來的片段）
#   seat    ：坐／趴在視窗邊緣用：原圖裡「貼著視窗邊」那條線的 y；seat_to：那條線要放到畫布的哪個 y（省略就照錨點換算）
CLIPS = [
    # 伸懶腰：最後一格不是站姿，播完再倒著（1.5 倍速）退回第 1 格的站姿，不用淡出重影
    dict(no=1,  src='伸懶腰',     key='stretchall', anchor='stand', once=True, register=False, sprites={'stretch': 8}, wired=False,   # 舊版 16 格（2026-11-10 換成伸懶腰49）
         derive=[dict(key='stretch', seq=[(1, 16), (15, 1, 1.5)])]),
    dict(no=2,  src='側睡',       key='sleepside', anchor='lie',   loop=(1, 16), xfade=0.3, k=0.93, sprites={'sleepside': 1}),
    dict(no=3,  src='出錯困惑',   key='confused',  anchor='stand', intro=(1, 9), loop=(10, 16), xfade=0.2, sprites={'confused': 10}),
    # 坐下（#04）、坐下2（#05）、坐著打盹（#06）、跪坐（#23）由 #44–46「坐下＋起身」取代（沒有起身動作）
    dict(no=4,  src='坐下',       key='seat1',     anchor='sit',   loop=(8, 16), intro=(1, 7), xfade=0.3, k=0.80, wired=False),
    dict(no=5,  src='坐下2',      key='sit2_old',  anchor='sit',   loop=(1, 16), xfade=0.4, k=0.70, wired=False),
    dict(no=6,  src='坐著打盹',   key='doze_old',  anchor='sit',   loop=(1, 16), xfade=0.3, k=0.84, wired=False),
    # 完成歡呼（#07）、拖曳2（#28）、點一下開心跳（#29）由 #57–59 幀數加倍的新版取代
    dict(no=7,  src='完成歡呼',   key='cheer_old', anchor='stand', loop=(1, 16), xfade=0.2, wired=False),
    dict(no=8,  src='工作中',     key='work',      anchor='stand', intro=(1, 4), loop=(5, 16), xfade=0.2, sprites={'work': 5, 'work2': 12}),
    dict(no=9,  src='工作中(揮手版本)', key='waitwave', anchor='stand', intro=(1, 6), loop=(7, 16), xfade=0.25),
    dict(no=10, src='思考',       key='think',     anchor='stand', intro=(1, 9), loop=(10, 16), xfade=0.2, sprites={'think': 10}),
    # 打哈欠（#11）、東張西望（#15）由 #51、#53 幀數加倍的新版取代
    dict(no=11, src='打哈欠',     key='yawn_old',  anchor='stand', once=True, wired=False),
    # 揮手打招呼（#12）由 #54 幀數加倍的新版取代
    dict(no=12, src='揮手打招呼', key='wave_old',  anchor='stand', loop=(1, 16), xfade=0.15, wired=False),
    # 昏倒（#13）祐決定不用，只留昏倒2（faintb）
    dict(no=13, src='昏倒',       key='faint',     anchor='lie',   intro=(1, 9), loop=(10, 16), xfade=0.3, wired=False),
    dict(no=14, src='昏倒2',      key='faintb',    anchor='lie',   intro=(1, 6), loop=(7, 15), xfade=0.3),
    dict(no=15, src='東張西望',   key='curious_old', anchor='stand', once=True, wired=False),
    # 東張西望2（#16）祐覺得銜接不順，改用 #38 新版
    dict(no=16, src='東張西望2',  key='curious2_old', anchor='side', once=True, wired=False),
    dict(no=17, src='禱告',       key='pray_16',   anchor='stand', intro=(1, 5), loop=(6, 16), xfade=0.25, wired=False),   # 舊版：一開始就合掌，進出會跳（2026-11-10 換成禱告49）
    # 站著打瞌睡（祐 2026-11-10 手動試播）：1–4 閉眼、5–16 來回（閉眼呼吸，頭髮裙擺擺動）、醒來 16→1 倒著播回站姿（起身從當下那格接著倒）
    dict(no=18, src='站著打瞌睡', key='sleep',     anchor='stand', loop=(1, 16), xfade=0.3, sprites={'sleep': 1},
         derive=[dict(key='standdozedown', seq=(1, 4)),
                 dict(key='standdoze', seq=[(5, 16), (15, 6)], loop=True, xfade=0.1),
                 dict(key='standdozeup', seq=(16, 1))]),
    dict(no=19, src='緩降',       key='float_old', anchor='stand', loop=(1, 10), xfade=0.25, wired=False),
    # 飛行（#20）由 #41 飛行+落地取代
    dict(no=20, src='飛行',       key='fly3_old',  anchor='stand', intro=(1, 8), loop=(9, 16), xfade=0.25, wired=False),
    # 飛行2（#21）由 #40 優雅起飛+落地取代
    dict(no=21, src='飛行2',      key='fly2_old',  anchor='fly',   loop=(1, 16), xfade=0.3, k=1.05, wired=False),
    # 2026-11-03 第二批：取代舊立繪（27／28 站姿與眨眼、61 跪坐、pose、77 害羞、30 摸頭、59／68 拎起）
    # 舊的 16 格站著發呆：片段改名不用，但靜態圖 idle／blink 仍從這裡出（所有動作的淡入底圖，位置不變）
    dict(no=22, src='站著發呆（idle，眨眼）', name='站著發呆', key='idle_16', anchor='stand', loop=(1, 16), xfade=0.3, sprites={'idle': 1, 'blink': 9}),
    # 站著發呆49（2026-11-10）：呼吸、眨眼三次、頭髮裙擺輕擺；第 49 格跟第 1 格幾乎一樣，整段直接循環
    dict(no=75, src='站著發呆49', key='idle', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, loop=(1, 49), xfade=0.1),
    dict(no=23, src='坐下休息（日式跪坐）', name='跪坐', key='seiza', anchor='sit', loop=(1, 16), xfade=0.3, k=0.80, wired=False),
    # 擺姿勢（祐 2026-11-10）：16 是站姿、1 是眨眼比姿勢 → 16→1 擺出姿勢、1–12 來回、1→16 回站姿（回站姿從當下那格接著播）
    dict(no=24, src='擺姿勢',     key='poseall_16', wired=False, anchor='stand', once=True, register=False, sprites={'pose': 8},   # 舊版 16 格（2026-11-12 換成擺姿勢49）
         derive=[dict(key='posein', seq=(16, 1)),
                 dict(key='poseloop', seq=[(1, 12), (11, 2)], loop=True, xfade=0.1),
                 dict(key='poseout', seq=(1, 16))]),
    dict(no=25, src='害羞',       key='shy_16',    anchor='stand', once=True, sprites={'shy': 7}, wired=False),   # 舊版 16 格（2026-11-10 換成害羞49）
    dict(no=26, src='摸頭',       key='pat',       anchor='stand', intro=(1, 3), loop=(4, 16), xfade=0.3, sprites={'pat': 8}),
    # 拎起：只用離地之後的格（拖曳1 第 1–6 格、拖曳2 第 1–3 格還站在地上），頭頂對到 hang（拖曳1 往上提一點免得腳尖出畫布；拖曳2 手腳甩得開，縮 0.95）
    # 拖曳1：12–16 格頭髮在原影片就被切掉（頭頂貼著上緣），只用 8–11 來回播；人在影片裡一路往上飄，用 shift 逐格把臉拉回第 8 格的位置（2026-11-08 祐）
    dict(no=27, src='拖曳 1：乖乖被拎著', name='拖曳1', key='drag_src', anchor='hang', hang=(330, 20), loop=(8, 11), xfade=0.1, register=False,
         shift={9: (-2, 7), 10: (-2, 14), 11: (-1, 18)}, sprites={'drag': 9},
         derive=[dict(key='drag', seq=[(8, 11), (10, 9)], loop=True, xfade=0.1)]),
    dict(no=28, src='拖曳 2：掙扎亂踢', name='拖曳2', key='drag2_old', anchor='hang', hang=(330, 38), k=0.95, intro=(4, 4), loop=(5, 16), xfade=0.25, wired=False),
    # 2026-11-03 第三批：取代舊 28 開心、23 疲憊、76／80 坐在視窗邊緣、83 趴在視窗上緣、78 緩降，並新增兩種落地
    dict(no=29, src='點一下開心跳', key='happy_old', anchor='stand', once=True, wired=False),
    # 疲憊：揉眼睛（1–15）播一次，之後在睏倦站姿（16–25）循環；每 14 秒另外插一次打哈欠
    dict(no=30, src='有點累的站姿', key='tired_25', wired=False, anchor='stand', intro=(1, 15), loop=(16, 25), xfade=0.3, sprites={'tired': 20}),
    # 坐在視窗邊緣：屁股與撐著的手在原圖 y≈430，這條線貼著視窗邊緣
    dict(no=31, src='坐在視窗邊緣', key='sit_edge', anchor='stand', seat=430, loop=(2, 19), xfade=0.1, sprites={'sit_edge': 1, 'sit_edge_b': 9}),
    # 祐 2026-11-11：視窗邊緣兩段原本 1→25 單向循環、25 淡回 1，接縫正是腳位置差最大的地方（坐：腳差 13.2，一般相鄰 2～11）。
    #   坐：腳 9 格擺一輪，改 2–19（兩輪，第 20 格≈第 2 格）；趴：改 9–22（第 23 格≈第 9 格，含 13–14 眨眼）。趴的腳本身每格就換位置（原圖 6 格/秒），要根治得重孵 49 格
    # 趴在視窗上緣：近景構圖，頭寬 285px → ×0.69；手肘與肚子在原圖 y≈612，放到畫布 630（垂下的頭髮才不會被畫布下緣裁掉）
    dict(no=32, src='趴在視窗上緣', key='lie_top', anchor='seat', seat=612, seat_to=630, k=0.69, loop=(9, 22), xfade=0.1, sprites={'lie_top': 1, 'lie_top_b': 13}),
    # 新緩降（側身張開雙手）：前 8 格身體被裁到，只用 9–16；影片裡她一路往下飄，逐格穩住在原地（stabilize）
    dict(no=33, src='緩降', name='緩降2', key='float', anchor='float', stabilize=True, range=(9, 16), loop=(9, 16), xfade=0.3, sprites={'float': 9}),
    # 落地：低處（13–25：著地、蹲下、站起）、高處（3–25：半空、摔在地上、爬起來、站好）
    dict(no=34, src='低處落地',     key='land',    anchor='stand', once=True, range=(13, 25)),
    # 高處摔倒（#35）由 #60 幀數加倍的新版取代
    dict(no=35, src='高處摔倒再爬起', key='tumble_old', anchor='stand', once=True, range=(3, 25), wired=False),
    # 2026-11-03 第四批：昏倒與睡午覺改成「躺下 → 循環 → 醒來站起」同一段影片，倒著播就是躺下
    # 兩段影片鏡頭都在拉遠（站起來只剩站姿的 0.86 倍），用 track 逐格補回來，站好時跟站著發呆一樣高
    # 昏倒那段：躺著時比站姿近（頭寬目測 ×0.83 剛好），坐起來後（第 17 格起）鏡頭才拉遠；側睡醒來那段整段一樣遠，只是躺著時右邊會出畫布，往左挪 22px
    dict(no=36, src='昏倒2+清醒', key='faint2all', anchor='track', match=25, track=[(17, 0.83), (23, 1.165)], once=True, register=False,
         # 循環用來回播（1→5→2），頭不會在接縫跳回去；第 6 格起頭開始挪、第 9 格起眼睛會睜開
         derive=[dict(key='faint2', seq=[(1, 5), (4, 2)], loop=True, xfade=0.2),   # 閉眼昏迷
                 dict(key='faint2up', seq=(6, 25)),                                # 睜眼、坐起、站好
                 dict(key='faint2down', seq=(25, 6), speed=2.0)],                  # 倒著播加速＝昏倒倒下
         sprites={'faint': 5}),
    dict(no=37, src='新版側睡醒來+清醒', name='側睡醒來', key='nap2all', anchor='track', match=25, track=[(12, 1.165, -22), (23, 1.165, 0)], once=True, register=False,
         # 循環用來回播（1→4→2）：第 6 格頭往左挪 8px，原本 1–6 循環接回第 1 格時頭會抖；第 8 格眼睛會睜開
         derive=[dict(key='nap2', seq=[(1, 4), (3, 2)], loop=True, xfade=0.2),     # 閉眼側睡
                 dict(key='nap2up', seq=(1, 25)),                                  # 醒來、坐起揉眼、站好
                 dict(key='nap2down', seq=(25, 1), speed=1.5)]),                  # 倒著播（稍快）＝躺下睡覺
    # 東張西望2 新版：正面 → 轉側身張望 → 轉回正面。鏡頭比站姿遠（身高 596px），腳底固定在原圖 y=681
    # 蓋棉被睡+起床：第 1 格是站姿參考圖、2–13 閉眼睡、14 起睜眼掀被站起。躺著時鏡頭近（×0.98）、站起來遠（×1.175）
    dict(no=39, src='蓋棉被睡+起床', name='蓋棉被', key='blanketall_25', wired=False, anchor='track', track=[(17, 0.98), (23, 1.175)], once=True, register=False,
         # 蓋棉被睡：2–8 一次呼吸（8≈2）；11–13 被子鼓高 26–38px，接回 2 會疊出兩層被子，不用。head_src 把氣泡固定在頭上（Z 字和被子不算頭）
         derive=[dict(key='blanket', seq=(2, 8), loop=True, xfade=0.2, head_src=(120, 421)),
                 dict(key='blanketup', seq=(14, 25)),                              # 睜眼、掀被、站好
                 dict(key='blanketdown', seq=(25, 14), speed=1.5)]),               # 倒著播＝鑽進棉被躺下
    # 優雅起飛+落地：1–9 起飛（蹲低、起跳、升空）、10–12 水平滑翔來回播、13–25 直立緩降、站好。鏡頭不動，腳底在原圖 y=681
    dict(no=40, src='優雅起飛+落地', key='fly2all', wired=False, anchor='track',   # 2026-11-12 換成飛行49
    track=[(1, 1.175)], ground_src=681, top_min=4, once=True, register=False,
         # 滑翔只用頭最穩的 10–12 來回播（祐查到第 9→10 格頭掉 24px，13 又再掉 14px）；9 歸起飛、13 起歸落地
         derive=[dict(key='fly2up', seq=(1, 9)),
                 dict(key='fly2', seq=[(10, 12), (11, 11)], loop=True, xfade=0.1),
                 dict(key='fly2down', seq=(13, 25))]),
    # 飛行+落地：1–5 起飛、6–14 平飛循環、15–25 落地站好。平飛時手腳張很開（寬 700px），站姿 ×1.175、平飛縮到 ×1.06 才放得進畫布
    dict(no=41, src='飛行+落地', key='fly3all', wired=False, anchor='track',   # 2026-11-12 換成飛行49
    track=[(3, 1.175), (6, 1.06), (14, 1.06), (17, 1.175)], ground_src=681, top_min=4,
         once=True, register=False,
         derive=[dict(key='fly3up', seq=(1, 5)),
                 dict(key='fly3', seq=[(6, 14), (13, 7)], loop=True, xfade=0.15),    # 來回播：頭一路往前飄 38px，單向循環接縫會跳
                 dict(key='fly3down', seq=(15, 25))]),
    # 走路（2026-11-03）：往右「自然走路」、往左「雙手互握優雅漫步」，各自轉身起步 → 走路循環 → 轉回正面
    # 側面走時腳底比正面站姿低幾 px，地面線取 684 折衷（站姿只浮 3px、走路腳尖只出畫布一點）
    dict(no=42, src='向右走', key='walkRall_25', wired=False, anchor='track', track=[(1, 1.175)], ground_src=684, once=True, register=False,
         derive=[dict(key='walkRstart', seq=(1, 5)),                               # 正面 → 轉身 → 第一步
                 dict(key='walkR', seq=(6, 17), loop=True, xfade=0.15),            # 每 6 格一個完整步伐，第 18 格≈第 6 格
                 dict(key='walkRstop', seq=(24, 25))]),                            # 第 24 格≈第 18 格，接第 25 格轉回正面
    dict(no=43, src='向左走2', key='walkLall_25', wired=False, anchor='track', track=[(1, 1.175)], ground_src=684, once=True, register=False,
         derive=[dict(key='walkLstart', seq=(1, 5)),
                 dict(key='walkL', seq=(6, 20), loop=True, xfade=0.15),            # 第 21 格≈第 6 格
                 dict(key='walkLstop', seq=(21, 25))]),                            # 21–23 還在走、24–25 轉回正面
    # 走路49（2026-11-12，取代上面兩段 25 格）：鏡頭不動，每格 0.082 秒。側面走時腳尖比站姿低到 713，地面線取 704 折衷（站姿只浮 2px）
    #   向右：1–7 轉身、8–40 走、41–48 轉回正面；12 格一個完整步伐，第 35 格≈第 23 格 → 起步 1–22、循環 23–34、收尾 35–48
    #   向左（祐標「些微瑕疵」：24–28 腿纏在一起、像三隻腳）：1–7 轉身、7–43 雙手互握漫步、43–48 轉回正面。避開 24–28：
    #   起步 1–11、循環 12–22 接 30–40（第 30 格≈第 23 格、第 41 格≈第 12 格，兩個接縫跟一般相鄰格差不多）、收尾 41–48
    dict(no=79, src='向右走49', key='walkRall', anchor='track', track=[(1, 1.095)], ground_src=704, once=True, register=False,
         derive=[dict(key='walkRstart', seq=(1, 22)), dict(key='walkR', seq=(23, 34), loop=True, xfade=0.1), dict(key='walkRstop', seq=(35, 48))]),
    dict(no=80, src='向左走49些微瑕疵', key='walkLall', anchor='track', track=[(1, 1.095)], ground_src=704, once=True, register=False,
         derive=[dict(key='walkLstart', seq=(1, 11)), dict(key='walkL', seq=[(12, 22), (30, 40)], loop=True, xfade=0.1), dict(key='walkLstop', seq=(41, 48))]),
    dict(no=38, src='東張西望2新版', key='curious2', anchor='track', track=[(1, 1.175)], ground_src=681, once=True, sprites={'curious2': 10}, wired=False),   # 祐 2026-11-12：只留 49 格正面版（側身版大動作容易孵出背後的大蝴蝶結）
    # 坐下＋起身（2026-11-03）：首幀是站著發呆，一段影片做完「坐下 → 坐著 → 站回原位」。鏡頭不動，站姿身高 638px（×1.095 對齊站著發呆），腳底在原圖 y=702
    # 坐著時裙擺鋪在腳前面，比腳底低十幾 px，出畫布的幾 px 剛好在地面線下，看不到
    # 坐著的循環都用來回播：頭會慢慢偏，單向接回去會跳
    # 祐：眨眼、點頭、擺頭太頻繁，所以循環開頭那格先停住幾秒（(格, 格, 速度)，每格原本 0.2 秒，速度 0.2/停秒數）再動一次
    # 2026-11-10 換成 49 格版（每格 0.102 秒，鏡頭不動：站姿兩端都是 638px、腳底 702，跟 25 格版同一套對齊）。舊 25 格版留在 #44–46 下面，wired=False
    # 祐：照影片順序連續播、不跳格。坐下＝1→L0，坐著＝L0–L1 幾格來回（L0 先停幾秒），起身＝從 L0 接著播到 49
    # 坐著大多停在 L0，起身就從同一格接下去；眨眼用「播到閉眼最後一格就倒回去」＝只眨一次
    dict(no=64, src='跪坐49', key='kneelall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='kneeldown', seq=(1, 19)),                               # 拉裙擺、跪下、坐定（10–12 閉眼微笑）
                 # 跪坐：19 停 4.6 秒 → 20–23（22、23 閉眼）→ 倒回 20，一輪約 5.3 秒
                 dict(key='kneel', seq=[(19, 19, 0.102 / 4.6), (20, 23), (22, 20)], loop=True, xfade=0.2),
                 dict(key='kneelup', seq=(19, 49))],                               # 從 19 接著播：眨眼、立起一膝、站起來、站好
         sprites={'sit1': 19, 'sit1_b': 23}),
    dict(no=65, src='雙手放膝的坐姿49', key='kneesall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='kneesdown', seq=(1, 13)),
                 # 雙手放膝：13→22 播完在 22 停 5 秒（眨眼），倒回 13 再停 5 秒（祐 2026-11-10）；停著的時候程式疊呼吸（SEATS.knees.breath）
                 dict(key='knees', seq=[(13, 21), (22, 22, 0.102 / 5.0), (21, 14), (13, 13, 0.102 / 5.0)], loop=True, xfade=0.2),
                 dict(key='kneesup', seq=(13, 49))],                               # 從 13 接著播：眨眼、擺頭、低頭撐膝站起
         sprites={'sit2': 13}),
    # 抱膝 49 格版沒有眨眼，整段閉眼把臉埋在手臂上＝坐著睡覺，祐指定當「坐著打盹」；呼吸由程式疊（SEATS.doze.breath）
    dict(no=66, src='抱膝49', key='dozeall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='dozedown', seq=(1, 17)),                                # 坐下、抱膝、把臉埋進手臂
                 dict(key='doze', seq=[(17, 21), (20, 18)], loop=True, xfade=0.3, speed=0.25),   # 17–21 放慢來回播；22 眼睛微微睜開，是醒來的第一格（祐），只用在起身
                 dict(key='dozeup', seq=(17, 49))],                                # 從 17 接著播：抬頭、睜眼、站起
         sprites={'doze': 19}),
    dict(no=44, src='跪坐+起身', name='跪坐起身', key='kneelall_25', wired=False, anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='kneeldown', seq=(1, 5)),                                # 站著 → 拉裙擺跪下
                 # 跪坐：13 停 4.6 秒 → 14–16 閉眼 → 退回 14，一輪約 5.6 秒（祐：12 頭會動、17 手腳都動）
                 dict(key='kneel', seq=[(13, 13, 0.2 / 4.6), (14, 16), (15, 14)], loop=True, xfade=0.2),
                 dict(key='kneelup', seq=(17, 25))],                               # 立起一膝、站起來
         sprites={'sit1': 10, 'sit1_b': 16}),
    dict(no=45, src='雙手放膝的坐姿+起身', name='放膝坐起身', key='kneesall_25', wired=False, anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='kneesdown', seq=(1, 5)),
                 # 雙手放膝：8 停 1.9 秒 → 9–12 擺頭 → 退回 9，一輪約 3.5 秒（祐：15 手的位置移動了）
                 dict(key='knees', seq=[(8, 8, 0.2 / 1.9), (9, 12), (11, 9)], loop=True, xfade=0.2),
                 dict(key='kneesup', seq=(13, 25))],                               # 雙手撐膝站起
         sprites={'sit2': 10}),
    # 抱膝那段閉著眼睛把臉埋在手臂上，比較像打瞌睡，祐指定取代坐著打盹（#06）
    dict(no=46, src='抱膝+起身', name='抱膝起身', key='dozeall_25', wired=False, anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='dozedown', seq=(1, 5)),
                 # 打盹：9 停 4.6 秒 → 10–13 點頭 → 退回 10，一輪約 6 秒（祐：14 會讓循環出問題）
                 dict(key='doze', seq=[(9, 9, 0.2 / 4.6), (10, 13), (12, 10)], loop=True, xfade=0.3),
                 dict(key='dozeup', seq=(14, 25))],                                # 抬頭醒來、站起
         sprites={'doze': 11}),
    # 唱歌（2026-11-03）：像樂團女高音，一手放胸前、一手伸向前方。1–4 抬手、5–16 唱（來回播）、17–25 放下手回站姿。鏡頭跟坐下＋起身一樣
    dict(no=47, src='唱歌', key='singall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='singstart', seq=(1, 4)),
                 dict(key='sing', seq=[(5, 16), (15, 6)], loop=True, xfade=0.2),
                 dict(key='singend', seq=(17, 25))]),
    # 小提琴（#48，25 格）由 #49 幀數加倍的新版取代
    dict(no=48, src='小提琴', key='violin_old', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False, wired=False),
    # 小提琴新版（2026-11-03，7×7＝49 格、每格約 0.1 秒）：1–14 拿起琴、架上肩、舉弓，15–48 拉琴；最後一格不用，收琴把 14→1 倒著播
    # 第 7 格琴是半透明的（影片在變形），開頭和收琴都跳過；拉琴 15–48 來回播，倒著播剛好是弓往回拉
    dict(no=49, src='小提琴新版', key='violinall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='violinstart', seq=[(1, 6), (8, 14)]),
                 dict(key='violin', seq=[(15, 48), (47, 16)], loop=True, xfade=0.1),
                 dict(key='violinend', seq=[(14, 8), (6, 1)])]),
    # 指揮（2026-11-03，7×7＝49 格）：1–3 舉起指揮棒，4–33 指揮（每 6 格一拍組，第 4、10、16、22、28 格都是棒子往左平指），34–49 放下棒子、睜眼回站姿
    # 打拍子有方向，倒著播會怪，所以循環單向播 4–33，第 33 格接回第 4 格
    dict(no=50, src='指揮', key='conductall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='conductstart', seq=(1, 3)),
                 dict(key='conduct', seq=(4, 33), loop=True, xfade=0.1),
                 dict(key='conductend', seq=(34, 49))]),
    # 2026-11-03 幀數加倍（7×7＝49 格）的三段：首尾都是站著發呆，整段播一次。鏡頭跟坐下＋起身一樣
    # 打哈欠新版（約 5 秒）：摀嘴打哈欠、揉眼、放下手
    dict(no=51, src='打哈欠新版', key='yawn', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, sprites={'yawn': 20}),
    # 提屈膝禮（約 4 秒）：拎裙、交叉腳、屈膝低頭（19–28 停在最低）、起身。裙擺鋪開時比腳底低 11px，剛好在地面線下
    dict(no=52, src='提屈膝禮', key='curtsy', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, sprites={'curtsy': 22}),
    # 東張西望新版（約 4 秒）：往右看、往左看、手指抵下巴歪頭、轉回正面
    dict(no=53, src='東張西望新版', key='curious', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, sprites={'curious': 8}),
    # 揮手新版（49 格、約 4 秒）：1–7 舉手、8–42 揮手、43–49 放下。打招呼、揮手、Claude 的打招呼狀態（剛好 4 秒）都整段播一次
    dict(no=54, src='揮手新版', key='wave', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, sprites={'wave': 10}),
    # 芭蕾·旋轉（49 格、約 5 秒）：3–5 抬手、6–33 踮腳轉兩圈、34–43 落下回站姿。轉的時候雙手舉過頭（原圖頭頂到 y=0），縮到 ×1.05 才不出畫布
    dict(no=55, src='旋轉', key='pirouette', anchor='track', track=[(4, 1.095), (6, 1.05), (34, 1.05), (36, 1.095)], ground_src=702, match=1, once=True,
         sprites={'pirouette': 16}),
    # 芭蕾·阿拉貝斯克（49 格、約 4 秒）：3–12 抬腿伸手、13–31 停在單腳站姿、32–45 收腿回站姿；伸直的腿到原圖 x=44，剛好在畫布裡
    dict(no=56, src='阿拉貝斯克', key='arabesque', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, sprites={'arabesque': 20}),
    # 完成歡呼新版（49 格、約 4 秒）：1–4 張開雙手、5–42 原地跳 7 下、43–49 最後一大跳、落地放下手回站姿。
    #   大小（祐 2026-11-10：結尾有瞬間縮小放大）：舊版 46→48 兩格就從 ×1.05 跳回 ×1.095（差 4%）。改成跳的那段 ×1.079（跳最高頭頂剛好不出畫布），
    #   最後一大跳（44，原圖手已經碰頂）再慢慢縮到 ×1.065，落地 44→49 分 5 格長回 ×1.095；開頭 4→6 只縮 1.5%。最後 45–49 放慢（×0.65 速度）讓落地站穩
    # Claude 完成時（6 秒）：1–13 播一次，之後 14–24 循環（第 25 格≈第 14 格，差 4.6）；自己歡呼（選單、隨機）整段播一次 cheerall
    dict(no=57, src='完成歡呼新版', key='cheer', anchor='track', track=[(4, 1.095), (6, 1.079), (42, 1.079), (44, 1.065), (49, 1.095)], ground_src=702, match=1,
         intro=(1, 13), loop=(14, 24), xfade=0.1, sprites={'cheer': 11},
         derive=[dict(key='cheerall', seq=[(1, 44), (45, 49, 0.65)])]),
    # 點一下開心跳新版：雙手合掌、冒愛心、小跳兩下。40 格之後幾乎不動，只用 1–40（約 3.3 秒）；跳起來時頭到原圖頂端，跳的那段縮到 ×1.05
    dict(no=58, src='點一下開心跳新版', key='happy', anchor='track', track=[(4, 1.095), (6, 1.05), (32, 1.05), (35, 1.095)], ground_src=702, match=1,
         once=True, range=(1, 40), sprites={'happy': 9}),
    # 掙扎亂踢新版：1–4 還站在地上、5–40 被拎著踢腳、41–49 放回地面站好。拎起只用離地的格：5–11 播一次，12–29 循環（第 30 格≈第 12 格，差 6.8）
    # 第 22、23 格腳甩到快碰地，照站姿大小會出畫布下緣，縮到 ×1.04（舉手、甩頭髮的格頂端也剛好不出去）
    # 高處摔倒再爬起新版（49 格）：1–4 站著不用（掉下來交給程式），5–6 著地、7–21 跌坐發暈揉頭、22–33 趴下撐地爬起、34–46 站好（之後幾乎不動，不用）
    # 頭髮鋪在地上時（26–30 格）比腳底低 30px，出畫布下緣一點點，只裁到地面線以下的髮尾
    dict(no=60, src='高處摔倒再爬起新版', key='tumble', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, range=(5, 46)),
    # 兩段新飛行（49 格，面向右，往左飛鏡像）：影片模型把「上下浮動」做成一跳一跳（每 7 格落回地面一次，像空中青蛙跳），
    # 所以只挑腳離地、姿勢最穩的 3 格來回播當飛行循環（放慢到 0.6 倍），起飛和落地各自從最像的那格剪接過去
    # 飛的時候手腳張開比畫布寬，飛行那段縮到 ×1.0
    # 祐 2026-11-03 試看後決定不用：飛行時人變小（×1.0 看得出縮水），優雅那段像被從側邊拎起來；飛行姿勢之後重做，先用回 #40、#41
    # 平飛：1–9 轉身起跳 → 接 30（第 9 格≈第 30 格，差 1.4）→ 30→32→31 來回 → 32–37 落地轉回正面
    # 2026-11-08 祐用 GPT Images 2.6 孵的 16 格轉圈（GIF 4×4 總覽，原本每格約 275px，放大到站姿高度 700px；腳底 733、頭的中心 384 已在切格時對好）
    # 1–6 轉過去、7–9 背身時頭髮裙擺甩開（來回播三趟，稍慢）、10–16 轉回正面（祐：轉身的飄逸挑幾格來回播）
    # 2026-11-08 祐看過不用：原圖小（每格約 275px 放大近 2.7 倍）、16 格太少，人物抖動大
    dict(no=63, src='旋轉GPT16格', key='twirlall', anchor='stand', match=1, once=True, register=False, wired=False,
         derive=[dict(key='twirl', seq=[(1, 9), (8, 7, 0.8), (8, 9, 0.8), (8, 7, 0.8), (8, 9, 0.8), (8, 7, 0.8), (8, 9, 0.8), (10, 16)])]),
    # 點頭贊同、搖頭困惑（2026-11-10，49 格，鏡頭不動，跟坐姿 49 格同一套對齊）：撫子回覆時用動作通道叫
    dict(no=67, src='點頭贊同49', key='nod', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, range=(1, 42)),   # 點兩下頭，42 之後都是靜止站姿
    # 禱告49（2026-11-10）：1–11 舉手合掌閉眼、11–33 祈禱（來回循環）、33–46 睜眼放下手回站姿；起身從當下那格接著播
    dict(no=70, src='禱告49', key='prayall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         sprites={'praying': 20},
         derive=[dict(key='praydown', seq=(1, 11)),
                 dict(key='prayloop', seq=[(11, 33), (32, 12)], loop=True, xfade=0.2),
                 dict(key='prayup', seq=(11, 46))]),
    # 工作49（2026-11-10）：3–11 平板發光出現、12–30 操作平板、31–40 平板發光淡掉、46 回站姿
    #   Claude 工作中：1→14 拿出平板，14–29 來回操作，離開工作狀態時從當下那格播到 46（收起平板回站姿）
    dict(no=71, src='工作49', key='workall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='workdown', seq=(1, 14)),
                 dict(key='workloop', seq=[(14, 29), (28, 15)], loop=True, xfade=0.2),
                 dict(key='workup', seq=(14, 46))]),
    # 報錯49（2026-11-10）：前段愣住眨眼、12–19 舉手、20–34 抓頭、35–45 放下手；1–3 沒動
    dict(no=72, src='報錯49', key='errall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='errdown', seq=(4, 20)),
                 dict(key='errloop', seq=[(20, 34), (33, 21)], loop=True, xfade=0.2),
                 dict(key='errup', seq=(20, 46))]),
    # 思考49（2026-11-10）：4–12 手指抵下巴、13–37 思考（後段閉眼沉思）、38–45 想到了放下手
    dict(no=73, src='思考49', key='thinkall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='thinkdown', seq=(1, 16)),
                 dict(key='thinkloop', seq=[(16, 37), (36, 17)], loop=True, xfade=0.2),
                 dict(key='thinkup', seq=(16, 46))]),
    # 等你確認49（2026-11-10）：3–9 平板發光出現、10–34 拿著平板朝觀眾揮手、35–38 平板淡掉、47 回站姿
    dict(no=74, src='等你確認49', key='waitall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='waitdown', seq=(1, 14)),
                 dict(key='waitloop', seq=[(14, 34), (33, 15)], loop=True, xfade=0.2),
                 dict(key='waitup', seq=(14, 47))]),
    # 伸懶腰49（2026-11-10）：3–11 十指交扣往上推、12–16 手舉過頭、17–24 張開雙臂左右伸展、25–40 放下手甩一甩；44 之後靜止
    dict(no=76, src='伸懶腰49', key='stretch', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, range=(1, 44)),
    # 摸頭49（2026-11-10，其實是用害羞提示詞孵的：閉眼臉紅、雙手合在胸前、左右搖擺）：1–13 閉眼合手、14–28 搖一個來回（第 29 格≈第 14 格）循環，
    #   停手時從當下那格播到 46 回站姿
    dict(no=77, src='摸頭49', key='patall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='patdown', seq=(1, 13)),
                 dict(key='patloop', seq=(14, 28), loop=True, xfade=0.1),
                 dict(key='patup', seq=(14, 46))]),
    # 害羞49（2026-11-10）：3–8 微側身雙手捧臉、8–33 閉眼捧臉左右扭、中間偷看一眼、34–45 放下手轉回正面；46 之後靜止
    dict(no=78, src='害羞49', key='shy', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, range=(1, 46)),
    # 擺姿勢49（2026-11-12）：1–11 擺出單手托腮眨眼、12–30 維持（17–28 最穩）、31–37 放下手；38 之後靜止
    dict(no=81, src='擺姿勢49', key='poseall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False, sprites={'pose': 20},
         derive=[dict(key='posein', seq=(1, 17)),
                 dict(key='poseloop', seq=[(17, 28), (27, 18)], loop=True, xfade=0.1),
                 dict(key='poseout', seq=(17, 41))]),
    # 聖誕節：送你禮物49（2026-11-12）：1–10 雙手繞到背後、11–15 拿出紅禮物盒、16–27 捧著（18–27 閉眼笑）、28–33 化成光點消散、34–39 回站姿；40 之後靜止
    #   捧著那段只有 1 秒，多來回一次拉長；18–19 盒子還在移動，所以只在 20–27 來回（祐 2026-11-12）
    dict(no=82, src='聖誕節：送你禮物49', key='giftall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='gift', seq=[(1, 27), (26, 20), (21, 27), (28, 40)])]),
    # 生日快樂49（2026-11-12）：1–4 雙手到背後、金光；5 蛋糕突然冒出又消失（祐：不用）；6–10 從金光裡拿出蛋糕；11–29 捧著點蠟燭的蛋糕左右搖；
    #   30 化成光點、31–40 雙手合十、41–45 放下手；46 之後靜止。第 27 格≈第 16 格，16–26 多搖兩輪拉長捧蛋糕的時間
    dict(no=83, src='生日快樂49', key='bdayall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='birthday', seq=[(1, 4), (6, 26), (16, 26), (16, 46)])]),
    # 5 小時額度用完49（2026-11-12，祐標「些微瑕疵」：9–11 枕頭突然消失）：用第 8 格的枕頭（右端被裙襬擋住，拿左半邊鏡像補齊）墊回 9–11
    #   躺著時棉被加枕頭幾乎佔滿原圖寬度，×1.095 會出畫布 → 跟舊版一樣躺著縮到 ×0.98，縮放只放在動作大的 1→3（棉被出現、跪下）與 38→46（掀被起身）
    #   1 站著、2–8 棉被枕頭出現、跪坐揉眼、9–13 躺下拉被、14–36 睡著（第 36 格≈第 16 格）、37–45 醒來坐起掀被站起、46 之後站好
    dict(no=84, src='5 小時額度用完（蓋棉被睡覺）49些微瑕疵', key='blanketall', anchor='track', track=[(1, 1.095), (3, 0.98), (38, 0.98), (46, 1.095)], ground_src=702, match=1, once=True, register=False,
         underlay=('patches/blanket49_pillow.png', [9, 10, 11]),
         # 祐 2026-11-12：整段放慢 30%（speed 0.7）
         derive=[dict(key='blanketdown', seq=(1, 15), speed=0.7),
                 dict(key='blanket', seq=(16, 35), loop=True, xfade=0.15, head_src=(150, 448), speed=0.7),
                 dict(key='blanketup', seq=(36, 48), speed=0.7)]),
    # 85% 疲憊49（2026-11-12）：4–12 肩膀垂下、眼皮變重；12–33 揉眼、搖搖晃晃（來回）；34–44 打起精神站好
    dict(no=85, src='85% 疲憊（有點累）49', key='tiredall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False, sprites={'tired': 20},
         derive=[dict(key='tireddown', seq=(1, 12)),
                 dict(key='tiredloop', seq=[(12, 33), (32, 13)], loop=True, xfade=0.15),
                 dict(key='tiredup', seq=(12, 45)),
                 # 祐 2026-11-14：疲憊改成站著，每 10–15 秒隨機播一次「揉眼」（整段 1→45，站→揉眼→站）或打哈欠
                 dict(key='tiredrub', seq=(1, 45))]),
    # 飛行49（2026-11-12，取代兩種舊飛行）：小仙子式，身體微前傾、膝蓋彎起、雙手往兩側張開，寬度跟站著差不多，不用縮小。
    #   這段和天燈49 的首幀比其他 49 格小 2%（身高 623 對 637、腳底 694），track ×1.1196、地面線 694 補回來
    #   1–5 蹲低、6–7 起跳、8–33 飛（第 23 格≈第 15 格）、34–38 降落、39–48 站好 → 起飛 1–14、循環 15–22、落地 23–48（先飛完一段再降落）
    dict(no=87, src='飛行49', key='fly4all', anchor='track', track=[(1, 1.1196)], ground_src=694, match=1, once=True, register=False,
         derive=[dict(key='fly4up', seq=(1, 14)),
                 dict(key='fly4', seq=(15, 22), loop=True, xfade=0.1),
                 dict(key='fly4down', seq=(23, 48))]),
    # 天燈49（2026-11-12）：2 天燈出現、2–22 捧著許願、23–27 往上推、28 起天燈飛出畫面上緣、29–45 抬頭看、回站姿。
    #   第 28 格換成擦掉天燈的版本（tools/patches/make_lantern49.py 產生），天燈改成獨立漂浮物（app/sprites/lantern.png）從那裡飄出螢幕
    dict(no=86, src='天燈49', key='lanternall', anchor='track', track=[(1, 1.1196)], ground_src=694, match=1, once=True, register=False,
         replace={28: 'patches/lantern49_f28.png'},
         derive=[dict(key='lantern', seq=(1, 46))]),
    # 仙女棒49（2026-11-12）：3–8 微側身撥裙、9–11 蹲下、12–31 拿著仙女棒揮（影片裡沒有火花，火花由 pet.js 照棒子尖端補畫）、32–37 放下、38–45 站起回正面。
    #   首幀比其他 49 格小 2%（同飛行49）；蹲著時裙襬會超出畫布左緣 9px，9–37 整體往右挪 14px（pet.js 的 SPARK_DX 一起算）
    dict(no=88, src='仙女棒49', key='sparkler', anchor='track', track=[(1, 1.1196, 0), (9, 1.1196, 14), (37, 1.1196, 14), (44, 1.1196, 0)],
         ground_src=694, match=1, once=True, range=(1, 46)),
    # 凱爾特豎琴49（2026-11-13）：1–13 金光中豎琴出現、14–38 撥弦（16–38 是木頭色、位置不動）、39–44 化成光點、45–49 回站姿。
    #   去背時琴弦被吃掉大半，tools/patches/harp49_strings.py 把 16–38 格的殘影清掉、重畫 16 條琴弦。豎琴底座在原圖 y≈736，畫布下緣夠放。
    #   演奏：1→18 播一次，18–38 來回（單向接縫差都比相鄰格大），收琴從當下那格播到 49
    dict(no=89, src='凱爾特豎琴49', key='harpall', anchor='track', track=[(1, 1.1196)], ground_src=694, match=1, once=True, register=False,
         preprocess='patches/harp49_strings.py',
         derive=[dict(key='harpstart', seq=(1, 18)),
                 dict(key='harp', seq=[(18, 38), (37, 19)], loop=True, xfade=0.1),
                 dict(key='harpend', seq=(18, 49))]),
    # 電子琴49（2026-11-13）：4–7 鍵盤發光出現、8–38 彈琴（左右移動、點頭）、39–42 鍵盤化成光點、43–49 回站姿。
    #   演奏：1→10 播一次，10–37 來回，收琴從當下那格播到 49
    dict(no=90, src='電子琴49', key='keysall', anchor='track', track=[(1, 1.1196)], ground_src=694, match=1, once=True, register=False,
         derive=[dict(key='keysstart', seq=(1, 10)),
                 dict(key='keys', seq=[(10, 37), (36, 11)], loop=True, xfade=0.1),
                 dict(key='keysend', seq=(10, 49))]),
    # 收信（2026-11-10，49 格，鏡頭不動）：信封飄下 → 接住拆封 → 讀信 → 信淡出 → 回站姿；40 之後靜止
    # 新的暈倒＋起身49（2026-11-14，取代昏倒2 側躺；祐：週上限躺平跟蓋棉被睡覺太像）：從站姿開始，首幀比其他 49 格小 2%（同飛行49）
    #   1–8 頭暈扶額、腿軟坐倒；9–15 側坐垂頭；16–25 閉眼昏迷；26–35 頭更低、手撐地；36–38 站起（37 動態模糊，放慢）；39–49 站好
    #   坐倒時裙襬比站姿寬、也比腳底低（離鏡頭近）：9–35 往右挪 20px、14–35 往上提 10px，才不會出畫布
    dict(no=91, src='新的暈倒＋起身49', key='faint3all', anchor='track',
         track=[(7, 1.1196, 0, 0), (9, 1.1196, 20, 0), (12, 1.1196, 20, 0), (15, 1.1196, 20, -10), (35, 1.1196, 20, -10), (37, 1.1196, 0, 0)], ground_src=694, match=1, once=True, register=False,
         # 祐 2026-11-14 午：16–25 整段循環時手會微抬、髮尾甩很兇，像一直收縮膨脹 → 只用最穩的 20–22 慢慢來回，有呼吸感就好
         #   （逐區量相鄰格差：20–22 髮尾、手、頭都最小；切格原圖在 撫子動作幀\切格原圖\91_新的暈倒＋起身49）
         derive=[dict(key='faint3down', seq=(1, 20), speed=0.8),
                 dict(key='faint3', seq=(20, 21), loop=True, xfade=0.2, speed=0.15),   # 祐：22 頭的位置有移動，只用 20–21 來回
                 dict(key='faint3up', seq=[(20, 34), (35, 38, 0.6), (39, 49)])]),
    dict(no=69, src='收信49', key='mail', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, range=(1, 40)),
    dict(no=68, src='搖頭困惑、不認同49', key='shake', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, range=(5, 46)),   # 1–5 還沒動、46 之後靜止
    dict(no=61, src='飛行（平飛）詭異', name='平飛剪接', key='fly3all_cut', wired=False, anchor='track', track=[(3, 1.095), (6, 1.0), (35, 1.0), (37, 1.095)],
         ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='fly3up', seq=(1, 9)),
                 dict(key='fly3', seq=[(30, 32, 0.6), (31, 31, 0.6)], loop=True, xfade=0.1),
                 dict(key='fly3down', seq=(32, 37), speed=0.8)]),
    # 優雅滑翔：1–9 轉身起跳 → 23–24 → 25→26→25→24 來回 → 接 33（第 24 格≈第 33 格，差 10.8）–44 緩緩落地站好
    dict(no=62, src='優雅起飛＋滑翔.詭異', name='優雅滑翔剪接', key='fly2all_cut', wired=False, anchor='track', track=[(4, 1.095), (6, 1.0), (41, 1.0), (43, 1.095)],
         ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='fly2up', seq=[(1, 9), (23, 24)]),
                 dict(key='fly2', seq=[(25, 26, 0.6), (25, 24, 0.6)], loop=True, xfade=0.1),
                 dict(key='fly2down', seq=(33, 44), speed=0.8)]),
    dict(no=59, src='掙扎亂踢新版', key='drag2', anchor='hang', hang=(330, 46), k=1.04, intro=(5, 11), loop=(12, 29), xfade=0.1, sprites={'drag2': 20}),
]


ARCHIVE = '舊版及不良品集中處'   # 祐把舊版、不良品搬進這個子資料夾（2026-11-10）：第一層找不到就去這裡找


def load_frames(folder):
    if not glob.glob(os.path.join(folder, '*.json')):
        alt = os.path.join(os.path.dirname(folder), ARCHIVE, os.path.basename(folder))
        if glob.glob(os.path.join(alt, '*.json')):
            folder = alt
    j = json.load(open(glob.glob(os.path.join(folder, '*.json'))[0], encoding='utf8'))
    sheet = Image.open(glob.glob(os.path.join(folder, '*.png'))[0]).convert('RGBA')
    out, durs = [], []
    for f in j['frames']:
        r = f['frame']
        im = sheet.crop((r['x'], r['y'], r['x'] + r['w'], r['y'] + r['h']))
        a = im.getchannel('A').point(lambda v: 0 if v < 8 else v)   # 清掉肉眼看不到的低 alpha 殘留
        im.putalpha(a)
        out.append(im)
        durs.append(f.get('duration', 187.5) / 1000)
    return out, durs


def bbox(im, thr=20):
    return im.getchannel('A').point(lambda v: 255 if v > thr else 0).getbbox()


IDLE_SRC = '站著發呆（idle，眨眼）'


def rgb_mean(im):
    """不透明部分的紅綠藍平均"""
    a = im.getchannel('A').point(lambda v: 255 if v > 200 else 0)
    return ImageStat.Stat(im.convert('RGB'), mask=a).mean


def apply_gain(im, gains):
    r, g, b, a = im.split()
    r, g, b = [ch.point(lambda v, k=k: min(255, round(v * k))) for ch, k in zip((r, g, b), gains)]
    return Image.merge('RGBA', (r, g, b, a))


def head_x(im, top, rows=50):
    """頭頂往下 rows 列的不透明像素水平中心（頭的中心，不受手臂、裙擺影響）"""
    a = im.getchannel('A').crop((0, top, im.width, min(im.height, top + rows))).point(lambda v: 255 if v > 20 else 0)
    b = a.getbbox()
    return (b[0] + b[2]) / 2 if b else im.width / 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--raw', default=None, help='切格原圖輸出資料夾；省略就不重切')
    ap.add_argument('--only', default='', help='只重建這幾個片段（逗號分隔的 key），其餘沿用 manifest 裡現有的')
    args = ap.parse_args()
    only = {k for k in args.only.split(',') if k}

    man_path = os.path.join(args.out, 'app', 'sprites', 'manifest.json')
    man = json.load(open(man_path, encoding='utf8'))
    sdir = os.path.join(args.out, 'app', 'sprites')
    cdir = os.path.join(sdir, 'clips')
    os.makedirs(cdir, exist_ok=True)
    clips, report = (dict(man.get('clips', {})) if only else {}), []

    for c in CLIPS:
        if only and c['key'] not in only:
            continue
        label = c['src']
        frames, durs = load_frames(os.path.join(args.src, label))
        n = len(frames)
        # underlay：(圖檔, [格序…])，把修補圖墊在那幾格底下（原圖座標 768×768）。影片裡東西突然消失時，從前後格補回來
        if c.get('underlay'):
            ufile, ufr = c['underlay']
            layer = Image.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), ufile)).convert('RGBA')
            for fi in ufr:
                patched = layer.copy(); patched.alpha_composite(frames[fi - 1]); frames[fi - 1] = patched
        # preprocess：tools/ 底下的 .py，裡面的 fix(frames) 會拿到原圖 768×768 的格（第 1 格在 frames[0]），回傳修好的（例如豎琴琴弦重畫）
        if c.get('preprocess'):
            import importlib.util
            spec = importlib.util.spec_from_file_location('pre', os.path.join(os.path.dirname(os.path.abspath(__file__)), c['preprocess']))
            pre = importlib.util.module_from_spec(spec); spec.loader.exec_module(pre)
            frames = pre.fix(frames)
        # replace：{格序: 圖檔}，整格換成修補好的圖（原圖座標 768×768）
        for fi, rfile in c.get('replace', {}).items():
            frames[fi - 1] = Image.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), rfile)).convert('RGBA')
        tag = f"{c['no']:02d}_{c.get('name', label)}"
        # ① 切格原圖：768 原尺寸、編號，給祐之後做首尾幀用
        if args.raw:
            rd = os.path.join(args.raw, tag)
            os.makedirs(rd, exist_ok=True)
            for i, im in enumerate(frames, 1):
                im.save(os.path.join(rd, f'{tag}_{i:02d}.png'), optimize=True)

        # 顏色對齊：影片整段調色偏暗時，拿第 match 格（站姿）跟站著發呆比，紅綠藍各自補到一樣亮，整段都乘上
        if c.get('match'):
            ref = rgb_mean(load_frames(os.path.join(args.src, IDLE_SRC))[0][0])
            cur = rgb_mean(frames[c['match'] - 1])
            gains = [r / max(1, v) for r, v in zip(ref, cur)]
            frames = [apply_gain(f, gains) for f in frames]
            report.append(f"   #{c['no']:02d} 顏色補正 ×" + '/'.join(f'{g:.3f}' for g in gains))

        # 只用祐標出能用的那幾格；之後的格序都扣掉 r0（檔名仍用原本的編號）
        r0, r1 = c.get('range', (1, n))
        frames, durs, n = frames[r0 - 1:r1], durs[r0 - 1:r1], r1 - r0 + 1
        # shift：{格序: (dx, dy)} 原圖像素，逐格平移（影片裡人慢慢飄走時，把臉拉回同一個位置）
        for fi, (dx, dy) in c.get('shift', {}).items():
            im = frames[fi - r0]
            moved = Image.new('RGBA', im.size, (0, 0, 0, 0))
            moved.alpha_composite(im, (max(0, dx), max(0, dy)), (max(0, -dx), max(0, -dy)))
            frames[fi - r0] = moved

        # ② 對齊：整組同一個縮放與位移，保留影片本身的位移與起伏
        bbs = [bbox(f) for f in frames]
        # 真的會播到的格（循環片段：開頭到循環結尾；沒用到的前幾格不影響對齊）
        used = range(n) if c.get('once') else range((c.get('intro') or c['loop'])[0] - r0, c['loop'][1] - r0 + 1)
        s = S_GLOBAL * c.get('k', 1.0)
        med = lambda xs: st.median(xs)
        bottom_m = med([b[3] for b in bbs])
        cx_m = med([(b[0] + b[2]) / 2 for b in bbs])
        cy_m = med([(b[1] + b[3]) / 2 for b in bbs])
        a = c['anchor']
        if a == 'stand':     # 影片鏡頭固定：腳底 733 → 649，水平中心 384 → 332
            ox, oy = STAND_X - 384 * s, 649 - 733 * s
        elif a == 'side':    # 側身站姿：腳底貼地，水平以外框中心對齊舊 curious2（335）
            ox, oy = 335 - cx_m * s, 649 - bottom_m * s
        elif a == 'sit':
            ox, oy = 330 - cx_m * s, 648 - bottom_m * s
        elif a == 'lie':
            ox, oy = 330 - cx_m * s, 648 - bottom_m * s
        elif a == 'hang':    # 拎起：只看用到的格，頭頂中心（中位數）對到 HANG
            tops = [bbs[i][1] for i in used]
            hx = [head_x(frames[i], bbs[i][1]) for i in used]
            hang = c.get('hang', HANG)
            ox, oy = hang[0] - med(hx) * s, hang[1] - med(tops) * s
        elif a == 'seat':    # 趴在視窗上緣：水平置中，貼著視窗的那條線放到 seat_to
            ox, oy = 330 - cx_m * s, c['seat_to'] - c['seat'] * s
        elif a == 'float':   # 緩降：外框中心對齊 (330, cy)，預設是舊 78 的中心 y 341
            ox, oy = 330 - cx_m * s, c.get('cy', 341) - cy_m * s
        elif a == 'track':   # 逐格算，見下面的迴圈
            ox, oy = 0, 0
        elif a == 'fly':     # 飛行：以外框中心對齊舊 fly3 的中心（329, 346）
            ox, oy = 329 - cx_m * s, 346 - cy_m * s
        else:
            raise SystemExit(f'unknown anchor {a}')

        files, boxes, heads, overflow, xf = [], [], [], 0, []
        sz = int(round(768 * s))
        seat = round(oy + c['seat'] * s) if c.get('seat') else None

        def track_at(i):
            # 回傳 (k, dx, dy)：關鍵格之間線性內插；dx／dy 是水平／垂直微調（省略＝0）
            ks = [(t[0], t[1], t[2] if len(t) > 2 else 0, t[3] if len(t) > 3 else 0) for t in c['track']]
            if i <= ks[0][0]: return ks[0][1:]
            for (f0, k0, d0, e0), (f1, k1, d1, e1) in zip(ks, ks[1:]):
                if i <= f1:
                    u = (i - f0) / (f1 - f0)
                    return k0 + (k1 - k0) * u, d0 + (d1 - d0) * u, e0 + (e1 - e0) * u
            return ks[-1][1:]

        for i, im in enumerate(frames, r0):
            if a == 'track':
                tk, tdx, tdy = track_at(i)
                s = S_GLOBAL * tk
                sz = int(round(768 * s))
                bi = bbs[i - r0]
                ox, oy = STAND_X + tdx - 384 * s, GROUND + tdy - c.get('ground_src', bi[3]) * s
                if 'top_min' in c and oy + bi[1] * s < c['top_min']:   # 跳太高會出畫布：這格往下挪到剛好不出去
                    oy = c['top_min'] - bi[1] * s
            xf.append((ox, oy, s))
            scaled = im.resize((sz, sz), Image.LANCZOS)
            # 位移可能是負的（alpha_composite 不收負座標），先放到比較大的暫存畫布再裁回 660
            big = Image.new('RGBA', (CANVAS + 2 * sz, CANVAS + 2 * sz), (0, 0, 0, 0))
            # stabilize：影片裡人一路往下飄的，逐格把外框中心拉回同一個高度（往下移交給程式），循環接縫才不會跳
            sy = (cy_m - (bbs[i - r0][1] + bbs[i - r0][3]) / 2) * s if c.get('stabilize') else 0
            big.alpha_composite(scaled, (sz + int(round(ox)), sz + int(round(oy + sy))))
            canvas = big.crop((sz, sz, sz + CANVAS, sz + CANVAS))
            b = bbox(canvas)
            if b is None:
                b = (0, 0, 1, 1)
            if b[0] <= 0 or b[2] >= CANVAS or b[1] <= 0 or b[3] >= CANVAS:
                overflow += 1
            name = f"{c['key']}_{i:02d}.webp"
            if c.get('wired', True):
                canvas.save(os.path.join(cdir, name), 'WEBP', quality=92, alpha_quality=100, method=6)
            files.append(name)
            boxes.append(list(b))
            heads.append([round(head_x(canvas, b[1])), b[1]])
            for sp, fi in c.get('sprites', {}).items():
                if fi == i and c.get('wired', True):
                    canvas.save(os.path.join(sdir, f'{sp}.png'), optimize=True)
                    man['sprites'][sp] = dict(file=f'{sp}.png', source=f'{tag}_{i:02d}.png', bbox=list(b), head=heads[-1])
                    if seat is not None: man['sprites'][sp]['seat'] = seat

        entry = dict(frames=files, bbox=boxes, head=heads, durations=[round(d, 4) for d in durs], label=label)
        if c.get('once'):
            entry['mode'] = 'once'
        else:
            entry['mode'] = 'loop'
            if c.get('intro'): entry['intro'] = [c['intro'][0] - r0, c['intro'][1] - r0]
            entry['loop'] = [c['loop'][0] - r0, c['loop'][1] - r0]
        if seat is not None: entry['seat'] = seat
        entry['xfade'] = c.get('xfade', 0.15)
        if c.get('wired', True) and c.get('register', True):
            clips[c['key']] = entry
        for dv in (c.get('derive', []) if c.get('wired', True) else []):   # 停用的不登記衍生片段（否則會蓋掉同名的新片段）
            # seq：(起, 迄) 或多段 [(起, 迄, 速度?), …]，迄 < 起＝倒著播；接起來就是來回播、播完倒退回去
            segs = dv['seq'] if isinstance(dv['seq'], list) else [dv['seq']]
            idx, dd = [], []
            for sg in segs:
                a0, a1 = sg[0], sg[1]
                sp = sg[2] if len(sg) > 2 else dv.get('speed', 1.0)
                order = list(range(a0, a1 + 1)) if a1 >= a0 else list(range(a0, a1 - 1, -1))
                idx += [f - r0 for f in order]
                dd += [round(durs[f - r0] / sp, 4) for f in order]
            # head_src：(x, y) 原圖像素，頭的位置寫死（頭上有 Z 字、被子之類會把自動量的頭拉走時用），氣泡就不會跑
            hs = dv.get('head_src')
            hd = [[round(xf[k][0] + hs[0] * xf[k][2]), round(xf[k][1] + hs[1] * xf[k][2])] for k in idx] if hs else [heads[k] for k in idx]
            de = dict(frames=[files[k] for k in idx], bbox=[boxes[k] for k in idx], head=hd,
                      durations=dd, label=f"{label} " + ' '.join(f'{sg[0]}→{sg[1]}' for sg in segs))
            if dv.get('loop'):
                de.update(mode='loop', loop=[0, len(idx) - 1], xfade=dv.get('xfade', 0.3))
            else:
                de.update(mode='once', xfade=0.15)
            clips[dv['key']] = de
        total_kb = sum(os.path.getsize(os.path.join(cdir, f)) for f in files if os.path.exists(os.path.join(cdir, f))) // 1024
        report.append(f"#{c['no']:02d} {c['key']:10s} anchor={a:5s} s={s:.4f} off=({ox:.1f},{oy:.1f}) bbox0={boxes[0]} overflow_frames={overflow} wired={c.get('wired', True)} kb={total_kb}")

    man['clips'] = clips
    json.dump(man, open(man_path, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    print('\n'.join(report))
    print('clips wired:', len(clips))


if __name__ == '__main__':
    main()
