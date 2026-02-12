FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY server.mjs ./
EXPOSE 3847
CMD ["node", "server.mjs"]
