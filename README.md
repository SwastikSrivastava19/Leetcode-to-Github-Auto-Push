# LeetCode to GitHub Auto Push (Chrome Extension)

This extension listens for accepted LeetCode submissions and auto-commits your code to GitHub.

## What it does
- Detects accepted submissions on LeetCode.
- Pushes solution file per problem:
  - `solution.<ext>`
- Tracks progress analytics in local extension storage.
- Writes analytics to repo at `leetcode/analytics/progress.json`.
- Updates `README.md` with:
  - Daily streak and progress analytics section
- Skips duplicate commits when solution content is unchanged.

## Publish-safe authentication
- No personal token in extension code.
- Use a Fine-grained PAT scoped to one repository only.
- PAT is stored only in local browser storage.

## Setup
1. Create a GitHub Fine-grained PAT.
2. Scope it to exactly one repository.
3. Grant only `Contents: Read and write`.
4. Set an expiry date.
5. Open `chrome://extensions`.
6. Enable `Developer mode`.
7. Click `Load unpacked` and select this folder.
8. Open extension options.
9. Fill:
   - `GitHub Fine-grained PAT`
   - `Repository` (`owner/repo`)
   - `Branch` (default `main`)
   - `Folder Path` (default `leetcode`)
10. Click `Save`.

## Usage
1. Open any LeetCode problem page.
2. Submit solution.
3. On accepted result, this extension updates files under:
   - `leetcode/<slug>-<title>/solution.<ext>`

## Notes
- You must be logged into LeetCode in the same browser profile.
- Use `Test GitHub Connection` and `Test GitHub Push` in options for diagnostics.
- View service worker logs from `chrome://extensions` for troubleshooting.
