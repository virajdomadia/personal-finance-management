# Gullak brand assets

The `gullak-*.svg` files are the sources. To regenerate every PNG (mobile icons, splash, apple icon, web `icon.svg`, and `branding/out/favicon-*.png`) run `node branding/render.mjs` from the repo root (it uses the `sharp` install in `frontend/node_modules`), then bundle the favicon sizes with `python -c "from PIL import Image; Image.open('branding/out/favicon-48.png').save('frontend/src/app/favicon.ico', sizes=[(16,16),(32,32),(48,48)])"`.
