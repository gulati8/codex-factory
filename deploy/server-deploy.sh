#!/usr/bin/env bash
set -euo pipefail

APP_ROOT=/srv/codex-factory
REPO_DIR="$APP_ROOT/repo"
COMPOSE_FILE="$REPO_DIR/deploy/docker-compose.prod.yml"
REPO_URL="${REPO_URL:-https://github.com/gulati8/codex-factory.git}"
BRANCH="${BRANCH:-main}"

mkdir -p "$APP_ROOT" "$APP_ROOT/data" "$APP_ROOT/runtime" "$APP_ROOT/runtime/worktrees" "$APP_ROOT/runtime/artifacts" "$APP_ROOT/projects" "$APP_ROOT/postgres"

if [ ! -d "$REPO_DIR/.git" ]; then
  rm -rf "$REPO_DIR"
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$REPO_DIR"
else
  git -C "$REPO_DIR" fetch origin "$BRANCH"
  git -C "$REPO_DIR" checkout "$BRANCH"
  git -C "$REPO_DIR" reset --hard "origin/$BRANCH"
fi

if [ ! -f "$APP_ROOT/.env" ]; then
  echo "Missing $APP_ROOT/.env" >&2
  exit 1
fi

docker compose --env-file "$APP_ROOT/.env" -f "$COMPOSE_FILE" up -d --build --remove-orphans
docker compose --env-file "$APP_ROOT/.env" -f "$COMPOSE_FILE" ps
