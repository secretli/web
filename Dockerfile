# Base images come from mirror.gcr.io, Google's mirror of Docker Hub: the same
# images, without the limit Docker Hub puts on anonymous pulls from shared CI
# runners.
#
# The build stage runs on the native builder platform: its output is static
# files, the same for every target.
FROM --platform=$BUILDPLATFORM mirror.gcr.io/library/node:24-alpine AS build
# The commit the image is built from, shown in the app's footer.
ARG VERSION=dev
RUN corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN VITE_BUILD_VERSION=$VERSION pnpm build

# nginx as an unprivileged user, listening on 8080.
FROM mirror.gcr.io/nginxinc/nginx-unprivileged:alpine
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
