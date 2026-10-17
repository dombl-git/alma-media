# alma-media

ALMA's clips for Paper Edit, published at https://dombl-git.github.io/alma-media/.

**To add a clip:** export it as an H.264 MP4 (suggested: 1280×720, 24 fps, about 3 Mbps, no audio), put it at the top of this folder, then Commit and Push in GitHub Desktop. A few minutes later it's in Paper Edit's Media panel, ready to drag onto a shot.

- Each file under 100 MB; the whole site under 1 GB (the Media panel shows how full it is).
- A new version of a clip gets a new name (`042_v2.mp4`), so earlier cuts keep playing the clip they used.
- On every push, the Action (`.github/workflows/publish.yml`) checks each clip, makes its thumbnails and `manifest.json`, and publishes the site. If a clip can't be used, the run fails and says which clip and why (see the Actions tab); the site stays as it was until it's fixed.
- Nothing here is private: anyone with the address can watch the clips.
