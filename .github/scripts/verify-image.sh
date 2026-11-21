#!/usr/bin/env bash
# Checks a built Control image before anyone relies on it (CI on every pull request).
#
#   verify-image.sh <image ref> <api|migrate|portal>
#
# It reads the image only; it needs no credential and sends nothing anywhere. It fails on the
# first problem and prints what it found.
#
#   1. linux/amd64, the platform ECS Fargate runs (X86_64 in munaxa-platform infra/aws).
#   2. Not root, by name and by uid.
#   3. Alpine (musl): no glibc and no util-linux package, the sources of 4 of the 7 HIGH findings
#      in the 8 Nov Debian images (report 2026-11-20-rds-rotation-and-docs-first-approvals).
#   4. zlib at or above 1.4-r0 (CVE-2026-4738), and the libz the loader maps is that package's.
#   5. The operating-system packages are the pinned base's plus ca-certificates only (no openssl CLI).
#   6. api and migrate: the Prisma query engine for linux-musl-openssl-3.0.x is present and loads
#      (a wrong engine target is otherwise found only when the service first queries).
#   7. The libraries a running Node process actually maps (read from /proc/self/maps after loading
#      the Prisma engine where there is one): the musl loader, no glibc, and every shared object
#      outside node_modules owned by an installed Alpine package, so the scanner sees all of them.
#
# A passing run is not a vulnerability scan: scan-image.sh is CI's scan, and ECR's scan on push
# of the released digest is the registry's evidence.
#   Also: libssl3 and libcrypto3 at or above 3.5.10-r0, and no npm, npx, corepack, yarn or pnpm.
set -euo pipefail

REF="${1:?usage: verify-image.sh <image ref> <api|migrate|portal>}"
TARGET="${2:?usage: verify-image.sh <image ref> <api|migrate|portal>}"
ZLIB_FIXED="1.4-r0"
DOCKERFILE="$(dirname "$0")/../../Dockerfile"

fail() { echo "::error::$REF: $*" >&2; exit 1; }
in_image() { docker run --rm --entrypoint sh "$REF" -c "$1"; }

case "$TARGET" in api|migrate|portal) ;; *) fail "unknown target '$TARGET'";; esac

platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$REF")"
[ "$platform" = "linux/amd64" ] || fail "platform is $platform, expected linux/amd64"

user="$(in_image 'id -un')"
uid="$(in_image 'id -u')"
{ [ "$user" != "root" ] && [ "$uid" != "0" ]; } || fail "runs as root ($user, uid $uid)"

in_image 'test -f /etc/alpine-release' || fail "not an Alpine image"
for pkg in glibc libc6 util-linux libuuid1 libblkid1 libmount1; do
  if in_image "apk info -e $pkg >/dev/null 2>&1"; then fail "package $pkg is installed"; fi
done

zlib="$(in_image "apk info -v 2>/dev/null | sed -n 's/^zlib-\([0-9][^ ]*\)\$/\1/p'")"
[ -n "$zlib" ] || fail "zlib is not installed as a package"
cmp="$(in_image "apk version -t '$zlib' '$ZLIB_FIXED'" || true)"
case "$cmp" in
  '='|'>') ;;
  '<') fail "zlib $zlib is older than $ZLIB_FIXED (CVE-2026-4738)" ;;
  *) fail "cannot compare zlib '$zlib' with $ZLIB_FIXED" ;;
esac
lib="$(in_image "ldd /sbin/apk | sed -n 's/^[[:space:]]*libz\.so\.1 => \([^ ]*\) .*/\1/p'")"
[ -n "$lib" ] || fail "cannot find the libz the loader maps"
lib="$(in_image "readlink -f '$lib'")"
case "$lib" in */libz.so.1.4*) ;; *) fail "the loader maps $lib, not zlib 1.4";; esac

base="$(sed -n 's/^ARG NODE_IMAGE=\(node:[^ ]*@sha256:[0-9a-f]\{64\}\)$/\1/p' "$DOCKERFILE")"
[ -n "$base" ] || fail "the Dockerfile's NODE_IMAGE is not pinned by digest"
docker image inspect "$base" >/dev/null 2>&1 || docker pull -q "$base" >/dev/null
want="$(docker run --rm --entrypoint sh "$base" -c "apk info 2>/dev/null | sort")"
have="$(in_image "apk info 2>/dev/null | sort")"
removed="$(comm -23 <(echo "$want") <(echo "$have") | tr '\n' ' ')"
added="$(comm -13 <(echo "$want") <(echo "$have") | grep -vxE 'ca-certificates' | tr '\n' ' ' || true)"
[ -z "$removed" ] || fail "packages of the base are missing: $removed"
[ -z "$added" ] || fail "packages beyond ca-certificates were added: $added"

