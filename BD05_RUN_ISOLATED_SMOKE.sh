#!/bin/bash
set -euo pipefail
WORK="${HOME}/Desktop/fin100b_bd05_linux_runtime"
NET='flashpay-bd05-http-only'
fail(){ echo "BD05_SAFETY_REFUSAL=$1"; exit 1; }
[[ -d "$WORK" && -f "$WORK/.next/BUILD_ID" ]] || fail WORK_OR_BUILD_MISSING
[[ -f "$WORK/app/api/payments/route.ts" && -f "$WORK/lib/db.ts" ]] || fail SOURCE_MISSING
[[ -f "$WORK/certification/FIN100B_BD05_DOCKER_REDIS_REST_BRIDGE_NOT_FOR_DEPLOY.cjs" ]] || fail EXISTING_BRIDGE_REQUIRED
grep -q "encodeResponse(await run(input),req)" "$WORK/certification/FIN100B_BD05_DOCKER_REDIS_REST_BRIDGE_NOT_FOR_DEPLOY.cjs" || fail BASE64_BRIDGE_PATCH_MISSING
[[ "$(docker network inspect "$NET" --format '{{.Internal}}' 2>/dev/null)" == true ]] || fail NETWORK_NOT_INTERNAL
for f in .env .env.local .env.production .env.production.local; do [[ ! -e "$WORK/$f" ]] || fail ENV_FILE_PRESENT; done
[[ -f "$WORK/certification/FIN100B_BD05_PI_FETCH_INTERCEPT_NOT_FOR_DEPLOY.cjs" && -f "$WORK/certification/FIN100B_BD05_HTTP_BEHAVIORAL_NOT_FOR_DEPLOY.cjs" ]] || fail TEST_SCRIPTS_MISSING
for name in flashpay-bd05-http-pg flashpay-bd05-http-redis flashpay-bd05-http-bridge; do
 [[ "$(docker inspect "$name" --format '{{.State.Running}}' 2>/dev/null)" == true ]] || fail SERVICE_NOT_RUNNING
 [[ "$(docker inspect "$name" --format '{{.HostConfig.NetworkMode}}')" == "$NET" ]] || fail SERVICE_NETWORK_MISMATCH
 [[ "$(docker inspect "$name" --format '{{json .HostConfig.PortBindings}}')" == null || "$(docker inspect "$name" --format '{{json .HostConfig.PortBindings}}')" == '{}' ]] || fail PUBLISHED_PORTS
 done
[[ "$(docker inspect flashpay-bd05-http-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_DB=//p')" == bd05_http_test ]] || fail DB_NAME_MISMATCH
[[ "$(docker inspect flashpay-bd05-http-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_USER=//p')" == bd05_admin ]] || fail DB_USER_MISMATCH
DB_PASS="$(docker inspect flashpay-bd05-http-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')"
TOKEN="$(docker inspect flashpay-bd05-http-bridge --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^BD05_BRIDGE_TOKEN=//p')"
[[ -n "$DB_PASS" && ${#TOKEN} -ge 32 ]] || fail TEST_CREDENTIALS_MISSING
if docker container inspect flashpay-bd05-http-next-test >/dev/null 2>&1; then
 [[ "$(docker inspect flashpay-bd05-http-next-test --format '{{.HostConfig.NetworkMode}}')" == "$NET" ]] || fail EXISTING_TEST_WRONG_NETWORK
 [[ "$(docker inspect flashpay-bd05-http-next-test --format '{{json .HostConfig.PortBindings}}')" == null || "$(docker inspect flashpay-bd05-http-next-test --format '{{json .HostConfig.PortBindings}}')" == '{}' ]] || fail EXISTING_TEST_PUBLISHED_PORTS
 # Only replace the known disposable fixture; never replace an arbitrary container by name.
 [[ "$(docker inspect flashpay-bd05-http-next-test --format '{{.Config.Image}}')" == node:24-bookworm-slim ]] || fail UNEXPECTED_EXISTING_TEST_IMAGE
 [[ "$(docker inspect flashpay-bd05-http-next-test --format '{{.Config.WorkingDir}}')" == /workspace ]] || fail UNEXPECTED_EXISTING_TEST_WORKDIR
 docker rm -f flashpay-bd05-http-next-test >/dev/null
fi
BD05_DB_SCHEME=postgres
ENC_PASS="$(node -p 'encodeURIComponent(process.argv[1])' "$DB_PASS")"
docker run -d --name flashpay-bd05-http-next-test --network "$NET" \
 --mount "type=bind,source=$WORK,target=/workspace,readonly" --workdir /workspace \
 --env NODE_ENV=production --env NEXT_TELEMETRY_DISABLED=1 --env BD05_ISOLATED_TEST=YES \
 --env NODE_OPTIONS=--require=/workspace/certification/FIN100B_BD05_PI_FETCH_INTERCEPT_NOT_FOR_DEPLOY.cjs \
 --env "DATABASE_URL=${BD05_DB_SCHEME}://bd05_admin:${ENC_PASS}@bd05-postgres:5432/bd05_http_test" \
 --env PI_API_KEY=BD05_DISPOSABLE_FAKE_PI_KEY_NO_REAL_ACCESS \
 --env A2U_INTERNAL_SECRET=BD05_DISPOSABLE_FAKE_INTERNAL_SECRET \
 --env UPSTASH_REDIS_REST_URL=http://flashpay-bd05-http-bridge:56381 \
 --env "UPSTASH_REDIS_REST_TOKEN=$TOKEN" --entrypoint node node:24-bookworm-slim \
 node_modules/next/dist/bin/next start -H 0.0.0.0 -p 3001 >/dev/null
[[ "$(docker inspect flashpay-bd05-http-next-test --format '{{.State.Running}}')" == true ]] || fail NEXT_TEST_NOT_RUNNING
# Readiness gate: starting a container is NOT equivalent to an HTTP-ready Next.js server.
# Wait within the internal Docker network before launching the behavioral suite.
docker run --rm --network "$NET" --entrypoint node node:24-bookworm-slim -e '
(async()=>{
 for(let attempt=1;attempt<=40;attempt++){
  try {
   const r=await fetch("http://flashpay-bd05-http-next-test:3001/",{signal:AbortSignal.timeout(1200),redirect:"manual"});
   if(r.status===200){console.log("BD05_NEXT_HTTP_READY=PASS ATTEMPT="+attempt);return;}
  } catch {}
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 console.log("BD05_NEXT_HTTP_READY=FAIL");process.exitCode=1;
})().catch(e=>{console.log("BD05_NEXT_HTTP_READY=FAIL "+e.message);process.exitCode=1})
' || fail NEXT_HTTP_NOT_READY
# No real Pi/Horizon: the Next.js fetch preload denies external fetch; Docker Internal=true stops egress.
docker run --rm --network "$NET" --mount "type=bind,source=$WORK,target=/workspace,readonly" \
 --workdir /workspace --env BD05_ISOLATED_TEST=YES --env BD05_DB_HOST=bd05-postgres \
 --env BD05_DB_NAME=bd05_http_test --env "BD05_DB_PASS=$DB_PASS" \
 --env BD05_REDIS_URL=http://flashpay-bd05-http-bridge:56381 \
 --env "BD05_BRIDGE_TOKEN=$TOKEN" --entrypoint node node:24-bookworm-slim \
 certification/FIN100B_BD05_HTTP_BEHAVIORAL_NOT_FOR_DEPLOY.cjs
unset DB_PASS TOKEN ENC_PASS
