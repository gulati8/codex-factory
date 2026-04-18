FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client python3 python-is-python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY scripts ./scripts
COPY manifests ./manifests
COPY README.md ARCHITECTURE.md .env.example ./

RUN npm run build

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

CMD ["npm", "run", "start"]
