#!/bin/sh
# pocketbase с каталогами conf-kit: pb serve …, pb superuser upsert …, pb apikey …, pb admin …
exec pocketbase "$@" \
  --dir=/app/pb/pb_data \
  --hooksDir=/app/pb/pb_hooks \
  --migrationsDir=/app/pb/pb_migrations \
  --publicDir=/app/dist
