"""Render the app icon (assets/icon.png, 1024x1024). Rebrand by changing COLORS / shapes here."""
from PIL import Image, ImageDraw, ImageFilter

S = 1024
COLORS = [(106, 168, 255), (155, 123, 255), (255, 122, 168)]


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size):
    g = Image.new("RGB", (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = lerp(COLORS[0], COLORS[1], t * 2) if t < 0.5 else lerp(COLORS[1], COLORS[2], (t - 0.5) * 2)
    return g


grad = gradient(S)
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
# background tile with vertical shading
bg = Image.new("RGBA", (S, S))
d = ImageDraw.Draw(bg)
for y in range(S):
    c = lerp((37, 39, 45), (18, 19, 22), y / S)
    d.line([(0, y), (S, y)], fill=c + (255,))
tile = Image.new("L", (S, S), 0)
ImageDraw.Draw(tile).rounded_rectangle([48, 48, S - 48, S - 48], radius=210, fill=255)
img.paste(bg, (0, 0), tile)
# gradient ring + play triangle + accent dot
mask = Image.new("L", (S, S), 0)
m = ImageDraw.Draw(mask)
m.ellipse([212, 212, 812, 812], outline=255, width=64)
m.polygon([(452, 380), (660, 512), (452, 644)], fill=255)
glow = mask.filter(ImageFilter.GaussianBlur(18))
img.paste(grad.convert("RGBA"), (0, 0), glow.point(lambda v: v // 3))
img.paste(grad.convert("RGBA"), (0, 0), mask)
ImageDraw.Draw(img).ellipse([698, 238, 786, 326], fill=(255, 197, 61, 255))
img.save("assets/icon.png")
print("assets/icon.png")
