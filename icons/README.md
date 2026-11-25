# Icons

`app-icon.svg` is the master: days as dots on a line, today bigger with a check (blue `#2563eb` on a
black rounded tile; the content at 115 %). `app-icon-square.svg` is the same on a full square for the
iPhone (it rounds the corners itself), `app-icon-maskable.svg` a smaller one (100 %) for Android,
which cuts a circle or another shape out of it. `public/favicon.svg` is a copy of the master. Change
them together; everything else is made from them:

```sh
npx tauri icon icons/app-icon.svg -o <a temporary folder>   # then copy the files src-tauri/icons has
rsvg-convert -w 192 -h 192 icons/app-icon.svg -o public/icon-192.png
rsvg-convert -w 512 -h 512 icons/app-icon.svg -o public/icon-512.png
rsvg-convert -w 512 -h 512 icons/app-icon-maskable.svg -o public/icon-maskable-512.png
rsvg-convert -w 180 -h 180 icons/app-icon-square.svg -o public/apple-touch-icon.png
cp icons/app-icon.svg public/favicon.svg
```
