# resume-screener Makefile
#
# Requires: make, Python 3.11+, Node 18+
# Windows users: run via Git Bash, WSL, or `choco install make`

BACKEND_DIR  := backend
FRONTEND_DIR := frontend
VENV         := $(BACKEND_DIR)/.venv

# Detect OS for venv activation path
ifeq ($(OS),Windows_NT)
  PYTHON := $(VENV)/Scripts/python
  PIP    := $(VENV)/Scripts/pip
else
  PYTHON := $(VENV)/bin/python
  PIP    := $(VENV)/bin/pip
endif

.PHONY: install install-backend install-frontend \
        run-backend run-frontend \
        test lint \
        clean help

# ── Default target ────────────────────────────────────────────────────────────

help:
	@echo ""
	@echo "  make install        Install Python + Node dependencies"
	@echo "  make run-backend    Start FastAPI with hot reload  (port 8000)"
	@echo "  make run-frontend   Start Next.js dev server       (port 3000)"
	@echo "  make test           Run pytest suite"
	@echo "  make lint           Run ruff (Python) + tsc (TypeScript)"
	@echo "  make clean          Remove build artefacts and caches"
	@echo ""

# ── Install ───────────────────────────────────────────────────────────────────

install: install-backend install-frontend

install-backend:
	@echo "→ Creating Python virtual environment…"
	python -m venv $(VENV)
	@echo "→ Installing Python dependencies…"
	$(PIP) install --upgrade pip --quiet
	$(PIP) install -r $(BACKEND_DIR)/requirements.txt --quiet
	@echo "✓ Backend deps installed."

install-frontend:
	@echo "→ Installing Node dependencies…"
	npm --prefix $(FRONTEND_DIR) install --silent
	@echo "✓ Frontend deps installed."

# ── Run ───────────────────────────────────────────────────────────────────────

run-backend:
	@echo "→ Starting FastAPI on http://localhost:8000 …"
	cd $(BACKEND_DIR) && $(PYTHON) -m uvicorn main:app --reload --host 0.0.0.0 --port 8000

run-frontend:
	@echo "→ Starting Next.js on http://localhost:3000 …"
	npm --prefix $(FRONTEND_DIR) run dev

# ── Test ──────────────────────────────────────────────────────────────────────

test:
	@echo "→ Running pytest…"
	$(PYTHON) -m pytest -v

# ── Lint ──────────────────────────────────────────────────────────────────────

lint: lint-python lint-typescript

lint-python:
	@echo "→ Linting Python (ruff)…"
	@if $(PYTHON) -m ruff --version > /dev/null 2>&1; then \
		$(PYTHON) -m ruff check $(BACKEND_DIR); \
	else \
		echo "  ruff not installed — run: $(PIP) install ruff"; \
	fi

lint-typescript:
	@echo "→ Type-checking TypeScript (tsc)…"
	npm --prefix $(FRONTEND_DIR) exec -- tsc --noEmit

# ── Clean ─────────────────────────────────────────────────────────────────────

clean:
	@echo "→ Removing Python caches…"
	find $(BACKEND_DIR) -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find $(BACKEND_DIR) -name "*.pyc" -delete 2>/dev/null || true
	rm -rf $(BACKEND_DIR)/.pytest_cache $(BACKEND_DIR)/reports
	@echo "→ Removing Next.js build output…"
	rm -rf $(FRONTEND_DIR)/.next
	@echo "✓ Clean."
