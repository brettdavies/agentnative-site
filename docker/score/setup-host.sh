#!/usr/bin/env bash
# One-time host setup for the anc100 batch-scoring image.
#
# What it installs:
#   1. Docker Engine (engine only — NOT Docker Desktop) via Docker's
#      official Ubuntu apt repository. Pulls docker-ce, docker-ce-cli,
#      containerd.io, docker-buildx-plugin, docker-compose-plugin.
#   2. nvidia-container-toolkit so `docker run --gpus all …` works,
#      enabling nvidia-smi to be one of the scored tools.
#   3. Adds the invoking user to the `docker` group so subsequent
#      `docker` commands don't need sudo (effective on next login or
#      after `newgrp docker`).
#
# Source: https://docs.docker.com/engine/install/ubuntu/
#         https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html
#
# Idempotent: safe to re-run. Each step checks for prior state before acting.
#
# Usage:
#   bash docker/score/setup-host.sh
#
# Tested on Ubuntu 24.04 (Noble). Should also work on 22.04 (Jammy) and
# Debian Bookworm/Trixie with one URL substitution (linux/ubuntu →
# linux/debian) — left as an exercise; the script asserts Ubuntu.

set -euo pipefail

# ---- Pre-flight ---------------------------------------------------------

if [[ "$EUID" -eq 0 ]]; then
  echo "error: do NOT run this script as root. Run as your normal user; sudo is invoked per command." >&2
  exit 1
fi

if [[ ! -f /etc/os-release ]]; then
  echo "error: /etc/os-release missing — can't detect distribution." >&2
  exit 1
fi
. /etc/os-release
if [[ "$ID" != "ubuntu" ]]; then
  echo "error: this script targets Ubuntu. Detected: $PRETTY_NAME" >&2
  echo "       For Debian, replace 'linux/ubuntu' with 'linux/debian' in the apt source URL." >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "error: sudo not found." >&2
  exit 1
fi

CODENAME="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
ARCH="$(dpkg --print-architecture)"

echo "==> Detected Ubuntu $VERSION_CODENAME ($CODENAME / $ARCH)"

# ---- Step 1: Conflict check --------------------------------------------

CONFLICTS=()
for p in docker.io docker-compose docker-doc podman-docker containerd runc; do
  if dpkg -l "$p" 2>/dev/null | grep -q "^ii"; then
    CONFLICTS+=("$p")
  fi
done

if (( ${#CONFLICTS[@]} > 0 )); then
  echo "==> Removing conflicting packages: ${CONFLICTS[*]}"
  sudo apt-get remove -y "${CONFLICTS[@]}"
fi

# ---- Step 2: Docker Engine (apt repo) -----------------------------------

if ! dpkg -l docker-ce 2>/dev/null | grep -q "^ii"; then
  echo "==> Setting up Docker apt repository"

  sudo apt-get update
  sudo apt-get install -y ca-certificates curl

  sudo install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
  fi

  sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $CODENAME
Components: stable
Architectures: $ARCH
Signed-By: /etc/apt/keyrings/docker.asc
EOF

  echo "==> Installing Docker Engine packages"
  sudo apt-get update
  sudo apt-get install -y \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
else
  echo "==> Docker Engine already installed: $(docker --version)"
fi

# ---- Step 3: Add invoking user to docker group --------------------------

if ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
  echo "==> Adding $USER to docker group"
  sudo usermod -aG docker "$USER"
  GROUP_NEEDS_RELOGIN=1
else
  echo "==> $USER already in docker group"
  GROUP_NEEDS_RELOGIN=0
fi

# ---- Step 4: nvidia-container-toolkit -----------------------------------

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "==> Skipping nvidia-container-toolkit — no NVIDIA driver detected on host."
  echo "    (nvidia-smi binary missing.) GPU passthrough will not be available;"
  echo "    nvidia-smi tool falls back to install-missing in the leaderboard."
elif ! dpkg -l nvidia-container-toolkit 2>/dev/null | grep -q "^ii"; then
  echo "==> Setting up nvidia-container-toolkit apt repository"

  if [[ ! -f /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg ]]; then
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  fi

  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null

  sudo apt-get update
  sudo apt-get install -y nvidia-container-toolkit

  echo "==> Configuring docker runtime to use nvidia-container-runtime"
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker
else
  echo "==> nvidia-container-toolkit already installed: $(dpkg -l nvidia-container-toolkit | awk '/^ii/ {print $3}')"
fi

# ---- Step 5: Verify ----------------------------------------------------

echo
echo "==> Verifying installation"

if (( GROUP_NEEDS_RELOGIN == 1 )); then
  echo "    (group change pending — using 'sudo docker' for verification this run)"
  DOCKER="sudo docker"
else
  DOCKER="docker"
fi

echo "    docker --version:       $($DOCKER --version)"
echo "    docker compose version: $($DOCKER compose version 2>&1 | head -1)"

echo "==> docker run hello-world (smoke test)"
$DOCKER run --rm hello-world | tail -5

if command -v nvidia-smi >/dev/null 2>&1; then
  echo "==> docker run --gpus all (GPU passthrough smoke test)"
  $DOCKER run --rm --gpus all nvidia/cuda:12.0.0-base-ubuntu22.04 nvidia-smi | head -5
fi

echo
echo "==> Done."
if (( GROUP_NEEDS_RELOGIN == 1 )); then
  echo "    Log out + back in (or run 'newgrp docker' in this shell) to use docker"
  echo "    without sudo. Then re-run: bash docker/score/build.sh --run"
fi
