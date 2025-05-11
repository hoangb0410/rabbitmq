FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./
# Cài đặt các dependencies cần thiết để build mysql2
RUN apk add --no-cache python3 make g++
RUN npm install

COPY . .

CMD [ "node", "worker.js" ]