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
    "faint2":     ("Qwen_image_2.1_00024-2.png", "flower:faint"),
    "faint2_b":   ("Qwen_image_2.1_00024-2-1.png", "match"),
    "faint3":     ("Qwen_image_2.1_00024-3.png", "auto", 1.026),
    "faint3_b":   ("Qwen_image_2.1_00024-3-1.png", "auto", 1.026),
    "drag":       ("Qwen_image_2.1_00059.png", "auto", 1.04),
    "fly1":       ("Qwen_image_2.1_00054.png", "box", 1.03),
    "fly1_b":     ("Qwen_image_2.1_00054-1.png", "box", 1.03),
    "fly1_hair":  ("Qwen_image_2.1_00054-2.png", "fit:fly1"),
    # 55/55-1 祐 2026-10-27 停用，準備改成更優雅的飛行姿勢
    # "fly2":       ("Qwen_image_2.1_00055.png", "box", 1.05),
    # "fly2_b":     ("Qwen_image_2.1_00055-1.png", "box", 1.05),
    "float":      ("Qwen_image_2.1_00078.png", "box", 1.05),
    "fly3":       ("Qwen_image_2.1_00053.png", "box", 1.02),
    "fly3_b":     ("Qwen_image_2.1_00053-1.png", "box", 1.02),
    # 髮與蕾絲裙飄逸版：跟 fly3 交替時不能跳，所以用髮飾的位置與大小對齊 fly3
    "fly3_hair":  ("Qwen_image_2.1_00053-2.png", "fit:fly3"),
    # 舊走路 15～19：祐 2026-10-27 已從專案移除原圖，停用
    #     "walk1":      ("Qwen_image_2.1_00016.png", "auto", 1.005),
    #     "walk2":      ("Qwen_image_2.1_00017.png", "auto", 1.038),
    #     "walk3":      ("Qwen_image_2.1_00018.png", "auto", 1.03),
    #     "walk4":      ("Qwen_image_2.1_00019.png", "auto", 1.03),
    #     "walk5":      ("9ec4f8ce-55ae-41de-89a6-1f7251bb80a7", "auto", 1.034),
    # 新走路（祐 2026-10-26）：walk-src/ 裡從 00089 切出的兩張；以「身高」對齊舊走路（約 607／660），不用花飾，因為 21 側身時花飾看起來比較大
    "walk20":     ("walk20.png", "auto", 1.166),
    "walk21":     ("walk21.png", "auto", 1.147),
    # 走路 v2（祐 2026-10-27）：22 站姿 → 22-2 起步 → 22-3～22-7 循環。來源大小不一，第三個值寫 "h610"
    # 代表「不管原圖多大，輸出後的身高統一 610／660」，走路時人物高度固定、不會忽大忽小
    "step0":      ("Qwen_image_2.1_00022.png", "auto", "h610"),
    "step0_b":    ("Qwen_image_2.1_00022-1.png", "match"),
    "step2":      ("Qwen_image_2.1_00022-2.png", "auto", "h610"),
    "step3":      ("Qwen_image_2.1_00022-3.png", "auto", "h610"),
    "step3_b":    ("Qwen_image_2.1_00022-3-1.png", "match"),
    "step4":      ("Qwen_image_2.1_00022-4.png", "auto", "h610"),
    "step5":      ("Qwen_image_2.1_00022-5.png", "auto", "h610"),
    "step5_b":    ("Qwen_image_2.1_00022-5-1.png", "match"),
    "step6":      ("Qwen_image_2.1_00022-6.png", "auto", "h610"),
    "step7":      ("Qwen_image_2.1_00022-7.png", "auto", "h610"),
    "step7_b":    ("Qwen_image_2.1_00022-7-1.png", "match"),
    # 影片走路（祐 2026-10-31）：圖生影片後切成 16 格（walk-src/vwalk/），每 7 格一個循環，取 02～08。
    # 整組共用同一個縮放與位移（group 模式），影片本身的上下起伏與腳步位置原封不動保留；
    # 身高以整組最高的那格＝610／660，跟 22 系列站姿一樣高
    "vwalk1":     ("vwalk02.png", "group:vwalk", 610),
    "vwalk2":     ("vwalk03.png", "group:vwalk", 610),
    "vwalk3":     ("vwalk04.png", "group:vwalk", 610),
    "vwalk4":     ("vwalk05.png", "group:vwalk", 610),
    "vwalk5":     ("vwalk06.png", "group:vwalk", 610),
    "vwalk6":     ("vwalk07.png", "group:vwalk", 610),
    "vwalk7":     ("vwalk08.png", "group:vwalk", 610),
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
    "sit_edge":   ("Qwen_image_2.1_00076.png", "auto", 1.03),
    "sit_edge_b": ("Qwen_image_2.1_00076-1.png", "auto", 1.03),
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