if [ "$TARGET" != "portal" ]; then
  # As root for this read only: as `node`, find exits 1 on the directories it may not read, which
  # under `set -e` ended the script with no message (CI run of 20 Nov 2026, 22:02 UTC).
  engines="$(docker run --rm --user 0 --entrypoint sh "$REF" -c "find / -xdev -name 'libquery_engine-*.so.node' 2>/dev/null || true")"
  echo "$engines" | grep -q 'libquery_engine-linux-musl-openssl-3.0.x.so.node' \
    || fail "no linux-musl-openssl-3.0.x Prisma engine (found: $(echo "$engines" | tr '\n' ' '))"
  for e in $(echo "$engines" | grep 'linux-musl-openssl-3.0.x'); do
    in_image "node -e 'process.dlopen({ exports: {} }, process.argv[1])' '$e'" \
      || fail "the Prisma engine $e does not load"
  done
fi

# OpenSSL at or above Alpine's 3.5.10-r0 (5 HIGH in 3.5.9-r1, OpenSSL advisory of 17 Nov 2026), and no
# package manager or Node tooling (npm, npx, corepack, yarn, pnpm) left in the image.
for want in libssl3=3.5.10-r0 libcrypto3=3.5.10-r0; do
  name="${want%%=*}"
  have_v="$(in_image "apk info -v 2>/dev/null | sed -n 's/^$name-\([0-9][^ ]*\)\$/\1/p'")"
  [ -n "$have_v" ] || fail "$name is not installed as a package"
  case "$(in_image "apk version -t '$have_v' '${want#*=}'" || true)" in
    '='|'>') ;;
    *) fail "$name $have_v is older than ${want#*=}" ;;
  esac
done
tooling="$(docker run --rm --user 0 --entrypoint sh "$REF" -c 'for p in /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/pnpm /opt/yarn-v* /root/.cache/node; do [ -e "$p" ] && echo "$p"; done; true')"
[ -z "$tooling" ] || fail "Node tooling present at run time: $(echo "$tooling" | tr '\n' ' ')"

# 7. What the loader really maps, not what the package database says.
maps_js='const e=process.argv[1]; if (e) process.dlopen({ exports: {} }, e);
const seen=new Set(); for (const l of require("fs").readFileSync("/proc/self/maps","utf8").split("\n")) {
  const f=l.split(/\s+/)[5]; if (f && f.startsWith("/") && /\.so(\.|$)|\.node$/.test(f)) seen.add(f); }
console.log([...seen].join("\n"));'
engine=""
[ "$TARGET" = "portal" ] || engine="$(echo "$engines" | grep 'linux-musl-openssl-3.0.x' | head -n1)"
mapped="$(docker run --rm --entrypoint node "$REF" -e "$maps_js" "$engine")" || fail "node could not start or load $engine"
[ -n "$mapped" ] || fail "no shared object mapped by node (cannot verify loaded libraries)"
echo "$mapped" | grep -q '/ld-musl-x86_64\.so\.1$' || fail "node is not running on the musl loader: $(echo "$mapped" | tr '\n' ' ')"
if echo "$mapped" | grep -qE '(ld-linux|libc\.so\.6|/x86_64-linux-gnu/)'; then
  fail "a glibc library is mapped: $(echo "$mapped" | grep -E '(ld-linux|libc\.so\.6|/x86_64-linux-gnu/)' | tr '\n' ' ')"
fi
unowned=""
for f in $(echo "$mapped" | grep -v '/node_modules/'); do
  real="$(in_image "readlink -f '$f'")"
  in_image "apk info -W '$real' >/dev/null 2>&1" || unowned="$unowned $real"
done
[ -z "$unowned" ] || fail "mapped libraries no Alpine package owns:$unowned"
loaded="$(echo "$mapped" | sed 's#.*/##' | sort -u | tr '\n' ' ')"

echo "$REF ($TARGET): linux/amd64, user $user, Alpine $(in_image 'cat /etc/alpine-release'), zlib $zlib, packages = base + ca-certificates; mapped: $loaded"
