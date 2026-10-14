# App Store — what to enter in App Store Connect

Keep in step with `ios/App/App/PrivacyInfo.xcprivacy` (privacy manifest) and `src/legal/content.ts` (privacy policy).
If the app starts collecting something new, all three change together.

## App Privacy ("nutrition labels")
Tracking: **No** (no ads, no analytics SDK, no data broker, no tracking domains).

| Data type (Apple's name) | Collected | Linked to the user | Used for tracking | Purpose | Why / retention |
|---|---|---|---|---|---|
| Precise Location | Yes | Yes | No | App Functionality | Only when sharing is on; latest position only, deleted when sharing stops or after 1 h; road reports (deleted 1 day after expiry; cameras live 30 days); parking spots you mark (deleted 1 h after expiry); route start / destination → routing provider |
| Audio Data | Yes | Yes | No | App Functionality | Push-to-talk voices, kept 24 h |
| Email Address | Yes | Yes | No | App Functionality | Sign-in |
| Name | Yes | Yes | No | App Functionality | Profile name, username |
| Photos or Videos | Yes | Yes | No | App Functionality | Profile photo (re-encoded, no EXIF; old ones removed) |
| Other User Content | Yes | Yes | No | App Functionality | Bio, road reports, abuse reports |
| User ID | Yes | Yes | No | App Functionality | Account id |
| Search History | Yes | **No** | No | App Functionality | Destination search text → routing provider; cached ≤ 1 day without identity |

Not collected: contacts, health, financial, browsing history, device ID, crash / performance data, advertising data.

## Age rating
Answer the questionnaire so the result is **18+**: user-generated content / unrestricted communication with strangers
(voice), location shared with strangers. In-app the sign-up asks for an 18+ declaration (D9).

## URLs
- Privacy policy URL: `https://<your domain>/privacy` (public page in the app; fill in the legal entity first).
- Terms (EULA): `https://<your domain>/terms` — or Apple's standard EULA plus a link in the description.
- Support URL: a page or mailbox you answer (Apple checks it is reachable).

## Notes for App Review (paste into "App Review Information → Notes")
> **What the app is:** a social navigation app — a map with friends and people nearby (opt-in), turn-by-turn navigation
> with Greek voice guidance, push-to-talk voice with friends and with people within 200 m, Waze-style road reports.
>
> **Demo accounts** (two, so you can talk between them; both 18+ and following each other):
> reviewer-a@… / password …, reviewer-b@… / password … — *(create them on the production project before submitting)*.
> Sign in on two devices (or one device + simulator), Map → Profile → "Location" → "Friends and people nearby".
> Walkie tab → the other account → hold the big button and talk.
>
> **Background modes:** *location* — turn-by-turn navigation keeps guiding with the screen locked, and people who chose to
> share keep their latest position fresh for the friends they chose (iOS shows the blue location indicator); *audio* —
> spoken navigation guidance and incoming push-to-talk voices while the screen is locked. The app does not run in the
> background for any other purpose; the optional "listen with the screen off" switch is off by default.
>
> **User-generated content (Guideline 1.2):** every person card and talk screen has Report and Block; road reports have
> "Report abuse"; reports go to a moderation queue the team reviews within 24 hours (hear the reported voice while it is
> kept, remove a road report, suspend an account). Blocking hides both users from each other everywhere at once.
>
> **Driving safety:** a one-time safety notice before the first push-to-talk; while moving faster than 18 km/h the talk
> screens show only one large button and destination search is disabled; reporting is one tap on large tiles.
>
> **Account deletion:** Profile → "Delete account" (also on the suspension and age screens).
>
> **Location while not navigating** is shared only if the user turns it on; one tap ("Ghost") deletes it from the server.

## Checks before each submission
- `npm run deploy` (bundle guard: no service / routing key in the bundle, first load ≤ 300 KB gzipped).
- The demo accounts work on production; reviewer can reach both.
- Screenshots: map with people, navigation, talk screen, road report — no real people's data.
