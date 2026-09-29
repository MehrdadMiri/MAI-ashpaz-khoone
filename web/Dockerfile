FROM nginx:1.28-alpine

RUN apk add --no-cache curl

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html pantry.css household.js pantry.js prices.js recipes.js fridge.js plan.js shop.js persist.js pwa.js sw.js manifest.webmanifest /usr/share/nginx/html/
COPY icons/icon-192.png icons/icon-512.png icons/apple-touch-icon.png /usr/share/nginx/html/icons/
COPY fonts/ /usr/share/nginx/html/fonts/

EXPOSE 80
