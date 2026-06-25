FROM node:20-alpine

WORKDIR /app

# Сначала копируем только package.json — слой кешируется Docker'ом,
# npm install не перезапускается при изменении только index.js
COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

# В Docker-режиме сервер слушает HTTP/SSE на этом порту
ENV HTTP_PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
