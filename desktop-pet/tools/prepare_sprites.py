"""把孵出來的立繪整理成桌寵用的 sprites。

做的事：
1. alpha < ALPHA_CUT 的像素全部清成 0（Qwen 圖有大量 alpha=1 的紫色殘留）。
2. 1254 尺寸的圖縮成和 1024 圖同一個角色比例。
3. 依腳底與頭部中心對齊到同一張畫布，輸出到 app/sprites/，並寫 manifest.json。

原檔不會被修改。用法：
    python tools/prepare_sprites.py --src <素材資料夾> [--out app/sprites] [--size 660]
"""
import argparse, json, os, sys
import numpy as np
from PIL import Image

ALPHA_CUT = 8
CANVAS = 1100          # 以 1024 圖為基準的畫布邊長
GROUND = 1080          # 腳底所在的 y
CENTER = 550           # 頭部中心所在的 x

# 狀態 → (檔名, 對齊方式)
#   front：同一張底圖改出來的正面立繪，共用固定位移，切換時身體不會抖
#   auto ：以頭部中心 x、外框底部 y 對齊
#   box  ：以外框中心 x、外框底部 y 對齊（躺下、橫向的圖）
#   boxh ：同 box，但記錄的頭部位置用頭部 alpha 重心（被拎起第二張：頭偏一邊，拖曳時要把頭對到游標）
# 第三個值（可省略）是額外縮放：側身與飛行圖孵出來時臉比較小，放大一點讓臉的大小一致
SPRITES = {
    "idle":       ("Qwen_image_2.1_00027.png", "front"),
    "blink":      ("Qwen_image_2.1_00028.png", "front"),
    "happy":      ("Qwen_image_2.1_00028.png", "front"),
    "pat":        ("Qwen_image_2.1_00030.png", "front"),
    "curious":    ("Qwen_image_2.1_00026.png", "front"),
    "curious2":   ("Qwen_image_2.1_00036.png", "front"),
    "think":      ("Qwen_image_2.1_00031.png", "front"),
    "work":       ("Qwen_image_2.1_00032.png", "front"),
    "yawn":       ("Qwen_image_2.1_00033.png", "front"),
    "wave":       ("Qwen_image_2.1_00038.png", "front"),
    "sleep":      ("Qwen_image_2.1_00042.png", "front"),
    "tired":      ("Qwen_image_2.1_00023.png", "front"),
    "stretch":    ("Qwen_image_2.1_00035.png", "auto"),
    "cheer":      ("Qwen_image_2.1_00045.png", "auto"),
    "faint":      ("Qwen_image_2.1_00024.png", "box"),
    "drag":       ("Qwen_image_2.1_00059.png", "auto", 1.04),
    "fly1":       ("Qwen_image_2.1_00054.png", "box", 1.03),
    "fly1_b":     ("Qwen_image_2.1_00054-1.png", "box", 1.03),
    "fly2":       ("Qwen_image_2.1_00055.png", "box", 1.05),
    "fly2_b":     ("Qwen_image_2.1_00055-1.png", "box", 1.05),
    "float":      ("Qwen_image_2.1_00078.png", "box", 1.05),
    "walk1":      ("Qwen_image_2.1_00016.png", "auto", 1.06),
    "walk2":      ("Qwen_image_2.1_00017.png", "auto", 1.06),
    "walk3":      ("Qwen_image_2.1_00018.png", "auto", 0.98),
    "walk4":      ("Qwen_image_2.1_00019.png", "auto", 0.98),
    "walk5":      ("9ec4f8ce-55ae-41de-89a6-1f7251bb80a7", "auto", 0.945),
    "pose":       ("1793e431-d033-4131-b125-5722b41a6ba5", "auto"),
    # --- v0.3：新動作（2026-10-21） ---
    "work2":      ("Qwen_image_2.1_00060.png", "front"),
    "work2_b":    ("Qwen_image_2.1_00060-1.png", "front"),
    "work_b":     ("Qwen_image_2.1_00032-1.png", "front"),
    "think_b":    ("Qwen_image_2.1_00031-1.png", "front"),
    "tired_b":    ("Qwen_image_2.1_00023-1.png", "front"),
    "curious_b":  ("Qwen_image_2.1_00026-1.png", "front"),
    "curious2_b": ("Qwen_image_2.1_00036-1.png", "front"),
    "wave_b":     ("Qwen_image_2.1_00038-1.png", "front"),
    "drag_b":     ("Qwen_image_2.1_00059-1.png", "auto", 1.04),
    "drag2":      ("Qwen_image_2.1_00068.png", "boxh"),
    "drag2_b":    ("Qwen_image_2.1_00068-1.png", "boxh"),
    "confused":   ("Qwen_image_2.1_00072.png", "auto", 1.12),
    "confused_b": ("Qwen_image_2.1_00072-1.png", "auto", 1.12),
    # --- v0.4：坐在邊緣、害羞 ---
    "sit_edge":   ("Qwen_image_2.1_00076.png", "auto", 1.05),
    "sit_edge_b": ("Qwen_image_2.1_00076-1.png", "auto", 1.05),
    "sit_edge2":  ("Qwen_image_2.1_00080.png", "auto"),
    "sit_edge2_b": ("Qwen_image_2.1_00080-1.png", "auto"),
    "lie_top":    ("Qwen_image_2.1_00083.png", "box", 1.2),
    "lie_top_b":  ("Qwen_image_2.1_00083-1.png", "box", 1.2),
    "shy":        ("Qwen_image_2.1_00077.png", "auto", 0.94),
    "shy_b":      ("Qwen_image_2.1_00077-1.png", "auto", 0.94),
    "sit1":       ("Qwen_image_2.1_00061.png", "auto", 0.95),
    "sit1_b":     ("Qwen_image_2.1_00061-1.png", "auto", 0.95),
    "sit2":       ("Qwen_image_2.1_00063.png", "auto"),
    "sit2_b":     ("Qwen_image_2.1_00063-1.png", "auto"),
    "sleepside":  ("Qwen_image_2.1_00062.png", "box"),
    "wake1":      ("Qwen_image_2.1_00062-2.png", "box"),
    "wake2":      ("Qwen_image_2.1_00062-3.png", "auto", 0.97),
    "wake2_b":    ("Qwen_image_2.1_00062-3-1.png", "auto", 0.97),
    "wake3":      ("Qwen_image_2.1_00062-4.png", "auto", 0.97),
    "wake3_b":    ("Qwen_image_2.1_00062-4-1.png", "auto", 0.97),
}
FRONT_REF = "idle"


