FROM node:20-alpine AS build
WORKDIR /squid

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci

COPY tsconfig.json schema.graphql commands.json ./
COPY src ./src
COPY db ./db
COPY assets ./assets

RUN npx squid-typeorm-codegen \
    && npx squid-substrate-typegen src/typegens/*.json \
    && rm -rf lib \
    && npx tsc

FROM node:20-alpine AS runtime
WORKDIR /squid

RUN apk add --no-cache tini

COPY --from=build /squid/node_modules ./node_modules
COPY --from=build /squid/lib ./lib
COPY --from=build /squid/db ./db
COPY --from=build /squid/assets ./assets
COPY --from=build /squid/schema.graphql ./schema.graphql
COPY --from=build /squid/commands.json ./commands.json
COPY --from=build /squid/package.json ./package.json

ENV NODE_ENV=production

ENTRYPOINT ["/sbin/tini", "--"]