def flower_stats(im):
    """頭上橙色花飾（最大的一團橙色）的中心與直徑，用來讓同一姿勢的兩張圖對齊。"""
    from scipy import ndimage
    a = np.array(im).astype(int)
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    m = (al > 200) & (r > 215) & (g > 80) & (g < 165) & (b < 90) & (r - b > 140)
    lab, n = ndimage.label(m)
    if n == 0:
        return None
    sz = ndimage.sum(m, lab, range(1, n + 1))
    i = int(np.argmax(sz)) + 1
    ys, xs = np.where(lab == i)
    return float(xs.mean()), float(ys.mean()), float(np.sqrt(4 * sz[i - 1] / np.pi))


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


def place(im, x, y, size):
    c = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cx, cy = max(0, -x), max(0, -y)
    c.alpha_composite(im.crop((cx, cy, im.width, im.height)), (x + cx, y + cy))
    return np.asarray(c, dtype=np.float32)


def fit_score(ref, cand):
    ma, mb = ref[:, :, 3] > 200, cand[:, :, 3] > 200
    both = ma & mb
    if both.sum() < 200:
        return 1e9
    diff = np.abs(ref[:, :, :3] - cand[:, :, :3]).sum(2)[both].mean()
    return diff + 0.3 * 255 * (1 - both.sum() / (ma | mb).sum())


def fit_refine(ref_canvas, im, dx, dy):
    """飄逸版（頭髮、裙子會動）只對髮飾不夠：身體可能被生圖放大或挪一點。
    以髮飾對齊為起點，找一個縮放與位移，讓兩張「重疊的地方」顏色最像（臉、身體、腳會疊在一起）。"""
    best = (fit_score_at(ref_canvas, im, 1.0, dx, dy, 0.25), 1.0, dx, dy)
    for q, zs, step, span in ((0.25, 0.01, 8, 48), (0.5, 0.004, 2, 8)):
        _, z0, x0, y0 = best
        ref = np.asarray(ref_canvas.resize((round(CANVAS * q),) * 2, Image.LANCZOS), dtype=np.float32)
        best = (fit_score_at(ref, im, z0, x0, y0, q), z0, x0, y0)
        for z in np.arange(z0 - 4 * zs, z0 + 4.01 * zs, zs) if q > 0.25 else np.arange(0.92, 1.081, zs):
            small = im.resize((max(1, round(im.width * z * q)), max(1, round(im.height * z * q))), Image.LANCZOS)
            for ox in range(-span, span + 1, step):
                for oy in range(-span, span + 1, step):
                    x, y = x0 + ox + im.width * (1 - z) / 2, y0 + oy + im.height * (1 - z) / 2
                    sc = fit_score(ref, place(small, round(x * q), round(y * q), ref.shape[0]))
                    if sc < best[0]:
                        best = (sc, z, x0 + ox, y0 + oy)
    _, z, x, y = best
    out = im.convert("RGBa").resize((round(im.width * z), round(im.height * z)), Image.LANCZOS).convert("RGBA")
    return out, x + im.width * (1 - z) / 2, y + im.height * (1 - z) / 2


