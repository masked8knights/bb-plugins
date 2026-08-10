import json
import urllib.request
from pathlib import Path

REPO = "get-bb/bb"
ISSUE_NUMBER = 1085
STATE_PATH = Path(".issue-1085-watch-state.json")
API_ROOT = "https://api.github.com"
ISSUE_URL = f"{API_ROOT}/repos/{REPO}/issues/{ISSUE_NUMBER}"
COMMENTS_URL = f"{ISSUE_URL}/comments?per_page=100"
DISPLAY_URL = f"https://github.com/{REPO}/issues/{ISSUE_NUMBER}"

def fetch(url):
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "bb-issue-watch",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

def compact(text, limit=500):
    value = " ".join((text or "").split())
    return value if len(value) <= limit else value[: limit - 1] + "…"

issue = fetch(ISSUE_URL)
comments = fetch(COMMENTS_URL)
previous = json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else None
previous_comments = (previous or {}).get("comments", {})
current_comments = {
    str(comment["id"]): {
        "updated_at": comment["updated_at"],
        "user": comment.get("user", {}).get("login", "unknown"),
        "body": comment.get("body", ""),
    }
    for comment in comments
}

new_comments = [
    comment
    for comment in comments
    if str(comment["id"]) not in previous_comments
] if previous else []
edited_comments = [
    comment
    for comment in comments
    if previous
    and str(comment["id"]) in previous_comments
    and comment["updated_at"] != previous_comments[str(comment["id"])]["updated_at"]
] if previous else []
issue_changed = (
    previous is None
    or issue["updated_at"] != previous.get("updated_at")
    or issue["state"] != previous.get("state")
    or issue.get("state_reason") != previous.get("state_reason")
    or issue["comments"] != previous.get("comment_count")
)
changed = previous is None or issue_changed or new_comments or edited_comments

snapshot = {
    "updated_at": issue["updated_at"],
    "state": issue["state"],
    "state_reason": issue.get("state_reason"),
    "comment_count": issue["comments"],
    "comments": current_comments,
}
STATE_PATH.write_text(json.dumps(snapshot, indent=2) + "\n")

if not changed:
    raise SystemExit(0)

print(f"GitHub issue watch: {DISPLAY_URL}")
print(f"#{ISSUE_NUMBER} — {issue['title']}")
print(f"State: {issue['state']}")
if previous is None:
    print("Initial snapshot captured.")
elif issue_changed:
    print("Issue metadata changed since the previous check.")
for comment in new_comments:
    user = comment.get("user", {}).get("login", "unknown")
    print(f"New comment from {user}: {compact(comment.get('body'))}")
for comment in edited_comments:
    user = comment.get("user", {}).get("login", "unknown")
    print(f"Edited comment from {user}: {compact(comment.get('body'))}")
