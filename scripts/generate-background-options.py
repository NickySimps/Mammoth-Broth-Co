"""Original procedural artwork, not diffusion/AI-generated imagery.
Reproduce with: python scripts/generate-background-options.py
Requires Pillow and numpy; no network, downloads, or frontend modifications.
"""
from pathlib import Path
import hashlib
import json
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets' / 'background-options'
SIZE = 1024
SEED = 28041


def field(rng, scale, n=SIZE-1):
    """Band-limited noise on a torus; never a mirrored/random edge patch."""
    white = rng.normal(size=(n, n))
    fy = np.fft.fftfreq(n)[:, None]
    fx = np.fft.rfftfreq(n)[None, :]
    weight = np.exp(-2 * math.pi**2 * scale**2 * (fx*fx + fy*fy))
    out = np.fft.irfft2(np.fft.rfft2(white) * weight, s=(n, n))
    out /= max(out.std(), 1e-8)
    return np.pad(out, ((0, 1), (0, 1)), mode='wrap')


def rgb(base, variation, shade):
    return np.clip(np.array(base)[None, None, :] + shade[:, :, None] * np.array(variation), 0, 255).astype('uint8')


def mammoth(draw, x, y, s, color):
    """A deliberately simple original ochre-line mammoth pictograph."""
    pts = [(0, 43), (2, 23), (13, 11), (33, 6), (53, 11), (65, 23),
           (73, 24), (80, 34), (81, 58), (87, 65), (94, 60), (92, 72),
           (81, 76), (73, 67), (72, 47), (63, 45), (59, 72), (50, 72),
           (49, 48), (28, 49), (23, 74), (14, 74), (15, 47), (0, 43)]
    line = [(round(x+a*s), round(y+b*s)) for a,b in pts]
    draw.line(line, fill=color, width=max(1, round(2*s)), joint='curve')
    draw.arc((x+58*s, y+32*s, x+91*s, y+59*s), 15, 155, fill=color, width=max(1, round(2*s)))
    draw.line([(x, y+31*s), (x-8*s, y+49*s)], fill=color, width=max(1, round(s)))


def textures():
    rng = np.random.default_rng(SEED)
    broad, med, fine, grain = [field(rng, k) for k in (88, 25, 5, .48)]
    yy, xx = np.meshgrid(np.linspace(0, 2*math.pi, SIZE), np.linspace(0, 2*math.pi, SIZE), indexing='ij')
    strata = np.sin(5*yy + .65*np.sin(2*xx) + .23*med)
    mineral = np.exp(-((strata-.65)/.09)**2)
    lime = rgb((174, 138, 87), (1, .87, .64), 7*broad+3.8*med+1.6*fine+.8*grain-3*mineral)
    paper = rgb((224, 209, 176), (1, .91, .74), 2.7*broad+1.35*med+.6*fine+.7*grain)
    p = Image.fromarray(paper).convert('RGBA')
    ink = Image.new('RGBA', p.size)
    d = ImageDraw.Draw(ink)
    mammoth(d, 148, 179, 1.28, (120, 84, 47, 18))
    mammoth(d, 700, 667, .93, (120, 84, 47, 17))
    # Quiet hand-stencil and tally marks, intentionally far from tile seams.
    cx, cy = 801, 264
    d.ellipse((cx-15, cy-4, cx+15, cy+30), fill=(129, 82, 39, 11))
    for dx,dy in [(-17,-18),(-8,-29),(2,-33),(12,-26),(23,-12)]:
        d.line([(cx+dx*.6,cy+9),(cx+dx,cy+dy)], fill=(129,82,39,13),width=7)
    for x in (348,359,370,381):
        d.line((x,755,x-4,781),fill=(129,82,39,17),width=2)
    d.line((342,777,387,762),fill=(129,82,39,17),width=2)
    parchment = np.array(Image.alpha_composite(p, ink).convert('RGB'))
    stone = rgb((43, 36, 32), (1,.85,.72), 3.2*broad+2.2*med+1.1*fine+.5*grain)
    # Buried rust/ember mineral seams, not bright lava or high-contrast cracks.
    vein = np.exp(-((np.sin(3*xx+2*yy+.42*med))/.075)**2)
    ember = vein * np.clip((broad+.7)/2, 0, 1)
    stone = np.clip(stone.astype(float)+ember[:,:,None]*np.array((15,5,0)),0,255).astype('uint8')
    return [('limestone-ochre', 'Limestone / Ochre', lime),
            ('quiet-parchment', 'Quiet Parchment', parchment),
            ('charcoal-ember', 'Charcoal / Ember', stone)]


