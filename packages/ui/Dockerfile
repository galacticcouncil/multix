FROM node:20-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn ./.yarn
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/ui/.papi ./packages/ui/.papi

RUN yarn install --immutable

COPY packages/ui ./packages/ui

RUN yarn workspace multix-ui build

FROM nginx:1.27-alpine AS runtime

COPY packages/ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/ui/build /usr/share/nginx/html

EXPOSE 80
