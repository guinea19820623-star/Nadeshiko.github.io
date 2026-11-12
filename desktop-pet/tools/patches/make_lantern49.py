#!/usr/bin/env python3
"""天燈49 的修補（祐 2026-11-12）：影片第 28 格天燈飛出畫面上緣被切掉，改成「切出天燈當獨立漂浮物，飄到螢幕外」。

做兩件事：
1. 從第 26 格切出完整的天燈（y 27–152）。天燈底部擋在頭髮前面，左邊界被頭髮的外框吃掉，
   所以左邊界用「中心線 x≈430 鏡像右邊界」推回來。存成 app/sprites/lantern.png（已縮放到畫布比例）。
2. 第 28 格把天燈擦掉（同樣用中心鏡像界定範圍），被天燈擋住的那一小塊頭髮用第 29 格補回，
   存成 tools/patches/lantern49_f28.png（原圖 768×768），build_clips.py 的 replace 會拿它取代第 28 格。

印出天燈在第 26 格時、畫布座標（660×660）裡的位置，pet.js 的 LANTERN_AT 用這組數字決定漂浮物從哪裡起飛。

用法：python tools/patches/make_lantern49.py <claude-workspaces 資料夾>
"""
import glob, json, os, sys
import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(sys.argv[1] if len(sys.argv) > 1 else '.', '天燈49')
S = 614 / 701.5 * 1.1196      # 跟 build_clips.py 的 #86 一樣：S_GLOBAL × track k
OX, OY = 332 - 384 * S, 648 - 694 * S

sheet = Image.open(glob.glob(os.path.join(SRC, '*.png'))[0]).convert('RGBA')
def frame(i):
    c, r = (i - 1) % 7, (i - 1) // 7
    return sheet.crop((c * 768, r * 768, c * 768 + 768, r * 768 + 768))

def lantern_mask(a, y0, y1, cx):
    """y0–y1 之間、以 cx 為中心、右邊界取實際外框、左邊界鏡像的梯形範圍"""
    al = a[..., 3] > 40
    m = np.zeros(al.shape, bool)
    for y in range(max(0, y0), y1 + 1):
        xs = np.nonzero(al[y])[0]
        if not len(xs):
            continue
        r = xs.max()
        l = int(round(2 * cx - r))
        m[y, max(0, l - 2):r + 1] = True
    return m

# 1. 第 26 格的天燈（祐 2026-11-12：上緣、底環都要完整）
#    上緣弧頂從 y≈20 起；76 以上左右邊界照實際外框，76 以下左邊被頭髮的外框吃掉 → 用中心 x=430 鏡像右邊界；
#    底環是橢圓（中心 430.5,155、半徑 49×12），整個橢圓（含圓環內的火光）都算天燈
def lantern26_mask(a):
    al = a[..., 3] > 8
    m = np.zeros(al.shape, bool)
    for y in range(18, 150):
        xs = np.nonzero(al[y, 330:540])[0] + 330
        if not len(xs):
            continue
        r = xs.max() if y < 150 else 0
        l = max(xs.min(), 371) if y < 76 else int(round(2 * 430 - r))   # 371：天燈左緣最寬處，再左邊是頭髮
        m[y, max(0, l - 1):r + 1] = True
    yy, xx = np.mgrid[0:768, 0:768]
    m |= ((xx - 430.5) / 49.0) ** 2 + ((yy - 155.0) / 12.0) ** 2 <= 1.0
    return m
f26 = np.asarray(frame(26)).copy()
m26 = lantern26_mask(f26)
lan = f26.copy(); lan[..., 3] = np.where(m26, lan[..., 3], 0)
ys, xs = np.nonzero(lan[..., 3] > 8)
x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
sprite = Image.fromarray(lan).crop((x0, y0, x1, y1))
w, h = round((x1 - x0) * S), round((y1 - y0) * S)
sprite.resize((w, h), Image.LANCZOS).save(os.path.join(ROOT, 'app', 'sprites', 'lantern.png'))

# 1b. 會動的火焰（祐 2026-11-12：飛上去時火焰是靜止的）：第 9–21 格捧著的天燈跟第 26 格同樣大小，只差位置
#     （模板比對得到的位移 OFFS，差異 6～8）。外殼和底環用第 26 格，內部火光換成各格的，邊緣羽化 → 13 格火焰動畫
OFFS = {9: (-7, 180), 10: (-7, 173), 11: (-7, 168), 12: (-7, 168), 13: (-7, 171), 14: (-7, 175), 15: (-7, 184),
        16: (-7, 189), 17: (-6, 196), 18: (-4, 198), 19: (-4, 195), 20: (-4, 182), 21: (-4, 166)}
inner = np.asarray(Image.fromarray(m26.astype(np.uint8) * 255).filter(ImageFilter.MinFilter(13))) > 0
inner[140:] = False                                        # 底環（y≥140）留第 26 格的
feather = np.asarray(Image.fromarray(inner.astype(np.uint8) * 255).filter(ImageFilter.GaussianBlur(3))).astype(np.float32)[..., None] / 255
strip = []
for i, (dx, dy) in sorted(OFFS.items()):
    fi = np.asarray(frame(i)).astype(np.float32)
    moved = np.zeros_like(fi)
    ys0, xs0 = slice(max(0, -dy), min(768, 768 - dy)), slice(max(0, -dx), min(768, 768 - dx))
    moved[ys0, xs0] = fi[max(0, dy):min(768, 768 + dy), max(0, dx):min(768, 768 + dx)]
    comp = lan.astype(np.float32).copy()
    comp[..., :3] = comp[..., :3] * (1 - feather) + moved[..., :3] * feather
    strip.append(Image.fromarray(comp.clip(0, 255).astype(np.uint8)).crop((x0, y0, x1, y1)).resize((w, h), Image.LANCZOS))
sheet_out = Image.new('RGBA', (w * len(strip), h), (0, 0, 0, 0))
for k, im in enumerate(strip):
    sheet_out.paste(im, (k * w, 0))
sheet_out.save(os.path.join(ROOT, 'app', 'sprites', 'lantern_anim.png'))

# 2. 第 28 格擦掉天燈、用第 29 格補頭髮（天燈 26→28 往上 35px、往右 3px）
DY, DX = -35, 3
f28 = np.asarray(frame(28)).copy(); f29 = np.asarray(frame(29))
m28 = lantern_mask(f28, 0, 118, 433)
m28 = np.asarray(Image.fromarray(m28.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(9))) > 0   # 外擴 4px，連天燈的描邊一起擦
out = f28.copy()
out[:78] = 0                       # 頭頂（第 29 格頭頂在 y≈80）以上只有天燈，整片清空，不留描邊殘線
out[78:][m28[78:]] = f29[78:][m28[78:]]   # 跟頭髮重疊的那段用第 29 格補
Image.fromarray(out).save(os.path.join(HERE, 'lantern49_f28.png'))

# 第 28 格時天燈在畫布上的位置
# 天燈改成第 26 格就出現、跟影片裡的天燈重疊（祐 2026-11-12），所以起飛位置就是第 26 格自己的位置
at = dict(x=round(OX + x0 * S, 1), y=round(OY + y0 * S, 1), w=w, h=h, frames=len(strip))
print(json.dumps(at))
