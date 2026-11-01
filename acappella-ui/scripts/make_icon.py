#!/usr/bin/env python3
# 生成应用图标与启动图（assets/icon-only.png、assets/splash*.png）。
# 设计：四根圆头竖条代表 SATB 四声部，高度错落成声浪；
# 女高那根用品牌青高亮（--brand: 173 80% 40% ≈ #16B8A6），其余三根暗青灰——
# 「听见整队，唱准自己」：团队都在，你的那一行被点亮。
# 背景深蓝绿纵向渐变，呼应应用深色主题；无文字、粗几何，小尺寸不糊。
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ASSETS = Path(__file__).resolve().parent.parent / "assets"

# 配色（HSL --brand 173 80% 40% → RGB）
BG_TOP = (7, 26, 34)      # 深墨绿蓝
BG_BOTTOM = (13, 46, 54)  # 稍亮的深青
BAR_HI = (26, 204, 188)   # 品牌青（高亮声部）
BAR_DIM = (82, 124, 134)  # 暗青灰（其余声部），提亮保证小尺寸可见


def vertical_gradient(size, top, bottom):
    w, h = size
    base = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / (h - 1)
        base.putpixel(
            (0, y),
            tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)),
        )
    return base.resize((w, h), Image.BILINEAR)


def draw_logo(size=(1024, 1024), scale=1.0):
    """在 1024 基准坐标里画四条声浪竖条，返回 RGBA 图（任意 size 输出）。"""
    img = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    W = 118                 # 条宽
    R = W / 2               # 圆头半径
    GAP = 64                # 条间距（≈0.54×条宽，四根条读作一个整体）
    # 高度节奏像一句旋律的起伏；高亮条（第 2 根）居中偏左，视觉重心不偏
    heights = [330, 600, 440, 260]
    colors = [BAR_DIM, BAR_HI, BAR_DIM, BAR_DIM]
    xs = [512 + (i - 1.5) * (W + GAP) for i in range(4)]
    mid = 556               # 垂直中心略偏下，顶部留出动势
    for cx, h, c in zip(xs, heights, colors):
        rounded = [cx - R, mid - h / 2, cx + R, mid + h / 2]
        draw.rounded_rectangle(rounded, radius=R, fill=c)
    return img.resize(
        (round(size[0] * scale), round(size[1] * scale)), Image.LANCZOS
    )


def glow(img, radius, alpha):
    """同形状柔光：只缩放 alpha 通道，避免把颜色也压暗。"""
    pad = radius * 2
    big = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (0, 0, 0, 0))
    big.paste(img, (pad, pad), img)
    blur = big.filter(ImageFilter.GaussianBlur(radius))
    r, g, b, a = blur.split()
    a = a.point(lambda v: v * alpha // 255)
    out = Image.alpha_composite(Image.new("RGBA", big.size, (0, 0, 0, 0)), Image.merge("RGBA", (r, g, b, a)))
    out.alpha_composite(big)
    return out.crop((pad, pad, pad + img.width, pad + img.height))


def make_icon(path):
    bg = vertical_gradient((1024, 1024), BG_TOP, BG_BOTTOM).convert("RGBA")
    bg.alpha_composite(glow(draw_logo(), radius=36, alpha=110))
    bg.convert("RGB").save(path)


def make_splash(path):
    size = (2732, 2732)
    bg = vertical_gradient(size, BG_TOP, BG_BOTTOM).convert("RGBA")
    logo = glow(draw_logo(scale=0.9), radius=48, alpha=90)
    bg.alpha_composite(logo, ((size[0] - logo.width) // 2, (size[1] - logo.height) // 2))
    bg.convert("RGB").save(path)


def main():
    if "--preview" in sys.argv:
        out = Path(tempfile.gettempdir()) / "icon-preview.png"
        make_icon(out)
        print(out)
        return
    make_icon(ASSETS / "icon-only.png")
    make_splash(ASSETS / "splash.png")
    make_splash(ASSETS / "splash-dark.png")
    print("ok:", ASSETS)


if __name__ == "__main__":
    main()
