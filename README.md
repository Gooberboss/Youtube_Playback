# My Video Library PWA

A cross-platform Progressive Web App starter for iPhone Safari and Windows browsers.

## Features
- Save YouTube URLs as bookmarks (streaming requires internet).
- Import video files into IndexedDB for offline playback.
- Local search, remove items, storage estimate.
- Offline app shell via service worker.
- Installable PWA on supported browsers.

## Run locally
Service workers and PWA installation require HTTPS or localhost.

1. Unzip this folder.
2. Open a terminal in this folder.
3. Run a local server, for example:
   - Python: `python -m http.server 8000`
4. Visit `http://localhost:8000` on the same computer.

For installation and use across devices, deploy the folder to an HTTPS host (for example, a static site host). The app does not include a server or account system.

## iPhone
1. Open the deployed HTTPS address in Safari.
2. Tap Share → Add to Home Screen.
3. Launch from the Home Screen.
4. Use Add videos → Choose video file to import a video from Files.
5. Open Storage to see the browser's approximate storage usage.

iOS storage behavior and supported video formats vary by device and iOS version. Keep separate backups of important media. A video stored on the iPhone is not automatically copied to Windows.

## Windows
Open the HTTPS site in Edge or Chrome. Use the install icon/menu → Install app. Imported files are stored in that browser profile on that PC.

## Important
This app does not download or extract YouTube streams. YouTube links are bookmarks and require an internet connection to play. Use YouTube's own authorized offline feature where available, or import video files you own or are authorized to download and store.

## Notes
- IndexedDB data is scoped to the browser and device. There is no cross-device sync in this starter.
- Browser quota and eviction policies vary. The app requests persistent storage when supported, but the browser may decline.
- Very large files may fail to import if the browser/device lacks available storage.


## YouTube embed Error 153
The app sets `strict-origin-when-cross-origin` as the document referrer policy and on YouTube iframe embeds. YouTube requires an HTTP Referer or equivalent client identity for embedded playback. Deploy the PWA on a real HTTPS origin and open the app from that website; opening `index.html` directly as a `file://` page, or using a preview/sandbox that suppresses referrers, can still cause Error 153. If an individual video disallows embedding, use its Open on YouTube fallback.


## Record from My Library
Open an item in My Library and use **Record this video**. Imported video files are captured directly from the player, including audio when the browser exposes its audio track. YouTube items use browser tab capture: select the current app tab in the browser sharing picker and enable tab audio. Tab recordings can include the player controls and surrounding app UI. Recordings are saved as new offline video files in this browser's library. This feature requires a desktop browser with MediaRecorder; browser support varies.
