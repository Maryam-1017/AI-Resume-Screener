"""
Pytest configuration for the backend test suite.

Sets stub environment variables before any app module is imported so that
module-level clients (OpenAI, httpx) initialise without errors, and the
startup env-check in main.py passes during TestClient construction.

Real integration tests that actually hit external APIs should override these
with genuine keys via a local .env file and pytest-dotenv, or by setting the
variables in the shell before running pytest.
"""
import os

os.environ.setdefault("OPENAI_API_KEY", "sk-test-00000000000000000000000000000000")
os.environ.setdefault("SERPER_API_KEY", "serper-test-00000000000000000000000000000000")
