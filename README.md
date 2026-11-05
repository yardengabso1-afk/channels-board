# Yarden Channels Board

A private tool for one owner's own YouTube channels. Read-only, through YouTube API Services.

An hourly job reads the channels, encrypts the result with AES-256-GCM and deploys it to GitHub Pages. The key is not in this repository: the job has it as a secret, and the page gets it from the owner's private link, after the `#`, which browsers don't send to any server.

- Home page: https://yardengabso1-afk.github.io/channels-board/
- Privacy policy: https://yardengabso1-afk.github.io/channels-board/privacy.html

The run logs of this repository are public, so the job prints only counts. Files here are copied from a private project, so a change made here directly will be overwritten.
