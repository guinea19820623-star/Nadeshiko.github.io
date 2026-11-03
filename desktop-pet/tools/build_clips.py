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
#   track   ：鏡頭會拉遠拉近的影片用。[(格序, k, 水平微調), …] 之間的格線性內插；每格最低點（貼地處）放到 648，水平以原圖中心 384 → 332
#             top_min：頭頂最高只到畫布這個 y，跳太高的格往下挪
#             ground_src：鏡頭不動時給原圖的地面 y（腳底），每格都用它，不逐格貼最低點（裙擺垂下來時人才不會跳）
#   match   ：顏色對齊用的格序（要是站姿）；整段乘上讓那格跟站著發呆一樣亮的紅綠藍倍率
#   derive  ：用同一批圖另外登記幾個片段，不多存檔：dict(key, seq=(起, 迄)（迄 < 起＝倒著播）或多段 [(起, 迄, 速度), …], loop=True?, xfade, speed)
#   register：False 代表只輸出圖檔、不登記自己（只登記 derive 出來的片段）
#   seat    ：坐／趴在視窗邊緣用：原圖裡「貼著視窗邊」那條線的 y；seat_to：那條線要放到畫布的哪個 y（省略就照錨點換算）
CLIPS = [
    # 伸懶腰：最後一格不是站姿，播完再倒著（1.5 倍速）退回第 1 格的站姿，不用淡出重影
    dict(no=1,  src='伸懶腰',     key='stretchall', anchor='stand', once=True, register=False, sprites={'stretch': 8},
         derive=[dict(key='stretch', seq=[(1, 16), (15, 1, 1.5)])]),
    dict(no=2,  src='側睡',       key='sleepside', anchor='lie',   loop=(1, 16), xfade=0.3, k=0.93, sprites={'sleepside': 1}),
    dict(no=3,  src='出錯困惑',   key='confused',  anchor='stand', intro=(1, 9), loop=(10, 16), xfade=0.2, sprites={'confused': 10}),
    # 坐下（#04）、坐下2（#05）、坐著打盹（#06）、跪坐（#23）由 #44–46「坐下＋起身」取代（沒有起身動作）
    dict(no=4,  src='坐下',       key='seat1',     anchor='sit',   loop=(8, 16), intro=(1, 7), xfade=0.3, k=0.80, wired=False),
    dict(no=5,  src='坐下2',      key='sit2_old',  anchor='sit',   loop=(1, 16), xfade=0.4, k=0.70, wired=False),
    dict(no=6,  src='坐著打盹',   key='doze_old',  anchor='sit',   loop=(1, 16), xfade=0.3, k=0.84, wired=False),
    dict(no=7,  src='完成歡呼',   key='cheer',     anchor='stand', loop=(1, 16), xfade=0.2, sprites={'cheer': 1}),
    dict(no=8,  src='工作中',     key='work',      anchor='stand', intro=(1, 4), loop=(5, 16), xfade=0.2, sprites={'work': 5, 'work2': 12}),
    dict(no=9,  src='工作中(揮手版本)', key='waitwave', anchor='stand', intro=(1, 6), loop=(7, 16), xfade=0.25),
    dict(no=10, src='思考',       key='think',     anchor='stand', intro=(1, 9), loop=(10, 16), xfade=0.2, sprites={'think': 10}),
    dict(no=11, src='打哈欠',     key='yawn',      anchor='stand', once=True, sprites={'yawn': 8}),
    dict(no=12, src='揮手打招呼', key='wave',      anchor='stand', loop=(1, 16), xfade=0.15, sprites={'wave': 4}),
    # 昏倒（#13）祐決定不用，只留昏倒2（faintb）
    dict(no=13, src='昏倒',       key='faint',     anchor='lie',   intro=(1, 9), loop=(10, 16), xfade=0.3, wired=False),
    dict(no=14, src='昏倒2',      key='faintb',    anchor='lie',   intro=(1, 6), loop=(7, 15), xfade=0.3),
    dict(no=15, src='東張西望',   key='curious',   anchor='stand', once=True, sprites={'curious': 8}),
    # 東張西望2（#16）祐覺得銜接不順，改用 #38 新版
    dict(no=16, src='東張西望2',  key='curious2_old', anchor='side', once=True, wired=False),
    dict(no=17, src='禱告',       key='pray',      anchor='stand', intro=(1, 5), loop=(6, 16), xfade=0.25),
    dict(no=18, src='站著打瞌睡', key='sleep',     anchor='stand', loop=(1, 16), xfade=0.3, sprites={'sleep': 1}),
    dict(no=19, src='緩降',       key='float_old', anchor='stand', loop=(1, 10), xfade=0.25, wired=False),
    # 飛行（#20）由 #41 飛行+落地取代
    dict(no=20, src='飛行',       key='fly3_old',  anchor='stand', intro=(1, 8), loop=(9, 16), xfade=0.25, wired=False),
    # 飛行2（#21）由 #40 優雅起飛+落地取代
    dict(no=21, src='飛行2',      key='fly2_old',  anchor='fly',   loop=(1, 16), xfade=0.3, k=1.05, wired=False),
    # 2026-11-03 第二批：取代舊立繪（27／28 站姿與眨眼、61 跪坐、pose、77 害羞、30 摸頭、59／68 拎起）
    dict(no=22, src='站著發呆（idle，眨眼）', name='站著發呆', key='idle', anchor='stand', loop=(1, 16), xfade=0.3, sprites={'idle': 1, 'blink': 9}),
    dict(no=23, src='坐下休息（日式跪坐）', name='跪坐', key='seiza', anchor='sit', loop=(1, 16), xfade=0.3, k=0.80, wired=False),
    dict(no=24, src='擺姿勢',     key='pose',      anchor='stand', once=True, sprites={'pose': 8}),
    dict(no=25, src='害羞',       key='shy',       anchor='stand', once=True, sprites={'shy': 7}),
    dict(no=26, src='摸頭',       key='pat',       anchor='stand', intro=(1, 3), loop=(4, 16), xfade=0.3, sprites={'pat': 8}),
    # 拎起：只用離地之後的格（拖曳1 第 1–6 格、拖曳2 第 1–3 格還站在地上），頭頂對到 hang（拖曳1 往上提一點免得腳尖出畫布；拖曳2 手腳甩得開，縮 0.95）
    dict(no=27, src='拖曳 1：乖乖被拎著', name='拖曳1', key='drag', anchor='hang', hang=(330, 20), loop=(7, 16), xfade=0.3, sprites={'drag': 9}),
    dict(no=28, src='拖曳 2：掙扎亂踢', name='拖曳2', key='drag2', anchor='hang', hang=(330, 38), k=0.95, intro=(4, 4), loop=(5, 16), xfade=0.25, sprites={'drag2': 9}),
    # 2026-11-03 第三批：取代舊 28 開心、23 疲憊、76／80 坐在視窗邊緣、83 趴在視窗上緣、78 緩降，並新增兩種落地
    dict(no=29, src='點一下開心跳', key='happy',  anchor='stand', once=True, sprites={'happy': 6}),
    # 疲憊：揉眼睛（1–15）播一次，之後在睏倦站姿（16–25）循環；每 14 秒另外插一次打哈欠
    dict(no=30, src='有點累的站姿', key='tired',  anchor='stand', intro=(1, 15), loop=(16, 25), xfade=0.3, sprites={'tired': 20}),
    # 坐在視窗邊緣：屁股與撐著的手在原圖 y≈430，這條線貼著視窗邊緣
    dict(no=31, src='坐在視窗邊緣', key='sit_edge', anchor='stand', seat=430, loop=(1, 25), xfade=0.3, sprites={'sit_edge': 1, 'sit_edge_b': 9}),
    # 趴在視窗上緣：近景構圖，頭寬 285px → ×0.69；手肘與肚子在原圖 y≈612，放到畫布 630（垂下的頭髮才不會被畫布下緣裁掉）
    dict(no=32, src='趴在視窗上緣', key='lie_top', anchor='seat', seat=612, seat_to=630, k=0.69, loop=(1, 25), xfade=0.3, sprites={'lie_top': 1, 'lie_top_b': 13}),
    # 新緩降（側身張開雙手）：前 8 格身體被裁到，只用 9–16；影片裡她一路往下飄，逐格穩住在原地（stabilize）
    dict(no=33, src='緩降', name='緩降2', key='float', anchor='float', stabilize=True, range=(9, 16), loop=(9, 16), xfade=0.3, sprites={'float': 9}),
    # 落地：低處（13–25：著地、蹲下、站起）、高處（3–25：半空、摔在地上、爬起來、站好）
    dict(no=34, src='低處落地',     key='land',    anchor='stand', once=True, range=(13, 25)),
    dict(no=35, src='高處摔倒再爬起', key='tumble', anchor='stand', once=True, range=(3, 25)),
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
    dict(no=39, src='蓋棉被睡+起床', name='蓋棉被', key='blanketall', anchor='track', track=[(17, 0.98), (23, 1.175)], once=True, register=False,
         derive=[dict(key='blanket', seq=(2, 13), loop=True, xfade=0.4),           # 蓋棉被睡，循環
                 dict(key='blanketup', seq=(14, 25)),                              # 睜眼、掀被、站好
                 dict(key='blanketdown', seq=(25, 14), speed=1.5)]),               # 倒著播＝鑽進棉被躺下
    # 優雅起飛+落地：1–9 起飛（蹲低、起跳、升空）、10–12 水平滑翔來回播、13–25 直立緩降、站好。鏡頭不動，腳底在原圖 y=681
    dict(no=40, src='優雅起飛+落地', key='fly2all', anchor='track', track=[(1, 1.175)], ground_src=681, top_min=4, once=True, register=False,
         # 滑翔只用頭最穩的 10–12 來回播（祐查到第 9→10 格頭掉 24px，13 又再掉 14px）；9 歸起飛、13 起歸落地
         derive=[dict(key='fly2up', seq=(1, 9)),
                 dict(key='fly2', seq=[(10, 12), (11, 11)], loop=True, xfade=0.1),
                 dict(key='fly2down', seq=(13, 25))]),
    # 飛行+落地：1–5 起飛、6–14 平飛循環、15–25 落地站好。平飛時手腳張很開（寬 700px），站姿 ×1.175、平飛縮到 ×1.06 才放得進畫布
    dict(no=41, src='飛行+落地', key='fly3all', anchor='track', track=[(3, 1.175), (6, 1.06), (14, 1.06), (17, 1.175)], ground_src=681, top_min=4,
         once=True, register=False,
         derive=[dict(key='fly3up', seq=(1, 5)),
                 dict(key='fly3', seq=[(6, 14), (13, 7)], loop=True, xfade=0.15),    # 來回播：頭一路往前飄 38px，單向循環接縫會跳
                 dict(key='fly3down', seq=(15, 25))]),
    # 走路（2026-11-03）：往右「自然走路」、往左「雙手互握優雅漫步」，各自轉身起步 → 走路循環 → 轉回正面
    # 側面走時腳底比正面站姿低幾 px，地面線取 684 折衷（站姿只浮 3px、走路腳尖只出畫布一點）
    dict(no=42, src='向右走', key='walkRall', anchor='track', track=[(1, 1.175)], ground_src=684, once=True, register=False,
         derive=[dict(key='walkRstart', seq=(1, 5)),                               # 正面 → 轉身 → 第一步
                 dict(key='walkR', seq=(6, 17), loop=True, xfade=0.15),            # 每 6 格一個完整步伐，第 18 格≈第 6 格
                 dict(key='walkRstop', seq=(24, 25))]),                            # 第 24 格≈第 18 格，接第 25 格轉回正面
    dict(no=43, src='向左走2', key='walkLall', anchor='track', track=[(1, 1.175)], ground_src=684, once=True, register=False,
         derive=[dict(key='walkLstart', seq=(1, 5)),
                 dict(key='walkL', seq=(6, 20), loop=True, xfade=0.15),            # 第 21 格≈第 6 格
                 dict(key='walkLstop', seq=(21, 25))]),                            # 21–23 還在走、24–25 轉回正面
    dict(no=38, src='東張西望2新版', key='curious2', anchor='track', track=[(1, 1.175)], ground_src=681, once=True, sprites={'curious2': 10}),
    # 坐下＋起身（2026-11-03）：首幀是站著發呆，一段影片做完「坐下 → 坐著 → 站回原位」。鏡頭不動，站姿身高 638px（×1.095 對齊站著發呆），腳底在原圖 y=702
    # 坐著時裙擺鋪在腳前面，比腳底低十幾 px，出畫布的幾 px 剛好在地面線下，看不到
    # 坐著的循環都用來回播：頭會慢慢偏，單向接回去會跳
    # 祐：眨眼、點頭、擺頭太頻繁，所以循環開頭那格先停住幾秒（(格, 格, 速度)，每格原本 0.2 秒，速度 0.2/停秒數）再動一次
    dict(no=44, src='跪坐+起身', name='跪坐起身', key='kneelall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='kneeldown', seq=(1, 5)),                                # 站著 → 拉裙擺跪下
                 # 跪坐：13 停 4.6 秒 → 14–16 閉眼 → 退回 14，一輪約 5.6 秒（祐：12 頭會動、17 手腳都動）
                 dict(key='kneel', seq=[(13, 13, 0.2 / 4.6), (14, 16), (15, 14)], loop=True, xfade=0.2),
                 dict(key='kneelup', seq=(17, 25))],                               # 立起一膝、站起來
         sprites={'sit1': 10, 'sit1_b': 16}),
    dict(no=45, src='雙手放膝的坐姿+起身', name='放膝坐起身', key='kneesall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
         derive=[dict(key='kneesdown', seq=(1, 5)),
                 # 雙手放膝：8 停 1.9 秒 → 9–12 擺頭 → 退回 9，一輪約 3.5 秒（祐：15 手的位置移動了）
                 dict(key='knees', seq=[(8, 8, 0.2 / 1.9), (9, 12), (11, 9)], loop=True, xfade=0.2),
                 dict(key='kneesup', seq=(13, 25))],                               # 雙手撐膝站起
         sprites={'sit2': 10}),
    # 抱膝那段閉著眼睛把臉埋在手臂上，比較像打瞌睡，祐指定取代坐著打盹（#06）
    dict(no=46, src='抱膝+起身', name='抱膝起身', key='dozeall', anchor='track', track=[(1, 1.095)], ground_src=702, match=1, once=True, register=False,
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
]


