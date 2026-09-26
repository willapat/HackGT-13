#!/usr/bin/env bash
# Curl smoke test for a running backend. Usage (from repo root): bash backend/tests/smoke.sh [api_url]
# Creates two throwaway Supabase users, walks every endpoint, then deletes everything it made.
set -uo pipefail
API=${1:-http://127.0.0.1:8000}
set -a; source .env; set +a
TAG=$RANDOM$RANDOM PW="Smoke-$RANDOM-$RANDOM!" FAILS=0 TOWN_ID="" UIDS=()

# call METHOD PATH EXPECTED_CODE [TOKEN] [JSON] → prints result, leaves response body in $BODY
call() {
  local out code
  out=$(curl -sS -X "$1" "$API$2" ${4:+-H "Authorization: Bearer $4"} \
    ${5:+-H "Content-Type: application/json" -d "$5"} -w $'\n%{http_code}')
  code=${out##*$'\n'} BODY=${out%$'\n'*}
  if [[ $code == "$3" ]]; then echo "PASS $code $1 $2"; else echo "FAIL $code (want $3) $1 $2: $BODY"; FAILS=$((FAILS + 1)); fi
}

cleanup() {
  [[ -n $TOWN_ID ]] && curl -sS -o /dev/null -X DELETE "$SUPABASE_URL/rest/v1/towns?id=eq.$TOWN_ID" \
    -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
  for id in ${UIDS[@]+"${UIDS[@]}"}; do
    curl -sS -o /dev/null -X DELETE "$SUPABASE_URL/auth/v1/admin/users/$id" \
      -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
  done
  echo "cleaned up town ${TOWN_ID:-none} and ${#UIDS[@]} users"
}
trap cleanup EXIT

# Test user via the admin API (pre-confirmed), then a real login; sets $TOKEN. Not in $(...): UIDS must persist.
new_user() {
  local email="smoke-$TAG-$1@example.com" id
  id=$(curl -sS "$SUPABASE_URL/auth/v1/admin/users" -H "apikey: $SUPABASE_SECRET_KEY" \
    -H "Authorization: Bearer $SUPABASE_SECRET_KEY" -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$PW\",\"email_confirm\":true,\"user_metadata\":{\"name\":\"$1\"}}" | jq -r .id)
  UIDS+=("$id")  # not inline: bash 3.2 (macOS) mis-parses a multi-line $(...) inside UIDS+=(...)
  TOKEN=$(curl -sS "$SUPABASE_URL/auth/v1/token?grant_type=password" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
    -H "Content-Type: application/json" -d "{\"email\":\"$email\",\"password\":\"$PW\"}" | jq -r .access_token)
}

echo "--- public"
call GET /health 200
call GET /demo/config 200
call GET /me 401
call GET /me 401 not-a-real-token

echo "--- users"
new_user Ana; ANA=$TOKEN; new_user Ben; BEN=$TOKEN; BEN_ID=${UIDS[1]}
[[ $ANA == ey* && $BEN == ey* ]] || { echo "FAIL could not log in test users"; exit 1; }

echo "--- profile"
call PATCH /me 200 "$ANA" '{"interests":["Climbing","coffee"]}'
call PATCH /me 200 "$BEN" '{"interests":["climbing"]}'
call GET /me 200 "$ANA"

echo "--- friends (by username)"
ANA_ID=${UIDS[0]}
call PATCH /me 200 "$ANA" "{\"username\":\"ana_$TAG\"}"
call PATCH /me 200 "$BEN" "{\"username\":\"ben_$TAG\"}"
call PATCH /me 409 "$BEN" "{\"username\":\"ana_$TAG\"}"
call GET "/users/search?username=ANA_$TAG" 200 "$BEN"
echo "     found=$(jq length <<<"$BODY")"
call POST /friends/requests 201 "$BEN" "{\"username\":\"ana_$TAG\"}"
REQ_ID=$(jq -r .id <<<"$BODY")
call POST /friends/requests 409 "$BEN" "{\"username\":\"ana_$TAG\"}"
call GET /friends/requests 200 "$ANA"
echo "     incoming=$(jq '.incoming | length' <<<"$BODY")"
call POST "/friends/requests/$REQ_ID/respond" 200 "$ANA" '{"status":"accepted"}'
call GET /friends 200 "$BEN"
echo "     friends=$(jq length <<<"$BODY")"

echo "--- towns"
call POST /towns 201 "$ANA" '{"name":"Smoke Town","tiles":[["lot","road","lot"],["lot","road","lot"],["home","road","lot"]],"map":{"places":{"cafe":{"name":"Cafe","tile":[2,1],"door":[1,1]}},"landmarks":{"stadium":{"model":"simplepoly-city/building-stadium"}}},"me":{"name":"Ana","color":"#ff3b30"}}'
call POST /towns 422 "$ANA" '{"name":"Bad Map","tiles":[["lot"]],"map":{"places":{"cafe":{"name":"Cafe","tile":[5,5],"door":[0,0]}}},"me":{"name":"Ana","color":"#ff3b30"}}'
TOWN_ID=$(jq -r .id <<<"$BODY"); CODE=$(jq -r .invite_code <<<"$BODY")
call GET "/towns/$TOWN_ID" 404 "$BEN"
call GET "/towns/lookup?invite_code=$CODE" 200 "$BEN"
call POST /towns/join 409 "$BEN" "{\"invite_code\":\"$CODE\",\"me\":{\"name\":\"ana\",\"color\":\"#2d9cdb\"}}"
call POST /towns/join 409 "$BEN" "{\"invite_code\":\"$CODE\",\"me\":{\"name\":\"Ben\",\"color\":\"#fe3c31\"}}"
call POST /towns/join 200 "$BEN" "{\"invite_code\":\"$CODE\",\"me\":{\"name\":\"Ben\",\"color\":\"#a24bff\"}}"
call PATCH "/towns/$TOWN_ID/members/me/identity" 409 "$BEN" '{"name":"ANA"}'
call PATCH "/towns/$TOWN_ID/members/me/identity" 200 "$BEN" '{"name":"Benny","color":"#ffd60a"}'
call PATCH "/towns/$TOWN_ID/members/me" 200 "$BEN" '{"house_x":0,"house_y":2,"home":{"model":"city-kit-suburban/building-type-k","door":[1,2]}}'
call PATCH "/towns/$TOWN_ID/members/me" 422 "$BEN" '{"house_x":9,"house_y":9}'
call PATCH "/towns/$TOWN_ID" 403 "$BEN" '{"name":"Hijacked"}'
call GET "/towns/$TOWN_ID" 200 "$BEN"
echo "     members=$(jq '.members | length' <<<"$BODY") agents=$(jq '.agents | length' <<<"$BODY")"

echo "--- move (walk to a building on the map)"
call POST "/towns/$TOWN_ID/members/me/move" 200 "$BEN" '{"building_id":"cafe","from_x":0,"from_y":2}'
echo "     action=$(jq -r .action <<<"$BODY") target=$(jq -c .target <<<"$BODY")"
call POST "/towns/$TOWN_ID/members/me/move" 422 "$BEN" '{"building_id":"gym","from_x":0,"from_y":2}'
call POST "/towns/$TOWN_ID/members/me/move" 422 "$BEN" '{"building_id":"cafe","from_x":9,"from_y":9}'
call POST "/towns/$TOWN_ID/members/me/move" 409 "$ANA" "{\"building_id\":\"house:${UIDS[0]}\",\"from_x\":1,\"from_y\":1}"
call POST "/towns/$TOWN_ID/members/me/move" 200 "$BEN" "{\"building_id\":\"house:$BEN_ID\",\"from_x\":1.5,\"from_y\":1}"
echo "     action=$(jq -r .action <<<"$BODY") from=($(jq -r .x <<<"$BODY"), $(jq -r .y <<<"$BODY"))"

echo "--- town invites (creator only, friends only)"
new_user Cy; CY=$TOKEN; CY_ID=${UIDS[2]}
call PATCH /me 200 "$CY" "{\"username\":\"cy_$TAG\"}"
call POST "/towns/$TOWN_ID/invites" 422 "$ANA" "{\"user_id\":\"$CY_ID\"}"
call POST /friends/requests 201 "$ANA" "{\"username\":\"cy_$TAG\"}"
call POST /friends/requests 201 "$CY" "{\"username\":\"ana_$TAG\"}"
echo "     crossed request -> status=$(jq -r .status <<<"$BODY")"
call POST "/towns/$TOWN_ID/invites" 403 "$BEN" "{\"user_id\":\"$CY_ID\"}"
call POST "/towns/$TOWN_ID/invites" 201 "$ANA" "{\"user_id\":\"$CY_ID\"}"
INVITE_ID=$(jq -r .id <<<"$BODY")
call POST "/towns/$TOWN_ID/invites" 409 "$ANA" "{\"user_id\":\"$CY_ID\"}"
call GET "/towns/$TOWN_ID/invites" 200 "$BEN"
call GET /me/invites 200 "$CY"
echo "     pending=$(jq length <<<"$BODY") town=$(jq -r '.[0].towns.name' <<<"$BODY") from=$(jq -r '.[0].from_profile.username' <<<"$BODY")"
call POST "/invites/$INVITE_ID/respond" 422 "$CY" '{"status":"accepted"}'
call GET "/towns/$TOWN_ID/identities" 200 "$CY"
call POST "/invites/$INVITE_ID/respond" 200 "$CY" '{"status":"accepted","me":{"name":"Cy","color":"#ff9500"}}'
call GET "/towns/$TOWN_ID" 200 "$CY"
echo "     members=$(jq '.members | length' <<<"$BODY")"
call DELETE "/friends/$ANA_ID" 204 "$BEN"
call DELETE "/friends/$ANA_ID" 404 "$BEN"

echo "--- signals"
call POST /signals 201 "$ANA" '{"source":"manual","type":"mood","value":{"mood":"great week"}}'
call POST /signals 422 "$ANA" '{"source":"manual","type":"mood","value":{"visibility":"public"}}'
call GET /signals 200 "$ANA"

echo "--- quest: propose → accept → approve"
call POST "/towns/$TOWN_ID/events" 201 "$ANA" "{\"title\":\"Go climbing\",\"text\":\"Beginner session at the gym\",\"participant_ids\":[\"$BEN_ID\"]}"
EVENT_ID=$(jq -r .id <<<"$BODY")
call POST "/events/$EVENT_ID/approve" 409 "$ANA"
call POST "/events/$EVENT_ID/respond" 200 "$BEN" '{"status":"accepted"}'
echo "     status=$(jq -r .status <<<"$BODY") place=$(jq -r .plan.place.name <<<"$BODY")"
call POST "/events/$EVENT_ID/approve" 200 "$ANA"
call GET "/events/$EVENT_ID" 200 "$BEN"
call GET "/towns/$TOWN_ID/events?type=quest" 200 "$BEN"
call GET /me/friendships 200 "$BEN"
echo "     path_score=$(jq -r '.[0].path_score' <<<"$BODY")"
call GET "/towns/$TOWN_ID/activity" 200 "$ANA"

echo "--- leave"
call DELETE "/towns/$TOWN_ID/members/me" 204 "$BEN"
call GET "/towns/$TOWN_ID" 404 "$BEN"

echo "--- $FAILS failure(s)"
exit $((FAILS > 0))
