# VBrowse (VibeBrowse)

A video, photo and text social network. People sign up, post, scroll, like or dislike, comment and follow each other. It starts completely empty: everything on it comes from real users. Nudity and sexual content are blocked automatically.

There are two ways to run it:

| | **Hosted on Claude** (`hosted/`) | **Your own server** (`server.js`) |
|---|---|---|
| Where it runs | claude.ai, as an Artifact page. No server needed | Any Node 22.5+ host |
| Sign-in | Claude accounts | Username and password |
| Who can post | The owner, plus people the owner shares it with who are allowed to edit or contribute | Anyone who signs up |
| Upload size | 20 MB per file | 200 MB per file |
| Safety scan | In the uploader's browser | On the server |

## Features

- **Accounts like YouTube's:** sign up with name, email, @handle and password, and sign in with email or @handle.
  - **Handles:** 3–30 characters, letters, numbers and single `. _ -` between them. No `...` or `___`, no leading or trailing symbols, at least one letter, and reserved names are blocked. The sign-up and settings forms check availability as you type.
  - **Passwords:** 8+ characters mixing letters and numbers or symbols, and they can't contain your handle.
  - **Sessions:** expire after 30 days, and changing your password signs out your other devices.
- **Channel page:** banner, picture, name, @handle, description, followers and following.
- **Settings:**
  - *Channel:* banner, picture, name, handle, description.
  - *Account:* change email or password, or delete the account and everything it posted.
  - *Appearance:* device theme, light or dark, and whether Scroll plays sound.
- **Light and dark mode:** follows the device by default, with a quick toggle in the top bar.
- **Posting:** videos, photos and text posts with a caption, category, tags and hashtags. People can edit or delete their own posts.
- **Home grid** (like YouTube): infinite scroll; videos preview on hover.
- **Scroll view** (like TikTok or Reels): full-screen vertical swipe, autoplay, tap to pause, double-tap to like, mute, and a Follow pill on the creator's picture.
- **Filters:** sort by Trending, Latest, Top rated, Most viewed, Most discussed or Oldest. Filter by type and category. Search, `#hashtag` pages, a Following feed and Saved posts.
- **Reactions:** like and dislike, one vote per person, which can be switched or removed, plus a like/dislike ratio bar.
- **Comments:** threaded replies, comment likes, Top/Newest sort, `@mentions` and `#tags`.

## Moderation (no NSFW)

- **Automatic nudity detection** on every photo and video ([nsfwjs](https://github.com/infinitered/nsfwjs) running locally, with no outside service). Videos are checked at 8 frames. Clear nudity or sexual content is **rejected**. Borderline content is **held for review**, so only its creator can see it until a moderator approves it. If the scanner is unavailable, uploads are held rather than published.
- **Word filter** on captions, tags, comments, usernames, names and bios. It covers explicit terms and slurs, catches l33t spellings and spaced-out letters like `p o r n`, and avoids false hits like "grapes" or "cocktail". The list is in `public/textfilter.js`.
- **Reports:** anyone can report a post or comment (nudity, violence, hate, harassment, spam or other). A post is hidden after 3 reports, or after 2 nudity reports.
- **Moderation page** (in the account menu): approve or remove posts, keep or remove comments, and ban accounts. On your own server, the **first account created** is the moderator; add more with `ADMIN_USERNAMES=alice,bob`. On the hosted version, the Artifact's owner is the moderator.
- Profile photos must pass the scan too.

Automatic detection is good but not perfect, which is why reports and the review queue exist.

## Put it online (Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sayovc/vbrowse)

1. Tap the button and sign in to Render with GitHub. Let Render access the `vbrowse` repository.
2. When asked for `ADMIN_USERNAMES`, type the @handle you will sign up with (without the @). That account becomes the moderator.
3. Add a payment method and apply. The `render.yaml` blueprint uses the Starter plan plus a 10 GB disk, so videos, photos and the database survive restarts (roughly $7 + $2.50 a month).
4. After about 5–10 minutes the site is live at `https://vbrowse-….onrender.com`. Sign up with the handle from step 2 first.

Every push to `main` redeploys automatically. Under Settings → Custom Domains you can add your own domain.

The image is built from the `Dockerfile` (Node 22 + ffmpeg). Any host that runs Docker with a persistent volume mounted at `/data` works the same way.

## Run on your own server

```bash
npm install
npm start
```

Then open http://localhost:3000. The first account you create becomes the moderator.

| Env var | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `DB_PATH` | `./vbrowse.db` | SQLite database |
| `UPLOAD_DIR` | `./uploads` | uploaded media |
| `ADMIN_USERNAMES` | | extra moderators (comma separated) |
| `REPORT_THRESHOLD` | `3` | reports that hide a post |
| `NSFW_REJECT` / `NSFW_REVIEW` / `NSFW_REVIEW_SEXY` | `0.5` / `0.2` / `0.7` | detector thresholds |

Needs `ffmpeg`/`ffprobe` installed for video scanning; without them, videos are held for review. The Docker image includes them.

## Hosted build

`node hosted/build.js` bundles `public/` and `hosted/backend.js` into `hosted/dist/vbrowse.html`, a single page that runs on Claude's Artifact runtime. It uses Claude's shared database, file storage and user identity in place of the Node server. Each person can only write their own data, and only the owner can moderate.

## Project layout

```
server.js          Express API (auth, posts, reactions, comments, follows, reports, moderation)
db.js              SQLite schema (Node's built-in node:sqlite)
moderation.js      NSFW image/video scanner (nsfwjs + TensorFlow.js WASM + ffmpeg)
public/            Shared frontend: index.html, app.js, styles.css, textfilter.js
hosted/backend.js  Browser-side backend for the Claude-hosted build
hosted/build.js    Bundles the hosted page
```
