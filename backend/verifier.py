import logging
import os
import re
from collections import Counter

import httpx

from models import GitHubCheckResult

logger = logging.getLogger(__name__)

_TIMEOUT = httpx.Timeout(5.0)  # 5-second ceiling on every external call

_SERPER_URL = "https://google.serper.dev/search"
_GITHUB_API = "https://api.github.com"
_GITHUB_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

# Matches github.com/<username> — rejects paths deeper than one segment
_USERNAME_RE = re.compile(
    r"^https?://(?:www\.)?github\.com/([A-Za-z0-9_.-]+)/?$",
    re.IGNORECASE,
)


def _extract_username(url: str) -> str | None:
    """Return the GitHub username from a profile URL, or None if the URL is unexpected."""
    m = _USERNAME_RE.match(url.strip())
    return m.group(1) if m else None


async def _serper_profile_exists(username: str, client: httpx.AsyncClient) -> bool:
    """
    Query Serper for 'site:github.com/<username>' and treat ≥1 organic result
    as confirmation the profile is publicly indexed.
    """
    api_key = os.getenv("SERPER_API_KEY", "")
    if not api_key:
        logger.warning("SERPER_API_KEY not set — skipping Serper confirmation step.")
        return True  # assume exists so the flow is not blocked by missing config

    try:
        resp = await client.post(
            _SERPER_URL,
            headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
            json={"q": f"site:github.com/{username}", "num": 3},
        )
        if resp.status_code == 429:
            logger.warning("Serper rate limit hit — treating profile as existing.")
            return True
        resp.raise_for_status()
        data = resp.json()
        return bool(data.get("organic"))
    except httpx.TimeoutException:
        logger.warning("Serper request timed out — treating profile as existing.")
        return True
    except httpx.HTTPStatusError as exc:
        logger.warning("Serper HTTP error %s — skipping.", exc.response.status_code)
        return True
    except Exception as exc:
        logger.warning("Serper unexpected error: %s — skipping.", exc)
        return True


async def _github_repo_data(username: str, client: httpx.AsyncClient) -> tuple[int, list[str]]:
    """
    Fetch public repos for *username* and return (repo_count, top_3_languages).
    Returns (0, []) on any failure so callers never have to handle exceptions.
    """
    try:
        resp = await client.get(
            f"{_GITHUB_API}/users/{username}/repos",
            headers=_GITHUB_HEADERS,
            params={"per_page": 100, "sort": "pushed"},
        )
        if resp.status_code == 404:
            return 0, []
        if resp.status_code == 429 or resp.status_code == 403:
            logger.warning("GitHub API rate limit hit for user '%s'.", username)
            return 0, []
        resp.raise_for_status()

        repos: list[dict] = resp.json()
        repo_count = len(repos)

        # Tally languages, skipping repos with no language set
        lang_counter: Counter = Counter(
            r["language"] for r in repos if r.get("language")
        )
        top_languages = [lang for lang, _ in lang_counter.most_common(3)]
        return repo_count, top_languages

    except httpx.TimeoutException:
        logger.warning("GitHub API timed out for user '%s'.", username)
        return 0, []
    except httpx.HTTPStatusError as exc:
        logger.warning("GitHub API HTTP error %s for user '%s'.", exc.response.status_code, username)
        return 0, []
    except Exception as exc:
        logger.warning("GitHub API unexpected error for user '%s': %s", username, exc)
        return 0, []


async def verify_github(github_url: str) -> GitHubCheckResult:
    """
    Verify a GitHub profile URL and return enriched metadata.

    Steps:
      1. Validate the URL shape and extract the username.
      2. Use Serper to confirm the profile is publicly indexed.
      3. Hit the GitHub public API for repo count + top languages.

    Never raises — all failures produce an exists=False result or a
    degraded-but-valid result so the main screening flow is never blocked.
    """
    username = _extract_username(github_url)
    if not username:
        logger.info("Could not extract GitHub username from URL: %s", github_url)
        return GitHubCheckResult(url=github_url, exists=False)

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            exists = await _serper_profile_exists(username, client)

            if not exists:
                return GitHubCheckResult(url=github_url, exists=False)

            repo_count, top_languages = await _github_repo_data(username, client)

        return GitHubCheckResult(
            url=github_url,
            exists=True,
            repo_count=repo_count or None,       # None when API was rate-limited
            top_languages=top_languages or None,  # None when no language data
        )

    except Exception as exc:
        # Last-resort catch so a bug here never kills a screening run.
        logger.error("verify_github failed unexpectedly for '%s': %s", github_url, exc)
        return GitHubCheckResult(url=github_url, exists=False)
