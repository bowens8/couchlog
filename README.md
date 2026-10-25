# Couchlog

A private Letterboxd-style log for movies and TV, just for you and your friends. Vanilla JS + Firebase (Auth + Firestore) + GitHub Pages. No ads, no build step.

## Features
- Log movies and TV shows: rating (half stars), date, review, season note for TV
- Watchlist
- Friends' activity feed (filter by movies / TV)
- Title pages with everyone's ratings and the group average
- Profiles with diary, watchlist and stats
- Google sign-in, locked to an email allowlist

## Setup

1. **TMDB key**: make a free account at themoviedb.org, then Settings > API > copy the v3 API key.
2. **Firebase**: create a project (or reuse one), then:
   - Add a Web app and copy its config.
   - Authentication > Sign-in method > enable **Google**.
   - Authentication > Settings > Authorized domains > add `<your-github-username>.github.io`.
   - Firestore Database > create (production mode), then **Rules** tab > paste `firestore.rules` > Publish.
3. **Guest list**: in Firestore, create collection `allowed`. For each person (you included), add a document whose **ID is their Gmail address in lowercase** (e.g. `ben@gmail.com`). The doc needs at least one field (e.g. `ok: true`). Anyone not listed can sign in but sees nothing.
4. **Config**: paste the Firebase config and TMDB key into `config.js`.
5. **Deploy**: push to a GitHub repo, then Settings > Pages > deploy from `main` / root.

To add a friend later, just add another doc to `allowed`.

## Notes
- The Firebase web config and TMDB key are visible in the page source. That's normal for Firebase, since the Firestore rules are what protect your data. If you want to be tidy, restrict the TMDB key by referrer in its settings.
- Movie/TV data and posters are from TMDB; their terms ask for attribution ("This product uses the TMDB API but is not endorsed or certified by TMDB").
