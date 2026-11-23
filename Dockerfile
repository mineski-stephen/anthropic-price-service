# syntax=docker/dockerfile:1
#
# Container image for the price research service on Render. No dependencies, so there is no npm
# install and no build step: copy the files and run.

FROM node:22-slim

ENV NODE_ENV=production
ENV HOST=0.0.0.0

WORKDIR /app

COPY package.json server.js prompt.md ./
COPY src ./src

USER node

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8003)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server.js"]