def load_frames(folder):
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

        files, boxes, heads, overflow = [], [], [], 0
        sz = int(round(768 * s))
        seat = round(oy + c['seat'] * s) if c.get('seat') else None

        def track_at(i):
            # 回傳 (k, dx)：關鍵格之間線性內插；dx 是水平微調（省略＝0）
            ks = [(t[0], t[1], t[2] if len(t) > 2 else 0) for t in c['track']]
            if i <= ks[0][0]: return ks[0][1:]
            for (f0, k0, d0), (f1, k1, d1) in zip(ks, ks[1:]):
                if i <= f1:
                    u = (i - f0) / (f1 - f0)
                    return k0 + (k1 - k0) * u, d0 + (d1 - d0) * u
            return ks[-1][1:]

        for i, im in enumerate(frames, r0):
            if a == 'track':
                tk, tdx = track_at(i)
                s = S_GLOBAL * tk
                sz = int(round(768 * s))
                bi = bbs[i - r0]
                ox, oy = STAND_X + tdx - 384 * s, GROUND - c.get('ground_src', bi[3]) * s
                if 'top_min' in c and oy + bi[1] * s < c['top_min']:   # 跳太高會出畫布：這格往下挪到剛好不出去
                    oy = c['top_min'] - bi[1] * s
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
        for dv in c.get('derive', []):
            # seq：(起, 迄) 或多段 [(起, 迄, 速度?), …]，迄 < 起＝倒著播；接起來就是來回播、播完倒退回去
            segs = dv['seq'] if isinstance(dv['seq'], list) else [dv['seq']]
            idx, dd = [], []
            for sg in segs:
                a0, a1 = sg[0], sg[1]
                sp = sg[2] if len(sg) > 2 else dv.get('speed', 1.0)
                order = list(range(a0, a1 + 1)) if a1 >= a0 else list(range(a0, a1 - 1, -1))
                idx += [f - r0 for f in order]
                dd += [round(durs[f - r0] / sp, 4) for f in order]
            de = dict(frames=[files[k] for k in idx], bbox=[boxes[k] for k in idx], head=[heads[k] for k in idx],
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
