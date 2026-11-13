"""凱爾特豎琴49 的琴弦修補（祐 2026-11-13）：去背時琴弦被當成背景去掉了大半，琴弦之間只剩一片半透明的深色陰影。

做法（第 16–38 格，豎琴是木頭色、位置不動的那段；發光出現／消散的格不動）：
1. 琴弦區＝琴頸下緣、琴柱內緣、音板上緣圍成的多邊形（照第 25 格量的原圖座標）。
2. 區域內半透明、偏暗或偏灰的像素（陰影、淡掉的舊琴弦）清成透明；她的手、袖子不透明、有顏色，會留下來。
3. 在最底層重畫 16 條細直的琴弦（從琴頸到音板），每 7 條一條紅弦（凱爾特豎琴的 C 弦），再把原本的畫面疊回上面，
   所以手擋在琴弦前面的地方自然會蓋住琴弦。

build_clips.py 的 preprocess 會呼叫 fix(frames)（frames 是原圖 768×768 的 RGBA，第 1 格在 frames[0]）。
"""
import numpy as np
from PIL import Image, ImageDraw

FRAMES = range(16, 39)
NECK = [(415, 290), (450, 248), (490, 228), (520, 214), (540, 213), (560, 222), (570, 238)]
PILLAR = [(574, 305), (576, 380), (574, 480), (567, 555), (557, 605), (545, 640), (535, 668)]
BOARD = [(520, 620), (495, 560), (465, 480), (440, 400), (425, 340), (415, 300)]   # 音板上緣（由下往上）


def _interp(pts, x):
    pts = sorted(pts)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return float(np.interp(x, xs, ys))


def _region():
    m = Image.new('L', (768, 768), 0)
    ImageDraw.Draw(m).polygon(NECK + PILLAR + BOARD, fill=255)
    return np.asarray(m) > 0


def _strings():
    """琴弦圖層（RGBA）：x 422–532 每 7px 一條，上端在琴頸下緣、下端在音板上緣"""
    layer = Image.new('RGBA', (768, 768), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for k, x in enumerate(range(422, 533, 7)):
        top = _interp(NECK, x) + 2
        bot = _interp(BOARD, x) - 1
        red = k % 7 == 3
        shade = (150, 60, 45, 140) if red else (110, 100, 90, 120)
        core = (215, 95, 75, 235) if red else (236, 230, 218, 235)
        d.line((x + 1, top, x + 1, bot), fill=shade, width=2)      # 一點陰影，讓琴弦在淺色桌面上也看得到
        d.line((x, top, x, bot), fill=core, width=2)
    return layer


def fix(frames):
    region = _region()
    strings = _strings()
    for i in FRAMES:
        a = np.asarray(frames[i - 1]).copy()
        r, g, b, al = (a[..., c].astype(np.int16) for c in range(4))
        mx = np.maximum(np.maximum(r, g), b); mn = np.minimum(np.minimum(r, g), b)
        sat = (mx - mn) / np.maximum(mx, 1)
        lum = (r + g + b) / 3
        skin = (r > 200) & (g > 150) & (b > 120)                  # 手、手臂（淡粉膚色）一律保留
        neutral_dark = (lum < 135) & (np.abs(r - b) < 45)     # 舊陰影是中性的深灰；木頭是偏紅的棕色（紅藍差 > 60），不會被刪
        # 琴頸下緣垂下來的舊紅弦殘影：細、暗紅、半透明（真正的木頭是不透明、寬的）
        old_red = (al < 250) & (r > g + 30) & (lum < 170) & ~skin
        smudge = region & (((al < 235) & ((lum < 150) | (sat < 0.12))) | ((al < 170) & (sat < 0.25)) | neutral_dark | old_red)
        a[smudge, 3] = 0
        out = strings.copy()
        out.alpha_composite(Image.fromarray(a))
        frames[i - 1] = out
    # 豎琴底座在原圖 y≈736，比腳底（694）低 42px，畫布腳底以下只放得下 11px：
    # 有豎琴的格（7–44）把 y 660–740 這段（音板下端＋底座）等比壓進 660–705，腳和裙子在 660 以上不受影響
    for i in range(7, 45):
        a = np.asarray(frames[i - 1]).copy()
        seg = a[660:741].copy()
        squeezed = np.asarray(Image.fromarray(seg).resize((768, 45), Image.LANCZOS))
        a[660:] = 0
        a[660:705] = squeezed
        frames[i - 1] = Image.fromarray(a)
    return frames
