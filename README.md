# DriveFX Motor Sounds

Futuristic web dashboard that revs a virtual engine from your real driving speed (browser GPS).

- Speed from `navigator.geolocation` (GPS needs HTTPS or localhost)
- 23 real cars; engine sounds come from a per-sample engine model (`engine-worklet.js`: firing order, exhaust pulses, pipe resonances), no recordings
- Car photos live in `img/<car id>.jpg` (1280×720); a car without a photo shows a drawn silhouette
- Test drive mode, auto "Simulate drive", gas/brake pedals

Run locally: `python -m http.server 5173` and open http://localhost:5173
