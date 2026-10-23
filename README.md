# DrawDoll

A posable 3D drawing mannequin that exports PNGs to use as an underlay layer in Procreate, Pixquare, etc.
Built with three.js + TypeScript + Vite; runs in any modern browser, including iPad Safari.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173 on this Mac. To use it on an iPad on the same Wi-Fi, open
`http://<this Mac's IP>:5173` in Safari. Over plain http the export sheet offers **Download** and
drag-and-drop of the preview; **Share** and **Copy** appear when the app is served over HTTPS.

## Deploy

Every push to `main` builds the app and publishes it to GitHub Pages
(`.github/workflows/deploy.yml`) at https://anthemik.github.io/drawdoll/. On iPad, open that in
Safari and choose Share → Add to Home Screen; it then runs full screen and works offline.

## Using it

- **Pose:** tap a body part, then use its sliders. Shoulders and hips have a direction pad: drag the dot
  to aim the limb (centre = hanging down, rim = straight up); the shaded area is the joint's real range.
  The collarbone follows the arm automatically.
- **Drag to pose:** drag the blue dots on the wrists and ankles to place hands and feet; the arm or
  leg follows within its joint limits. Drag the green dot on the hips to crouch, lunge or shift
  weight — the feet stay planted. In a hand or foot panel you can pin it in place (it holds its
  world position while you move the rest of the body) and set which way the elbow or knee points.
  The head panel has **Look at camera**.
- **Body:** age 2 → adult, sex (female ↔ neutral ↔ male), height, build, muscle.
- **Camera:** lens in mm (35 mm equivalent), preset views, canvas size. The bright frame in the
  viewport is exactly what exports.
- **Look:** shaded / toon / line art, outlines, face guide lines, light direction.
- **Export PNG:** transparent, white or gray background; optional floor shadow, grid and horizon line.

## Code map

| File | What it does |
|---|---|
| `src/proportions.ts` | Age/sex/build → every body dimension (growth-chart heights, heads-tall table) |
| `src/figure.ts` | Builds the skeleton and mannequin meshes, materials, outlines, balance model |
| `src/loft.ts` | Sweeps cross-sections into smooth body-part meshes |
| `src/joints.ts` | Pose controls, joint ranges, ball-joint reach maps, applying a pose to the bones |
| `src/ik.ts` | Two-bone IK for arms and legs, pins, elbow/knee direction, look-at |
| `src/pad.ts` | The direction pad for shoulders and hips |
| `src/viewer.ts` | Scene, camera/lens maths, export frame, lights, picking |
| `src/export.ts` | Full-resolution PNG render |
| `src/app.ts` | State, undo/redo, persistence and the side panel UI |