def fit_score_at(ref, im, z, x, y, q):
    if isinstance(ref, Image.Image):
        ref = np.asarray(ref.resize((round(CANVAS * q),) * 2, Image.LANCZOS), dtype=np.float32)
    small = im.resize((max(1, round(im.width * z * q)), max(1, round(im.height * z * q))), Image.LANCZOS)
    x, y = x + im.width * (1 - z) / 2, y + im.height * (1 - z) / 2
    return fit_score(ref, place(small, round(x * q), round(y * q), ref.shape[0]))


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
    def base_mode(k):  # match 版跟著原圖排序，要等原圖先算完
        m = SPRITES[k[:-2]][1] if SPRITES[k][1] == "match" else SPRITES[k][1]
        return "flower:" if m.startswith("fit:") else m
    order = sorted(SPRITES, key=lambda k: (k != FRONT_REF, base_mode(k).startswith('flower:'), k.endswith('_b')))
    flowers = {}
    offsets = {}
    boxes = {}
    fit_refs = {v[1].split(":")[1] for v in SPRITES.values() if v[1].startswith("fit:")}
    canvases = {}
    # group 模式：同一組（例如影片切出來的連續動作）先一起量，算出共用的縮放與位移
    groups = {}
    for key, (name, mode, *extra) in SPRITES.items():
        if mode.startswith("group:"):
            path = find(args.src, name)
            if path:
                im = cache.get(path) or load(path)
                cache[path] = im
                groups.setdefault(mode.split(":")[1], {"target": extra[0], "ims": []})["ims"].append(im)
    for g in groups.values():
        boxes_ = []
        for im in g["ims"]:
            al = np.array(im)[:, :, 3] > 128
            ys, xs = np.where(al)
            boxes_.append((ys.min(), ys.max() + 1, head_x(np.array(im))))
        h = max(b[1] - b[0] for b in boxes_)
        g["zoom"] = (g["target"] / scale) / h
        g["off"] = (CENTER - float(np.median([b[2] for b in boxes_])) * g["zoom"], GROUND - max(b[1] for b in boxes_) * g["zoom"])
    for key in order:
        name, mode, *extra = SPRITES[key]
        fit_ref = mode.split(":")[1] if mode.startswith("fit:") else None
        if fit_ref:
            mode = "flower:" + fit_ref
        zoom = extra[0] if extra else 1.0
        path = find(args.src, name)
        if not path:
            missing.append((key, name))
            continue
        im = cache.get(path) or load(path)
        cache[path] = im
        group_off = None
        if mode.startswith("group:"):
            g = groups[mode.split(":")[1]]
            zoom, group_off, mode = g["zoom"], g["off"], "box"
        if mode == "match":
            # 閉眼版的原圖有時被生圖拉長了一點（例如 880 高變 896），等比縮放會讓身高或寬度差一點。
            # 直接把人物外框拉到跟睜眼版輸出前一模一樣的大小與位置，眨眼時身高就不會變
            bx0, by0, bw, bh, bdx, bdy = boxes[key[:-2]]
            im = im.crop(im.getbbox()).convert("RGBa").resize((bw, bh), Image.LANCZOS).convert("RGBA")
            zoom, extra = 1.0, []
            mode = SPRITES[key[:-2]][1]
            match_off = (bdx + bx0, bdy + by0)
        else:
            match_off = None
        if mode.startswith("flower:") and match_off is None:
            ref = mode.split(":")[1]
            if ref not in flowers:
                missing.append((key, name)); continue
            own = flower_stats(im)
            zoom = flowers[ref][2] / own[2]
        if isinstance(zoom, str) and zoom.startswith("h"):
            # 指定輸出身高：先裁到人物外框（原圖可能比畫布高），再算縮放
            im = im.crop(im.getbbox())
            zoom = (float(zoom[1:]) / scale) / im.height
        if zoom != 1.0:
            im = im.convert("RGBa").resize((round(im.width * zoom), round(im.height * zoom)), Image.LANCZOS).convert("RGBA")
        if match_off is None and group_off is None:
            im = trim_stray_bottom(im)
        a = np.array(im)
        x0, y0, x1, y1 = im.getbbox()
        if mode == "front":
            if front_offset is None:
                front_offset = (CENTER - head_x(a), GROUND - y1)
            dx, dy = front_offset
        elif mode == "auto":
            dx, dy = CENTER - head_x(a), GROUND - y1
        elif mode.startswith("flower:"):
            fs = flower_stats(im)
            ref = flowers[mode.split(":")[1]]
            dx, dy = ref[0] - fs[0], ref[1] - fs[1]
        else:  # box / boxh
            dx, dy = CENTER - (x0 + x1) / 2, GROUND - y1
        if key.endswith("_b") and key[:-2] in offsets:
            dx, dy = offsets[key[:-2]]
        if match_off is not None:
            dx, dy = match_off
        if group_off is not None:
            dx, dy = group_off
        if fit_ref:
            im, dx, dy = fit_refine(canvases[fit_ref], im, dx, dy)
            x0, y0, x1, y1 = im.getbbox()
        offsets[key] = (dx, dy)
        boxes[key] = (x0, y0, x1 - x0, y1 - y0, dx, dy)
        fs0 = flower_stats(im)
        if fs0 and not key.endswith("_b"):
            flowers[key] = (fs0[0] + dx, fs0[1] + dy, fs0[2])
        canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        canvas.alpha_composite(im, (round(dx), round(dy)))
        if key in fit_refs:
            canvases[key] = canvas
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
