# LeetCode to GitHub Auto Push (Chrome Extension)

This extension listens for accepted LeetCode submissions and auto-commits your code to GitHub.

## What it does
- Detects accepted submissions on LeetCode.
- Pushes multi-file output per problem:
  - `solution.<ext>`
  - `notes.md` (editable template)
- Tracks progress analytics in local extension storage.
- Writes analytics to repo at `leetcode/analytics/progress.json`.
- Updates `README.md` with:
  - Solutions index table
  - Daily streak and progress analytics section
  - Revision queue + recommended next practice topics
- Skips duplicate commits when solution content is unchanged.

## Publish-safe authentication
- No personal token in extension code.
- Each user connects their own GitHub account via OAuth device flow.
- OAuth token is stored only in local browser storage.

## Setup
1. Create a GitHub OAuth App in Developer Settings.
2. Copy its Client ID.
3. Open `chrome://extensions`.
4. Enable `Developer mode`.
5. Click `Load unpacked` and select this folder.
6. Open extension options.
7. Fill:
   - `GitHub OAuth Client ID`
   - `Repository` (`owner/repo`)
   - `Branch` (default `main`)
   - `Folder Path` (default `leetcode`)
8. Click `Connect GitHub` and authorize.

## Usage
1. Open any LeetCode problem page.
2. Submit solution.
3. On accepted result, this extension updates files under:
   - `leetcode/<slug>-<title>/solution.<ext>`
   - `leetcode/<slug>-<title>/notes.md`

## Notes
- You must be logged into LeetCode in the same browser profile.
- Use `Test GitHub Connection` and `Test GitHub Push` in options for diagnostics.
- View service worker logs from `chrome://extensions` for troubleshooting.
