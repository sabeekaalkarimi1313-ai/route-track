# Route Lab

A mobile-first GPS web app built with plain HTML, CSS, and JavaScript. No build step.

## Publish on GitHub Pages
1. Create a GitHub repository.
2. Upload `index.html` to the repository root.
3. Open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Select your main branch and `/ (root)`, then Save.
6. Open the published HTTPS URL on your iPhone or Android phone.

## Use
- Tap **Start GPS** and allow location permission.
- The map follows your current position and displays latitude, longitude, and GPS accuracy in metres.
- Tap **Stop GPS** to stop updates; **Center** returns the map to your current position.

## Notes
- Browser geolocation requires HTTPS (GitHub Pages provides it) or localhost during testing.
- On iPhone, use Safari and allow location access when prompted. On Android, use Chrome and allow location access.
- GPS accuracy depends on your device, location services, signal, and surroundings.
- Map tiles are provided by OpenStreetMap. Please follow its tile usage policy; the standard tile service is not intended for heavy/offline bulk use.
