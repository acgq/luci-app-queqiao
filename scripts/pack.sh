#!/bin/sh
# Invoked by build.py in a Linux environment with root/fakeroot ownership.
set -eu
apk_tool=$1
archive=$2
output=$3
name=$4
version=$5
arch=$6
depends=$7
epoch=$8
stage=$(mktemp -d /tmp/queqiao-apk.XXXXXXXX)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
tar -xf "$archive" -C "$stage"
set -- "$apk_tool" mkpkg --compat 3.0.0 \
	--info "name:$name" --info "version:$version" --info "arch:$arch" \
	--info "license:MIT" --info "url:https://github.com/acgq/luci-app-queqiao" \
	--info "description:Queqiao OpenWrt development package" \
	--info "depends:$depends" --info "build-time:$epoch" \
	--files "$stage/root" --output "$output"
if [ "$name" = queqiao ]; then
	set -- "$@" --info "provides:queqiao-luci-api-v4=$version"
fi
for script in post-install post-upgrade pre-deinstall; do
	if [ -f "$stage/scripts/$script" ]; then
		set -- "$@" --script "$script:$stage/scripts/$script"
	fi
done
SOURCE_DATE_EPOCH=$epoch "$@"
