# The build stage runs on the native builder platform: its output is static
# files, the same for every target.
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
# The commit the image is built from, shown in the app's footer.
ARG VERSION=dev
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Node 26 ships no corepack: install the pnpm version packageManager pins.
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"
RUN pnpm install --frozen-lockfile
COPY . .
RUN VITE_BUILD_VERSION=$VERSION pnpm build

# nginx as an unprivileged user, listening on 8080.
FROM nginxinc/nginx-unprivileged:alpine
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
