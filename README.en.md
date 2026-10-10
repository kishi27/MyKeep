# MyKeep

[日本語](README.md) | English

A simple personal notes web app for saving notes, URLs, and images from a PC or phone as an alternative to Google Keep.

MyKeep is an independent personal app and is not an official Google product. Its connection to Google Keep is limited to migration support for Google Takeout data.

## Screenshots

### Desktop

Five-column masonry-style layout on wide screens.

<img src="docs/screenshots/mykeep-desktop.png" alt="MyKeep on desktop" width="1400">

### Mobile

Two-column layout on phones.

<img src="docs/screenshots/mykeep-mobile.jpg" alt="MyKeep on mobile" width="420">

### Chrome extension

Save the current page to MyKeep. The screenshot shows the older UI; the extension now also supports editing titles and saving pinned notes.

<img src="docs/screenshots/mykeep-extension.png" alt="MyKeep Capture Chrome extension" width="360">

## Features

- **Notes**: Create, edit, and delete notes; save URLs; pin, archive, and color notes; create checklists and assign multiple labels; search titles, note text, and URLs.
- **Images and attachments**: View and delete multiple images. Add files with the file picker, Ctrl+V, or drag and drop. JPEG, PNG, WebP, GIF, and AVIF are supported up to 20 MB per file. Files are stored in R2, and list images load lazily. Choose a representative card image from saved attachments or link thumbnails. “Auto” keeps the existing behavior of preferring attached images. Imports also support attachments such as PDFs.
- **Note list**: A masonry-style layout built with CSS Grid and row spans based on card height. It does not use dense placement, so DOM and visual order remain left to right and top to bottom within each section. Wide desktop screens show five columns, narrower screens show four to three, and phones show two (one at widths of 300 px or less). Pinned and regular notes are separated. The header and desktop sidebar stay in view while scrolling. Sidebar counts show totals for each list and label, unaffected by the current search.
- **Filters**: Use the sidebar to switch among all notes, pinned notes, unpinned notes, unlabeled notes, notes without images, archived notes, and Trash. Search within the current list; the “×” in the search field clears only the search text.
- **Links**: Rich link previews can show a title, description, domain, and image. MyKeep falls back to a plain link when preview information cannot be fetched.
- **Bulk actions**: Select individual notes, select all, or clear the selection. Archive, return notes to the main list, move them to Trash, restore or permanently delete them, add or remove labels, and undo supported actions.
- **Trash**: Restore or permanently delete notes, see the time remaining before permanent deletion, empty all of Trash, and automatically delete notes after seven days.
- **Label management**: Create, rename, and delete multiple labels. A label page includes regular and archived notes.
- **Settings**: Configure rich link previews, whether note cards show titles and text, dark mode, and periodic refresh while MyKeep is visible.
- **Chrome extension**: Save the current page’s title, URL, note, labels, and image. Edit the title and pin the note before saving, fetch Open Graph / Twitter Card data, open saved notes in MyKeep, and repair thumbnails in bulk.
- **Migration and backup**: Import a Google Keep Takeout ZIP. Export JSON, Markdown, and attachments together in a ZIP.
- **PWA**: Open MyKeep from the home screen or as an app on iPhone, Android, and desktop. An internet connection is required.

## Architecture

| Role | Technology |
| --- | --- |
| Web UI | React + Vite + TypeScript |
| API, static file delivery, and Trash cleanup | Cloudflare Worker |
| Notes, labels, checklists, and attachment metadata | Cloudflare D1 |
| Image and attachment files | Private Cloudflare R2 bucket |
| Web access control | Cloudflare Access (email OTP) |
| Chrome extension | Manifest V3 |
| PWA | Web App Manifest + minimal Service Worker |
| ZIP reading and creation | Processed in the browser (zip.js) |

## Run locally

Install Node.js **22.12 or later** and npm, then run these commands from the project root. This is the minimum version required by the current Vite and Wrangler setup.

```sh
npm install
npm run db:local
npm run dev
```

Open the local URL shown in the terminal. ``npm run dev`` builds the app and serves the web UI and API on the same port through Wrangler. D1 and R2 run locally. Restart the process after changing code.