def font(size, bold=False, serif=False):
    names = ([('georgiab.ttf' if bold else 'georgia.ttf')] if serif else
             [('arialbd.ttf' if bold else 'arial.ttf')])
    for name in names:
        path = Path('C:/Windows/Fonts') / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    # Portable fallback, no font downloads required.
    try:
        return ImageFont.truetype('DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf', size)
    except OSError:
        return ImageFont.load_default(size=size)


def text(draw, xy, value, size, fill, bold=False, serif=False):
    draw.text(xy,value,font=font(size,bold,serif),fill=fill,spacing=7)


def make_board(items):
    board = Image.new('RGB',(2100,1450),'#201b17')
    d = ImageDraw.Draw(board)
    text(d,(70,44),'MAMMOTH BROTH CO.',20,'#d1a766',True)
    text(d,(70,82),'Three ways to set the table.',47,'#f4ead8',True,True)
    text(d,(70,151),'BACKGROUND STUDIES  /  Original procedural artwork  /  Same storefront specimen',19,'#bfb09b')
    descriptions = ['Warm mineral layers. Soft ochre, no visual noise.',
                    'Pale fibers. A whisper of prehistoric linework.',
                    'Low-lit stone. Restrained, buried ember seams.']
    for i,(slug,title,arr) in enumerate(items):
        x,y,w,h = 70+i*660,234,640,1020
        tile = Image.fromarray(arr).resize((640,640),Image.Resampling.LANCZOS)
        panel = Image.new('RGB',(w,h))
        for ty in range(0,h,640):
            panel.paste(tile,(0,ty))
        board.paste(panel,(x,y))
        d = ImageDraw.Draw(board)
        dark = i == 2
        fg = '#f4ead7' if dark else '#34251b'
        muted = '#c9b69b' if dark else '#5b4630'
        edge = '#65513c' if dark else '#a48b62'
        d.rectangle((x,y,x+w-1,y+h-1),outline=edge,width=1)
        text(d,(x+32,y+31),'MAMMOTH',24,fg,True,True)
        text(d,(x+32,y+61),'B R O T H   C O.',12,muted,True)
        text(d,(x+432,y+48),'SHOP   /   STORY',13,fg,True)
        d.line((x+32,y+104,x+w-32,y+104),fill=edge,width=1)
        text(d,(x+35,y+168),'ROOTED IN THE GOOD STUFF',14,muted,True)
        text(d,(x+32,y+208),'Good broth.\nDeep roots.',61,fg,True,True)
        text(d,(x+35,y+379),'Slow-simmered comfort,\nmade for your everyday rituals.',21,fg)
        d.rounded_rectangle((x+35,y+465,x+267,y+519),radius=7,fill='#713a25' if not dark else '#d4a76a')
        text(d,(x+59,y+481),'EXPLORE BROTHS  >',16,'#fff3df' if not dark else '#261c16',True)
        # Solid product surface keeps actionable content readable in all options.
        d.rounded_rectangle((x+32,y+592,x+w-32,y+911),radius=12,fill='#f5ecdc',outline='#c7b99e',width=1)
        # Original bowl illustration, not a product photograph.
        bx,by=x+175,y+700
        d.ellipse((bx-82,by+44,bx+81,by+70),fill='#dfd0b6')
        d.pieslice((bx-77,by-134,bx+77,by+78),0,180,fill='#75432d')
        d.ellipse((bx-77,by-48,bx+77,by-9),fill='#c1a17c')
        d.ellipse((bx-67,by-43,bx+67,by-15),fill='#ba7c37')
        for dx in (-25,0,25):
            d.arc((bx+dx-9,by-102,bx+dx+9,by-54),85,260,fill='#b5a17e',width=2)
        text(d,(x+295,y+633),'THE DAILY RITUAL',12,'#8b653e',True)
        text(d,(x+295,y+666),'Bone broth',27,'#3c281d',True,True)
        text(d,(x+295,y+708),'Rich. Warming. Simple.',16,'#69543f')
        d.rounded_rectangle((x+295,y+758,x+w-61,y+801),radius=5,fill='#39291f')
        text(d,(x+315,y+771),'FIND YOUR FAVORITE',13,'#f8ebd6',True)
        text(d,(x+60,y+858),'A little warmth goes a long way.',17,'#6c543e',False,True)
        text(d,(x+35,y+955),'SMALL BATCH  /  BIG COMFORT',14,muted,True)
        text(d,(x,1280),f'0{i+1}  {title}',25,'#f4ead8',True,True)
        text(d,(x,1326),descriptions[i],17,'#c7b69f')
    text(d,(70,1394),'1024 x 1024 seamless tiles  |  PNG + lossless optimized WebP  |  Preview only - live storefront unchanged',18,'#ad9a7e')
    return board


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    items = textures()
    records=[]
    verification=[]
    for slug,title,arr in items:
        image=Image.fromarray(arr)
        for ext in ('png','webp'):
            path=OUT/f'{slug}.{ext}'
            if ext=='png': image.save(path,optimize=True)
            else: image.save(path,format='WEBP',lossless=True,quality=100,method=6,exact=True)
            with Image.open(path) as saved:
                decoded=np.array(saved.convert('RGB'))
                assert saved.size==(SIZE,SIZE)
                assert np.array_equal(decoded,arr), f'Lossless decode failed: {path}'
                lr=int(np.abs(decoded[:,0].astype(int)-decoded[:,-1].astype(int)).max())
                tb=int(np.abs(decoded[0].astype(int)-decoded[-1].astype(int)).max())
                assert lr==0 and tb==0, f'Seam mismatch: {path}'
            records.append({'name':path.name,'width':SIZE,'height':SIZE,'bytes':path.stat().st_size,
                            'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
            verification.append({'name':path.name,'left_right_max_difference':lr,'top_bottom_max_difference':tb,'lossless_decode_matches_source':True})
    board_path=OUT/'comparison-board.png'
    board=make_board(items)
    board.save(board_path,optimize=True)
    with Image.open(board_path) as im:
        assert im.size==(2100,1450)
    records.append({'name':board_path.name,'width':2100,'height':1450,'bytes':board_path.stat().st_size,
                    'sha256':hashlib.sha256(board_path.read_bytes()).hexdigest()})
    assert len(records)==7 and len(verification)==6
    manifest={'method':'Original deterministic Pillow/numpy procedural artwork: periodic Fourier-filtered noise, mineral strata, hand-drawn prehistoric motifs; no diffusion model, external generator, or stock texture.',
              'seed':SEED,'texture_count':3,'texture_files':6,'comparison_boards':1,
              'seam_definition':'Opposite boundary pixels identical in decoded RGB for both formats; toroidal fields with wrap endpoint. Motifs stay clear of boundaries.',
              'ui_specimen':'Illustrative storefront mockup only. Bowl illustration and Georgia heading fallback are not actual product photography or Underdog font.',
              'outputs':records,'verification':verification}
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(manifest,indent=2))
    print('Manifest:',OUT/'manifest.json')


if __name__=='__main__':
    main()
