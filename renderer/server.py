"""Private, bounded deterministic compositor. No customer payload logging."""
import base64
import json
import io
import math
import pathlib
import subprocess
import tempfile
import threading
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image, ImageDraw, ImageFont, features

LIMIT = 64 * 1024 * 1024
SLOT = threading.BoundedSemaphore(1)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

def caption(text, locale, width, height, output, visible=None, effect='none', time=0, color='white', family='classic', layout=None, preview=False):
    if family not in ('classic','fredoka','pacifico','lobster','caveat'):
        raise ValueError('Invalid font')
    if family == 'fredoka' and any('CYRILLIC' in unicodedata.name(c,'') for c in text):
        raise ValueError('Font does not support Cyrillic')
    if family not in ('classic','fredoka') and any('HEBREW' in unicodedata.name(c,'') for c in text):
        raise ValueError('Font does not support Hebrew')
    if color not in ('white', 'gold', 'pink', 'multicolor'):
        raise ValueError('Invalid color')
    if effect not in ('none', 'hearts', 'fireworks', 'celebration'):
        raise ValueError('Invalid effect')
    if not features.check_feature('raqm'):
        raise ValueError('Text shaping unavailable')
    if not isinstance(text, str) or len(text) > 80 or any(unicodedata.category(c).startswith('C') for c in text):
        raise ValueError('Invalid greeting')
    if locale not in ('en', 'ru', 'es', 'he'):
        raise ValueError('Invalid locale')
    # First strong character determines text direction, independent of UI language.
    rtl = next((unicodedata.bidirectional(c) in ('R', 'AL') for c in text
                if unicodedata.bidirectional(c) in ('R', 'AL', 'L')), locale == 'he')
    canvas = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    mask = Image.new('L', (width,height), 0)
    mask_draw = ImageDraw.Draw(mask)
    direction = 'rtl' if rtl else 'ltr'
    # Render supported colour emoji separately; decorative text fonts lack these glyphs.
    original = text
    emojis = [(c, i) for i, c in enumerate(original) if c in ('❤', '🎉')]
    text = text.replace('❤️', '').replace('❤', '').replace('🎉', '').rstrip()
    lines = []
    for size in range(round(min(width, height) * .065), 13, -1):
        font = ImageFont.truetype(FONT if family == 'classic' else '/app/fonts/'+family+'.ttf', size, layout_engine=ImageFont.Layout.RAQM)
        if family in ('fredoka','caveat'):
            axes = font.get_variation_axes()
            font.set_variation_by_axes([650 if a['name'] == b'Weight' else a['default'] for a in axes])
        lines = ['']
        for word in text.split(' '):
            # Wrap a long unbroken greeting without dropping or inventing letters.
            if draw.textlength(word, font=font, direction=direction) > width * .86:
                for char in word:
                    if draw.textlength(lines[-1] + char, font=font, direction=direction) > width * .86 and not unicodedata.combining(char):
                        lines.append('')
                    lines[-1] += char
                continue
            candidate = (lines[-1] + ' ' + word).lstrip(' ')
            if draw.textlength(candidate, font=font, direction=direction) <= width * .86:
                lines[-1] = candidate
            else:
                lines.append(word)
        if len(lines) <= 3 and all(draw.textlength(s, font=font, direction=direction) <= width * .86 for s in lines):
            break
    else:
        raise ValueError('Greeting cannot fit')
    line_height = size * 1.5
    top = height * .04
    remaining = len(text) if visible is None else visible
    pieces = []
    layered = preview == 'layers' or (isinstance(layout,dict) and 'elements' in layout)
    for i, line in enumerate(lines):
        shown = line[:max(0, remaining)]
        remaining -= len(line)
        length = draw.textlength(line, font=font, direction=direction)
        # Fix the full line's position throughout the reveal; Hebrew grows from the right.
        x = width/2 + length/2 if rtl else width/2 - length/2
        draw.text((x, top + size*.3 + i*line_height), shown, font=font, direction=direction,
                  anchor='rt' if rtl else 'lt', fill={'gold':'#FFD36A','pink':'#FF9EC4'}.get(color,'white'), stroke_width=2, stroke_fill=(30,30,30,220))
        if color == 'multicolor':
            mask_draw.text((x, top + size*.3 + i*line_height), shown, font=font, direction=direction,
                           anchor='rt' if rtl else 'lt', fill=255)
    if color == 'multicolor':
        # A fixed gradient colours the shaped text without splitting RTL glyphs.
        layer = Image.new('RGBA', (width,height))
        gradient = ImageDraw.Draw(layer)
        palette = [(255,158,196),(255,211,106),(140,230,189),(143,195,255),(204,165,255)]
        for px in range(width):
            p = min(3.999999, max(0, (px/width-.07)/.86*4))
            i, f = int(p), p-int(p)
            rgb = tuple(round(palette[i][j]*(1-f)+palette[i+1][j]*f) for j in range(3))
            gradient.line((px,0,px,height),fill=rgb+(255,))
        layer.putalpha(mask)
        canvas.alpha_composite(layer)
    if layered:
        text_bottom=min(height,math.ceil(top+len(lines)*line_height+size*.5))
        pieces.append(('text',text,canvas.crop((0,0,width,text_bottom)),0,0))
    if emojis:
        emoji_font = ImageFont.truetype('/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', 109)
        icon_size = size
        for index, (char, offset) in enumerate(emojis):
            if not layered and visible is not None and visible <= offset:
                continue
            icon = Image.new('RGBA', (160,160))
            ImageDraw.Draw(icon).text((0,0), char, font=emoji_font, embedded_color=True)
            icon = icon.crop(icon.getbbox()).resize((icon_size,icon_size), Image.Resampling.LANCZOS)
            ex,ey=round(width/2-len(emojis)*(icon_size+8)/2+index*(icon_size+8)),round(top+len(lines)*line_height+size*.5)
            if layered:
                if visible is not None and visible<=offset: icon=Image.new('RGBA',icon.size)
                pieces.append((f'emoji{index}',char,icon,ex,ey))
            canvas.alpha_composite(icon,(ex,ey))
    # Sparse, silent decoration at the outer edges; no rapid full-screen flashes.
    for side in (0.08, 0.92):
        side_index=0 if side == .08 else 1
        x, y = width*side, height*(0.22 - 0.025*math.sin(time*2))
        scale = min(width,height)*0.018
        if effect in ('hearts', 'celebration'):
            heart_layer=Image.new('RGBA',(width,height))
            hd=ImageDraw.Draw(heart_layer) if layered else draw
            points = []
            for n in range(60):
                a = n*math.tau/60
                points.append((x+scale*math.sin(a)**3, y-scale*(13*math.cos(a)-5*math.cos(2*a)-2*math.cos(3*a)-math.cos(4*a))/16))
            hd.polygon(points, fill=(242,95,130,220))
            if layered:
                box=(round(x-scale*1.2),round(height*.22-scale*2.7),round(x+scale*1.2),round(height*.22+scale*2.7))
                pieces.append((f'heart{side_index}','♥',heart_layer.crop(box),box[0],box[1]))
        if effect in ('fireworks', 'celebration'):
            fire_layer=Image.new('RGBA',(width,height))
            fd=ImageDraw.Draw(fire_layer) if layered else draw
            if effect == 'celebration':
                y += height*.09
            radius = scale*(1 + 2*(time % 1.5)/1.5)
            for n in range(10):
                a = n*math.tau/10
                px, py = x+radius*math.cos(a), y+radius*math.sin(a)
                fd.ellipse((px-2,py-2,px+2,py+2),fill=(255,205,105,220))
            if layered:
                cy=height*(.31 if effect=='celebration' else .22)
                box=(round(x-scale*3.3),round(cy-scale*4.7),round(x+scale*3.3),round(cy+scale*4.7))
                pieces.append((f'firework{side_index}','✦',fire_layer.crop(box),box[0],box[1]))
    if layered:
        bottom=min(height,math.ceil(max(height*.36,top+len(lines)*line_height+size*(1.7 if emojis else .5))))
        if preview == 'layers':
            assets=[]
            for key,label,tile,x,y in pieces:
                buf=io.BytesIO();tile.save(buf,format='PNG')
                assets.append({'id':key,'label':label,'x':x,'y':y,'width':tile.width,'height':tile.height,'png':base64.b64encode(buf.getvalue()).decode('ascii')})
            output.write_text(json.dumps({'width':width,'height':height,'bottom':bottom,'layers':assets}),encoding='utf-8')
            return
        overrides=layout['elements']
        ids={p[0] for p in pieces}
        if not isinstance(overrides,list) or len(overrides)>84 or any(not isinstance(p,dict) or p.get('id') not in ids for p in overrides) or len({p['id'] for p in overrides})!=len(overrides):raise ValueError('Invalid elements')
        overrides={p['id']:p for p in overrides}
        canvas=Image.new('RGBA',(width,height))
        scale=layout.get('scale',80)/100
        ox=max(0,min(width-width*scale,width*layout.get('x',50)/100-width*scale/2))
        oy=max(0,min(height-bottom*scale,height*layout.get('y',20)/100-bottom*scale/2))
        for key,label,tile,x,y in pieces:
            p=overrides.get(key)
            if p:
                if any(type(p.get(k)) not in (int,float) or not math.isfinite(p[k]) for k in ('x','y','scale')) or not(0<=p['x']<=100 and 0<=p['y']<=100 and 30<=p['scale']<=200):raise ValueError('Invalid element')
                s=p['scale']/100;cx=width*p['x']/100;cy=height*p['y']/100
            else:s=scale;cx=ox+(x+tile.width/2)*s;cy=oy+(y+tile.height/2)*s
            resized=tile.resize((max(1,round(tile.width*s)),max(1,round(tile.height*s))),Image.Resampling.LANCZOS)
            px=round(max(0,min(width-resized.width,cx-resized.width/2)));py=round(max(0,min(height-resized.height,cy-resized.height/2)))
            canvas.alpha_composite(resized,(px,py))
        canvas.save(output)
        return
    if layout is not None or preview:
        # Fixed crop across every animation frame prevents positional jitter.
        bottom = min(height, math.ceil(max(height*.36, top+len(lines)*line_height+size*(1.7 if emojis else .5))))
        group = canvas.crop((0,0,width,bottom))
        if preview:
            group.save(output)
            return
        if not isinstance(layout,dict) or any(type(layout.get(k)) not in (int,float) or not math.isfinite(layout[k]) for k in ('x','y','scale')):
            raise ValueError('Invalid layout')
        if not (0 <= layout['x'] <= 100 and 0 <= layout['y'] <= 100 and 30 <= layout['scale'] <= 100):
            raise ValueError('Invalid layout')
        scale=layout['scale']/100
        group=group.resize((round(width*scale),round(bottom*scale)),Image.Resampling.LANCZOS)
        x=round(max(0,min(width-group.width,width*layout['x']/100-group.width/2)))
        y=round(max(0,min(height-group.height,height*layout['y']/100-group.height/2)))
        canvas=Image.new('RGBA',(width,height))
        canvas.alpha_composite(group,(x,y))
    canvas.save(output)