To try the Chrome extension locally, set ``CAPTURE_API_KEY=<your-generated-key>`` in the Git-ignored ``.dev.vars`` file. Set the extension’s API URL to the local URL followed by ``/api/capture``, for example ``http://127.0.0.1:8787/api/capture``.

## Fork this repository on GitHub

To use the public repository, **fork the official MyKeep repository to your own GitHub account, then connect your fork to Cloudflare Workers Builds**.

The setup is: official MyKeep repository → your GitHub fork → your Cloudflare Workers Builds project.

1. Click **Fork** on the official repository to copy it to your account.
2. Clone your fork locally, then follow [Run locally](#run-locally) and [Deploy to Cloudflare](#deploy-to-cloudflare) to configure your environment.
3. Set your own fork’s ``main`` branch as the source for automatic deployments. Do not use the official repository as the deployment source.

Updates to the official ``main`` branch are not copied to your fork automatically. You choose when to take them in, and changes you make to your fork remain yours (resolve conflicts if they arise). We recommend deploying from your own fork so changes by the author do not reach production without your decision.

Set up and manage D1, R2, Cloudflare Access, and ``CAPTURE_API_KEY`` in your own Cloudflare account. These resources are separate from the author’s environment; forking the repository does not give the author access to your notes, images, or API key.

## Deploy to Cloudflare

### Initial setup

1. Sign in to your Cloudflare account with ``npx wrangler login``.
2. Check whether D1 database ``mykeep`` and R2 bucket ``mykeep-images`` already exist. Reuse existing resources and create **only the ones that are missing**.

   ```sh
   npx wrangler d1 create mykeep
   npx wrangler r2 bucket create mykeep-images
   ```

3. Replace ``database_id`` in ``wrangler.jsonc`` with **your D1 database ID**. The D1 binding is ``DB`` and the R2 binding is ``IMAGES``. If you change either resource name, update its reference in the binding configuration as well. Do not enable public access for R2.
4. Apply all migrations to the production D1 database, then deploy the web app and Worker.

   ```sh
   npx wrangler d1 migrations apply mykeep --remote
   npm run deploy
   ```

5. Generate a secure random value of at least 32 bytes for the API key and add it as a Worker Secret. Enter the key when prompted.

   ```sh
   npx wrangler secret put CAPTURE_API_KEY
   ```

6. Protect the entire web host with Cloudflare Access. Allow only your own email address and use email OTP.
7. Create an Access application and Bypass policy for **only ``/api/capture``** on the same host. Keep the regular UI, other APIs, and attachment image URLs protected.

Before saving personal data, confirm that Access protects the site and that requests without an API key or with an incorrect key are rejected. See [Security](#security) for the roles of each authentication layer.

### Continuous deployment

The current setup is **push or merge to ``main`` on the connected GitHub repository → Cloudflare Workers Builds → automatic deployment**. For a fork, the trigger is **the ``main`` branch of your own fork**. Connect your fork in Cloudflare and set the build command to ``npm run build`` and the deploy command to ``npx wrangler deploy``.

``npm run deploy`` is for manual deployment and includes a build. **D1 migrations are not applied automatically by a push or by either deployment command.** When a new migration is added, run ``npx wrangler d1 migrations apply mykeep --remote`` again before deploying the code that depends on it.

The Trash cleanup Cron is ``0 18 * * *`` in ``wrangler.jsonc`` (18:00 UTC / 03:00 Japan time every day). Notes that have been in Trash for seven days are permanently deleted during the next cleanup run, after their R2 attachments are deleted.

## Update MyKeep

**Updates to the official repository do not update your fork automatically.** Choose which changes to bring into your fork.

1. Before updating, check the README changes, new files in ``migrations/``, changes to ``wrangler.jsonc``, Chrome extension version and changes, and conflicts with your own edits. Do not replace your D1 ID or R2 settings with the author’s values.
2. If there is a new migration, first bring the change into a local working branch. Before merging it into your fork’s ``main``, run ``npx wrangler d1 migrations apply mykeep --remote`` as described in [Continuous deployment](#continuous-deployment). Automatic deployment does not update D1.
3. On GitHub, use **Sync fork** to review differences and **Update branch** to apply them. Updating ``main`` starts an automatic deployment, so prepare any required migrations and configuration first. Review and resolve conflicts or changes that need discussion on a working branch or Pull Request before updating ``main``. See [GitHub’s official guide to syncing a fork](https://docs.github.com/ja/pull-requests/how-tos/work-with-forks/syncing-a-fork).
4. After updating **your fork’s ``main``**, check the Cloudflare Workers Builds result. If the Chrome extension changed, update your local ``extension/`` folder and reload it in Chrome.

The flow is: bring in changes from the official repository → review the changes and prepare any required migrations → update your fork’s ``main`` → let Cloudflare deploy to your account.

## Basic usage

- **Create**: Select “+ New note” in the header, enter a title, note text, URL, or other details, and save. The note editor starts with three lines of text and can be resized vertically.
- **Edit**: Open a card to edit it. Color, pin, and archive controls appear side by side. Long text is shortened in the list, but the saved data is not truncated. The display limits are three lines for note titles, two for note text, two for link titles, and three for link descriptions.
- **Images**: In the new-note or edit screen, add images with the file picker, Ctrl+V, or drag and drop. Remove pending images from their previews. For a new note, images upload one at a time after the note is saved.
- **View images**: Click or tap a saved image in the editor to open it larger. Saved link thumbnails appear after attachment images and can also be enlarged. Select “Open original” to use the browser’s standard image-saving options. Switch between multiple images with the previous and next buttons; the viewer shows the current position. On a PC, use the left and right arrow keys to move and Escape to close. On phones, swipe to move between images.
- **Pin and archive**: Use the buttons at the bottom of a card. After unpinning a note, select “Undo” within five seconds to restore the pin. Open archived notes from “Archive” in the sidebar.
- **Unpinned notes**: “Unpinned” in the sidebar shows regular notes without a pin. Archived notes and Trash are excluded, and you can search within this list.
- **Pinned and unlabeled notes**: “Pinned” shows only pinned regular notes. “Unlabeled” shows only regular notes without any labels. Both exclude archived notes and Trash, and both support search within the list.
- **Notes without images**: Shows regular notes with neither a saved thumbnail nor an attached image. Pinned and unpinned notes are both included, as are notes with only non-image attachments such as PDFs. Images from link previews fetched at display time do not affect this filter.
- **Trash**: Move a note from the editor or another supported action. Attachments are kept while the note is in Trash. Restore a note or permanently delete it from Trash; a restored note keeps its previous archive state. “Empty Trash” permanently deletes all notes, including those not yet loaded in the list. Permanent deletion cannot be undone.
- **Search**: Search titles, note text, and URLs for partial matches in D1 within the current view. Select the “×” at the right of the search field to clear only the search text while keeping the current list and label filters.
- **Home and refresh**: Select “MyKeep” to clear search and label filters and return to the notes list. Select “↻” to fetch notes and labels again.
- **Settings**: Open Settings, Import, or Export from the settings icon in the header. Rich link previews, card titles, and card text are on by default; dark mode is off by default. The web app’s language selector switches between Japanese and English immediately. Its default is Japanese; the choice is stored in ``localStorage`` under ``mykeep.language`` with the value ``ja`` or ``en``. This setting is separate from the Chrome extension’s language. Other settings are also stored in the browser’s ``localStorage``. Title and text visibility affect list cards only; they do not change saved data or search results. Hiding either one makes cards more compact while preserving the editing tap area.
- **Phones**: Tap “☰” or swipe right across the list to open the left drawer and switch views or labels. Swipe left across the drawer to close it. Pull down from the top of the list to refresh.

MyKeep loads notes 50 at a time and fetches more as you approach the end of the list. If an edited note moves to the top because of its updated timestamp, MyKeep preserves the area you were viewing and the number of pages already loaded. It does not make unnecessary scroll corrections when images load or card heights otherwise change.

Choose an automatic refresh interval of 10, 30, or 60 seconds in Settings; the default is 30 seconds. MyKeep checks for changes only while the page is visible, not in the background. It also checks when the page gains focus or becomes visible again, so notes saved from the Chrome extension appear automatically.

Rich links use saved preview information first and fill in missing information through the Worker. When the representative image is set to “Auto,” attached images are preferred. Sites that require login or block automated requests may not provide preview information; previews are not guaranteed for every site.

## Labels

- Select a label in the sidebar to see **regular and archived notes** with that label. Trash is excluded.
- In the editor, choose multiple labels from the dropdown and remove them with the “×” on a label chip. A name entered through “+ Create new label” is registered when the note is saved.
- Select “Organize labels” at the bottom of the sidebar to create labels, rename them, or delete several at once, including unused labels. You can also create a label from the bulk label screen.
- Select the pencil button on a label row to rename it. The label keeps its links to all notes, and an open label page follows the new name. Renaming is rejected if another label already has the destination name; labels are not merged.
- Deletion requires confirmation. It removes the label from all notes but does not delete the notes, images, or checklists.

Names are checked for duplicates after trimming surrounding spaces and applying Unicode NFC normalization and a case-insensitive key. Label names must be 1–100 characters. A note can have up to 50 labels and 500 checklist items.

## Multi-select

1. Select the checkbox icon (“☑”) in the header to enter selection mode.
2. Select or clear individual notes by clicking their cards. You can also select all or clear the selection.
3. Use the bulk action bar to archive notes, return them to the main list, move them to Trash, or add labels. On a label page, you can remove that label. In Trash, you can restore or permanently delete notes.
4. After an action, select “Undo” in the snackbar within about five seconds when Undo is available. Permanent deletion cannot be undone.

**Select all applies only to cards currently loaded on screen, not every note in the database.** Bulk action success and failure counts disappear after about 10 seconds. Regular screen errors do not disappear automatically.

## Chrome extension

**MyKeep Capture v0.3.4** supports Chrome Manifest V3 and Chrome 120 or later.

### Install and configure

1. Open ``chrome://extensions`` in Chrome and enable Developer mode.
2. Select “Load unpacked” and choose the entire ``extension/`` folder in the repository.
3. In MyKeep Capture, open “Details” → “Extension options,” enter the following, and select “Save settings.”
   - API URL: ``https://<your-worker>/api/capture``
   - API key: the value registered as a Worker Secret
   - Language: Japanese or English. The default is Japanese. The extension stores this choice independently as ``chrome.storage.local.language`` with the value ``ja`` or ``en``; it does not sync with the web app’s ``mykeep.language`` setting.
4. Allow the extension to connect to your MyKeep host. When you update the extension files, open ``chrome://extensions`` and reload the extension in Chrome on each PC or Mac where you use it.

The API URL and API key are stored in ``chrome.storage.local``. HTTPS is required; HTTP is allowed for local development on ``localhost`` or ``127.0.0.1``.

### Save the current page

Select the toolbar icon to fetch the current page’s title and URL. You can freely edit the title before saving (up to 300 characters); if a URL is present, it can be saved with an empty title. A title you have entered is not overwritten by a later fetch.

Add an optional note, registered labels (multiple, up to 50), and one image. Turn on “Pin” beside the label selector to save the note already pinned. It is off when the popup opens. Add an image with Ctrl+V or the file picker; supported formats and the 20 MB limit are the same as in the web app.

Normal saves use ``activeTab`` to fetch the current page’s Open Graph / Twitter Card title, description, image, and domain. If fetching fails, the extension can still save the title and URL. You cannot create a new label from the popup.

After saving, “Open in MyKeep” opens the note in a new tab. You must sign in to Cloudflare Access for the web app.

## Share from iPhone Safari

Use an iOS shortcut to save a Safari page’s title and URL.

1. Create a shortcut, enable “Show in Share Sheet,” and accept Safari web pages or URLs.
2. Use “Get URLs from Input” with the Shortcut Input to extract the shared URL. Use the shared page’s name as the title, or enter a title with “Ask for Input.”
3. Add “Get Contents of URL,” set the destination to `https://<your-worker>/api/capture`, and choose **POST**.
4. Add the `Authorization` header with `Bearer <CAPTURE_API_KEY>`. Include a space after `Bearer` and use the same key as the Worker Secret.
5. Choose **Form** as the request body. Add text fields named `title` (up to 300 characters) and `url` (the shared http / https URL, up to 2000 characters). The `title` field is required but may be empty. Add “Show Result” to see the response.

Run the shortcut from Safari’s Share menu and allow it to connect to your MyKeep host on first use. Let Shortcuts set Content-Type. The API accepts both `application/x-www-form-urlencoded` and `multipart/form-data`, not JSON. Images still require multipart.

Use the existing Access Bypass for `/api/capture` only. Keep shortcuts containing your API key private: the key grants access to the capture API independently of the web app’s Access login.

## Google Keep Import

1. Download a Google Keep ZIP through Google Takeout.
2. In MyKeep, open “Settings” → “Import” and select the ZIP.
3. Review progress for notes and attachments, along with success, failure, and skipped counts. “Import as Trash” is included in the number of successfully imported notes.

The ZIP and Keep JSON are **parsed in the browser**; the entire ZIP is not sent to the Worker. Notes and attachments are sent one at a time, so one failed item does not stop the full import.

Imported data:

- Titles, note text, pin and archive states, and creation and update times.
- Item text, checked states, and order from ``listContent``, plus labels from ``labels[].name``.
- Files matched to ``attachments[].filePath`` in the ZIP and saved to R2, including images and other attachments. Filenames with Japanese characters or spaces are supported. Non-image attachments can be downloaded.
- HTTP(S) URLs and ``preview_title``, ``preview_description``, and ``preview_hostname`` restored from ``annotations`` with ``source: "WEBLINK"``. If the full note text is a URL, it can be used. When annotations are present, MyKeep prefers an entry matching the URL in the note; otherwise it uses the first valid entry.
- Notes where ``isTrashed: true`` are imported into Trash with ``deleted_at`` set to the import time. They become eligible for automatic permanent deletion after seven days.

Import does not fetch external pages and sets ``preview_image`` to empty. Takeout data alone may not include thumbnails. After migration, run [Thumbnail Repair](#thumbnail-repair) from the Chrome extension’s options. A rich link shown in the web list does not always save its fetched image URL as the note’s thumbnail.

Missing, empty, or oversized attachments over 20 MB are skipped individually while the note is kept. Invalid checklist items and labels are skipped. Notes that exceed limits such as a 300-character title, 100,000-character note, 500 checklist items, or 50 labels fail to import. There is no duplicate detection or re-import tracking, so running Import again creates duplicate notes. Google Keep compatibility is not complete.

## Thumbnail Repair

This tool targets notes with ``deleted_at IS NULL``, an empty ``preview_image``, and an HTTP(S) URL. It includes regular and archived notes and excludes Trash.

The Chrome extension opens each URL **one at a time in a background tab**, reads ``og:image``, ``twitter:image``, and related metadata, and saves it to MyKeep. It fills in the image URL and any missing preview information without changing existing information, note text, or the note’s update time. It does not copy the image itself to R2.

### Steps

Open ``chrome://extensions`` → MyKeep Capture → “Details” → “Extension options” → “Thumbnail repair.”

<img src="docs/screenshots/mykeep-thumbnail-repair.png" alt="Thumbnail repair in MyKeep Capture options, where you can check the missing count before starting" width="540">

1. Enter the API URL and API key, select “Save settings,” and select “Check missing count.” If they are already configured, start by checking the count.
2. Select “Start thumbnail repair” and allow additional access to the target sites. **Unlike ``activeTab`` for normal saves, starting, resuming, or retrying repair asks for permission to access HTTP(S) sites.**
3. Review the number of processed notes and successes and failures. Processing continues after you close the options page.
4. Select “Pause” if needed, then “Resume” to continue. If you quit Chrome, resume manually after restarting it.
5. When the run finishes, select “Retry failed” if needed. Access denials, timeouts, and pages without images remain failures; processing continues for other notes.
6. Select “Clear results” when you no longer need the history. You cannot clear while processing. If paused, select “Cancel” before clearing.

After repair, select “↻” in MyKeep to refresh the list and check the thumbnails. Repair does not update note timestamps, so the lightweight automatic refresh may not detect the changes. Login requirements and site restrictions can prevent an image from being fetched, even on retry.

The extension processes one tab at a time instead of opening many tabs. It is designed for 1,000 or more notes, using 50-note cursor pages and saving progress in ``chrome.storage.local`` so work can resume. Progress is stored locally in the Chrome profile and is not synced to Google servers.

“Clear results” resets only repair progress and failure history, and changes the missing-count state back to “Not checked.” It does not remove API settings or data already saved to MyKeep. Check the count again before the next run. Sites where an image cannot be fetched remain in the missing set after results are cleared.

## Backup / Export

Open “Settings” → “Export” to download all data, including regular notes, archived notes, and Trash, as ``mykeep-backup-YYYY-MM-DD.zip``, generated **in the browser**. Notes are fetched 50 at a time and attachments one at a time; the Worker does not create a large ZIP.

```text
mykeep-backup-YYYY-MM-DD.zip
├─ notes.json
├─ markdown/
│  ├─ note-000001.md
│  └─ ...
└─ attachments/
   └─ uniquely named files with IDs
```

``notes.json`` contains the format name, version, export time, and an array of notes. Each note includes its ID, title, text, URL, color, pin, archive, and Trash state and dates; creation and update times; checklist state and order; labels; attachment details; and Markdown path. It also includes saved ``preview_title``, ``preview_description``, ``preview_image``, and ``preview_hostname``, plus the selected representative image in ``card_image``.

Markdown files store note text, URL, dates, state, checklist, labels, and attachment paths in a human-readable format. Images, PDFs, and other R2 files go in ``attachments/``. Images are not embedded as Base64 in JSON. **External preview images are included as URL information only; their image files are not in the ZIP.**

If an attachment cannot be fetched, Export continues when possible and sets that attachment’s ``zip_path`` to ``null``. At the end, it shows the number of notes and successful and failed attachments. Browsers with direct file access write items to the selected file in sequence. Other browsers download the completed ZIP as an in-memory Blob. Large backups require enough free memory on the device.

Do not change data from another tab or device while Export is running. Unused labels that are not assigned to notes are not exported. This ZIP cannot be imported back into MyKeep as a restore, and re-importing it into Google Keep is not guaranteed.

## PWA

Open the deployed HTTPS URL and sign in through Cloudflare Access before adding MyKeep to your device.

- **iPhone**: In Safari, select “Add to Home Screen” from the Share menu. Enable “Open as Web App” if it is offered.
- **Android**: In Chrome, select Install or Add to Home Screen from the menu.
- **Desktop**: Use the install control in the address bar or browser menu when available. MyKeep also works as a regular website.

The manifest requests ``standalone`` display. The Service Worker uses a minimal setup that loads page navigation from the network; it does not cache note data or images for offline use. An internet connection is required.

## Security

- **Web app**: Protect the entire host with Cloudflare Access, including normal APIs and attachment image URLs. Access must be configured in Cloudflare; the regular API does not have its own login flow.
- **Extension API**: Limit the Access Bypass policy to ``/api/capture``. Saving, fetching labels, and thumbnail repair on this route all require ``Authorization: Bearer <CAPTURE_API_KEY>``. A missing key configuration returns 503; a missing or invalid key returns 401. Do not bypass Access for all of ``/api/*``.
- **API key**: Use a random value of at least 32 bytes and store it as a Worker Secret. Do not put its value in code, ``wrangler.jsonc``, D1, or this README, and do not commit it to Git.
- **Local configuration**: ``.env*`` and ``.dev.vars*`` are Git-ignored. The extension’s API key is stored in ``chrome.storage.local`` in the Chrome profile.
- **R2**: Keep the bucket private. Attachments are served through the Worker protected by Access. Rich link images from external sites are loaded from those sites’ URLs.

## Issues / Pull Requests

Issues in the official GitHub repository are welcome for bug reports, setup problems, improvement suggestions, and feature requests. Pull Requests for bug fixes, README updates, and improvements are also welcome. Include reproduction steps and your environment where relevant; do not include API keys, Secrets, or personal data.

MyKeep is a personal project. Issues and Pull Requests are welcome, but a response, fix, acceptance, merge, or schedule is not guaranteed.

### Contributing policy

- Pull Requests are not merged automatically into the official ``main`` branch. They may be reviewed, merged, sent back for changes, put on hold, or closed.
- Discuss major changes to the database schema, authentication, Cloudflare setup, or UI, as well as large features, in an Issue before implementing them.
- The official ``main`` branch may change after you open a Pull Request, causing conflicts in the same files. You may be asked to bring the latest official ``main`` into your branch and resolve the conflicts.

## Directory structure

```text
src/              React UI, Import / Export, link previews
worker/           Worker API, preview fetching, Cron-based Trash cleanup
extension/        MyKeep Capture (popup, options, background)
public/           PWA manifest, icons, Service Worker
migrations/       All D1 migrations
wrangler.jsonc    Worker, D1, R2, and Cron configuration
package.json      Development, build, and deployment commands
```
