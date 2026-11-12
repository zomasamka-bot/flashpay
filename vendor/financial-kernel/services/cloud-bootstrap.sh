#!/bin/sh
set -eu
# Only a nonpersistent VM may run this script. Credentials live on RAM-backed
# storage. Never snapshot a VM after credentials have been injected.
test "$(id -u)" = 0
mkdir -p /sys/fs/cgroup/host-processes
# The VM agent can create a short-lived root process while the session starts.
# Retry the no-internal-process transition; never omit Docker resource limits.
ready=0
attempt=0
while [ "$attempt" -lt 10 ]; do
  for p in $(cat /sys/fs/cgroup/cgroup.procs); do
    echo "$p" >/sys/fs/cgroup/host-processes/cgroup.procs 2>/dev/null || true
  done
  if (echo '+cpu +memory +pids' >/sys/fs/cgroup/cgroup.subtree_control) 2>/dev/null; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.2
done
test "$ready" = 1
for controller in cpu memory pids; do
  grep -qw "$controller" /sys/fs/cgroup/cgroup.subtree_control
done
if ! docker info >/dev/null 2>&1; then
  rm -f /var/run/docker.pid
  dockerd >/tmp/r36-dockerd.log 2>&1 &
fi
timeout 25s sh -c 'until docker info >/dev/null 2>&1; do sleep 1; done'
mkdir -p /run/flashpay-r36
chmod 700 /run/flashpay-r36
if ! mountpoint -q /run/flashpay-r36; then
  mount -t tmpfs -o mode=0700,nosuid,nodev,noexec,size=2m tmpfs /run/flashpay-r36
fi
mkdir -p /data/r36
# Do not chmod/chown recursively: preserve immutable artifacts and existing data.
for d in /data/r36 /data/r36/scratch /data/r36/artifacts /data/r36/jobs /data/r36/facts; do
  mkdir -p "$d"
  chmod 700 "$d"
done
chown 10001:10001 /data/r36/artifacts /data/r36/jobs /data/r36/facts
printf 'R36_EPHEMERAL_HOST_READY\n'
