# DriveFX Motor Sounds

Futuristic web dashboard that revs a virtual engine from your real driving speed (browser GPS).

- Speed from `navigator.geolocation` (GPS needs HTTPS or localhost)
- 10 cars with photos; engine sounds come from a per-sample engine model (`engine-worklet.js`: firing order, exhaust pulses, pipe resonances). Open with `?engine=classic` for the older recordings-based sound
- Test drive mode, auto "Simulate drive", gas/brake pedals

Run locally: `python -m http.server 5173` and open http://localhost:5173
