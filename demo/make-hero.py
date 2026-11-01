#!/usr/bin/env python3
"""重新生成 Demo 首屏大图 demo/hero.jpg（刻意保留较大体积，用于演示 LCP 优化建议）。

用法： python demo/make-hero.py
依赖： Pillow
"""
import os
import random

from PIL import Image, ImageDraw, ImageFilter

W, H = 1600, 900
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hero.jpg')

img = Image.new('RGB', (W, H))
draw = ImageDraw.Draw(img)
for y in range(H):
    t = y / H
    draw.line([(0, y), (W, y)], fill=(int(16 + 44 * t), int(32 + 90 * t), int(56 + 130 * t)))

random.seed(42)
for _ in range(140):
    x, y = random.randint(0, W), random.randint(0, H)
    r = random.randint(12, 150)
    draw.ellipse([x - r, y - r, x + r, y + r], outline=(255, 255, 255))

img = img.filter(ImageFilter.GaussianBlur(6))
# 叠加少量噪点模拟真实照片的不可压缩性，让“图片过大”这条规则稳定触发
noise = Image.effect_noise((W, H), 36).convert('RGB')
img = Image.blend(img, noise, 0.08)

img.save(OUT, 'JPEG', quality=88)
print('written: %s (%d KB)' % (OUT, os.path.getsize(OUT) // 1024))
