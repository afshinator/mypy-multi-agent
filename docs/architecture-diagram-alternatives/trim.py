from PIL import Image, ImageChops
import glob, os
for f in sorted(glob.glob("*-architecture.png")):
    im = Image.open(f).convert("RGB")
    bg = Image.new("RGB", im.size, (255, 255, 255))
    bbox = ImageChops.difference(im, bg).getbbox()
    if bbox:
        pad = 24
        bbox = (max(0, bbox[0]-pad), max(0, bbox[1]-pad), min(im.width, bbox[2]+pad), min(im.height, bbox[3]+pad))
        im.crop(bbox).save(f)
    print(f, Image.open(f).size)
