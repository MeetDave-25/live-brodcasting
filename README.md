# RANGVAASA 2026 · Live coverage

Your own live-coverage app for the garba night: several phones film different angles,
everyone watches in a calm, mobile-first app, and the organisers run it all from a control room.
No YouTube or third-party platform is involved.

```
Camera phones (/studio)            Your server                         Viewers (/)
 01 Main stage  ─┐                                                   ┌─ phone
 02 The circle  ─┼─ WebRTC ─►  MediaMTX ─ records every angle ─ HLS ─┼─ phone   × 500+
 03 Dhol        ─┘             + serve.js + Caddy (HTTPS)            └─ laptop
                                     ▲
                         Control room (/admin)
```

## What's inside

**Viewers** (`https://your-domain/`)
- Countdown before the event, then the video starts on its own
- Up to 6 camera angles, switched with one tap; follows the control room's "main angle" by default
- Sound toggle, full screen (rotates to landscape), picture-in-picture
- Notes from the organisers, tonight's programme with "Now" marked, event details
- Installs to the home screen like an app; Lenis smooth scrolling; light and dark mode
- Recovers by itself from network drops and frozen video

**Cameras** (`/studio`): works like the phone's camera app
- Pick the angle and quality once; tap the red button to go live
- Live timer, upload stats with a "weak signal" warning, flip camera, mute mic
- Reconnects automatically if the signal drops; keeps the screen awake
- Garba music isn't muffled (voice-call filters are off)

**Control room** (`/admin`)
- Muted live preview of every angle, with bitrate and viewers per angle
- Choose the main angle, end a phone's stream, post announcements to all viewers
- **Recordings:** every angle is recorded automatically; download any session as MP4
- Viewer link, camera link, and a QR code PNG ready for posters

## Files you edit

| File | What |
|---|---|
| `.env` | Domain and the two passwords (copy from `.env.example`) |
| `public/config.js` | Event name, start time, camera angle names, programme, details |

---

## Try it on this PC

1. Double-click `start-local.bat`
2. Camera: http://localhost:8080/studio (password `garba2026` until you create `.env`)
3. Watch: http://localhost:8080 · Control room: http://localhost:8080/admin (password `admin123`)

Phones can't use their camera over plain `http://`, so test phones against the real server.

## About Vercel / Netlify

This repo includes a `vercel.json`, so the pages (`/`, `/studio`, `/admin`) open on Vercel. But Vercel only
serves static files: it **can't run the live server** (camera uploads, video, admin login, recordings).
On Vercel the camera and control-room pages say "The live server isn't connected".
For the real event, run everything on a VPS as described below.

## Put it on your domain

Your domain stays where it is. You only add a **subdomain** pointing to a small server.
The video engine can't run on shared web hosting (Hostinger/GoDaddy/cPanel plans); it needs a VPS.

**Domain on Hostinger?** Keep it there. Your current website isn't touched; only a new `live.` subdomain is added.

**1. Get a VPS.** Hostinger VPS (KVM 2) keeps everything in one account. Check its "network speed": at
~300 Mbps it carries about 300 viewers at Standard quality. For a full 500, a DigitalOcean Bangalore droplet
(1 Gbps+, billed hourly) is the safer pick. Any provider works if it has: Ubuntu 24.04, in the Mumbai or Bangalore region, with 2+ vCPU and a 1 Gbps network.
DigitalOcean, Vultr, Linode, AWS Lightsail and Hostinger VPS all work. Hourly-billed providers let
you create it a few days before and delete it after you've downloaded the recordings.

**2. Point a subdomain at it.** On Hostinger: hPanel → **Domains** → your domain → **DNS / Nameservers**
→ **Add record**, then add:

| Type | Name | Value |
|---|---|---|
| A | `live` | your VPS IP address |

That gives you `live.yourdomain.com`.

**3. Fill in `.env`** on your PC:
```
copy .env.example .env
```
Set `DOMAIN=live.yourdomain.com` and two strong passwords.

**4. Upload and install** (Git Bash, from this folder):
```bash
bash deploy/upload.sh root@YOUR_VPS_IP
```
It packs the app, uploads it, and installs everything: HTTPS certificate, streaming engine, app
server, firewall, auto-start on reboot. It prints your links when it's done.

**Updating later:** edit files, then run the same command again. Your recordings, settings and
announcements are kept.

If your provider has a separate cloud firewall (AWS, Oracle, Azure), open **TCP 80, 443, 8189** and **UDP 8189** there too.

## Bandwidth for 500 viewers

| Camera quality | Server upload at 500 viewers | Data for 3 hours |
|---|---|---|
| Standard 480p (default) | ~450 Mbps | ~0.6 TB |
| HD 720p | ~850 Mbps | ~1.2 TB |

Each viewer watches one angle at a time, so more angles don't multiply the load.
Recordings take about **0.4 GB per angle per hour** at Standard. Make sure the server disk has room.

## On the night

- **Each camera phone needs a steady upload:** 1.5+ Mbps for Standard, 3+ for HD. A crowded ground jams
  mobile data, so use venue Wi-Fi or SIMs on different networks. Speed-test at the exact spot.
- If the studio shows **weak signal**, switch that phone to Saver.
- Phones on power banks and tripods, held sideways, **Do Not Disturb** on.
- Use Chrome on Android, Safari on iPhone.
- **Rehearse the day before at the venue**, with friends watching on different phones, including an iPhone.
- After the event, download the recordings from the control room **before** deleting the server.
