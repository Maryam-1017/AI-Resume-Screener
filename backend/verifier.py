import httpx
from models import GitHubVerification


async def verify_github(url: str) -> GitHubVerification:
    if not url or "github.com" not in url:
        return GitHubVerification(url=url, is_valid=False, error="Not a GitHub URL")

    username = url.rstrip("/").split("github.com/")[-1].split("/")[0]
    api_url = f"https://api.github.com/users/{username}"

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            user_resp = await client.get(api_url, headers={"Accept": "application/vnd.github+json"})
            if user_resp.status_code != 200:
                return GitHubVerification(url=url, is_valid=False, error=f"User not found (HTTP {user_resp.status_code})")

            user_data = user_resp.json()
            repo_count = user_data.get("public_repos", 0)

            repos_resp = await client.get(
                f"https://api.github.com/users/{username}/events/public",
                headers={"Accept": "application/vnd.github+json"},
            )
            has_activity = repos_resp.status_code == 200 and len(repos_resp.json()) > 0

            return GitHubVerification(
                url=url,
                is_valid=True,
                repo_count=repo_count,
                has_activity=has_activity,
            )
    except httpx.RequestError as e:
        return GitHubVerification(url=url, is_valid=False, error=str(e))
