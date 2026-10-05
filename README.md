# Glance

A personal canvas of projects. Each project is a card with its name, the current stage or milestone, and the next important date. Open a card and the project fills the screen as stacked stage rows, with milestones running across each row.

New project starts a blank card. Dates are written as YYYY-MM-DD. Add project (assisted) asks for a name, a project start (day 1), and a stage count, then opens every stage at once in a wide window. Each new date starts where the previous stage or milestone left off. +30, +90, and +180 add that many days to the date shown, and Day 1 returns it to the project start. Changing the stage count adds or removes rows.

Drag empty canvas to move around. Drag a card to move that project. Pinch, or hold Ctrl (or Cmd) and scroll, to zoom. A mouse wheel zooms. A trackpad scroll pans.

There is no account and no server. What you add stays in this browser (`localStorage`). The first visit is empty until you add a project.

## Run locally

From the project folder, serve the `public` directory:

```bash
python3 -m http.server 47321 -d public
```

Open [http://127.0.0.1:47321](http://127.0.0.1:47321).

Any static file server works. `index.html` should be at the site root.

## Deploy on Render

Glance is a static site. No build step and no backend.

[`render.yaml`](render.yaml) is a Render Blueprint for one static site. The build command is `true` (a no-op), and the publish directory is `public`.

1. Push this project to a Git repository Render can access.
2. In the Render dashboard, choose **New → Blueprint** and select that repository.
3. Apply the blueprint. Render publishes the `public` folder.

To create the site by hand instead: **New → Static Site**, set the build command to `true`, and set the publish directory to `public`.

Projects still live in each visitor's browser, not on Render.
