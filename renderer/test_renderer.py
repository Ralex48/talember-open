"""Synthetic media only. Run inside the renderer image on the release host."""
import pathlib
import json
import tempfile
import unittest
from PIL import Image, ImageChops
from server import caption, render, run

class RendererTest(unittest.TestCase):
    def test_languages_and_literal_text(self):
        with tempfile.TemporaryDirectory() as folder:
            for locale, text in [('en', 'We love you!'), ('es', '¡Te queremos, mamá!'),
                                 ('ru', 'Маша, мы тебя любим!'), ('he', 'מאשה, אנחנו אוהבים אותך!'),
                                 ('he', 'שלום 2026!'), ('en', r'{x}: 100% / text')]:
                target = pathlib.Path(folder)/(locale+'.png')
                caption(text, locale, 1280, 720, target)
                self.assertIsNotNone(Image.open(target).getbbox())
            with self.assertRaises(ValueError):
                caption('a'*81, 'en', 1280, 720, target)
            for effect in ('hearts', 'fireworks', 'celebration'):
                caption('Hello!', 'en', 1280, 720, target, effect=effect, time=0.2)
                first = Image.open(target).copy()
                caption('Hello!', 'en', 1280, 720, target, effect=effect, time=0.8)
                self.assertIsNotNone(ImageChops.difference(first, Image.open(target)).getbbox())
            with self.assertRaises(ValueError):
                caption('Hello!', 'en', 1280, 720, target, effect='invalid')
            caption('Маша, мы тебя любим! С днем рождения! ❤️ 🎉', 'ru', 1280, 720, target, family='pacifico', effect='celebration')
            pixels = list(Image.open(target).getdata())
            self.assertTrue(any(r > 200 and g < 90 and b < 100 and a > 200 for r,g,b,a in pixels))
            self.assertTrue(any(b > 150 and b > r*1.3 and a > 200 for r,g,b,a in pixels))
            for color in ('gold','pink','multicolor'):
                caption('שלום, Маша!', 'he', 1280, 720, target, color=color)
                coloured = Image.open(target).convert('RGBA')
                self.assertEqual(coloured.getpixel((0,0))[3],0)
                pixels = [p for p in coloured.getdata() if p[3] == 255 and max(p[:3])-min(p[:3]) > 40]
                self.assertTrue(pixels)
            with self.assertRaises(ValueError):
                caption('Hello!', 'en', 1280, 720, target, color='invalid')
            for family, text, locale in [('fredoka','שלום!','he'),('pacifico','Маша, мы тебя любим!','ru'),('lobster','¡Feliz cumpleaños!','es'),('caveat','We love you!','en')]:
                caption(text, locale, 1280, 720, target, family=family)
                self.assertIsNotNone(Image.open(target).getbbox())
            for family,text in [('fredoka','Маша'),('pacifico','שלום'),('lobster','שלום'),('caveat','שלום')]:
                with self.assertRaises(ValueError):
                    caption(text, 'en', 1280, 720, target, family=family)
            caption('Маша! ❤️ 🎉','ru',1280,720,target,family='pacifico',effect='celebration',layout={'x':50,'y':100,'scale':60})
            bounds=Image.open(target).getbbox()
            self.assertGreater(bounds[1],400)
            self.assertLessEqual(bounds[3],720)
            with self.assertRaises(ValueError):
                caption('Hello','en',1280,720,target,layout={'x':50,'y':50,'scale':1000})
            caption('Маша! ❤️ 🎉','ru',1280,720,target,family='pacifico',effect='celebration',preview='layers')
            manifest=json.loads(target.read_text())
            self.assertEqual([p['id'] for p in manifest['layers']],['text','emoji0','emoji1','heart0','firework0','heart1','firework1'])
            layout={'x':50,'y':20,'scale':80,'elements':[{'id':'heart0','x':20,'y':80,'scale':100}]}
            caption('Маша! ❤️ 🎉','ru',1280,720,target,family='pacifico',effect='celebration',layout=layout)
            first=Image.open(target).copy()
            layout['elements'][0]['x']=70
            caption('Маша! ❤️ 🎉','ru',1280,720,target,family='pacifico',effect='celebration',layout=layout)
            difference=ImageChops.difference(first,Image.open(target)).getbbox()
            self.assertGreater(difference[1],500)
            layout['elements']=[{'id':'unknown','x':50,'y':50,'scale':100}]
            with self.assertRaises(ValueError):
                caption('Hello','en',1280,720,target,layout=layout)

    def test_exact_final_three_seconds_and_audio(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = pathlib.Path(folder)
            source, output = folder/'source.mp4', folder/'out.mp4'
            run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=30:d=15',
                 '-f', 'lavfi', '-i', 'sine=frequency=400:duration=15', '-c:v', 'libx264',
                 '-threads', '2', '-c:a', 'aac', '-y', str(source)])
            render(source, output, 'Маша, мы тебя любим!', 'ru',layout={'x':50,'y':20,'scale':80,'elements':[{'id':'text','x':50,'y':80,'scale':70}]})
            def frame(t):
                path = folder/('frame'+str(t)+'.png')
                run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', str(output), '-frames:v', '1', '-y', str(path)])
                return Image.open(path).convert('RGB')
            self.assertIsNone(ImageChops.difference(frame(1), frame(11)).getbbox())
            self.assertIsNotNone(ImageChops.difference(frame(11), frame(14)).getbbox())
            self.assertIsNotNone(ImageChops.difference(frame(12.2), frame(12.8)).getbbox())
            self.assertIsNone(ImageChops.difference(frame(13.2), frame(14)).getbbox())
            self.assertEqual(frame(14).getpixel((60, 60)), frame(11).getpixel((60, 60)))
            source_audio = run(['ffmpeg', '-v', 'error', '-i', str(source), '-map', '0:a', '-c', 'copy', '-f', 'adts', '-'])
            result_audio = run(['ffmpeg', '-v', 'error', '-i', str(output), '-map', '0:a', '-c', 'copy', '-f', 'adts', '-'])
            self.assertEqual(source_audio, result_audio)

if __name__ == '__main__':
    unittest.main()
