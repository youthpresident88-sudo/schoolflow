FROM node:22-slim
WORKDIR /app
COPY . .
# Database lives on a mounted volume so it survives redeploys
ENV NODE_ENV=production SF_HOST=0.0.0.0 SF_DB=/data/schoolflow.db SF_SECURE_COOKIES=1 SF_TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
