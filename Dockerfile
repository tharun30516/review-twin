FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=optional
COPY . .
ENV PORT=8787 REVIEW_TWIN_DB=/data/review-twin.db
VOLUME /data
EXPOSE 8787
USER node
CMD ["npx", "tsx", "src/server.ts"]
