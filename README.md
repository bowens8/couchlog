# Couchlog

A private Letterboxd-style log for movies and TV, just for you and your friends. Vanilla JS + Firebase (Auth + Firestore) + GitHub Pages. No ads, no build step.

## Features
- **Log** movies and TV: half-star rating, review, season note for TV, and an optional watch date (tick "No date" to skip it)
- **Browse**: endless-scroll lists (trending, popular, top rated, in theaters, airing now, and "Friends' picks") with one-tap **✓ Seen** and **＋ List** buttons on every poster
- **Reviews**: a page with every written review from the group, plus a "Write a review" button
- **Import from Letterboxd**: upload your Letterboxd export zip (ratings, diary, reviews, watched, watchlist)
- Watchlist, friends' activity feed, title pages with the group average, profiles with diary and stats
- Google sign-in, locked to an email allowlist

## Setup

1. **TMDB key**: free account at themoviedb.org, then Settings > API > copy the v3 **API Key**.
2. **Firebase**: create a project, then:
   - Add a Web app and copy its config.
   - Authentication > Sign-in method > enable **Google**.
   - Authentication > Settings > Authorized domains > add `<your-github-username>.github.io`.
   - Firestore Database > create (production mode), then **Rules** tab > paste `firestore.rules` > Publish.
3. **Guest list**: in Firestore, create collection `allowed`. For each person (you included), add a document whose **ID is their Gmail address in lowercase** (e.g. `ben@gmail.com`) with one field such as `ok: true`.
4. **Config**: paste the Firebase config and TMDB key into `config.js`.
5. **Deploy**: push to a public GitHub repo, then Settings > Pages > deploy from `main` / root.

To add a friend later, add another doc to `allowed`.

## Importing from Letterboxd
1. On letterboxd.com: Settings > Data > **Export your data**, and download the zip.
2. In Couchlog: Me > **Import from Letterboxd**, choose the zip, and click Import.
3. Films are matched to TMDB by title and year. Anything that can't be matched is listed at the end.
4. Imported entries are back-dated, so they land in your diary instead of flooding the friends' feed.
5. Untick "Keep watched dates" if you'd rather import everything without dates. Letterboxd exports films only, so no TV comes over.

## Notes
- The Firebase web config and TMDB key are visible in the page source. That's normal for Firebase, since the Firestore rules are what protect your data.
- Never put the TMDB "Read Access Token" in the project. Only the v3 API Key is needed.
- Movie/TV data and posters are from TMDB; their terms ask for attribution ("This product uses the TMDB API but is not endorsed or certified by TMDB").
