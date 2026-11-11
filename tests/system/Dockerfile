FROM node:20-alpine
RUN apk add --no-cache docker-cli
WORKDIR /repo/tests/system
COPY tests/system/package.json tests/system/package-lock.json ./
RUN npm ci
COPY tests/system/ ./
COPY .prettierrc.json /repo/.prettierrc.json
COPY apps/matching-engine-service/test/helpers/reference-matcher.ts /repo/apps/matching-engine-service/test/helpers/reference-matcher.ts
COPY apps/frontend/lib/book-session.ts /repo/apps/frontend/lib/book-session.ts
CMD ["npm", "run", "chaos:sigterm"]
