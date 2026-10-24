#!/usr/bin/env bash
# career-ops — one-time Ubuntu host bootstrap. Run as your normal user.
#   bash deploy/bootstrap-ubuntu.sh
set -euo pipefail

REPO="${CAREER_OPS_DIR:-$HOME/career-ops}"
echo "==> Repo dir: $REPO"
[ -d "$REPO" ] || { echo "!! $REPO not found. Clone the repo there first (and copy your private data)."; exit 1; }

echo "==> Base packages"
sudo apt-get update
sudo apt-get install -y curl ca-certificates git jq poppler-utils

# LaTeX toolchain for resume PDFs. texlive-fonts-extra is REQUIRED: it ships
# fontawesome.sty, used by templates/cv-template.tex. Without it pdflatex aborts
# and the pipeline silently emits a degraded, ATS-unparseable PDF (no ToUnicode
# CMap -> resume parsers cannot read the candidate name).
echo "==> LaTeX (resume PDF generation)"
sudo apt-get install -y --no-install-recommends \
  latexmk texlive-latex-recommended texlive-latex-extra \
  texlive-fonts-recommended texlive-fonts-extra texlive-xetex
kpsewhich fontawesome.sty >/dev/null 2>&1 \
  && echo "    fontawesome.sty OK" \
  || echo "    !! fontawesome.sty still missing — resume PDFs will be ATS-broken"

echo "==> Node 20 (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//;s/\..*//')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "    node $(node -v) / npm $(npm -v)"

echo "==> Docker + compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER" || true
echo "    (log out/in or run 'newgrp docker' so the docker group applies)"

echo "==> Claude Code CLI"
if ! command -v claude >/dev/null 2>&1; then
  npm i -g @anthropic-ai/claude-code || sudo npm i -g @anthropic-ai/claude-code
fi
echo "    claude installed -> authenticate once:  claude   (then /login)  OR set ANTHROPIC_API_KEY in deploy/.env"

echo "==> Repo + webapp deps, Playwright Chromium (for PDF generation)"
cd "$REPO" && npm install
[ -d "$REPO/webapp" ] && (cd "$REPO/webapp" && npm install --omit=dev || true)
cd "$REPO" && npx playwright install --with-deps chromium

echo "==> gog (Gmail CLI)"
command -v gog >/dev/null 2>&1 && echo "    gog present -> ensure it's authed: gog -a $GOG_ACCOUNT --client work gmail search test --max 1" \
  || echo "    !! Install 'gog' manually and auth the work account (see README-deploy.md)."

echo "==> Done. Next:"
echo "    1) cp deploy/.env.example deploy/.env && edit it"
echo "    2) bash deploy/install-systemd.sh"