def find(src_dirs, name):
    for d in src_dirs:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return None


def load(path):
    im = Image.open(path).convert("RGBA")
    a = np.array(im)
    a[a[:, :, 3] < ALPHA_CUT] = 0
    im = Image.fromarray(a, "RGBA")
    if im.width != 1024:  # 1254 圖縮到 1024 比例
        s = 1024 / im.width
        im = im.convert("RGBa").resize((round(im.width * s), round(im.height * s)), Image.LANCZOS).convert("RGBA")
    return im


def trim_stray_bottom(im):
    """腳底以下若有零星半透明殘影（側睡那張有 110px），對齊地面時會讓人物看起來飄起來。
    以「有 4 個以上不透明像素的最後一列」當實際底部，其下超過 6px 的殘留一律清掉。"""
    a = np.array(im)
    alpha = a[:, :, 3]
    rows = np.where((alpha > 128).sum(1) >= 4)[0]
    ys = np.where((alpha > 0).any(1))[0]
    if len(rows) and len(ys) and ys[-1] - rows[-1] > 6:
        a[rows[-1] + 2:] = 0
        return Image.fromarray(a, "RGBA")
    return im


def head_x(a):
    """外框上方 28% 的 alpha 重心 x，當作頭部中心。"""
    alpha = a[:, :, 3] > 0
    ys = np.where(alpha.any(1))[0]
    top, bot = ys[0], ys[-1]
    band = alpha[top: top + int((bot - top) * 0.28)]
    xs = np.where(band)[1]
    return float(xs.mean())


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--src", action="append", required=True, help="素材資料夾，可給多次")
    ap.add_argument("--out", default=os.path.join(here, "..", "app", "sprites"))
    ap.add_argument("--size", type=int, default=660, help="輸出邊長（像素）")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    scale = args.size / CANVAS

    front_offset = None
    manifest = {"canvas": args.size, "ground": round(GROUND * scale), "sprites": {}}
    missing = []
    cache = {}
    # 先算 front 基準；閉眼版（_b）排在原圖後面，共用原圖的位移，眨眼時才不會跳
    order = sorted(SPRITES, key=lambda k: (k != FRONT_REF, k.endswith('_b')))
    offsets = {}
    for key in order:
        name, mode, *extra = SPRITES[key]
        zoom = extra[0] if extra else 1.0
        path = find(args.src, name)
        if not path:
            missing.append((key, name))
            continue
        im = cache.get(path) or load(path)
        cache[path] = im
        if zoom != 1.0:
            im = im.convert("RGBa").resize((round(im.width * zoom), round(im.height * zoom)), Image.LANCZOS).convert("RGBA")
        im = trim_stray_bottom(im)
        a = np.array(im)
        x0, y0, x1, y1 = im.getbbox()
        if mode == "front":
            if front_offset is None:
                front_offset = (CENTER - head_x(a), GROUND - y1)
            dx, dy = front_offset
        elif mode == "auto":
            dx, dy = CENTER - head_x(a), GROUND - y1
        else:  # box / boxh
            dx, dy = CENTER - (x0 + x1) / 2, GROUND - y1
        if key.endswith("_b") and key[:-2] in offsets:
            dx, dy = offsets[key[:-2]]
        offsets[key] = (dx, dy)
        canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        canvas.alpha_composite(im, (round(dx), round(dy)))
        out = canvas.convert("RGBa").resize((args.size, args.size), Image.LANCZOS).convert("RGBA")
        oa = np.array(out)
        oa[oa[:, :, 3] < 4] = 0
        out = Image.fromarray(oa, "RGBA")
        fn = f"{key}.png"
        out.save(os.path.join(args.out, fn), optimize=True)
        bx0, by0, bx1, by1 = out.getbbox()
        entry_extra = {}
        if key.startswith("lie_top"):
            # 趴姿：貼著視窗上緣的那條線＝身體最低處（扣掉一點半透明邊）
            al = oa[:, :, 3] > 128
            rows = np.where(al.sum(1) >= 4)[0]
            entry_extra["seat"] = int(rows[-1])
        if key.startswith("sit_edge"):
            # 坐點：裙襬最寬那一段的最後一列，視窗上緣要對到這一列
            al = oa[:, :, 3] > 128
            wid = al.sum(1)
            rows = np.where(wid >= 0.75 * wid.max())[0]
            entry_extra["seat"] = int(rows[-1])
        manifest["sprites"][key] = {
            "file": fn, "source": name, "bbox": [bx0, by0, bx1, by1],
            **entry_extra,
            "head": [round(head_x(oa)) if mode == "boxh" else round(CENTER * scale) if mode not in ("box",) else round((bx0 + bx1) / 2), by0],
        }
        print(f"{key:9s} <- {name}  bbox={bx0,by0,bx1,by1}")
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    if missing:
        print("找不到：", missing, file=sys.stderr)


if __name__ == "__main__":
    main()