def run(args, timeout=90):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout).stdout

def render(source, output, text, locale, effect='none', color='white', family='classic', layout=None):
    info = json.loads(run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', str(source)], 10))
    videos = [s for s in info['streams'] if s['codec_type'] == 'video']
    if len(videos) != 1:
        raise ValueError('Invalid video')
    width, height = videos[0]['width'], videos[0]['height']
    duration = float(info['format']['duration'])
    if not (14 <= duration <= 16 and 320 <= width <= 2560 and 320 <= height <= 2560 and width*height <= 2100000):
        raise ValueError('Invalid dimensions or duration')
    # Keep combining marks attached to their preceding letter.
    ends = [i for i in range(1, len(text)+1)
            if i == len(text) or not unicodedata.combining(text[i])]
    ends = ends or [0]
    sequence = []
    frames = [(end, 1/len(ends), n/len(ends)) for n,end in enumerate(ends)]
    if effect != 'none':
        frames = [(ends[min(len(ends)-1, int(n/30*len(ends)))], 1/30, n/30) for n in range(90)]
    for n, (end, seconds, time) in enumerate(frames):
        overlay = output.parent / f'title-{n}.png'
        caption(text, locale, width, height, overlay, end, effect, time, color, family, layout)
        sequence.extend([f"file '{overlay.name}'", f'duration {seconds:.9f}'])
    if effect == 'none':
        sequence.extend([f"file '{overlay.name}'", 'duration 2'])
    sequence.append(f"file '{overlay.name}'")
    manifest = output.parent / 'titles.txt'
    manifest.write_text('\n'.join(sequence)+'\n')
    start = duration - 3
    # Text comes only from a PNG. It never enters a shell, filter expression or ASS markup.
    graph = f'[1:v]setpts=PTS+{start:.6f}/TB[title];[0:v][title]overlay=0:0:eof_action=pass:enable=gte(t\\,{start:.6f})[v]'
    run(['ffmpeg', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', str(source),
         '-f', 'concat', '-safe', '1', '-i', str(manifest), '-filter_complex', graph, '-map', '[v]', '-map', '0:a?',
         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
         '-threads', '2', '-c:a', 'copy', '-movflags', '+faststart', '-y', str(output)])
    if output.stat().st_size > LIMIT:
        raise ValueError('Output too large')

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == '/health' else 404)
        self.send_header('X-Renderer-Version','placement-1')
        self.send_header('Content-Length','0')
        self.end_headers()

    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.path not in ('/render','/preview') or not SLOT.acquire(blocking=False):
            self.send_error(503)
            return
        self.connection.settimeout(20)
        try:
            metadata = self.headers.get('X-Greeting', '')
            if len(metadata) > 16384 or (self.path == '/render' and self.headers.get('Content-Type') != 'video/mp4'):
                raise ValueError('Invalid request')
            greeting = json.loads(base64.b64decode(metadata, validate=True))
            if self.path == '/preview':
                w,h=greeting['width'],greeting['height']
                if type(w) is not int or type(h) is not int or not (320<=w<=2560 and 320<=h<=2560 and w*h<=2100000):
                    raise ValueError('Invalid size')
                with tempfile.TemporaryDirectory(prefix='preview-') as folder:
                    output=pathlib.Path(folder)/'preview.png'
                    caption(greeting['text'],greeting['locale'],w,h,output,effect=greeting.get('effect','none'),time=1.2,color=greeting.get('color','white'),family=greeting.get('font','classic'),preview='layers')
                    data=output.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(data)))
                self.send_header('X-Renderer-Version','placement-1')
                self.send_header('Cache-Control','no-store')
                self.end_headers()
                self.wfile.write(data)
                return
            with tempfile.TemporaryDirectory(prefix='render-') as folder:
                source, output = pathlib.Path(folder)/'input.mp4', pathlib.Path(folder)/'output.mp4'
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= LIMIT or self.headers.get('Transfer-Encoding'):
                    raise ValueError('Invalid length')
                with source.open('wb') as stream:
                    remaining = length
                    while remaining:
                        data = self.rfile.read(min(65536, remaining))
                        if not data:
                            raise ValueError('Incomplete upload')
                        stream.write(data)
                        remaining -= len(data)
                render(source, output, greeting['text'], greeting['locale'], greeting.get('effect','none'), greeting.get('color','white'), greeting.get('font','classic'), greeting.get('layout'))
                self.send_response(200)
                self.send_header('Content-Type', 'video/mp4')
                self.send_header('X-Renderer-Version', 'placement-1')
                self.send_header('Content-Length', str(output.stat().st_size))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                with output.open('rb') as stream:
                    while data := stream.read(65536):
                        self.wfile.write(data)
        except Exception:
            self.send_error(422, 'Rendering unavailable')
        finally:
            SLOT.release()

if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
